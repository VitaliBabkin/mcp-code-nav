// The prelude the TypeScript navigation tools share: the addressing of one declaration in one file,
// the project map that says which tsconfig projects an answer must cover, the documents-opened readiness
// proof, and the `scope` block an answer reports. Reading the locations a request comes back in, and the
// fan-out that names a reported site, live in `lsp-locations.ts` and `location-naming.ts`, which every
// backend reaches without going through a TypeScript workspace.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LspDocumentSymbol } from "../clangd/outline.js";
import type { FreshnessOutcome, LspSession, ReadinessOutcome } from "../lsp/session.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { escapesRoot, pathKey } from "../paths/path-containment.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { byNormalisedKey, rankPaths, ranksFile } from "../paths/ranked-paths.js";
import { defaultTsExec, type TsgoBinary, type TsExecFn } from "../tsgo/binary.js";
import {
  cachedProjectMap,
  dropProjectMap,
  projectMapNeedsRebuild,
  type ProjectFailure,
  type TsProject,
} from "../tsgo/project-map.js";
import { scanMentions, type MentionScanner } from "../tsgo/uncovered-mentions.js";
import { workspaceWalkedPaths } from "../tsgo/workspace-snapshot.js";
import { type Budget, withinBudget } from "./budget.js";
import type { BoundaryTest, ReportedLocation } from "./lsp-locations.js";
import type { RowSpeller } from "./location-naming.js";
import type { NavigationLimit } from "./navigation-limits.js";
import { candidateText, containerOf, freshnessText, type Step, withArticle } from "./navigation-text.js";
import {
  addressTsSymbol,
  spellTsRow,
  type TsAddressOutcome,
  type TsCandidate,
  type TsSubject,
} from "./ts-addressing.js";
import { resolveTsTarget, type HumanSummary, type TsTarget, type TsTargetDeps } from "./ts-shared.js";
import { messageOf } from "../error-message.js";

/** How many configs, and how many uncovered sources, one `scope` block may name; the counts beside them stay exact. */
const TS_SCOPE_LIST_LIMIT = 20;

/** Whether `projects` names every project it counts, which is all a derived number in the sentence may use. */
function projectsNamed(projects: TsProjectsBlock): boolean {
  return projects.configs.length + projects.failed.length + projects.subsumed.length === projects.count;
}

/** A list that reaches the cap is twenty named, not twenty total; the `+` says which the reader is seeing. */
function cappedAt(items: readonly unknown[]): boolean {
  return items.length === TS_SCOPE_LIST_LIMIT;
}

/** A path under any `node_modules` directory is a dependency, never a workspace member. */
const IN_NODE_MODULES = /[\\/]node_modules[\\/]/i;

/** A row outside the workspace the answer is rooted at is reported and never read. */
export const OUTSIDE_WORKSPACE_REASON = "outside the workspace root; not named";

/** One declaration the answer is about, in the shape every TS listing publishes beside its rows. */
export type TsResolvedSymbol = {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  /**
   * Present only on a `ts_find_references` answer for a renamed import (`import { Store as S }`): tsgo scopes
   * that binding's references to the local name, and this says which declaration the name stands for
   *. `symbol` is null when that declaration cannot be spelled.
   */
  readonly renamedImportOf?: {
    readonly symbol: string | null;
    readonly file: string;
    readonly line: number;
    /** The binding names a whole module (`import * as ns`), so there is no declaration to point at. */
    readonly module: boolean;
    /** The binding sits in an export clause (`export { a as b } from`). */
    readonly reExport: boolean;
  };
};

/** What the map proved about one workspace's projects, capped the way `scope` caps them. */
export interface TsProjectsBlock {
  readonly count: number;
  readonly configs: readonly string[];
  readonly failed: readonly ProjectFailure[];
  /**
   * Configs that list members and own none, every member owned by a project that IS anchored: not loaded, needing no anchor, and stating no limit code — every file they
   * read sits in a program that is loaded.
   */
  readonly subsumed: readonly string[];
}

/** One uncovered directory of the set, counted exactly, in the spelling `ts_find_symbol`'s `container` uses. */
export interface TsUncoveredDirectory {
  readonly directory: string;
  readonly count: number;
}

/** One uncovered file that holds the subject's name in its text. `matchingLines` is a count, never a line number. */
export interface TsUncoveredMention {
  readonly file: string;
  readonly matchingLines: number;
}

/**
 * A pointer for a text search over files no project includes; never a row, never counted as a use
 *. `count` is exact and `files` is what a caller may read;
 * `filesTruncated` is how many matching files the cap left out.
 */
export interface TsUncoveredMentions {
  readonly name: string;
  readonly count: number;
  readonly files: readonly TsUncoveredMention[];
  readonly filesTruncated: number;
  readonly unchecked: number;
}

/**
 * The sources of the workspace that no project lists. `directories` partitions the set, largest first, and
 * `mentioning` names the files whose text holds the subject.
 */
export interface TsUncoveredBlock {
  readonly count: number;
  /**
   * Some file of the set needs a grep: one holds the name, or one could not be checked. It is the verdict the
   * summary's `INCOMPLETE:` line states. `false` claims only that no
   * uncovered file needs a grep, never that the answer is complete.
   */
  readonly grepRequired: boolean;
  readonly directories: readonly TsUncoveredDirectory[];
  readonly directoriesTruncated: number;
  readonly mentioning: TsUncoveredMentions;
  readonly namedFileUncovered: boolean;
}

/** Exactly one of these two blocks is on every TS answer: what loaded, or why that is not known. */
export type TsScopeProjects = { readonly projects: TsProjectsBlock } | { readonly projectsUnavailable: string };

