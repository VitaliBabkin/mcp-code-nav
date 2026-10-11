import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolKindName } from "../clangd/outline.js";
import type { GoExecFn } from "../gopls/go-env.js";
import { LanguageServerUnavailableError } from "../lsp/server-config.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { errorResult, successResult } from "../mcp-response.js";
import { escapesRoot, pathKey } from "../paths/path-containment.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { withinBudget } from "./budget.js";
import { GoSourceRootsSchema, resolveGoAnchor, timeBudgetSchema } from "./go-shared.js";
import {
  containerOf,
  declarationKey,
  declarationScope,
  type DeclarationSource,
  describeDeclarations,
  environmentText,
  freshnessText,
  type GoDeclarationScope,
  type GoOpened,
  goVisibility,
  type GoSymbolLookup,
  type GoVisibility,
  matchDeclarations,
  methodMember,
  methodParts,
  openGoModule,
  proveWorkspaceReady,
  readModuleOutline,
  typeAwareRequest,
} from "./go-navigation-shared.js";
import {
  type AnswerShape,
  pathOfUri,
  rangeStart,
  recordOf,
  unexpectedAnswerText,
} from "./lsp-locations.js";
import type { Step } from "./navigation-text.js";
import type { SymbolDescription } from "./navigation-limits.js";
import { NameInput, PathInput } from "./input-limits.js";
import { resolutionNote } from "./shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "go_find_symbol";

/**
 * This server's watermark on gopls's symbol list — a bound this server owns, not a fact about gopls. An
 * answer is capped when the raw count of entries gopls returned, before the exact-name filter, reaches it:
 * the raw count is what matters, because the filter is exactly what a truncated list could have defeated.
 * It must sit AT OR BELOW gopls's own cap, so the code over-reports on a complete list rather than staying
 * silent on a truncated one; a watermark raised above the real cap would turn the signal off with no test
 * noticing. Pinned by the live probe: seven deliberately overflowing queries against the installed gopls
 * each returned exactly this many entries, which is the cap's signature. No published sentence says so.
 */
export const WORKSPACE_SYMBOL_CAP_WATERMARK = 100;

/** A declaration this tool reports: where the name is, what it is, and what the hover said it means. */
export type DeclarationRow = {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly container: string | null;
  readonly visibility: GoVisibility;
  readonly external: boolean;
} & SymbolDescription;

export type FindSymbolPayload = {
  readonly declarations: DeclarationRow[];
  readonly scope: GoDeclarationScope;
};

export const GoFindSymbolInput = z.object({
  sourceRoots: GoSourceRootsSchema,
  symbol: NameInput
    .describe(
      "Exact name: a method is `Concrete.Get` or `(*Concrete).Get`, and a bare `Get` means a package-level " +
        "`Get`, never a method. gopls's fuzzy near-matches are dropped.",
    ),
  anchor: PathInput
    .describe(
      "Where to search: absolute, or relative - it must exist under exactly one sourceRoots entry. A FILE " +
        "searches only its top-level declarations; a DIRECTORY searches the whole module through gopls's " +
        "index of loaded packages. The module is the path's nearest go.mod.",
    ),
  timeBudgetMs: timeBudgetSchema(60_000),
});

export type GoFindSymbolInputType = z.infer<typeof GoFindSymbolInput>;

export interface GoFindSymbolDeps {
  /**
   * Seam for the `go` subprocesses that state the port this answer was computed under; a test injects one
   * so the default suite never runs a Go toolchain (see CONTRIBUTING.md).
   */
  exec?: GoExecFn;
}

/** Which lookup answered, phrased for the two texts that have to name it. */
function searchedWhere(lookup: GoSymbolLookup, file: string | undefined, moduleRoot: string): string {
  return lookup === "document-symbol"
    ? `the top-level declarations of "${file}"`
    : `the whole module "${moduleRoot}" through gopls's symbol index`;
}

function noMatchText(symbol: string, lookup: GoSymbolLookup, file: string | undefined, moduleRoot: string): string {
  return (
    `${TOOL} failed: no declaration named "${symbol}" was found in ${searchedWhere(lookup, file, moduleRoot)}. ` +
    "The match is exact, not fuzzy: `(Concrete).Method` and `Concrete.Method` name a method, a bare name " +
    "names the package-level declaration of that word, and nothing outside this one module is searched. " +
    "A name gopls spells differently, or one declared in another module or the standard library, is not an " +
    "answer this call can give."
  );
}

