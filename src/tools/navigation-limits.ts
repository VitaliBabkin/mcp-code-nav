// The closed set of boundary codes and listing caps, and the one
// shape a declaration's hover answer is read into. Shared by both languages, so a C++ and a Go answer
// describe their limits and their declarations in the same vocabulary.

/**
 * What an answer does not cover, in one machine-readable field rather than in prose the caller must
 * parse. The set is closed: a new limit is a new code and a description change, never an undocumented
 * string.
 */
export type NavigationLimit =
  | "one-module"
  /** Only the file named in `anchor` was searched; another file of the module may declare the same name. */
  | "one-file"
  | "one-port"
  | "osarch-excluded-files"
  | "exported-symbol-importers-invisible"
  /** A method's listing spans the interface method it satisfies, never a sibling implementation's. */
  | "corresponding-interface-methods-included"
  | "indirect-dispatch-not-resolved"
  /**
   * A member mentioned as `x.m` or `x["m"]` without being called — passed as a callback, bound, stored,
   * type-queried — is listed as a caller at that site. Every
   * `ts_find_callers` answer carries it; the call made later through that stored value is the absence
   * `indirect-dispatch-not-resolved` states, and the two are complementary.
   */
  | "uncalled-mentions-included"
  | "compile-database-only"
  /** A TypeScript answer covers the npm workspace holding the named file; another package is unseen. */
  | "one-workspace"
  /** A project under that workspace was not loaded, so its consumers are absent from the answer. */
  | "projects-not-loaded"
  /** A type that satisfies an interface without naming it is not an implementer tsgo can be asked about. */
  | "structural-implementers-not-reported"
  /** The workspace compiles with a different TypeScript major than the server that answered. */
  | "workspace-typescript-differs"
  | "uncovered-sources-present"
  | "index-still-building"
  | "index-state-unknown"
  | "index-behind-disk"
  | "index-drift-unknown"
  | "listing-capped"
  /** The outline came from clangd's default flags because projectRoot holds no readable compile database. */
  | "parsed-without-compile-database";

/** How many files a reference listing may group. `totalReferences` beside it stays exact. */
export const REFERENCE_FILES_LIMIT = 40;

/** How many sites one file's group may list. Its own `count` stays exact. */
export const REFERENCE_SITES_PER_FILE_LIMIT = 20;

/** How many callers one listing may carry. `totalCallers` beside it stays exact. */
export const CALLERS_LIMIT = 40;

/**
 * How many rows an implementation listing may carry. Moved here from `go-find-implementations.ts` when the
 * TypeScript tools needed the same ceiling for their own answer, because two backends
 * with two numbers for one limit would make the cap a fact about the language rather than about this server.
 */
export const IMPLEMENTATIONS_LIMIT = 50;

/**
 * How many changed sources `scope.index.staleFiles` may name. `count` beside it stays exact, and the cap
 * exists for the same reason the other two do: a rebuild that touched three thousand files must not turn
 * the boundary signal into the bulk of the payload.
 */
export const STALE_FILES_LIMIT = 20;

/**
 * The wall-clock ceiling a navigation call runs under when its own input carries none. The Go tools take a
 * `timeBudgetMs` because their first call pays a package load measured in tens of seconds; a C++ listing
 * question has no such input, and the work that must still be bounded is the outline fan-out that names
 * its rows — reaching this ceiling costs rows their names, never the answer.
 */
export const NAVIGATION_CEILING_MS = 600_000;

/**
 * What a symbol IS, read from `textDocument/hover` at the declaration this server already resolved.
 * Spread into the row it describes. Hover that answers nothing this server can read yields
 * `descriptionUnavailable` naming why — never a guessed or empty signature.
 */
export interface SymbolDescription {
  readonly signature?: string;
  readonly documentation?: string;
  readonly descriptionUnavailable?: string;
}

/**
 * One stretch of a hover answer. `code` is whether the answer marked the stretch as a code block — a
 * `MarkedString`, or a ``` fence, with or without an info string — and `language` is the tag it arrived
 * under, `""` when it had none. The two are separate because the untagged fence is exactly the shape gopls
 * has been seen to send for a `type` declaration, and prose is the one thing that must never be read as a
 * signature.
 */
interface HoverPart {
  readonly language: string;
  readonly text: string;
  readonly code: boolean;
}

/** A ```-fenced stretch inside a markdown hover value. */
const CODE_FENCE = /```([^\n`]*)\r?\n([\s\S]*?)```/g;

/** One value from a hover answer, split into the code blocks it holds and the prose between them. */
function partsOfValue(text: string, language: string): HoverPart[] {
  if (language !== "") return [{ language, text, code: true }];
  const parts: HoverPart[] = [];
  let rest = 0;
  for (const fence of text.matchAll(CODE_FENCE)) {
    const before = text.slice(rest, fence.index);
    if (before.trim() !== "") parts.push({ language: "", text: before, code: false });
    parts.push({ language: (fence[1] ?? "").trim(), text: fence[2] ?? "", code: true });
    rest = (fence.index ?? 0) + fence[0].length;
  }
  if (parts.length === 0) return [{ language, text, code: false }];
  const after = text.slice(rest);
  if (after.trim() !== "") parts.push({ language: "", text: after, code: false });
  return parts;
}

/** Every value a hover `contents` carries: a string, a `{language,value}`, a `{kind,value}`, or a list. */
function collectParts(contents: unknown, into: HoverPart[]): void {
  if (typeof contents === "string") {
    into.push(...partsOfValue(contents, ""));
    return;
  }
  if (Array.isArray(contents)) {
    for (const entry of contents) collectParts(entry, into);
    return;
  }
  if (typeof contents !== "object" || contents === null) return;
  const { value, language } = contents as { value?: unknown; language?: unknown };
  if (typeof value !== "string") return;
  into.push(...partsOfValue(value, typeof language === "string" ? language.trim() : ""));
}

/** The `contents` field of a hover answer, or the answer itself when a server skipped the envelope. */
function hoverContents(hover: unknown): unknown {
  if (typeof hover !== "object" || hover === null) return hover;
  return "contents" in hover ? (hover as { contents: unknown }).contents : hover;
}

function unreadableHover(contents: unknown): string {
  const shape =
    Array.isArray(contents) ? "an empty list" : contents === null || contents === undefined ? "nothing" : `a ${typeof contents}`;
  return (
    "the hover answer carried " +
    shape +
    ` where this server reads a code block for the signature: ${JSON.stringify(contents)?.slice(0, 200) ?? String(contents)}`
  );
}

/**
 * The declaration's signature is the code block the hover answer carried — the one tagged `go` when several
 * arrived — and its documentation is the prose around it. A missing block or a missing doc comment is not an
 * error: the field is simply absent, because inventing either is the defect this shape exists to refuse.
 */
export function readSymbolDescription(hover: unknown): SymbolDescription {
  const contents = hoverContents(hover);
  const parts: HoverPart[] = [];
  collectParts(contents, parts);
  const code = parts.filter((part) => part.code && part.text.trim() !== "");
  const signature = code.find((part) => part.language.toLowerCase() === "go") ?? code[0];
  const documentation = parts
    .filter((part) => !part.code)
    .map((part) => part.text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
  if (signature === undefined && documentation === "") return { descriptionUnavailable: unreadableHover(contents) };
  return {
    ...(signature === undefined ? {} : { signature: signature.text.trim() }),
    ...(documentation === "" ? {} : { documentation }),
  };
}