/** Exactly one of these two: the sources no project includes, or why the set cannot be proved. */
export type TsScopeUncovered =
  | { readonly uncoveredSources: TsUncoveredBlock }
  | { readonly uncoveredSourcesUnavailable: string };

/**
 * Everything a TS type-aware answer states about the ground it was computed on, before the boundary codes
 *. No `visibility`: TypeScript's export test needs a syntactic read this server does
 * not make, and `one-workspace` already says that code outside the root is unseen.
 */
export type TsWorkspaceScope = {
  readonly workspaceRoot: string;
  readonly enclosingWorkspace: string | null;
  readonly freshness: FreshnessOutcome;
  readonly server: { readonly version: string | null };
  readonly workspaceTypescript: string | null;
} & TsScopeProjects &
  TsScopeUncovered;

/** The whole `scope` block of a reference, caller or implementation answer: the workspace scope and its codes. */
export type TsNavigationScope = TsWorkspaceScope & { readonly limits: NavigationLimit[] };

/** What answered, which is the pair the differing-major code is read from. */
interface TsAnsweredScope {
  readonly server: { readonly version: string | null };
  readonly workspaceTypescript: string | null;
}

/** A TS call whose workspace is open and whose disk has just been proved current. */
export interface TsWorkspaceOpen {
  readonly session: LspSession;
  readonly budget: Budget;
  readonly binary: TsgoBinary;
  readonly workspaceRoot: string;
  readonly enclosingWorkspace: string | null;
  readonly freshness: FreshnessOutcome;
  /**
   * The scan of the uncovered sources, replaceable by the one live case that prices it
   *. Every real call reads the default.
   */
  readonly mentionScan?: MentionScanner;
}

/** The same, for a call addressed by one file. */
export interface TsOpened extends TsWorkspaceOpen {
  readonly file: string;
}

/**
 * What the `scope` block reads off a call: the open workspace, what the map left, and the file the call named.
 * A call addressed by a directory names none, so no source can be "the named file" of it.
 */
export interface TsScopeSource extends TsWorkspaceOpen, TsMapFacts {
  readonly file?: string | undefined;
}

/** What a type-aware request needs to answer for the process that was proved. */
export type TsRequestQuery = Pick<TsQuery, "session" | "budget" | "workspaceRoot" | "anchorsProvenOn">;

/** What the project map left this call with: what to anchor, what refused to list, and what nothing lists. */
export interface TsMapFacts {
  readonly projects: readonly TsProject[];
  readonly failed: readonly ProjectFailure[];
  readonly subsumed: readonly string[];
  /** `undefined` when no map could be proved, which is the state `uncoveredSourcesUnavailable` reports. */
  readonly uncovered: readonly string[] | undefined;
  readonly projectsUnavailable: string | undefined;
  readonly anchors: readonly string[];
  /** `pathKey` of a file to the config that owns it; `undefined` when no map could be proved. */
  readonly owners?: ReadonlyMap<string, string> | undefined;
}

/** What a tool needs once addressing, the map, the anchors and the readiness proof have all held. */
export interface TsQuery extends TsOpened, TsMapFacts {
  readonly symbols: readonly LspDocumentSymbol[];
  readonly subject: TsSubject;
  readonly resolved: TsResolvedSymbol;
  /**
   * The process the anchors were opened on. The proof is that THEY were opened on the process that
   * answers, and `isWorkspaceLoaded` alone cannot say that: the mark is set by any caller's `openAnchors` on
   * whichever process is live, so a request retried on a replacement plus another call's proof on
   * that replacement would answer here for a process this call never anchored.
   */
  readonly anchorsProvenOn: number;
}

/**
 * The codes a subject and a listing decide, rather than facts about the workspace. The optional flags belong
 * to one tool each, so a call that passes none stays as it reads.
 */
export interface TsScopeFlags {
  readonly capped: boolean;
  readonly correspondingMethods: boolean;
  readonly structuralImplementers?: boolean;
  readonly indirectDispatch?: boolean;
  readonly uncalledMentions?: boolean;
  readonly oneFile?: boolean;
}

export interface TsQueryDeps extends TsTargetDeps {
  /**
   * Seam for the `tsc --listFilesOnly` subprocesses the project map is built from; a test injects one so the
   * default suite never starts a compiler per project (see CONTRIBUTING.md).
   */
  exec?: TsExecFn;
}

/**
 * The name the uncovered text is scanned for: the subject's key with its selector prefix off and its
 * dotted path cut to the last segment — what a reader would grep, not what this server addressed (`Driver.run`
 * and `static C.run` are both grepped as `run`).
 */
export function mentionNameOf(symbol: string): string {
  const key = symbol.trim().replace(/^(?:static|instance|value|type|namespace)\s+/, "");
  return key.slice(key.lastIndexOf(".") + 1);
}

/**
 * The boundary, as the test a reported location is judged by: outside the workspace the answer is
 * rooted at, or under any `node_modules` directory. Both are dependency or foreign ground, so only
 * non-external files are ever opened, outlined or hovered.
 */
export function tsFileExternal(workspaceRoot: string): BoundaryTest {
  return (file) => escapesRoot(workspaceRoot, file) || IN_NODE_MODULES.test(file);
}

/** One file's text, or the reason this server could not read it. */
type FileText = { readonly lines: readonly string[] } | { readonly failure: string };

function readLines(file: string): FileText {
  try {
    return { lines: readFileSync(file, "utf-8").split(/\r?\n/) };
  } catch (e) {
    return { failure: `its file could not be read: ${messageOf(e)}` };
  }
}

