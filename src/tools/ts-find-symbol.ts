import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type LspDocumentSymbol, symbolKindName } from "../clangd/outline.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { errorResult, successResult } from "../mcp-response.js";
import { pathKey } from "../paths/path-containment.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { withinBudget } from "./budget.js";
import { type DeclarationSource, describeRows } from "./declaration-description.js";
import {
  type AnswerShape,
  pathOfUri,
  type Position,
  rangeStart,
  recordOf,
  unexpectedAnswerText,
} from "./lsp-locations.js";
import type { SymbolDescription } from "./navigation-limits.js";
import { containerOf, type Step } from "./navigation-text.js";
import { NameInput, PathInput } from "./input-limits.js";
import { resolutionNote } from "./shared.js";
import { matchingEntries, type ReachedEntry } from "./ts-addressing.js";
import {
  anchorProjects,
  mentionNameOf,
  openWorkspace,
  readTsOutline,
  tsFileExternal,
  tsNavigationScope,
  tsRestartedText,
  tsScopeText,
  summarised,
  unreadableSpanText,
  tsTypeAwareRequest,
  tsUncoveredClause,
  tsUncoveredClauseWithoutMap,
  type TsNavigationScope,
  type TsOpened,
  type TsQueryDeps,
  type TsRequestQuery,
  type TsScopeSource,
} from "./ts-navigation-shared.js";
import { type HumanSummary, resolveTsAnchor, TsSourceRootsSchema, timeBudgetSchema, withSummary } from "./ts-shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "ts_find_symbol";

const SYMBOL_METHOD = "workspace/symbol";

/**
 * This server's watermark on tsgo's symbol list — a bound this server owns, not a fact about tsgo. An answer is
 * capped when the raw count of entries tsgo returned, before the exact-name filter, reaches it: the raw count is
 * what matters, because the filter is exactly what a truncated list could have defeated. It must sit AT OR BELOW
 * tsgo's own cap, so the code over-reports on a complete list rather than staying silent on a truncated one; a
 * watermark raised above the real cap would turn the signal off with no test noticing. Pinned by the live
 * two-query probe: two deliberately overflowing queries against the installed tsgo each returned exactly this
 * many entries, which is the cap's signature. No published sentence says so.
 */
export const TS_WORKSPACE_SYMBOL_CAP_WATERMARK = 256;

/** Why a row outside the workspace carries no description: reading it would cross the declared boundary. */
const EXTERNAL_DESCRIPTION_REASON = "outside the workspace root; not read";

/** A declaration this tool reports: where the name is, what it is, and what the hover said it means. */
export type TsDeclarationRow = {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly container: string | null;
  readonly external: boolean;
  /** The config that owns the row's file; `null` when none does. Absent on an external row and with no map. */
  readonly ownedBy?: string | null;
  /** Why a dotted row could not be checked against its file's outline and stands unchecked. */
  readonly pathUnverified?: string;
  /** Set when TypeScript's printer elided part of `signature` (`...;`); the text is published as tsgo sent it. */
  readonly signatureTruncated?: true;
} & SymbolDescription;

/**
 * Which lookup produced an answer. The set is closed at two and named for the request that answered:
 * `"document-symbol"` is a FILE anchor — that file's own outline, no search — and `"workspace-symbol"` is a
 * DIRECTORY anchor — tsgo's index over the projects whose anchors are open. A third value is a contract change.
 */
export type TsSymbolLookup = "document-symbol" | "workspace-symbol";

export type TsDeclarationScope = TsNavigationScope & { readonly lookup: TsSymbolLookup };

export type TsFindSymbolPayload = {
  readonly declarations: TsDeclarationRow[];
  readonly scope: TsDeclarationScope;
};

export const TsFindSymbolInput = z.object({
  sourceRoots: TsSourceRootsSchema,
  symbol: NameInput
    .describe(
      "Exact name: top-level, or a dotted path through classes, interfaces, enums and namespaces " +
        "(`Driver.run`); a bare name never matches a member.",
    ),
  anchor: PathInput
    .describe(
      "Absolute, or relative to exactly one sourceRoots entry. A FILE searches that file's own declarations; " +
        "a DIRECTORY searches the whole npm workspace.",
    ),
  timeBudgetMs: timeBudgetSchema(60_000),
});

