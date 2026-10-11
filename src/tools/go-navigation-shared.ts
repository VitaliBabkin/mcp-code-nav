// The prelude the Go navigation tools share: the declaration addressing, readiness and freshness,
// the type-aware request sequence, and the `scope` block an answer reports. Reading the locations a request
// comes back in, and the fan-out that names a reported site, live in `lsp-locations.ts` and
// `location-naming.ts`, which the C++ navigation tools reach without going through a Go module.

import { extname } from "node:path";
import { symbolKindName, type LspDocumentSymbol } from "../clangd/outline.js";
import {
  defaultGoExec,
  type GoEnvironment,
  type GoExecFn,
  readToolchain,
  type GoToolchain,
} from "../gopls/go-env.js";
import { filenameExcluded, osArchExcluded, type OsArchExcluded } from "../gopls/os-arch-excluded.js";
import type { FreshnessOutcome, LspSession, ReadinessOutcome } from "../lsp/session.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { type Budget, withinBudget } from "./budget.js";
import { type DeclarationSource, describeRows } from "./declaration-description.js";
import { budgetText, type GoTargetOutcome, resolveGoTarget } from "./go-shared.js";
import type { Position } from "./lsp-locations.js";
import type { NavigationLimit, SymbolDescription } from "./navigation-limits.js";
import { candidateText, containerOf, type Step } from "./navigation-text.js";

// What the answer's graph was proved against, and a declaration's container, are not Go facts, so they live in
// the language-neutral `navigation-text.ts`; they are re-exported here because every Go tool reads its prelude
// from this module.
export { containerOf, freshnessText } from "./navigation-text.js";

export type ResolvedSymbol = {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
};

export interface Target {
  readonly symbol: LspDocumentSymbol;
  readonly resolved: ResolvedSymbol;
  readonly position: Position;
}

/**
 * The scope pair: exactly one of `environment` / `environmentUnavailable`, and only
 * beside `environment` exactly one of `osArchExcluded` / `osArchExcludedUnavailable`.
 */
export type GoEnvironmentScope =
  | ({ readonly environment: GoEnvironment } &
      ({ readonly osArchExcluded: OsArchExcluded } | { readonly osArchExcludedUnavailable: string }))
  | { readonly environmentUnavailable: string };

/** The part of `scope` every Go type-aware answer carries, whatever question it answers. */
export type GoScopeBase = { readonly moduleRoot: string; readonly freshness: FreshnessOutcome } & GoEnvironmentScope;

/** Go's export test read off the subject's own identifier (a method's is its method name); `exported` means
 *  code outside this module may denote it. */
export type GoVisibility = "exported" | "package-private";

/** The scope of a reference or caller answer: the Go base plus its visibility and limits. */
export type GoNavigationScope = GoScopeBase & {
  readonly visibility: GoVisibility;
  readonly limits: NavigationLimit[];
};

/** Which question is being answered, which decides the boundary codes that always apply. */
export type NavigationQuestion = "callers" | "references";

/**
 * What one type-aware request needs from the session: the server, the module it is rooted at, the call's
 * budget, and the one `go` pass the answer's `scope` will report. Stated apart from `GoQueryContext`
 * because a question addressed to a whole module resolves no file and picks no declaration.
 */
export interface GoRequest {
  readonly moduleRoot: string;
  readonly budget: Budget;
  readonly session: LspSession;
  readonly toolchain: Promise<GoToolchain>;
}

/** A Go call whose module is open and whose package graph has just been proved current. */
export interface GoOpened extends GoRequest {
  readonly freshness: FreshnessOutcome;
}

/** What a tool needs after addressing, freshness, readiness and the kind gate are through. */
export interface GoQueryContext extends GoOpened {
  readonly file: string;
  readonly symbols: readonly LspDocumentSymbol[];
  readonly picked: Target;
}

export type GoQuery<G> = GoQueryContext & { readonly gated: G };

const NO_PACKAGE_METADATA = /no package metadata for file\s+(.+?)(?:\r?\n|$)/;

/** `(m *Store).Get` and `Store.Get` are one declaration; a bare `Get` is another declaration entirely. */
export function declarationKey(name: string): string {
  const parts = methodParts(name);
  if (parts === undefined) return name;
  return `${parts.type}.${parts.method}`;
}

