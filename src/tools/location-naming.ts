// Naming the declaration a reported location falls inside. A listing of locations is not answerable until
// each row says what it sits in, and naming one costs an outline read — so this runs after the caps, on one
// transiently opened document per distinct in-module file, bounded by the call's remaining budget. A site
// this step cannot name keeps a reason beside its row and is never dropped.

import { flattenOutline, symbolKindName, type LspDocumentSymbol } from "../clangd/outline.js";
import type { LspSession } from "../lsp/session.js";
import { pathKey } from "../paths/path-containment.js";
import { type Budget, withinBudget } from "./budget.js";
import { comparePositions, type Located, type LinePosition } from "./lsp-locations.js";
import { messageOf } from "../error-message.js";

/**
 * The stated reason for a row outside the module: naming it would mean reading outside the boundary.
 * A C++ listing states its own boundary, because a C++ answer is scoped to a set of declared roots rather
 * than to one root; the rule that such a row is reported and never read is the same either way.
 */
export const OUTSIDE_MODULE_REASON = "outside the module root; not named";

/**
 * The same rule stated for an answer whose boundary is a set of declared source roots rather than one
 * module: a location outside every one of them is reported and never opened, so it keeps no name.
 */
export const OUTSIDE_SOURCE_ROOTS_REASON = "outside every declared source root; not named";

/** The reason a row carries when its file's outline never arrived inside the call's budget. */
function namingBudgetReason(budget: Budget): string {
  return `its outline was not read: the naming step ran out of the call's ${budget.ceilingMs} ms budget`;
}

type OutlineRead = { readonly symbols: readonly LspDocumentSymbol[] } | { readonly failure: string };

/** What the naming step knows about one location, before any tool puts it into its own row shape. */
export interface NamedSymbol {
  readonly name: string | null;
  readonly kind: string | null;
  readonly reason?: string;
}

/**
 * A language's own answer to "what is this location inside". The two rules this server already has — Go's
 * top-level declaration and C++'s deepest qualified one — are both stated in terms of the *outline*, and a
 * third backend may need the file as well: TypeScript decides a name's spelling by whether the declaration
 * beside it shares its key, which it reads off the declaration's own modifiers.
 */
export type RowSpeller = (
  file: string,
  symbols: readonly LspDocumentSymbol[],
  position: LinePosition,
) => NamedSymbol;

/** A named location in the shape every Go listing row starts from. */
export type NamedRow = {
  readonly name: string | null;
  readonly kind: string | null;
  readonly file: string;
  readonly line: number;
  readonly external: boolean;
  readonly reason?: string;
};

/** Containment by full position, or by line alone when either side carries no character to compare. */
function encloses(symbol: LspDocumentSymbol, position: LinePosition): boolean {
  const { start, end } = symbol.range;
  const byLine = start.character === undefined || end.character === undefined || position.character === undefined;
  if (byLine) return position.line >= start.line && position.line <= end.line;
  return comparePositions(start, position) <= 0 && comparePositions(position, end) <= 0;
}

/**
 * The declaration a reported location falls inside, searched among the file's TOP-LEVEL declarations and
 * no deeper: a navigation answer names a type or an interface, both always top level in Go, and a member
 * that shares the line is the wrong answer. Where several top-level declarations contain the position — a
 * whole-file wrapper, say — the one starting latest is the most specific.
 */
function enclosingSymbol(symbols: readonly LspDocumentSymbol[], position: LinePosition): LspDocumentSymbol | undefined {
  let best: LspDocumentSymbol | undefined;
  for (const symbol of symbols) {
    if (!encloses(symbol, position)) continue;
    if (best === undefined || comparePositions(symbol.range.start, best.range.start) > 0) best = symbol;
  }
  return best;
}

/**
 * The C++ shape of the same question, where the declaration a site sits in is usually a member inside a
 * class inside a namespace: the deepest enclosing entry wins, named by its qualified path — the same
 * spelling `cpp_find_symbol` publishes as `name` — so a row can be handed straight back as this tool's `name`
 * input, which is the contract a Go row already holds.
 */
function enclosingDeclaration(
  symbols: readonly LspDocumentSymbol[],
  position: LinePosition,
): { name: string; kind: string } | undefined {
  const row = position.line + 1;
  const containing = flattenOutline([...symbols]).filter(
    (entry) => entry.range.startLine <= row && row <= entry.range.endLine,
  );
  const deepest = containing.reduce<(typeof containing)[number] | undefined>(
    (best, entry) => (best === undefined || entry.qualifiedPath.length > best.qualifiedPath.length ? entry : best),
    undefined,
  );
  return deepest === undefined ? undefined : { name: deepest.qualifiedPath.join("::"), kind: deepest.kind };
}