export type TsFindSymbolInputType = z.infer<typeof TsFindSymbolInput>;

/** What is known of one call once its projects are anchored and the documents-opened proof holds. */
interface TsSearch extends TsScopeSource, Pick<TsRequestQuery, "anchorsProvenOn"> {}

/** Which lookup answered, phrased for the two texts that have to name it. */
function searchedWhere(lookup: TsSymbolLookup, file: string | undefined, workspaceRoot: string): string {
  return lookup === "document-symbol"
    ? `the outline of "${file}"`
    : `the whole workspace "${workspaceRoot}" through tsgo's symbol index`;
}

function noMatchText(symbol: string, lookup: TsSymbolLookup, file: string | undefined, workspaceRoot: string): string {
  return (
    `${TOOL} failed: no declaration named "${symbol}" was found in ${searchedWhere(lookup, file, workspaceRoot)}. ` +
    "The match is exact, not fuzzy: a bare name names a top-level declaration of that word and never a member, " +
    "`Container.member` names a member of a class, interface, enum or namespace, and nothing outside this one " +
    "npm workspace is searched. A name tsgo spells differently, or one declared in another package or in a " +
    "dependency, is not an answer this call can give."
  );
}

/**
 * What the caller reads whenever the raw list reached the watermark — beside the rows on a successful answer,
 * and beside the not-found text when the filter found nothing. It claims no number: the watermark is this
 * server's, and stating one as tsgo's cap is an unverified fact about another program that a version bump
 * falsifies silently.
 */
function capText(): string {
  return (
    "tsgo's symbol search returns a bounded list and this one came back at the size this server treats as " +
    "that bound, so a declaration of this name may have been ranked out of it."
  );
}

const SYMBOL_ANSWER: AnswerShape = {
  noun: "workspace-wide symbol search",
  dropped: "a declaration",
  expects: "`SymbolInformation` entries, each with a `name`, a `kind` and a `location`",
};

function unreadableEntryText(received: unknown, symbol: string, part?: string): string {
  return unexpectedAnswerText("tsgo", TOOL, received, symbol, part, SYMBOL_ANSWER);
}

/** The identifier tsgo's matcher is asked for: the last segment of a dotted name, which is what it indexes. */
function symbolQuery(symbol: string): string {
  return symbol.slice(symbol.lastIndexOf(".") + 1);
}

/** A name with an empty segment (`A..b`, `A.`) names nothing, so it is answered without asking a server. */
function isWellFormed(symbol: string): boolean {
  return symbol !== "" && symbol.split(".").every((segment) => segment !== "");
}

/** One `workspace/symbol` entry that names the wanted declaration, and whether its outline still has to agree. */
interface SymbolCandidate {
  readonly source: DeclarationSource;
  /** Composed from a `containerName`, which names only the nearest container, so the outline has the last word. */
  readonly checkAgainstOutline: boolean;
}

/**
 * One `workspace/symbol` entry. tsgo answers that request with `SymbolInformation`, whose `location.range` IS the
 * declaration's identifier span, so the row's line and the position its hover is asked at both come from that
 * range. A range that carries a line but no character costs the row its description, never its place in the
 * list; a range that is not there at all is an entry this server cannot place, and is reported rather than
 * answered with a row without a location.
 *
 * The exact-name filter composes `containerName.name`: a bare name matches only an entry
 * that has no container, and a dotted one matches the last two segments of its path against the entry's nearest
 * container and own name. The row is named the way the caller asked, which is the spelling `ts_find_references`
 * accepts back.
 */