/**
 * The receiver type and the member name of a method spelling, or `undefined` for a name that is one
 * identifier. gopls spells a method two ways: the outline carries `(m *Store).Get`, its own symbol index
 * `Store.Get` — the receiver without parentheses — and both name one declaration, so both are read here
 * rather than in whichever caller happens to be looking. A package path (`example.com/m/storage`) is
 * neither: its segments carry dots, and a name with more than one dot is no method's spelling.
 */
export function methodParts(name: string): { readonly type: string; readonly method: string } | undefined {
  const receiver = /^\(([^)]*)\)\.(.*)$/.exec(name);
  if (receiver !== null) return { type: receiverType(receiver[1] ?? ""), method: receiver[2] ?? "" };
  const dotted = /^(.+)\.([^\s.]+)$/.exec(name);
  if (dotted === null) return undefined;
  return { type: receiverType(dotted[1] ?? ""), method: dotted[2] ?? "" };
}

/**
 * The receiver's own type name: an optional receiver variable and the pointer star are dropped, and the read
 * stops at a type-parameter list — `m *Cache[K, V]` names `Cache`, while whitespace-splitting alone lands on
 * the last token of the parameter list.
 */
function receiverType(receiver: string): string {
  const beforeParameters = receiver.split("[", 1)[0] ?? "";
  const token = beforeParameters.trim().split(/\s+/).pop() ?? "";
  return token.replace(/^\*/, "");
}

/**
 * The member name of a method spelling, and the name itself otherwise. This is the identifier gopls's
 * symbol index keys a method under, so it is what a whole-module search has to be asked with: the
 * punctuation of `(*Store).Get` matches nothing fuzzy, and the receiver beside `Store.Get` is a second
 * identifier the index does not start its name with. The exact-name filter puts the receiver back, which
 * is where both spellings land on one declaration key.
 */
export function methodMember(name: string): string {
  return methodParts(name)?.method ?? name;
}

/**
 * Whether the subject's own identifier is exported — Go's test exactly: its first character must be
 * Unicode category Lu. For a method that is the name after the receiver, in either spelling gopls uses
 * (`(m *Store).Get` in an outline, `Store.Get` in its symbol index), for anything else the name's own first
 * rune, and the receiver type is never consulted: importers reach an exported method of an
 * unexported type through values of that type, through an exported variable or field, by embedding, or
 * through an interface the method satisfies.
 */
export function goVisibility(name: string): GoVisibility {
  return /^\p{Lu}/u.test(methodParts(name)?.method ?? name) ? "exported" : "package-private";
}

function candidateLine(symbol: LspDocumentSymbol, file: string): string {
  return candidateText(symbol.name, symbolKindName(symbol.kind), file, symbol.range.start.line + 1);
}

/**
 * `symbol` is matched against TOP-LEVEL entries only, gopls reports methods at top
 * level under their receiver spelling, and children are not searched. Ambiguity is never resolved by picking.
 */
function pickTarget(tool: string, outline: readonly LspDocumentSymbol[], symbol: string, file: string): Step<Target> {
  const wanted = declarationKey(symbol);
  const matches = outline.filter((entry) => declarationKey(entry.name) === wanted);
  if (matches.length === 0) {
    return {
      ok: false,
      error:
        `${tool} failed: no top-level declaration named "${symbol}" in "${file}". Only a file's own top-level ` +
        "declarations are searched, and a method is named with its receiver - `(Concrete).Method` or " +
        '`Concrete.Method` - not by its bare name.',
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        `${tool} failed: "${symbol}" matches ${matches.length} top-level declarations in "${file}"; name one ` +
        `file or a more specific spelling:\n${matches.map((entry) => candidateLine(entry, file)).join("\n")}`,
    };
  }
  const only = matches[0];
  if (only === undefined) return { ok: false, error: `${tool} failed: "${symbol}" matched nothing in "${file}"` };
  const selection = only.selectionRange;
  if (selection === undefined) {
    return {
      ok: false,
      error:
        `${tool} failed: gopls reported no selection range for "${only.name}" in "${file}", so the position of ` +
        "its name is unknown and a type-aware query would be asked about a guessed location.",
    };
  }
  return {
    ok: true,
    value: {
      symbol: only,
      resolved: { name: only.name, kind: symbolKindName(only.kind), file, line: only.range.start.line + 1 },
      position: { line: selection.start.line, character: selection.start.character },
    },
  };
}

