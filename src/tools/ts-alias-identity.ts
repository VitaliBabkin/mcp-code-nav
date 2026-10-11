import { type LspDocumentSymbol, symbolKindName } from "../clangd/outline.js";
import { textDocumentId } from "../lsp/document-uri.js";
import { withinBudget } from "./budget.js";
import { type ReportedLocation, toReported } from "./lsp-locations.js";
import { readSymbolDescription } from "./navigation-limits.js";
import {
  subjectPositions,
  tsFileExternal,
  tsRowSpeller,
  type TsQuery,
  type TsResolvedSymbol,
} from "./ts-navigation-shared.js";

/**
 * Where the subject itself sits, as the identity test reads it, for a
 * subject addressed through an import binding. `own` is a set of `key:line:character`; `target`
 * is the first declaration `definition` named, present only for an alias subject whose definition answered.
 *
 * A binding's own site is an import or re-export line and is always a row; the declaration it binds is the
 * subject's. So for a top-level `variable` entry whose hover opens `(alias)` (the test `ts_file_symbols` classifies
 * bindings with), the identity is where `textDocument/definition` lands. Any other subject keeps its own positions
 * and sends neither request. When the hover or the definition fails, times out or names nothing, `own` is empty,
 * which drops nothing: never a guessed declaration.
 */
export interface SubjectIdentity {
  readonly own: ReadonlySet<string>;
  readonly target?: ReportedLocation;
  /** The alias hover shows an export clause (`export { a as b } from`), so the binding is a re-export. */
  readonly reExport?: boolean;
}

const positionKey = (at: ReportedLocation): string => `${at.key}:${at.line}:${at.character}`;

export async function subjectIdentity(tool: string, query: TsQuery, symbol: string): Promise<SubjectIdentity> {
  const { subject } = query;
  const isBindingCandidate = symbolKindName(subject.entry.kind) === "variable" && query.symbols.includes(subject.entry);
  if (!isBindingCandidate) return { own: subjectPositions(subject) };

  const params = { textDocument: textDocumentId(query.file), position: subject.position };
  const asked = async (method: string): Promise<unknown> =>
    await withinBudget(query.session.request<unknown>(method, params).catch(() => undefined), query.budget);

  const signature = readSymbolDescription(await asked("textDocument/hover")).signature;
  if (signature === undefined) return { own: new Set() };
  if (!signature.trimStart().startsWith("(alias)")) return { own: subjectPositions(subject) };

  const answered = await asked("textDocument/definition");
  const list = answered !== null && typeof answered === "object" && !Array.isArray(answered) ? [answered] : answered;
  const targets = toReported("tsgo", tool, list, tsFileExternal(query.workspaceRoot), symbol);
  if (!targets.ok) return { own: new Set() };
  const placed = targets.value.filter((target) => target.character !== undefined);
  const reExport = signature.split("\n").some((line) => line.trimEnd().startsWith("export "));
  return { own: new Set(placed.map(positionKey)), target: placed[0], reExport };
}

function declaresAt(entries: readonly LspDocumentSymbol[], line: number, character: number): boolean {
  return entries.some((entry) => {
    const start = entry.selectionRange?.start;
    return (start?.line === line && start.character === character) || declaresAt(entry.children ?? [], line, character);
  });
}

/**
 * A renamed import is scoped by tsgo to the local name: its raw answer lists none of the places `definition` named.
 * An alias that is not renamed lists the declaration among them, so this needs no request beyond naming the
 * target. `symbol` is the target spelled by the row rule, so it feeds back as `symbol`, but only where an outline
 * entry is declared exactly at the position: the row rule names what encloses a place, not what is declared there.
 * A binding of a whole module is answered at line 0, character 0, where nothing is declared (`module`); `symbol`
 * is null for it, for an unreadable outline, and for a file outside the workspace.
 */
export async function renamedImportOf(
  query: TsQuery,
  identity: SubjectIdentity,
  raw: readonly ReportedLocation[],
): Promise<TsResolvedSymbol["renamedImportOf"]> {
  const { target, own } = identity;
  if (target === undefined || own.size === 0) return undefined;
  if (raw.some((location) => own.has(`${location.key}:${location.line}:${location.character ?? "-"}`))) return undefined;
  let symbol: string | null = null;
  let module = false;
  if (!target.external && target.character !== undefined) {
    const outline = await withinBudget(
      query.session.documentSymbolTransient(target.file).catch(() => undefined),
      query.budget,
    );
    if (outline !== undefined && outline !== null) {
      const declared = declaresAt(outline, target.line, target.character);
      if (declared) {
        symbol = tsRowSpeller()(target.file, outline, { line: target.line, character: target.character }).name;
      }
      module = !declared && target.line === 0 && target.character === 0;
    }
  }
  return { symbol, file: target.file, line: target.rowLine, module, reExport: identity.reExport === true };
}