/**
 * What the caller reads whenever the raw list reached the watermark — beside the rows on a successful
 * answer, and beside the not-found text when the filter found nothing. It claims no number: the watermark is
 * this server's, and stating one as gopls's cap is an unverified fact about another program that a version
 * bump falsifies silently.
 */
function capText(): string {
  return (
    "gopls's symbol search returns a bounded list and this one came back at the size this server treats as " +
    "that bound, so a declaration of this name may have been ranked out of it."
  );
}

const SYMBOL_ANSWER: AnswerShape = {
  noun: "module-wide symbol search",
  dropped: "a declaration",
  expects: "`SymbolInformation` entries, each with a `name`, a `kind` and a `location`",
};

function unreadableEntryText(received: unknown, symbol: string, part?: string): string {
  return unexpectedAnswerText("gopls", TOOL, received, symbol, part, SYMBOL_ANSWER);
}

/**
 * The word to hand gopls's fuzzy matcher: the identifier gopls indexes, which is the member name whenever
 * the caller's spelling carries a receiver. The receiver is then applied by the exact-name filter below,
 * which is what gopls's fuzzy matcher calls for: its results are filtered to exact name equality
 * — a search asked with the receiver punctuation in it would answer nothing at all.
 */
function symbolQuery(symbol: string): string {
  return methodMember(symbol);
}

/**
 * The name an entry is reported under, and its kind. gopls spells a method either inside its own `name`
 * (`(*Store).Get`) or as a bare member name with the receiver in `containerName`, so both spellings are
 * tried and whichever is exactly the name asked for wins; the receiver text is always gopls's own, never a
 * reconstruction from this server. The composition is attempted whenever a `containerName` is present
 * rather than only when the entry's kind reads `method`, because gopls reports a method's kind as
 * `function` and this server does not gate on a fact it knows to be unreliable — and
 * a row named by that composition is a method whatever the entry claimed. `undefined` is the near-match
 * gopls's fuzzy ranking offered and the exact-name filter refused.
 */
function exactName(
  name: string,
  kind: string,
  containerName: string | null,
  wanted: string,
): { name: string; kind: string } | undefined {
  if (declarationKey(name) === wanted) return { name, kind };
  if (containerName === null) return undefined;
  const composed = `(${containerName}).${name}`;
  return methodParts(composed) !== undefined && declarationKey(composed) === wanted
    ? { name: composed, kind: "method" }
    : undefined;
}

/**
 * One `workspace/symbol` entry. gopls answers that request with `SymbolInformation`, whose `location.range`
 * IS the declaration's identifier span — the outline's rule about a `type` keyword does not apply to it —
 * so the row's line and the position its hover is asked at both come from that range. A range that carries
 * a line but no character costs the row its description, never its place in the list; a range that is not
 * there at all is an entry this server cannot place, and is reported rather than answered with a row
 * without a location. `containerName` never reaches the row's `container`, which is this server's own
 * package path.
 */
function symbolEntry(
  raw: unknown,
  moduleRoot: string,
  symbol: string,
  part: string,
): Step<DeclarationSource | undefined> {
  const entry = recordOf(raw);
  const location = recordOf(entry.location);
  const file = pathOfUri(location.uri) ?? pathOfUri(location.targetUri);
  const named = rangeStart(location.range) ?? rangeStart(location.targetSelectionRange) ?? rangeStart(location.targetRange);
  const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : undefined;
  if (name === undefined || file === undefined || named === undefined) {
    return { ok: false, error: unreadableEntryText(raw, symbol, part) };
  }
  const kind = typeof entry.kind === "number" ? symbolKindName(entry.kind) : "?";
  const containerName = typeof entry.containerName === "string" && entry.containerName !== "" ? entry.containerName : null;
  const matched = exactName(name, kind, containerName, declarationKey(symbol));
  if (matched === undefined) return { ok: true, value: undefined };
  const external = escapesRoot(moduleRoot, file);
  return {
    ok: true,
    value: {
      name: matched.name,
      kind: matched.kind,
      file,
      line: named.line + 1,
      container: external ? null : containerOf(file, moduleRoot),
      position: named.character === undefined ? null : { line: named.line, character: named.character },
      external,
    },
  };
}