/** The initial-load progress `end` is the only proof, and without it no answer is returned. */
function readinessText(
  tool: string,
  budget: Budget,
  symbol: string,
  moduleRoot: string,
  outcome: ReadinessOutcome,
): string {
  if (outcome === "restarted") return restartedText(tool, symbol, moduleRoot);
  return (
    `${tool} failed: gopls never reported the initial workspace load of the module "${moduleRoot}" as ` +
    `finished within this call's ${budget.ceilingMs} ms budget, so a type-aware answer for "${symbol}" cannot ` +
    "be proven complete and is not being returned. Raise timeBudgetMs or call again: a session whose load has " +
    "finished answers without waiting."
  );
}

/** Neither a budget nor a fault of the module: the process that was asked was replaced mid-call. */
function restartedText(tool: string, symbol: string, moduleRoot: string): string {
  return (
    `${tool} failed: gopls restarted during the query about "${symbol}" in the module "${moduleRoot}", so the ` +
    "answer came from a process whose initial workspace load has not been proven. Call again: the restarted " +
    "server loads the module from scratch and proves it before answering."
  );
}

/**
 * The part of `scope` that states what the answer was computed under: the one `go` pass per module root
 * (started beside the gopls work, raced here by this call's remaining budget), and the filename blind spot
 * read off the file set the package graph was just proved against — those paths, rather than a second walk
 * of the same tree. `namedFile` is the file the call addressed; a question put to a whole module names no
 * file, so it gets `undefined` and `namedFileExcluded` says nothing it could support.
 */
export async function environmentScope(
  session: LspSession,
  budget: Budget,
  moduleRoot: string,
  namedFile: string | undefined,
  toolchain: Promise<GoToolchain>,
): Promise<GoEnvironmentScope> {
  const asked = await withinBudget(toolchain, budget);
  if (asked === undefined) {
    return {
      environmentUnavailable:
        "this server got no answer about the module's GOOS/GOARCH within this call's " +
        `${budget.ceilingMs} ms budget`,
    };
  }
  const { environment, ports } = asked;
  if ("unavailable" in environment) return { environmentUnavailable: environment.unavailable };
  const goFiles = session.moduleSnapshotPaths()?.filter((path) => extname(path) === ".go");
  if (goFiles === undefined) {
    return {
      environment,
      osArchExcludedUnavailable:
        `this session holds no module snapshot for "${moduleRoot}", so the module's .go file set — and ` +
        "with it which of those files their own filename excludes — is unknown",
    };
  }
  return { environment, osArchExcluded: osArchExcluded(goFiles, environment, ports, namedFile) };
}

/** The same scope, phrased for the reader who will not parse it. */
export function environmentText(scope: GoEnvironmentScope): string {
  if ("environmentUnavailable" in scope) {
    return `; ${scope.environmentUnavailable}, so the port this answer describes is unknown`;
  }
  const { environment } = scope;
  const work = environment.goWork === null ? "" : `, go.work "${environment.goWork}" not spanned`;
  const tags = environment.buildTags.length === 0 ? "" : `, build tags ${environment.buildTags.join(",")}`;
  const hidden =
    "osArchExcluded" in scope
      ? `, ${scope.osArchExcluded.count} filename-excluded .go file(s) absent from this answer`
      : `, ${scope.osArchExcludedUnavailable}`;
  return ` under ${environment.goos}/${environment.goarch}${work}${tags}${hidden}`;
}

/**
 * The boundary codes, in a fixed order. `one-module` and `one-port` hold on every
 * Go answer on purpose: a scope statement that lists only what varies states no scope. A func-value
 * assignment is itself a reference, so a use listing never carries `indirect-dispatch-not-resolved`.
 */