/**
 * The TypeScript row name: the deepest enclosing entry spelled the way `symbol` accepts it, which needs the
 * text beside the declaration as well as the outline — a prefix is only written when the key is shared in
 * that file, and only the declaration's own modifiers say whether it is. Each file's text is read once and
 * keyed by `pathKey`, because one file is reported many times and has two spellings on Windows. Every TS
 * listing shares this speller, so a reference `in`, a caller's `name` and an implementation's `name` are one
 * rule, read back as one `symbol`.
 *
 * `noDeclarationReason` replaces the reason a location outside every declaration carries. Only a caller listing
 * has such a row that is not a naming failure: TypeScript credits a site with no enclosing callable to the
 * SOURCE FILE, and that is what the callers tool passes.
 */
export function tsRowSpeller(noDeclarationReason?: string): RowSpeller {
  const texts = new Map<string, FileText>();
  return (file, symbols, position) => {
    const key = pathKey(file);
    const held = texts.get(key);
    const text = held ?? readLines(file);
    if (held === undefined) texts.set(key, text);
    return "failure" in text
      ? { name: null, kind: null, reason: text.failure }
      : spellTsRow(symbols, position, text.lines, noDeclarationReason);
  };
}

/** What a call states when the walk could not prove the disk its projects would be read off. */
function noSnapshotReason(workspaceRoot: string): string {
  return `no workspace snapshot could be proved for "${workspaceRoot}", so which tsconfig projects exist is not known`;
}

function withoutMap(reason: string): TsMapFacts {
  return {
    projects: [],
    failed: [],
    subsumed: [],
    uncovered: undefined,
    projectsUnavailable: reason,
    anchors: [],
  };
}

export function tsBudgetText(tool: string, budget: Budget, what: string, workspaceRoot: string): string {
  return (
    `${tool} failed: tsgo did not ${what} within this call's ${budget.ceilingMs} ms budget. The workspace at ` +
    `"${workspaceRoot}" may still be loading its projects; raise timeBudgetMs or call again, and do not read ` +
    "this as an empty answer."
  );
}

/** A map build is a queue of compiler runs, and abandoning one mid-queue would throw the work away twice. */
export function listingBudgetText(tool: string, budget: Budget, workspaceRoot: string): string {
  return (
    `${tool} failed: this call's ${budget.ceilingMs} ms budget ran out while the workspace ` +
    `"${workspaceRoot}" was being listed project by project. Those listings keep running, so the next call ` +
    "waits on the same map rather than starting a second pass; raise timeBudgetMs or call again."
  );
}

/**
 * The proof is that every project anchor and the named file were opened on the process that
 * answers; without it a type-aware answer cannot be called complete, because tsgo answers a project it has
 * never been shown with a silent partial. `restarted` is a different fact — the process was replaced — and
 * gets its own text rather than a blamed budget.
 */
export function tsReadinessText(
  tool: string,
  budget: Budget,
  symbol: string,
  workspaceRoot: string,
  outcome: ReadinessOutcome,
): string {
  if (outcome === "restarted") return tsRestartedText(tool, symbol, workspaceRoot);
  return (
    `${tool} failed: this server could not prove within its ${budget.ceilingMs} ms budget that the documents ` +
    `this answer depends on — every project anchor and "${symbol}"'s own file — were opened on the process ` +
    `answering for the workspace "${workspaceRoot}", so a type-aware answer is not being returned. Raise ` +
    "timeBudgetMs or call again: a session whose anchors are open answers without waiting."
  );
}

/** Neither a budget nor a fault of the workspace: the process that was asked was replaced mid-call. */
export function tsRestartedText(tool: string, symbol: string, workspaceRoot: string): string {
  return (
    `${tool} failed: tsgo restarted during the query about "${symbol}" in the workspace "${workspaceRoot}", ` +
    "so the documents the answer depends on were opened on a process that is not the one that answered. " +
    "Call again: the restarted server opens its anchors and proves them before answering."
  );
}

/** Why the file a symbol is addressed in could not be addressed at all. */
export function unreadableSourceText(tool: string, file: string, symbol: string, message: string): string {
  return (
    `${tool} failed: "${file}" could not be read (${message}). A TS \`symbol\` is addressed against the ` +
    `file's own text as well as its outline, because a static member and a type beside a value are told ` +
    `apart by the declaration's own modifiers, so "${symbol}" cannot be located without it.`
  );
}

/** The addressing rule, stated in the refusal that a caller has to act on. */
function notFoundText(tool: string, symbol: string, file: string): string {
  return (
    `${tool} failed: "${file}" declares nothing named "${symbol}". \`symbol\` is a top-level name in the ` +
    'file, or a dotted path descending through a class, interface, enum or namespace (`ExecDriver.run`, ' +
    "`Ns.Inner.x`); an import binding matches like a variable and the checker follows the alias. A local, " +
    "or an object literal's member, is not addressable."
  );
}

/** The spelling that selects one of two symbols sharing a key; `undefined` when no documented prefix does. */
function selectorSpelling(symbol: string, candidate: TsCandidate): string {
  return candidate.selector === undefined ? symbol : `${candidate.selector} ${symbol}`;
}

function sharedKeyText(tool: string, symbol: string, file: string, candidates: readonly TsCandidate[]): string {
  const lines = candidates.map(
    (candidate) =>
      candidateText(selectorSpelling(symbol, candidate), candidate.kind, file, candidate.line) +
      (candidate.selector === undefined ? " - no documented prefix separates these" : ""),
  );
  return (
    `${tool} failed: "${symbol}" names ${candidates.length} declarations in "${file}" that TypeScript does ` +
    "not merge into one, so this server will not pick between them. Select one with a prefix - `static`, " +
    "`instance`, `value`, `type` or `namespace`:\n" +
    lines.join("\n")
  );
}