function symbolCandidate(
  raw: unknown,
  workspaceRoot: string,
  symbol: string,
  part: string,
): Step<SymbolCandidate | undefined> {
  const entry = recordOf(raw);
  const location = recordOf(entry.location);
  const file = pathOfUri(location.uri) ?? pathOfUri(location.targetUri);
  const named = rangeStart(location.range) ?? rangeStart(location.targetSelectionRange) ?? rangeStart(location.targetRange);
  const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : undefined;
  if (name === undefined || file === undefined || named === undefined) {
    return { ok: false, error: unreadableEntryText(raw, symbol, part) };
  }
  const containerName = typeof entry.containerName === "string" && entry.containerName !== "" ? entry.containerName : null;
  const tail = symbol.split(".").slice(-2).join(".");
  const reads = containerName === null ? name === symbol : symbol.includes(".") && `${containerName}.${name}` === tail;
  if (!reads) return { ok: true, value: undefined };
  const external = tsFileExternal(workspaceRoot)(file);
  return {
    ok: true,
    value: {
      checkAgainstOutline: containerName !== null && !external,
      source: {
        name: symbol,
        kind: typeof entry.kind === "number" ? symbolKindName(entry.kind) : "?",
        file,
        line: named.line + 1,
        container: external ? null : containerOf(file, workspaceRoot),
        position: named.character === undefined ? null : { line: named.line, character: named.character },
        external,
      },
    },
  };
}

/**
 * Owned in-workspace rows first, then in-workspace rows no project owns, then external rows, each by path and line. The group is the comparator's own first key: `Array#sort` is total,
 * so partitioning first and sorting after would interleave the groups by path again.
 */
function rank(search: TsSearch, row: DeclarationSource): number {
  if (row.external) return 2;
  return ownerField(search, row).ownedBy === null ? 1 : 0;
}

function byLocation(search: TsSearch, a: DeclarationSource, b: DeclarationSource): number {
  return (
    rank(search, a) - rank(search, b) ||
    pathKey(a.file).localeCompare(pathKey(b.file)) ||
    a.line - b.line ||
    a.name.localeCompare(b.name)
  );
}

function workspaceCandidates(
  result: unknown,
  workspaceRoot: string,
  symbol: string,
): Step<{ candidates: SymbolCandidate[]; capped: boolean }> {
  if (result !== null && result !== undefined && !Array.isArray(result)) {
    return { ok: false, error: unreadableEntryText(result, symbol) };
  }
  const entries = Array.isArray(result) ? result : [];
  const candidates: SymbolCandidate[] = [];
  for (const [index, raw] of entries.entries()) {
    const read = symbolCandidate(raw, workspaceRoot, symbol, `entry ${index + 1}`);
    if (!read.ok) return read;
    if (read.value !== undefined) candidates.push(read.value);
  }
  return { ok: true, value: { candidates, capped: entries.length >= TS_WORKSPACE_SYMBOL_CAP_WATERMARK } };
}

/** Whether two positions name the same identifier start. */
function samePlace(a: Position, b: Position): boolean {
  return a.line === b.line && a.character === b.character;
}

/**
 * One file's outline as the check read it, with the file's text a dotted namespace run is read against: nothing
 * (`null`), no answer in time (`undefined`), or a rejection of either read.
 */
type OutlineRead =
  | { readonly outline: readonly LspDocumentSymbol[]; readonly lines: readonly string[] }
  | null
  | undefined
  | { readonly failure: string };

/** The rows that stand, and why a row that stands could not be checked. */
interface ConfirmedRows {
  readonly rows: DeclarationSource[];
  readonly unverified: ReadonlyMap<DeclarationSource, string>;
}

async function readOutline(search: TsSearch, file: string): Promise<OutlineRead> {
  try {
    const outline = await withinBudget(search.session.documentSymbolTransient(file), search.budget);
    if (outline === undefined || outline === null) return outline;
    return { outline, lines: readFileSync(file, "utf-8").split(/\r?\n/) };
  } catch (e) {
    return { failure: messageOf(e) };
  }
}

/** Whether a row stands against its file's outline, and why it stands unchecked when it could not be checked. */
function check(
  source: DeclarationSource,
  read: OutlineRead,
  symbol: string,
  search: TsSearch,
): { readonly stands: boolean; readonly unverified?: string } {
  if (read === undefined) {
    return { stands: true, unverified: `this call's ${search.budget.ceilingMs} ms budget ran out before the outline of its file was read` };
  }
  if (read === null) return { stands: true, unverified: "tsgo answered no outline for its file" };
  if ("failure" in read) return { stands: true, unverified: `its outline could not be read: ${read.failure}` };
  const position = source.position;
  if (position === null) return { stands: true, unverified: "the symbol index named no position for its identifier" };
  const reach = matchingEntries(symbol, read.outline, read.lines);
  if (reach.kind === "unreadable") {
    return { stands: true, unverified: `its outline entry "${reach.entry.name}" is a dotted namespace run this server cannot read` };
  }
  const reached = reach.kind === "reached" ? reach.entries : [];
  return { stands: reached.some(({ position: at }) => at !== undefined && samePlace(at, position)) };
}