function goNavigationLimits(
  scope: GoEnvironmentScope,
  visibility: GoVisibility,
  flags: {
    readonly indirectDispatch: boolean;
    readonly correspondingMethods: boolean;
    readonly capped: boolean;
  },
): NavigationLimit[] {
  const limits: NavigationLimit[] = ["one-module"];
  if ("environment" in scope) limits.push("one-port");
  if ("osArchExcluded" in scope && scope.osArchExcluded.count > 0) limits.push("osarch-excluded-files");
  if (visibility === "exported") limits.push("exported-symbol-importers-invisible");
  if (flags.correspondingMethods) limits.push("corresponding-interface-methods-included");
  if (flags.indirectDispatch) limits.push("indirect-dispatch-not-resolved");
  if (flags.capped) limits.push("listing-capped");
  return limits;
}

/**
 * The whole `scope` block of a reference or caller answer: the environment pass, the subject's visibility,
 * the correspondence flag its kind decides, and the boundary codes in table order.
 */
export async function navigationScope(
  query: GoQueryContext,
  question: NavigationQuestion,
  capped: boolean,
): Promise<GoNavigationScope> {
  const { session, budget, moduleRoot, file, toolchain, freshness, picked } = query;
  const envScope = await environmentScope(session, budget, moduleRoot, file, toolchain);
  const visibility = goVisibility(picked.resolved.name);
  return {
    moduleRoot,
    freshness,
    visibility,
    ...envScope,
    limits: goNavigationLimits(envScope, visibility, {
      indirectDispatch: question === "callers",
      correspondingMethods: picked.resolved.kind === "method",
      capped,
    }),
  };
}

/** The file gopls refused, or `undefined` when this rejection is not that refusal. */
function noPackageMetadataFile(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const path = NO_PACKAGE_METADATA.exec(message)?.[1]?.trim();
  return path === undefined || path === "" ? undefined : path;
}

/**
 * gopls answers `no package metadata for file <path>` for a file it never loaded — commonly a build
 * constraint, and also a file under `testdata/`, under a `_`-prefixed directory, or in a nested module.
 * Whether the filename rule explains this file is stated from the same pass `scope` reports, because the
 * two wordings are different facts: `osArchExcluded` listing it means the graph is behaving as described,
 * and `osArchExcluded` not listing it means something the rule cannot see is at work.
 */
async function noPackageMetadataText(
  tool: string,
  refused: string,
  symbol: string,
  toolchain: Promise<GoToolchain>,
  budget: Budget,
): Promise<string> {
  const asked = await withinBudget(toolchain, budget);
  const namedByRule =
    asked === undefined || "unavailable" in asked.environment
      ? undefined
      : filenameExcluded(refused, asked.environment, asked.ports);
  const why =
    namedByRule === undefined
      ? "the toolchain could not be asked, so the filename rule could not be checked against this file either"
      : namedByRule
        ? "the file's own filename carries a GOOS/GOARCH suffix, so this is exactly the exclusion `scope.osArchExcluded` reports"
        : "the file's filename carries no GOOS/GOARCH suffix, so `scope.osArchExcluded` does not list it and something the filename rule cannot see excludes it";
  return (
    `${tool} failed: gopls has no package metadata for "${refused}", so the query about "${symbol}" cannot ` +
    "be answered - the file is not in the package graph loaded for this module. Commonly a build constraint " +
    "(a `//go:build` line) is why; gopls also answers this for a file under `testdata/`, under a directory " +
    `whose name starts with \`_\`, or in a nested module. Here ${why}.`
  );
}

/**
 * The prelude up to the point a tool holds a module whose graph it may ask about: derive nothing new here
 * — the caller resolved the path and its module — but start the one toolchain pass beside the gopls work
 * and prove the graph current. Nothing here waits for readiness: a name with no answer must
 * not pay for that, so each tool proves readiness as its last step before its own request. `onResolved`
 * hears the resolved path the moment it is known, so the caller's own catch can still name the spellings
 * it tried when a later step throws rather than failing.
 */
export async function openGoModule(
  target: GoTargetOutcome,
  onResolved: (resolution: ResolvedPath) => void,
  exec?: GoExecFn,
): Promise<Step<GoOpened>> {
  if (!target.ok) return target;
  const { moduleRoot, budget, session, resolution } = target.value;
  onResolved(resolution);
  // `readToolchain` attaches its own handlers, so nothing has to be listening while this runs.
  const toolchain = readToolchain(moduleRoot, exec ?? defaultGoExec);
  const freshness = await session.refreshModuleSnapshot();
  return { ok: true, value: { moduleRoot, budget, session, toolchain, freshness } };
}