/** The refusal for a dotted namespace entry whose own span does not hold the run it claims; shared with `ts_find_symbol`. */
export function unreadableSpanText(tool: string, file: string, entry: LspDocumentSymbol): string {
  return (
    `${tool} failed: tsgo reported the declaration "${entry.name}" in "${file}" as one dotted namespace entry, but ` +
    "the text inside its own selection range is not that run of names, so the position of the name asked for is " +
    "unknown and a type-aware query would be asked about a guessed location."
  );
}

export function notAddressableText(tool: string, symbol: string, file: string, through: string, kindName: string): string {
  const why = kindName === "nothing" ? "no entry in this file carries that path" : `it is ${withArticle(kindName)}`;
  return (
    `${tool} failed: "${symbol}" cannot be addressed in "${file}": "${through}" is not a class, interface, ` +
    `enum or namespace (${why}), and only those four hold addressable members. Locals and object-literal ` +
    "members are not addressable."
  );
}

function subjectOf(tool: string, symbol: string, file: string, outcome: TsAddressOutcome): Step<TsSubject> {
  if (outcome.kind === "addressed") return { ok: true, value: outcome.subject };
  if (outcome.kind === "not-found") return { ok: false, error: notFoundText(tool, symbol, file) };
  if (outcome.kind === "shared-key") {
    return { ok: false, error: sharedKeyText(tool, outcome.symbol, file, outcome.candidates) };
  }
  if (outcome.kind === "unreadable-span") return { ok: false, error: unreadableSpanText(tool, file, outcome.entry) };
  return { ok: false, error: notAddressableText(tool, symbol, file, outcome.through, outcome.kindName) };
}

/**
 * The subject spelled the way `symbol` accepts it, so an answer names what it was asked about in the same
 * vocabulary a caller would address it with again — prefix and all, where a prefix is what separates it.
 * Exported because a tool that re-aims the question at another entry of the same symbol (implementations)
 * still publishes `resolved` in this shape.
 */
export function tsResolvedOf(subject: TsSubject): TsResolvedSymbol {
  return { name: subject.spelling, kind: subject.kind, file: subject.file, line: subject.line };
}

/**
 * The named file's outline and the subject inside it. The file's text is read here rather than trusted to
 * the outline alone: static-ness and the value-or-type meaning of a name are decided by the modifiers
 * beside its declaration, which only the text carries.
 */
async function addressSubject(
  tool: string,
  symbol: string,
  opened: TsOpened,
  outline: readonly LspDocumentSymbol[],
  askable?: (entry: LspDocumentSymbol) => boolean,
): Promise<Step<TsSubject>> {
  let text: string;
  try {
    text = readFileSync(opened.file, "utf-8");
  } catch (e) {
    return { ok: false, error: unreadableSourceText(tool, opened.file, symbol, messageOf(e)) };
  }
  const outcome = addressTsSymbol(symbol, outline, { file: opened.file, lines: text.split(/\r?\n/) }, askable);
  return subjectOf(tool, symbol, opened.file, outcome);
}

/**
 * Which projects exist, which files each reads, and which sources nothing includes — from the compiler's
 * own answer, never a re-implemented glob. An unavailable map is reported, not failed: the call then opens
 * only the named file and says which projects it could not load.
 */
async function loadProjectMap(
  tool: string,
  opened: TsWorkspaceOpen,
  exec: TsExecFn | undefined,
): Promise<Step<TsMapFacts>> {
  // The other half: an unprovable closure hands out no snapshot, so every call reloads — and the map
  // is still built from the paths the walk DID see. That is what the answer needs
  // to carry: a config this server cannot read is a `failed` PROJECT, and `{kind: "mapped"}` stays
  // correct for the map itself. Only a walk that never finished has nothing to build from, and that is the
  // no-map case. Because every call in this state reloads the session, and a map is bound to
  // the process it was proved against, the map is rebuilt on every call here: one `--listFilesOnly`
  // per project per call, on top of the reload, already priced at "slow, never stale".
  const paths = opened.session.moduleSnapshotPaths() ?? workspaceWalkedPaths(opened.workspaceRoot);
  if (paths === undefined) return { ok: true, value: withoutMap(noSnapshotReason(opened.workspaceRoot)) };
  const built = await withinBudget(
    cachedProjectMap(opened.workspaceRoot, paths, opened.binary, opened.session.generation(), exec ?? defaultTsExec),
    opened.budget,
  );
  if (built === undefined) return { ok: false, error: listingBudgetText(tool, opened.budget, opened.workspaceRoot) };
  if (built.kind === "unavailable") return { ok: true, value: withoutMap(built.reason) };
  const anchors = built.projects.flatMap((project) => (project.anchor === null ? [] : [project.anchor]));
  return {
    ok: true,
    value: {
      projects: built.projects,
      failed: built.failed,
      subsumed: built.subsumed,
      uncovered: built.uncovered,
      owners: built.owners,
      projectsUnavailable: undefined,
      anchors,
    },
  };
}

/**
 * Which projects exist is a fact about the disk and about the process that read it: a reload leaves no session
 * for a map to belong to, a replacement takes a fresh baseline at spawn so a change in the gap never appears
 * as a diff, and a push that created or deleted a path, changed a
 * manifest, or changed a file of the config closure changes the project set. A content edit changes neither,
 * which is what keeps a warm call cheap.
 */
function mapIsStale(session: LspSession, workspaceRoot: string, freshness: FreshnessOutcome): boolean {
  if (freshness.kind === "reloaded") return true;
  if (freshness.kind !== "pushed") return false;
  const diff = session.snapshotDiff();
  return diff !== undefined && projectMapNeedsRebuild(workspaceRoot, diff, session.generation());
}