/**
 * External rows sort after every in-module row by the comparator's own first key: `Array#sort` is total, so
 * partitioning first and sorting after would interleave them by path again.
 */
function byLocation(a: DeclarationSource, b: DeclarationSource): number {
  return (
    Number(a.external) - Number(b.external) ||
    pathKey(a.file).localeCompare(pathKey(b.file)) ||
    a.line - b.line ||
    a.name.localeCompare(b.name)
  );
}

function moduleDeclarations(
  result: unknown,
  moduleRoot: string,
  symbol: string,
): Step<{ declarations: DeclarationSource[]; capped: boolean }> {
  if (result !== null && result !== undefined && !Array.isArray(result)) {
    return { ok: false, error: unreadableEntryText(result, symbol) };
  }
  const entries = Array.isArray(result) ? result : [];
  const rows: DeclarationSource[] = [];
  for (const [index, raw] of entries.entries()) {
    const read = symbolEntry(raw, moduleRoot, symbol, `entry ${index + 1}`);
    if (!read.ok) return read;
    if (read.value !== undefined) rows.push(read.value);
  }
  return {
    ok: true,
    value: {
      declarations: rows.sort(byLocation),
      capped: entries.length >= WORKSPACE_SYMBOL_CAP_WATERMARK,
    },
  };
}

/**
 * A row's `visibility` is Go's own export test on that row's name — an outline row is already spelled with
 * its receiver, and a composed `workspace/symbol` row is spelled so by `exactName` — which is why one
 * derivation covers both lookups with no special case for either.
 */
function toRow(declaration: DeclarationSource, description: SymbolDescription): DeclarationRow {
  const { name, kind, file, line, container, external } = declaration;
  return { name, kind, file, line, container, visibility: goVisibility(name), external, ...description };
}

/**
 * The answer once the declarations are known: each one's signature and documentation from its own hover,
 * then the `scope` block stating what the search covered.
 */
async function answered(
  opened: GoOpened,
  symbol: string,
  declarations: readonly DeclarationSource[],
  lookup: GoSymbolLookup,
  namedFile: string | undefined,
  capped: boolean,
): Promise<Step<FindSymbolPayload>> {
  const described = await describeDeclarations(TOOL, opened, symbol, declarations);
  if (!described.ok) return described;
  const scope = await declarationScope(opened, namedFile, lookup, capped);
  return {
    ok: true,
    value: {
      declarations: declarations.map((declaration, index) =>
        toRow(declaration, described.value[index] ?? { descriptionUnavailable: "this server read no hover answer for this row" }),
      ),
      scope,
    },
  };
}

/** A file anchor: the path — one `documentSymbol`, every top-level entry of that name, no search. */
async function fromOneFile(
  opened: GoOpened,
  symbol: string,
  file: string,
  moduleRoot: string,
): Promise<Step<FindSymbolPayload>> {
  const outline = await readModuleOutline(TOOL, opened, file);
  if (!outline.ok) return outline;
  const matched = matchDeclarations(symbol, outline.value, file, moduleRoot);
  if (matched.length === 0) {
    return { ok: false, error: noMatchText(symbol, "document-symbol", file, moduleRoot) };
  }
  const ready = await proveWorkspaceReady(TOOL, opened, symbol);
  if (!ready.ok) return ready;
  return answered(opened, symbol, matched, "document-symbol", file, false);
}

/** The module root's own build file: the document a module cannot lack, and the one a module-wide question
 *  can name without being told any file. */
const GO_MOD = "go.mod";

/**
 * A module-wide question has no file to outline, so nothing before the readiness proof would reach the
 * child — and a wait cannot report a server that never started: it has no process to time out against, so
 * the caller would spend its whole budget being told a load did not finish. The module's own `go.mod` is
 * therefore read transiently to start the child — opened, asked, closed, leaving no document behind and no
 * claim in the payload resting on the answer. A server that says nothing about its build file has still
 * answered; only a child that cannot be started is the caller's failure, and it then reads as the same
 * unavailability a file anchor reports.
 */
async function startTheChild(opened: GoOpened): Promise<void> {
  try {
    await withinBudget(opened.session.documentSymbolTransient(join(opened.moduleRoot, GO_MOD)), opened.budget);
  } catch (e) {
    if (e instanceof LanguageServerUnavailableError) throw e;
  }
}