/** One file's outline, bounded by the call's budget, or the reason the call did not get one. */
export async function readModuleOutline(
  tool: string,
  opened: GoOpened,
  file: string,
): Promise<Step<readonly LspDocumentSymbol[]>> {
  const outline = await withinBudget(opened.session.documentSymbol(file), opened.budget);
  if (outline === undefined) {
    return { ok: false, error: budgetText(tool, opened.budget, `answer the outline of "${file}"`, opened.moduleRoot) };
  }
  // gopls's outline is syntactic and never premature, so an empty one is an answer about the file.
  return { ok: true, value: outline.state === "ok" ? outline.symbols : [] };
}

/**
 * The initial-load progress `end` is the only proof, and without it no answer is returned. The
 * last shared step before a type-aware request, in the one place that phrases its two failures.
 */
export async function proveWorkspaceReady(tool: string, opened: GoOpened, symbol: string): Promise<Step<true>> {
  const readiness = await opened.session.awaitWorkspaceReady(opened.budget.remainingMs());
  if (readiness === "ready") return { ok: true, value: true };
  return { ok: false, error: readinessText(tool, opened.budget, symbol, opened.moduleRoot, readiness) };
}

/**
 * The prelude every type-aware tool that addresses one declaration in one file runs: the module prelude,
 * the file's outline, the addressing, the caller's own kind gate, then the readiness proof — in that
 * order, because a graph that is about to be corrected must not be proven ready first, and a name with no
 * answer here must not pay for readiness.
 */
export async function openGoQuery<G>(
  tool: string,
  sessions: LspSessionManager,
  input: { sourceRoots: string[]; file: string; symbol: string; timeBudgetMs: number },
  deps: { readonly exec?: GoExecFn },
  gate: (symbol: LspDocumentSymbol) => Step<G>,
  onResolved: (resolution: ResolvedPath) => void,
): Promise<Step<GoQuery<G>>> {
  const target = resolveGoTarget(tool, sessions, input);
  if (!target.ok) return target;
  const { file } = target.value;
  const opened = await openGoModule(target, onResolved, deps.exec);
  if (!opened.ok) return opened;
  const outline = await readModuleOutline(tool, opened.value, file);
  if (!outline.ok) return outline;
  const picked = pickTarget(tool, outline.value, input.symbol, file);
  if (!picked.ok) return picked;
  const gated = gate(picked.value.symbol);
  if (!gated.ok) return gated;
  const ready = await proveWorkspaceReady(tool, opened.value, input.symbol);
  if (!ready.ok) return ready;
  return { ok: true, value: { ...opened.value, file, symbols: outline.value, picked: picked.value, gated: gated.value } };
}

/**
 * The scope of a declaration answer: the Go base, which of the two lookups produced it, and the boundary
 * codes that answer states. No `visibility` — a reference or caller answer has one subject whose own name
 * decides reachability, while a declaration answer can carry several subjects, and a single field naming
 * their reachability would be one claim about rows it cannot make.
 */
export type GoDeclarationScope = GoScopeBase & {
  readonly lookup: GoSymbolLookup;
  readonly limits: NavigationLimit[];
};

/**
 * Which lookup produced a declaration answer. The set is closed at two and named for the request that
 * answered: `"document-symbol"` is a FILE anchor — that file's top-level declarations, one outline, no
 * search — and `"workspace-symbol"` is a DIRECTORY anchor — gopls's symbol index over the packages it has
 * loaded for this module. A third value is a contract change and needs its own addendum.
 */
export type GoSymbolLookup = "document-symbol" | "workspace-symbol";

/**
 * The boundary codes of a declaration listing, in a fixed order. `one-module`
 * and `one-port` hold on every Go answer on purpose: a scope statement that lists only what varies states
 * no scope. `one-file` bounds the inner edge a file answer leaves open — without it, a one-row answer read
 * as a module-wide search that found one declaration. No visibility code: this answer lists declarations,
 * not uses, and a declaration answer has no `scope.visibility` for the code to key on.
 */