/**
 * The prelude every TS tool that addresses one declaration in one file runs, in the order the proof needs:
 * the target and its located server, the disk proved current, the file's outline, the subject inside it, the
 * project map, the anchors that load those projects, then the readiness proof. The map is read after the
 * outline because a call that reloads the session gets its snapshot taken by the spawn this outline starts,
 * and a name that addresses nothing must not pay for anchors. `onResolved` hears the resolved path the
 * moment it is known, so the caller's own catch can still name the spellings it tried when a
 * later step throws rather than failing.
 */
export async function openTsQuery(
  tool: string,
  sessions: LspSessionManager,
  input: { sourceRoots: string[]; file: string; symbol: string; timeBudgetMs: number },
  deps: TsQueryDeps = {},
  onResolved: (resolution: ResolvedPath) => void,
  askable?: (entry: LspDocumentSymbol) => boolean,
): Promise<Step<TsQuery>> {
  const target = await resolveTsTarget(tool, sessions, input, "file", deps);
  if (!target.ok) return target;
  onResolved(target.value.resolution);
  const opened = await openWorkspace(target.value);
  const outline = await readTsOutline(tool, opened);
  if (!outline.ok) return outline;
  const subject = await addressSubject(tool, input.symbol, opened, outline.value, askable);
  if (!subject.ok) return subject;
  const anchored = await anchorProjects(tool, opened, deps.exec, input.symbol, [opened.file]);
  if (!anchored.ok) return anchored;
  return {
    ok: true,
    value: {
      ...opened,
      ...anchored.value.mapped,
      symbols: outline.value,
      subject: subject.value,
      resolved: tsResolvedOf(subject.value),
      anchorsProvenOn: anchored.value.anchorsProvenOn,
    },
  };
}

/** What `anchorProjects` proved: the map the anchors came from, and the spawn they were opened on. */
export interface TsAnchored {
  readonly mapped: TsMapFacts;
  /**
   * Which spawn the proof was made on, as `openAnchorsOn` read it at the proof: every type-aware request the call
   * goes on to make is answered by that process or by none.
   */
  readonly anchorsProvenOn: number;
}

/**
 * The project map, the anchors that load its projects, and the documents-opened proof.
 * `named` is what the call itself names: a file-addressed call always contributes that file, so it can always
 * carry the proof, while a directory-addressed one names nothing and depends on the map alone.
 *
 * Starting the process is the first step, because the map is bound to the process generation it was built for
 *: a call addressed by a file has already started it with its outline, and
 * a directory has no outline to do that.
 */
export async function anchorProjects(
  tool: string,
  opened: TsWorkspaceOpen,
  exec: TsExecFn | undefined,
  symbol: string,
  named: readonly string[],
): Promise<Step<TsAnchored>> {
  // Starting the process waits for `initialize`, which a silent tsgo never answers: the wait is part of the call.
  const started = await withinBudget(opened.session.openAnchorsOn([]).then(() => true), opened.budget);
  if (started === undefined) {
    return { ok: false, error: tsBudgetText(tool, opened.budget, "start", opened.workspaceRoot) };
  }
  const mapped = await loadProjectMap(tool, opened, exec);
  if (!mapped.ok) return mapped;
  const files = [...mapped.value.anchors, ...named];
  // Nothing to open proves nothing, and a workspace-wide search over a server that loaded no project
  // answers a silent `[]` : refused with what the map did find, not waited out.
  if (files.length === 0) {
    return { ok: false, error: noAnchorText(tool, symbol, opened.workspaceRoot, mapped.value) };
  }
  const opening = await withinBudget(opened.session.openAnchorsOn(files).then((serial) => ({ serial })), opened.budget);
  if (opening === undefined) {
    return { ok: false, error: tsBudgetText(tool, opened.budget, "open the project anchors", opened.workspaceRoot) };
  }
  const provenOn = opening.serial;
  // A process replaced halfway through the opens holds only some of the documents, so the answer would be an
  // empty from a server that never loaded what the question covers.
  if (provenOn === undefined) {
    return { ok: false, error: tsReadinessText(tool, opened.budget, symbol, opened.workspaceRoot, "restarted") };
  }
  const ready = await proveDocumentsOpen(tool, opened, symbol);
  if (!ready.ok) return ready;
  return { ok: true, value: { mapped: mapped.value, anchorsProvenOn: provenOn } };
}

/**
 * Why a call addressed by a directory found no project to anchor:
 * the projects the map did find, each with why it gave no anchor, or why there is no map at all.
 */
export function noAnchorText(tool: string, symbol: string, workspaceRoot: string, facts: TsMapFacts): string {
  const head =
    `${tool} failed: no project anchor could be opened in the workspace "${workspaceRoot}", so tsgo has loaded ` +
    `no project and a workspace-wide search for "${symbol}" would answer a silent empty list, which this ` +
    "server does not return. ";
  const tail = " Name a file of the project as the anchor instead: it loads with that file.";
  if (facts.projectsUnavailable !== undefined) {
    return `${head}There is no project map: ${facts.projectsUnavailable}.${tail}`;
  }
  const failed = facts.failed.map((failure) => `  - "${failure.config}" failed to list: ${failure.reason}`);
  const solution = facts.projects
    .filter((project) => project.anchor === null)
    .map((project) => `  - "${project.config}" lists no member file to anchor on (a solution-style config)`);
  const lines = [...failed, ...solution];
  if (lines.length === 0) {
    return `${head}The workspace holds no tsconfig.json or jsconfig.json project.${tail}`;
  }
  return `${head}The projects found:\n${lines.join("\n")}\n${tail.trim()}`;
}