/** A directory anchor: gopls's index of the loaded module, narrowed to exact names by this server. */
async function fromWholeModule(
  opened: GoOpened,
  symbol: string,
  moduleRoot: string,
): Promise<Step<FindSymbolPayload>> {
  await startTheChild(opened);
  const ready = await proveWorkspaceReady(TOOL, opened, symbol);
  if (!ready.ok) return ready;
  const searched = await typeAwareRequest(
    TOOL,
    opened,
    symbol,
    "workspace/symbol",
    { query: symbolQuery(symbol) },
    `search the module for "${symbol}"`,
  );
  if (!searched.ok) return searched;
  const found = moduleDeclarations(searched.value, moduleRoot, symbol);
  if (!found.ok) return found;
  const { declarations, capped } = found.value;
  if (declarations.length === 0) {
    const absent = noMatchText(symbol, "workspace-symbol", undefined, moduleRoot);
    return { ok: false, error: capped ? `${absent} ${capText()}` : absent };
  }
  return answered(opened, symbol, declarations, "workspace-symbol", undefined, capped);
}

function declarationText(row: DeclarationRow): string {
  const inside = row.external ? " outside the module" : ` in package ${row.container}`;
  const unavailable = row.descriptionUnavailable ? ` - no description: ${row.descriptionUnavailable}` : "";
  return `  ${row.name} (${row.kind}, ${row.visibility})${inside} at ${row.file}:${row.line}${unavailable}`;
}

/** The same JSON, phrased once for a reader who will not parse it. */
function humanSummary(payload: FindSymbolPayload, symbol: string, anchorPath: string): string {
  const { declarations, scope } = payload;
  const searched = searchedWhere(scope.lookup, scope.lookup === "document-symbol" ? anchorPath : undefined, scope.moduleRoot);
  const capped = scope.limits.includes("listing-capped") ? `; ${capText()}` : "";
  const head =
    `Declarations named "${symbol}" (exact match) in ${searched}${environmentText(scope)} - ` +
    `${declarations.length} declaration(s), freshness: ${freshnessText(scope.freshness)}${capped}.`;
  const rows = declarations.map(declarationText).join("\n");
  return `${head}\nlimits: ${scope.limits.join(", ")}\n${rows}`;
}

export async function runGoFindSymbol(
  sessions: LspSessionManager,
  input: GoFindSymbolInputType,
  deps: GoFindSymbolDeps = {},
) {
  let resolution: ResolvedPath | undefined;
  try {
    const anchor = resolveGoAnchor(TOOL, sessions, input);
    if (!anchor.ok) return errorResult(anchor.error);
    const { file: anchorPath, kind, moduleRoot } = anchor.value;
    const opened = await openGoModule(
      anchor,
      (resolved) => {
        resolution = resolved;
      },
      deps.exec,
    );
    if (!opened.ok) return errorResult(opened.error);
    const search =
      kind === "file"
        ? await fromOneFile(opened.value, input.symbol, anchorPath, moduleRoot)
        : await fromWholeModule(opened.value, input.symbol, moduleRoot);
    if (!search.ok) return errorResult(search.error);
    return successResult(search.value, humanSummary(search.value, input.symbol, anchorPath));
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.anchor, resolution)}`);
  }
}

const TOOL_DESCRIPTION =
  "Find every declaration of a name in a Go module, with each one's signature and doc comment - unlike " +
  "grep, it returns declarations only, not uses, comments or standard-library text. Several declarations " +
  "are several rows, not an error (C++ cpp_find_symbol refuses instead). A row's `visibility` is Go's export " +
  "test on its own name (a method's is its method name): `exported` means code outside the module may use " +
  "it; go_find_references says who does.";

export function registerGoFindSymbol(
  server: McpServer,
  sessions: LspSessionManager,
  deps: GoFindSymbolDeps = {},
) {
  server.registerTool(
    TOOL,
    {
      title: "Find where a Go name is declared",
      description: TOOL_DESCRIPTION,
      inputSchema: GoFindSymbolInput.shape,
    },
    async (args) => runGoFindSymbol(sessions, args as GoFindSymbolInputType, deps),
  );
}