/**
 * A composed row stands only if its file's own outline reaches the same name at the same place by the full
 * dotted path: `containerName` is the nearest container alone, so `Geometry.Worker.run` and a top-level
 * `Worker.run` both read `Worker.run`, and a local inside a function reads like a member of it. A row whose
 * outline cannot be read keeps its place, because dropping it would narrow the answer silently, and carries the
 * reason as `pathUnverified`, because publishing it unmarked would claim a spelling nobody checked.
 */
async function confirmed(
  search: TsSearch,
  symbol: string,
  candidates: readonly SymbolCandidate[],
): Promise<ConfirmedRows> {
  const files = new Map<string, string>();
  for (const { source, checkAgainstOutline } of candidates) {
    if (checkAgainstOutline) files.set(pathKey(source.file), source.file);
  }
  const outlines = new Map<string, OutlineRead>();
  await Promise.all(
    [...files.entries()].map(async ([key, file]) => {
      outlines.set(key, await readOutline(search, file));
    }),
  );
  const rows: DeclarationSource[] = [];
  const unverified = new Map<DeclarationSource, string>();
  for (const { source, checkAgainstOutline } of candidates) {
    if (!checkAgainstOutline) {
      rows.push(source);
      continue;
    }
    const verdict = check(source, outlines.get(pathKey(source.file)), symbol, search);
    if (verdict.unverified !== undefined) unverified.set(source, verdict.unverified);
    if (verdict.stands) rows.push(source);
  }
  return { rows, unverified };
}

/**
 * `ownedBy`: the config that owns the row's file, `null` when no mapped
 * project does, and absent on an external row and when no map could be proved.
 */
function ownerField(search: TsSearch, declaration: DeclarationSource): { readonly ownedBy?: string | null } {
  if (declaration.external || search.owners === undefined) return {};
  return { ownedBy: search.owners.get(pathKey(declaration.file)) ?? null };
}

/**
 * Whether the printer shortened this row's signature: `...;` is an elided
 * arm of a union, `... N more ...` a run of members left out. A rest parameter (`...args`) matches neither. The
 * signature text stays exactly as tsgo sent it — this marks what the answer is, it never repairs it.
 */
const TRUNCATED_SIGNATURE = [/\.\.\.;/, /\.\.\. \d+ more \.\.\./];

function signatureFlag(description: SymbolDescription): { readonly signatureTruncated?: true } {
  const signature = description.signature;
  return signature !== undefined && TRUNCATED_SIGNATURE.some((test) => test.test(signature))
    ? { signatureTruncated: true }
    : {};
}

function toRow(
  search: TsSearch,
  declaration: DeclarationSource,
  description: SymbolDescription,
  unverified: string | undefined,
): TsDeclarationRow {
  const { name, kind, file, line, container, external } = declaration;
  return {
    name,
    kind,
    file,
    line,
    container,
    external,
    ...ownerField(search, declaration),
    ...(unverified === undefined ? {} : { pathUnverified: unverified }),
    ...description,
    ...signatureFlag(description),
  };
}

/**
 * The answer once the declarations are known: each one's signature and documentation from its own hover, then
 * the `scope` block stating what the search covered.
 */
async function answered(
  search: TsSearch,
  symbol: string,
  declarations: readonly DeclarationSource[],
  lookup: TsSymbolLookup,
  capped: boolean,
  unverified: ReadonlyMap<DeclarationSource, string> = new Map(),
): Promise<Step<TsFindSymbolPayload>> {
  const described = await describeRows(
    {
      session: search.session,
      budget: search.budget,
      server: "tsgo",
      externalReason: EXTERNAL_DESCRIPTION_REASON,
      stillProven: () => search.session.spawnSerial() === search.anchorsProvenOn && search.session.isWorkspaceLoaded(),
    },
    declarations,
  );
  if (described === undefined) return { ok: false, error: tsRestartedText(TOOL, symbol, search.workspaceRoot) };
  const scope = await tsNavigationScope(
    search,
    { capped, correspondingMethods: false, oneFile: lookup === "document-symbol" },
    mentionNameOf(symbol),
  );
  return {
    ok: true,
    value: {
      declarations: declarations.map((declaration, index) =>
        toRow(
          search,
          declaration,
          described[index] ?? { descriptionUnavailable: "this server read no hover answer for this row" },
          unverified.get(declaration),
        ),
      ),
      scope: { ...scope, lookup },
    },
  };
}

