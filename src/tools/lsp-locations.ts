// Reading the locations a language server reports, and the order one listing keeps them in. Nothing here
// knows which server sent them or which language the answer is about: one reported range becomes one
// comparable position, one grouping key per distinct file, and a boundary flag saying whether the location
// lies inside the root the call was rooted at.

import { fileURLToPath } from "node:url";
import { escapesRoot, pathKey } from "../paths/path-containment.js";
import { type Step, withArticle } from "./navigation-text.js";

export type Position = { readonly line: number; readonly character: number };

/** A position whose character a server may not have sent; then only the line can be compared. */
export type LinePosition = { readonly line: number; readonly character?: number };

/**
 * One location as a server reported it: `line`/`character` are 0-based for outline matching, `key` is the
 * `pathKey` of `file` so grouping and dedupe never recompute it.
 */
export interface ReportedLocation {
  readonly key: string;
  readonly file: string;
  readonly line: number;
  readonly character: number | undefined;
  readonly rowLine: number;
  readonly external: boolean;
}

/** Anything a listing can name: a reported site, or a group carrying one. */
export interface Located {
  readonly location: ReportedLocation;
}

/** Names which fields to look at; asserts nothing about their types, which is what the checks below are for. */
export function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
}

export function rangeStart(range: unknown): LinePosition | undefined {
  if (typeof range !== "object" || range === null) return undefined;
  const { start } = range as { start?: unknown };
  if (typeof start !== "object" || start === null) return undefined;
  const { line, character } = start as { line?: unknown; character?: unknown };
  if (typeof line !== "number") return undefined;
  return typeof character === "number" ? { line, character } : { line };
}

/** `fileURLToPath`, because gopls percent-encodes URIs; `undefined` for a URI that is not a file. */
export function pathOfUri(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * One location a server reported, with the boundary flag and the grouping key. `key` is the `pathKey` of
 * `file`; the caller caches it because one file is often reported many times. `outside` is the boundary of
 * the answer being built — one module root for a Go answer, every declared source root for a C++ one.
 */
export function reportedLocation(
  file: string,
  start: LinePosition,
  outside: BoundaryTest,
  key: string,
): ReportedLocation {
  return {
    key,
    file,
    line: start.line,
    character: start.character,
    rowLine: start.line + 1,
    external: outside(file),
  };
}

/** `pathKey` once per distinct raw spelling, so a wide answer does not fold the same path thousands of times. */
export function locationKeyFactory(): (file: string) => string {
  const seen = new Map<string, string>();
  return (file) => {
    const cached = seen.get(file);
    if (cached !== undefined) return cached;
    const key = pathKey(file);
    seen.set(file, key);
    return key;
  };
}

/** The kept items of one listing, in the order a cap may drop them from: in-module ahead of external. */
export function inModuleFirst<T>(items: readonly T[], isExternal: (item: T) => boolean): T[] {
  return [...items.filter((item) => !isExternal(item)), ...items.filter((item) => isExternal(item))];
}

/** Ordering for two positions, comparing the character only when both sides carry one. */
export function comparePositions(a: LinePosition, b: LinePosition): number {
  return a.line - b.line || (a.character ?? 0) - (b.character ?? 0);
}

/** A location is outside the boundary the answer was scoped to; each language states that boundary itself. */
export type BoundaryTest = (file: string) => boolean;

/** The boundary of a call rooted at one directory: outside it is outside the answer's scope. */
export function outsideRoot(root: string): BoundaryTest {
  return (file) => escapesRoot(root, file);
}

/** A server answer this server reads as `Location`s, or one it reads as a call hierarchy. */
export interface AnswerShape {
  readonly noun: string;
  readonly dropped: string;
  readonly expects: string;
}

export const LOCATION_ANSWER: AnswerShape = {
  noun: "query",
  dropped: "a match",
  expects: "`Location` or `LocationLink`",
};

export const CALL_HIERARCHY_ANSWER: AnswerShape = {
  noun: "caller query",
  dropped: "a caller",
  expects: "`CallHierarchyItem` and `IncomingCall`",
};

/** The project-wide declaration search, whose rows carry their own `location`. */
export const WORKSPACE_SYMBOL_ANSWER: AnswerShape = {
  noun: "project-wide symbol search",
  dropped: "a declaration",
  expects: "`SymbolInformation` entries, each with a `name`, a `kind` and a `location`",
};

export function unexpectedAnswerText(
  server: string,
  tool: string,
  received: unknown,
  symbol: string,
  part: string | undefined,
  shape: AnswerShape,
): string {
  const what = part ?? withArticle(Array.isArray(received) ? "list" : typeof received);
  return (
    `${tool} failed: ${server} answered the ${shape.noun} for "${symbol}" with ${what} this server cannot ` +
    `read, so the answer cannot be reported without possibly dropping ${shape.dropped}. It expects ` +
    `${shape.expects} entries: ${JSON.stringify(received)?.slice(0, 300) ?? String(received)}`
  );
}

/**
 * Every entry either becomes a location or fails the call: an entry this server cannot read would
 * otherwise shrink the answer with nothing in the payload saying so.
 */
export function toReported(
  server: string,
  tool: string,
  result: unknown,
  outside: BoundaryTest,
  symbol: string,
): Step<ReportedLocation[]> {
  if (result === null || result === undefined) return { ok: true, value: [] };
  if (!Array.isArray(result)) {
    return { ok: false, error: unexpectedAnswerText(server, tool, result, symbol, undefined, LOCATION_ANSWER) };
  }
  const rows: ReportedLocation[] = [];
  const keyOf = locationKeyFactory();
  for (const [index, entry] of result.entries()) {
    const raw = recordOf(entry);
    const file = pathOfUri(raw.uri) ?? pathOfUri(raw.targetUri);
    const start = rangeStart(raw.range) ?? rangeStart(raw.targetSelectionRange) ?? rangeStart(raw.targetRange);
    if (file === undefined || start === undefined) {
      return {
        ok: false,
        error: unexpectedAnswerText(server, tool, result[index], symbol, `entry ${index + 1}`, LOCATION_ANSWER),
      };
    }
    rows.push(reportedLocation(file, start, outside, keyOf(file)));
  }
  return { ok: true, value: rows };
}