/**
 * The name and kind of the declaration `location` sits in, or the reason this server could not find one.
 * `nestedNames` chooses the deepest-declaration rule for a listing whose rows are members, and leaves
 * Go's top-level rule — and its reason text — exactly as it was.
 */
function namedSymbolAt(location: LinePosition, read: OutlineRead, nestedNames: boolean): NamedSymbol {
  if ("failure" in read) {
    return { name: null, kind: null, reason: read.failure };
  }
  if (nestedNames) {
    const declaration = enclosingDeclaration(read.symbols, location);
    if (declaration !== undefined) return { name: declaration.name, kind: declaration.kind };
    return { name: null, kind: null, reason: "no declaration in this file encloses the reported location" };
  }
  const enclosing = enclosingSymbol(read.symbols, location);
  if (enclosing === undefined) {
    return { name: null, kind: null, reason: "no top-level declaration in this file encloses the reported location" };
  }
  return { name: enclosing.name, kind: symbolKindName(enclosing.kind) };
}

/**
 * One transient outline read per distinct file — each opened, asked and closed again by the session, never
 * taken into its long-lived opened set — the files read concurrently and the whole step bounded by the
 * call's budget. Keyed by `pathKey`, because one file has two spellings on Windows and a second read of
 * the other one would race the first over whether the document is already open. A read that failed, or
 * never finished, is carried per file so its rows keep a reason instead of vanishing.
 */
async function readOutlines(
  session: LspSession,
  files: readonly string[],
  budget: Budget,
): Promise<Map<string, OutlineRead>> {
  const outlines = new Map<string, OutlineRead>();
  const reading = Promise.all(
    files.map(async (file) => {
      const key = pathKey(file);
      if (budget.remainingMs() <= 0) {
        outlines.set(key, { failure: namingBudgetReason(budget) });
        return;
      }
      try {
        outlines.set(key, { symbols: (await session.documentSymbolTransient(file)) ?? [] });
      } catch (e) {
        outlines.set(key, { failure: `its outline could not be read: ${messageOf(e)}` });
      }
    }),
  );
  if ((await withinBudget(reading, budget)) === undefined) {
    for (const file of files) {
      const key = pathKey(file);
      if (!outlines.has(key)) outlines.set(key, { failure: namingBudgetReason(budget) });
    }
  }
  return outlines;
}

/**
 * Names every item a listing kept, in the order given: the queried file's outline is already in hand, an
 * external file is never opened, and the remaining in-module files are read concurrently
 * through the transient fan-out. A location that cannot be named keeps a reason rather than vanishing, and
 * `outsideReason` is the one an external row carries — each language names its own boundary.
 */
export async function nameLocations<T extends Located>(
  session: LspSession,
  items: readonly T[],
  queriedFile: string,
  queriedOutline: readonly LspDocumentSymbol[],
  budget: Budget,
  outsideReason: string,
  nestedNames = false,
  spellRow?: RowSpeller,
): Promise<Array<T & NamedSymbol>> {
  const read = (file: string, symbols: readonly LspDocumentSymbol[], location: LinePosition): NamedSymbol =>
    spellRow?.(file, symbols, location) ?? namedSymbolAt(location, { symbols }, nestedNames);
  const queried = pathKey(queriedFile);
  const others = new Map<string, string>();
  for (const { location } of items) {
    if (location.external || location.key === queried) continue;
    if (!others.has(location.key)) others.set(location.key, location.file);
  }
  const outlines = await readOutlines(session, [...others.values()], budget);
  return items.map((item) => {
    const { location } = item;
    if (location.external) return { ...item, name: null, kind: null, reason: outsideReason };
    if (location.key === queried) return { ...item, ...read(queriedFile, queriedOutline, location) };
    const outline = outlines.get(location.key);
    if (outline === undefined || "failure" in outline) {
      return { ...item, ...namedSymbolAt(location, outline ?? { failure: namingBudgetReason(budget) }, nestedNames) };
    }
    return { ...item, ...read(location.file, outline.symbols, location) };
  });
}

/** The naming in the shape a Go listing row starts from: name, kind, where it is, and why if unnamed. */
export function namedRow(named: Located & NamedSymbol): NamedRow {
  const { location, name, kind, reason } = named;
  return {
    name,
    kind,
    file: location.file,
    line: location.rowLine,
    external: location.external,
    ...(reason === undefined ? {} : { reason }),
  };
}