/** One file's text, or the failure that keeps a dotted namespace run in it from being read. */
function readLines(file: string): Step<readonly string[]> {
  try {
    return { ok: true, value: readFileSync(file, "utf-8").split(/\r?\n/) };
  } catch (e) {
    return { ok: false, error: `${TOOL} failed: "${file}" could not be read (${messageOf(e)}), so the names it declares cannot be located.` };
  }
}

/** A row for one entry a name reached: its line is the name's own, and its position is where a hover is asked. */
function declarationAt(
  reached: ReachedEntry,
  symbol: string,
  file: string,
  container: string,
): DeclarationSource {
  const { entry, position } = reached;
  return {
    name: symbol,
    kind: symbolKindName(entry.kind),
    file,
    line: position === undefined ? entry.range.start.line + 1 : position.line + 1,
    container,
    position: position ?? null,
    external: false,
  };
}

/** A file anchor: one outline, every entry the name reaches, no search. */
async function fromOneFile(
  opened: TsOpened,
  symbol: string,
  deps: TsQueryDeps,
): Promise<Step<TsFindSymbolPayload>> {
  const outline = await readTsOutline(TOOL, opened);
  if (!outline.ok) return outline;
  const lines = readLines(opened.file);
  if (!lines.ok) return lines;
  const reach = isWellFormed(symbol) ? matchingEntries(symbol, outline.value, lines.value) : undefined;
  if (reach?.kind === "unreadable") {
    return { ok: false, error: unreadableSpanText(TOOL, opened.file, reach.entry) };
  }
  const entries = reach?.kind === "reached" ? reach.entries : [];
  // A name with no answer here pays for the project map only, never for anchors or a type-aware request; an
  // ill-formed name names nothing, so there is nothing to point at.
  if (entries.length === 0) {
    const absent = noMatchText(symbol, "document-symbol", opened.file, opened.workspaceRoot);
    const uncovered = isWellFormed(symbol)
      ? await tsUncoveredClauseWithoutMap(opened, deps.exec, mentionNameOf(symbol))
      : "";
    return { ok: false, error: uncovered === "" ? absent : `${absent}\n${uncovered}` };
  }
  const anchored = await anchorProjects(TOOL, opened, deps.exec, symbol, [opened.file]);
  if (!anchored.ok) return anchored;
  const search: TsSearch = { ...opened, ...anchored.value.mapped, anchorsProvenOn: anchored.value.anchorsProvenOn };
  const container = containerOf(opened.file, opened.workspaceRoot);
  const declarations = entries.map((reached) => declarationAt(reached, symbol, opened.file, container));
  return answered(search, symbol, declarations, "document-symbol", false);
}

/** A directory anchor: tsgo's index of the loaded projects, narrowed to exact names by this server. */
async function fromWholeWorkspace(
  opened: TsOpened,
  symbol: string,
  deps: TsQueryDeps,
): Promise<Step<TsFindSymbolPayload>> {
  if (!isWellFormed(symbol)) {
    return { ok: false, error: noMatchText(symbol, "workspace-symbol", undefined, opened.workspaceRoot) };
  }
  const anchored = await anchorProjects(TOOL, opened, deps.exec, symbol, []);
  if (!anchored.ok) return anchored;
  // A directory names no file, so none can be "the named file" of this answer.
  const search: TsSearch = { ...opened, file: undefined, ...anchored.value.mapped, anchorsProvenOn: anchored.value.anchorsProvenOn };
  const searched = await tsTypeAwareRequest(
    TOOL,
    search,
    symbol,
    SYMBOL_METHOD,
    { query: symbolQuery(symbol) },
    `search the workspace for "${symbol}"`,
  );
  if (!searched.ok) return searched;
  const found = workspaceCandidates(searched.value, opened.workspaceRoot, symbol);
  if (!found.ok) return found;
  const { rows, unverified } = await confirmed(search, symbol, found.value.candidates);
  const { capped } = found.value;
  if (rows.length === 0) {
    const absent = noMatchText(symbol, "workspace-symbol", undefined, opened.workspaceRoot);
    const uncovered = await tsUncoveredClause(search, mentionNameOf(symbol));
    const refusal = capped ? `${absent} ${capText()}` : absent;
    return { ok: false, error: uncovered === "" ? refusal : `${refusal}\n${uncovered}` };
  }
  const ordered = rows.sort((a, b) => byLocation(search, a, b));
  return answered(search, symbol, ordered, "workspace-symbol", capped, unverified);
}