function goDeclarationLimits(scope: GoEnvironmentScope, lookup: GoSymbolLookup, capped: boolean): NavigationLimit[] {
  const limits: NavigationLimit[] = ["one-module"];
  if (lookup === "document-symbol") limits.push("one-file");
  if ("environment" in scope) limits.push("one-port");
  if ("osArchExcluded" in scope && scope.osArchExcluded.count > 0) limits.push("osarch-excluded-files");
  if (capped) limits.push("listing-capped");
  return limits;
}

/**
 * The whole `scope` block of a declaration answer. `namedFile` is the file a file-addressed call read; a
 * module-wide search names none, so its `osArchExcluded` carries no `namedFileExcluded` claim.
 */
export async function declarationScope(
  opened: GoOpened,
  namedFile: string | undefined,
  lookup: GoSymbolLookup,
  capped: boolean,
): Promise<GoDeclarationScope> {
  const { session, budget, moduleRoot, toolchain, freshness } = opened;
  const envScope = await environmentScope(session, budget, moduleRoot, namedFile, toolchain);
  return { moduleRoot, freshness, lookup, ...envScope, limits: goDeclarationLimits(envScope, lookup, capped) };
}

export type { DeclarationSource };

/**
 * The descriptions of every row, each from its own hover. The process the load was proven on must still be
 * the one answering: rows described by a replacement are refused as a whole.
 */
export async function describeDeclarations(
  tool: string,
  opened: GoOpened,
  symbol: string,
  declarations: readonly DeclarationSource[],
): Promise<Step<SymbolDescription[]>> {
  const described = await describeRows(
    {
      session: opened.session,
      budget: opened.budget,
      server: "gopls",
      externalReason: "outside the module root; not read",
      stillProven: () => opened.session.isWorkspaceLoaded(),
    },
    declarations,
  );
  if (described === undefined) return { ok: false, error: restartedText(tool, symbol, opened.moduleRoot) };
  return { ok: true, value: described };
}

/** The position gopls named a declaration's own identifier at, or `null` when its answer carried none. */
function selectionStart(symbol: LspDocumentSymbol): Position | null {
  const start = symbol.selectionRange?.start;
  return start === undefined ? null : { line: start.line, character: start.character };
}

/**
 * The addressing rule with the ambiguity refusal removed: every TOP-LEVEL entry whose declaration
 * key is the caller's `symbol`, under the same receiver spelling `pickTarget` matches, but kept as several
 * rows rather than refused. The questions differ: "what declares this name" is answered by the complete
 * set, so listing it guesses nothing, while a type-aware query about one of them has to pick.
 */
export function matchDeclarations(
  symbol: string,
  outline: readonly LspDocumentSymbol[],
  file: string,
  moduleRoot: string,
): DeclarationSource[] {
  const wanted = declarationKey(symbol);
  const container = containerOf(file, moduleRoot);
  return outline
    .filter((entry) => declarationKey(entry.name) === wanted)
    .map((entry) => ({
      name: entry.name,
      kind: symbolKindName(entry.kind),
      file,
      line: entry.range.start.line + 1,
      container,
      position: selectionStart(entry),
      external: false,
    }));
}

/**
 * One type-aware request, bounded by the call's remaining budget, with the three answers only a session can
 * give: the budget ran out, gopls refused the file, or the process that proved its load was replaced while
 * the request was in flight — a reply from that process is not an answer, however complete it looks.
 */
export async function typeAwareRequest<T>(
  tool: string,
  query: GoRequest,
  symbol: string,
  method: string,
  params: unknown,
  what: string,
): Promise<Step<T>> {
  const { session, budget, moduleRoot, toolchain } = query;
  const answered = await withinBudget(
    session
      .request<T>(method, params)
      .then((value) => ({ value }))
      .catch((e: unknown) => {
        const refused = noPackageMetadataFile(e);
        if (refused === undefined) throw e;
        return { refusedFile: refused };
      }),
    budget,
  );
  if (answered === undefined) return { ok: false, error: budgetText(tool, budget, what, moduleRoot) };
  if ("refusedFile" in answered) {
    return { ok: false, error: await noPackageMetadataText(tool, answered.refusedFile, symbol, toolchain, budget) };
  }
  if (!session.isWorkspaceLoaded()) return { ok: false, error: restartedText(tool, symbol, moduleRoot) };
  return { ok: true, value: answered.value };
}