export async function openWorkspace(target: TsTarget): Promise<TsOpened> {
  const { session, budget, binary, workspaceRoot, enclosingWorkspace, file, mentionScan } = target;
  const freshness = await session.refreshModuleSnapshot();
  if (mapIsStale(session, workspaceRoot, freshness)) dropProjectMap(workspaceRoot);
  return { session, budget, binary, workspaceRoot, enclosingWorkspace, freshness, file, mentionScan };
}

/** One file's outline, bounded by the call's budget, or the reason the call did not get one. */
export async function readTsOutline(tool: string, opened: TsOpened): Promise<Step<readonly LspDocumentSymbol[]>> {
  const outline = await withinBudget(opened.session.documentSymbol(opened.file), opened.budget);
  if (outline === undefined) {
    return {
      ok: false,
      error: tsBudgetText(tool, opened.budget, `answer the outline of "${opened.file}"`, opened.workspaceRoot),
    };
  }
  // tsgo's outline is syntactic and never premature, so an empty one is an answer about the file, and a file that declares nothing addresses no symbol — which the next step says.
  return { ok: true, value: outline.state === "ok" ? outline.symbols : [] };
}

/** The documents this answer depends on are opened, and that is the whole of the proof. */
async function proveDocumentsOpen(tool: string, opened: TsWorkspaceOpen, symbol: string): Promise<Step<true>> {
  const readiness = await opened.session.awaitWorkspaceReady(opened.budget.remainingMs());
  if (readiness === "ready") return { ok: true, value: true };
  return { ok: false, error: tsReadinessText(tool, opened.budget, symbol, opened.workspaceRoot, readiness) };
}

/** The configs the map loaded, capped; `count` and `failed` beside it stay exact. */
function projectsBlock(query: TsScopeSource): TsScopeProjects {
  if (query.projectsUnavailable !== undefined) return { projectsUnavailable: query.projectsUnavailable };
  return {
    projects: {
      count: query.projects.length + query.failed.length + query.subsumed.length,
      configs: query.projects.map((project) => project.config).slice(0, TS_SCOPE_LIST_LIMIT),
      failed: query.failed,
      subsumed: query.subsumed.slice(0, TS_SCOPE_LIST_LIMIT),
    },
  };
}

/**
 * A listing that failed says nothing about the files it would have named, so with one in the set "no
 * project includes this file" is unprovable rather than answered with a set that quietly omits a project.
 */
function uncoveredUnavailable(query: TsScopeSource): string | undefined {
  if (query.projectsUnavailable !== undefined) return query.projectsUnavailable;
  if (query.failed.length === 0) return undefined;
  const configs = query.failed.map((failure) => `"${failure.config}"`).join(", ");
  const plural = query.failed.length === 1 ? "listing" : "listings";
  return `the project ${plural} for ${configs} failed, so which sources no project includes is not known`;
}

/** The set partitioned by its own directories, largest group first, then by directory name. */
function directoryCounts(files: readonly string[], workspaceRoot: string): TsUncoveredDirectory[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const directory = containerOf(file, workspaceRoot);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([directory, count]) => ({ directory, count }))
    .sort((left, right) => right.count - left.count || (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0));
}

/**
 * The whole uncovered block: the set partitioned by directory, and the files whose text holds the subject.
 * The scan runs on the call's remaining budget: one that ran out reports the files it did not read rather than
 * failing the answer.
 */
async function uncoveredBlock(query: TsScopeSource, mentionName: string): Promise<TsScopeUncovered> {
  const reason = uncoveredUnavailable(query);
  if (reason !== undefined) return { uncoveredSourcesUnavailable: reason };
  const ranked = [...rankPaths(query.uncovered ?? [])].sort(byNormalisedKey);
  const files = ranked.map((entry) => entry.file);
  const scanned = await (query.mentionScan ?? scanMentions)(files, mentionName, query.budget);
  const directories = directoryCounts(files, query.workspaceRoot);
  return {
    uncoveredSources: {
      count: ranked.length,
      grepRequired: scanned.hits.length > 0 || scanned.unchecked > 0,
      directories: directories.slice(0, TS_SCOPE_LIST_LIMIT),
      directoriesTruncated: Math.max(0, directories.length - TS_SCOPE_LIST_LIMIT),
      mentioning: {
        name: mentionName,
        count: scanned.hits.length,
        files: scanned.hits.slice(0, TS_SCOPE_LIST_LIMIT),
        filesTruncated: Math.max(0, scanned.hits.length - TS_SCOPE_LIST_LIMIT),
        unchecked: scanned.unchecked,
      },
      namedFileUncovered: query.file !== undefined && ranksFile(ranked, query.file),
    },
  };
}

/**
 * What answered and what the workspace compiles with. A host may hold two global TypeScript 7 installs, and
 * only the process that answered is the server this answer came from, so the located package states nothing
 * here — `initialize` does.
 */
function answeredScope(session: LspSession, workspaceRoot: string): TsAnsweredScope {
  return {
    server: { version: session.serverInfo()?.version ?? null },
    workspaceTypescript: workspaceTypescriptVersion(workspaceRoot),
  };
}

/** The major of a version string, wherever its first number sits; `undefined` when it states none. */
function majorOf(version: string | null): number | undefined {
  const match = /(\d+)\.\d+/.exec(version?.trim() ?? "");
  return match === null ? undefined : Number(match[1]);
}

/**
 * What the workspace compiles with: `<workspaceRoot>/node_modules/typescript/package.json`, or `null` when
 * there is none or it states nothing readable. This server reads a manifest inside the root it was given,
 * which is inside the caller's declared boundary, so it is a read and not a load.
 */