function declarationText(row: TsDeclarationRow): string {
  const inside = row.external ? " outside the workspace" : ` in ${row.container}`;
  const unowned = row.ownedBy === null ? " (no owning project)" : "";
  const unverified = row.pathUnverified === undefined ? "" : ` - path unverified: ${row.pathUnverified}`;
  const unavailable = row.descriptionUnavailable ? ` - no description: ${row.descriptionUnavailable}` : "";
  const shortened = row.signatureTruncated
    ? ` - signature shortened by TypeScript; read ${row.file}:${row.line} for the full type`
    : "";
  return `  ${row.name} (${row.kind})${inside}${unowned} at ${row.file}:${row.line}${unverified}${unavailable}${shortened}`;
}

/** The same JSON, phrased once for a reader who will not parse it. */
function humanSummary(payload: TsFindSymbolPayload, symbol: string, anchorPath: string): HumanSummary {
  const { declarations, scope } = payload;
  const searched = searchedWhere(scope.lookup, anchorPath, scope.workspaceRoot);
  const capped = scope.limits.includes("listing-capped") ? `; ${capText()}` : "";
  const head =
    `Declarations named "${symbol}" (exact match) in ${searched}${tsScopeText(scope)} - ` +
    `${declarations.length} declaration(s)${capped}.`;
  const rows = declarations.map(declarationText).join("\n");
  return summarised(head, scope, `limits: ${scope.limits.join(", ")}\n${rows}`);
}

export async function runTsFindSymbol(
  sessions: LspSessionManager,
  input: TsFindSymbolInputType,
  deps: TsQueryDeps = {},
) {
  let resolution: ResolvedPath | undefined;
  try {
    const target = await resolveTsAnchor(TOOL, sessions, input, deps);
    if (!target.ok) return errorResult(target.error);
    resolution = target.value.resolution;
    const symbol = input.symbol.trim();
    const opened = await openWorkspace(target.value);
    const search =
      target.value.kind === "file"
        ? await fromOneFile(opened, symbol, deps)
        : await fromWholeWorkspace(opened, symbol, deps);
    if (!search.ok) return errorResult(search.error);
    const { summary, text } = humanSummary(search.value, symbol, target.value.file);
    return successResult(withSummary(summary, search.value), text);
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.anchor, resolution)}`);
  }
}

const TOOL_DESCRIPTION =
  "Find every declaration of a name in a TypeScript workspace, with its signature and doc comment from tsgo - " +
  "declarations only, and a signature TypeScript inferred is shown though no line writes it. Several " +
  "declarations are several rows, not an error (cpp_find_symbol refuses instead). A row's `container` is its " +
  "directory; a type alias has kind `class`, as tsgo spells it. `ownedBy: null` marks a row no project owns, " +
  "usually build output such as `dist/*.d.ts` that importers bind to. " +
  "Files no tsconfig includes are not searched: if `scope.uncoveredSources.mentioning` lists any, the answer " +
  "is incomplete until you grep them.";

export function registerTsFindSymbol(server: McpServer, sessions: LspSessionManager, deps: TsQueryDeps = {}) {
  server.registerTool(
    TOOL,
    {
      title: "Find where a TypeScript name is declared",
      description: TOOL_DESCRIPTION,
      inputSchema: TsFindSymbolInput.shape,
    },
    async (args) => runTsFindSymbol(sessions, args as TsFindSymbolInputType, deps),
  );
}