function workspaceTypescriptVersion(workspaceRoot: string): string | null {
  const manifestPath = join(workspaceRoot, "node_modules", "typescript", "package.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const stated = parsed !== null && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
    if (typeof stated !== "string") return null;
    return stated.trim() === "" ? null : stated.trim();
  } catch {
    return null;
  }
}

/**
 * The boundary codes, pushed in a fixed order; the meanings live in
 * `navigation-limits.ts`. A tool adding a code adds it here, in its position.
 */
function tsNavigationLimits(
  projects: TsScopeProjects,
  uncovered: TsScopeUncovered,
  answered: TsAnsweredScope,
  flags: TsScopeFlags,
): NavigationLimit[] {
  const limits: NavigationLimit[] = ["one-workspace"];
  if ("projectsUnavailable" in projects || projects.projects.failed.length > 0) limits.push("projects-not-loaded");
  // The table's own order: what could not load, then what this class of answer can never hold, then what the
  // answering server is, then what the listing dropped. A reader that stops early still learns the answer came
  // from a different compiler than the workspace's own.
  if (flags.structuralImplementers) limits.push("structural-implementers-not-reported");
  const server = majorOf(answered.server.version);
  const workspace = majorOf(answered.workspaceTypescript);
  if (server !== undefined && workspace !== undefined && server !== workspace) limits.push("workspace-typescript-differs");
  if ("uncoveredSources" in uncovered && uncovered.uncoveredSources.count > 0) {
    limits.push("uncovered-sources-present");
  }
  if (flags.correspondingMethods) limits.push("corresponding-interface-methods-included");
  if (flags.indirectDispatch) limits.push("indirect-dispatch-not-resolved");
  if (flags.uncalledMentions) limits.push("uncalled-mentions-included");
  if (flags.oneFile) limits.push("one-file");
  if (flags.capped) limits.push("listing-capped");
  return limits;
}

/**
 * The positions the subject IS: the start of every name it is declared with in `file`, keyed by `pathKey` and
 * the 0-based position. A location that starts at one of these is the subject itself, and no other declaration
 * can start there, which is what makes this identity rather than a text read.
 */
export function subjectPositions(subject: TsSubject): ReadonlySet<string> {
  const positions = new Set<string>();
  const add = (at: { readonly line: number; readonly character: number }): void => {
    positions.add(`${pathKey(subject.file)}:${at.line}:${at.character}`);
  };
  for (const entry of subject.entries) {
    const start = entry.selectionRange?.start;
    if (start !== undefined) add(start);
  }
  // A dotted namespace entry (`A.B`) is asked at its last identifier, not where the entry starts.
  for (const asked of subject.positions ?? [subject.position]) add(asked);
  return positions;
}

/**
 * The reported locations that are not the subject's own declaration in `file`. It errs toward keeping: a
 * location that carries no character cannot be proved to be a name, and a declaration of the same symbol in
 * another file is not among the subject's entries here. Both stay.
 */
export function withoutSubjectPositions(
  locations: readonly ReportedLocation[],
  subject: TsSubject,
): readonly ReportedLocation[] {
  return withoutPositions(locations, subjectPositions(subject));
}

/** `own` is a set of `positionKey`s; an empty set drops nothing. */
export function withoutPositions(
  locations: readonly ReportedLocation[],
  own: ReadonlySet<string>,
): readonly ReportedLocation[] {
  return locations.filter((location) => !own.has(`${location.key}:${location.line}:${location.character ?? "-"}`));
}

/**
 * The whole `scope` block of a TS type-aware answer: the workspace the call was rooted at, the projects the
 * map proved (or why none could be), the sources none of them includes (or why that is not known), what
 * answered, and the boundary codes in table order. `mentionName` is the subject's key in the form it is grepped
 * — the last dotted segment, no selector prefix — and reading the uncovered files for it is why this is
 * awaited.
 */
export async function tsNavigationScope(
  query: TsScopeSource,
  flags: TsScopeFlags,
  mentionName: string,
): Promise<TsNavigationScope> {
  const projects = projectsBlock(query);
  const uncovered = await uncoveredBlock(query, mentionName);
  const answered = answeredScope(query.session, query.workspaceRoot);
  return {
    workspaceRoot: query.workspaceRoot,
    enclosingWorkspace: query.enclosingWorkspace,
    freshness: query.freshness,
    ...answered,
    ...projects,
    ...uncovered,
    limits: tsNavigationLimits(projects, uncovered, answered, flags),
  };
}

/**
 * The uncovered half of a refusal: a name this call could not find may live in a file no project includes, and
 * the line that says which files hold it as text is the only thing pointing there. Empty when the set is not
 * known or holds nothing, so the refusal then carries no line.
 */
export async function tsUncoveredClause(query: TsScopeSource, mentionName: string): Promise<string> {
  return tsUncoveredLine(await uncoveredBlock(query, mentionName));
}

/**
 * The same clause for a call that never built a project map (a file anchor with no match returns before it):
 * the map is built here, with no anchors and no type-aware request, and any failure of it leaves the refusal
 * unchanged rather than failing it.
 */
export async function tsUncoveredClauseWithoutMap(
  opened: TsOpened,
  exec: TsExecFn | undefined,
  mentionName: string,
): Promise<string> {
  try {
    const mapped = await loadProjectMap("", opened, exec);
    return mapped.ok ? await tsUncoveredClause({ ...opened, ...mapped.value }, mentionName) : "";
  } catch {
    return "";
  }
}

/** `dir n` for one directory of the uncovered set, as the clause spells it. */
function directoryText(entry: TsUncoveredDirectory): string {
  return `${entry.directory} ${entry.count}`;
}

/** One file that mentions the name, with how many of its lines hold it (a count, never a line number). */
function mentionText(entry: TsUncoveredMention): string {
  return `${entry.file} (${entry.matchingLines} matching line${entry.matchingLines === 1 ? "" : "s"})`;
}

/** The head line's share of the uncovered set: only the reason it is not known. */
export function tsUncoveredText(scope: TsScopeUncovered): string {
  return "uncoveredSourcesUnavailable" in scope ? `; ${scope.uncoveredSourcesUnavailable}` : "";
}

const INCOMPLETE_TAIL = "Do not report this answer as complete until you have.";

/**
 * The summary's second line, empty when no set is known or it is empty:
 * the set was not searched, which directories hold it, and which files hold the name as text. A match or an
 * unchecked file opens it with `INCOMPLETE:` and tells the reader to grep them; only a fully checked set with no
 * match leaves it as a statement. `matchingLines` is a count, and the line says so.
 */
export function tsUncoveredLine(scope: TsScopeUncovered): string {
  if ("uncoveredSourcesUnavailable" in scope) return "";
  const { count, directories, directoriesTruncated, mentioning, namedFileUncovered } = scope.uncoveredSources;
  if (count === 0) return "";
  const named = namedFileUncovered ? ", the named file among them" : "";
  const dirs = directories
    .map(directoryText)
    .join(", ")
    .concat(directoriesTruncated > 0 ? `, +${directoriesTruncated} more directories` : "");
  const unsearched = `${count} file(s) no tsconfig project includes were not searched (${dirs})${named}`;
  const { name, unchecked } = mentioning;
  if (mentioning.count > 0) {
    const more =
      mentioning.filesTruncated > 0 ? `, and ${mentioning.filesTruncated} more files in the directories above` : "";
    const unread = unchecked > 0 ? `. ${unchecked} file(s) could not be checked - grep them too` : "";
    return (
      `INCOMPLETE: ${unsearched}. ${mentioning.count} of them contain "${name}" and may hold more results - ` +
      `grep "${name}" in: ${mentioning.files.map(mentionText).join(", ")}${more}${unread}. ${INCOMPLETE_TAIL}`
    );
  }
  if (unchecked > 0) {
    return (
      `INCOMPLETE: ${unsearched}. None of the checked files contains "${name}"; ${unchecked} file(s) could not ` +
      `be checked - grep them for "${name}". ${INCOMPLETE_TAIL}`
    );
  }
  return `${unsearched}; none of them contains "${name}" as text.`;
}

/**
 * The summary a TS answer carries twice: `summary` is the head line and, when
 * the uncovered set is non-empty, the line that points at it; `text` is that followed by `rest` (the `limits:`
 * line and the rows), for clients that read `content`.
 */
export function summarised(
  head: string,
  scope: TsScopeUncovered,
  rest: string,
): HumanSummary {
  const line = tsUncoveredLine(scope);
  const summary = line === "" ? head : `${head}\n${line}`;
  return { summary, text: `${summary}\n${rest}` };
}

/**
 * The whole scope, phrased once: workspace, projects, what answered, what is absent, how current.
 *
 * `loaded` is stated only when every project is named — the two lists are capped at twenty while `count` is
 * exact, so past that point the sentence would be doing arithmetic on a truncated list and reporting a number
 * that is not true. `subsumed` carries a `+` when it is the capped twenty, not the whole set.
 */
export function tsScopeText(scope: TsWorkspaceScope): string {
  const projects =
    "projects" in scope
      ? `${scope.projects.count} project(s) found` +
        `${projectsNamed(scope.projects) ? `, ${scope.projects.configs.length} loaded` : ""}` +
        `, ${scope.projects.failed.length} failed` +
        (scope.projects.subsumed.length === 0
          ? ""
          : `, ${scope.projects.subsumed.length} subsumed${cappedAt(scope.projects.subsumed) ? "+" : ""}`)
      : scope.projectsUnavailable;
  const server = scope.server.version === null ? "" : `, answered by tsgo ${scope.server.version}`;
  const spanned = scope.enclosingWorkspace === null ? "" : `; npm workspace "${scope.enclosingWorkspace}" not spanned`;
  return (
    ` under workspace "${scope.workspaceRoot}": ${projects}${server}${tsUncoveredText(scope)}` +
    `${spanned}, freshness: ${freshnessText(scope.freshness)}`
  );
}

/**
 * One type-aware request, bounded by the call's remaining budget, with the two answers only a session can
 * give: the budget ran out, or the process that had the documents open was replaced while the request was in
 * flight — a reply from a different process is not an answer, however complete it looks. A refusal the server
 * raises propagates to the tool's own handler; an empty answer is not an error.
 */
export async function tsTypeAwareRequest<T>(
  tool: string,
  query: TsRequestQuery,
  symbol: string,
  method: string,
  params: unknown,
  what: string,
): Promise<Step<T>> {
  const answered = await withinBudget(query.session.request<T>(method, params), query.budget);
  if (answered === undefined) {
    return { ok: false, error: tsBudgetText(tool, query.budget, what, query.workspaceRoot) };
  }
  // The mark alone is a flag any caller's `openAnchors` sets on whichever process is live, so it cannot say
  // that THIS call's anchors are on the process that answered; the spawn they were proved on can, and it moves
  // on a reload as well as on a replacement.
  if (query.session.spawnSerial() !== query.anchorsProvenOn || !query.session.isWorkspaceLoaded()) {
    return { ok: false, error: tsRestartedText(tool, symbol, query.workspaceRoot) };
  }
  return { ok: true, value: answered };
}
