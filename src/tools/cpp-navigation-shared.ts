// The machinery the C++ navigation tools share: resolving one declaration by name the way `cpp_find_symbol`
// already does, and stating the boundary of an answer that came from clangd's index. Both languages ask the
// same two questions of a listing — how far the answer reaches, and what it could not see — and the
// second is a machine-readable block, not prose, so it is built here once.
//
// Nothing in this file reaches for a Go module, a `go` subprocess or gopls's shapes: the Go prelude keeps
// its own freshness and environment blocks, and a C++ answer has neither. What it has instead is drift —
// clangd learns of disk changes from its client alone, and a push tells this server that re-indexing was
// asked for, never that it happened.

import { constants as fsConstants, existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { flattenOutline, symbolKindName, type FlatSymbol } from "../clangd/outline.js";
import { CompileDbNotFoundError, listTranslationUnits } from "../clang-query/compile-db.js";
import { describeMissingCompileDb } from "../clang-query/compile-db-hint.js";
import {
  cppSourceRoots,
  deriveSourceRoot,
  type CppSourceRootsBlock,
} from "../clang-query/derived-source-roots.js";
import type { ProjectFingerprint } from "../clang-query/project-fingerprint.js";
import { readIgnoredPatterns } from "../config/ignored-paths.js";
import {
  uncoveredSourcesBlock,
  type UncoveredSourcesBlock,
} from "../clang-query/uncovered-sources.js";
import type { IndexState, LspSession } from "../lsp/session.js";
import type { IndexDriftReading, IndexDriftVerdict, IndexWalkAccount } from "../paths/index-drift.js";
import { escapesRoot } from "../paths/path-containment.js";
import { rankPaths, summariseRanked, type CappedList } from "../paths/ranked-paths.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { candidateHeaders, isCppSourceFile } from "../symbols/header-fallback.js";
import { matchSymbols, type FindSymbolQuery } from "../symbols/match.js";
import {
  CPP_PROJECT_ROOT_DESCRIPTION,
  fileNotFoundHint,
  isPathResolutionError,
  pathFixHint,
  resolveAndCheckIgnored,
  resolutionNote,
  SourceRootsSchema,
} from "./shared.js";
import {
  pathOfUri,
  rangeStart,
  recordOf,
  unexpectedAnswerText,
  WORKSPACE_SYMBOL_ANSWER,
  type BoundaryTest,
} from "./lsp-locations.js";
import { NameInput, PathInput } from "./input-limits.js";
import { STALE_FILES_LIMIT, type NavigationLimit } from "./navigation-limits.js";
import { type Step } from "./navigation-text.js";
import { messageOf } from "../error-message.js";

/** Where one C++ declaration is, and where its own name is inside that. */
export type CppDeclaration = {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly range: { startLine: number; endLine: number };
  readonly namePosition?: { line: number; character: number };
};

/** A bare name or a qualified one, optionally narrowed to one kind — the addressing all three tools share. */
export const SymbolKindFilterSchema = z.enum(["class", "function", "method", "constructor"]);

/**
 * What the three C++ questions are addressed by — `cpp_find_symbol`'s own input, field for field: a declaration named in a file, never a position, because a position is the one input whose
 * staleness is silent. Stated once so the tools cannot drift apart in what they accept or in how they say
 * so, and so a caller that can address one can address all three.
 */
export const CppAddressShape = {
  projectRoot: PathInput.describe(CPP_PROJECT_ROOT_DESCRIPTION),
  name: NameInput.describe(
    "Exact name, bare (`paint`) or qualified (`Widget::paint`); a qualified name must match the trailing " +
      "scope segments.",
  ),
  file: PathInput
    .optional()
    .describe(
      "The declaring file (a .cpp resolves to its header): absolute, or relative - a relative path is " +
        "resolved against projectRoot and each sourceRoots entry, and must exist under exactly one of them. " +
        "Omit it to search the files this session opened, then clangd's index.",
    ),
  sourceRoots: SourceRootsSchema,
  kind: SymbolKindFilterSchema.optional().describe(
    "Narrows a bare name that matches both a class and its constructors.",
  ),
};

/** What the tools are addressed by, as the shape above types it. */
export interface CppAddress {
  projectRoot: string;
  name: string;
  file?: string;
  sourceRoots: string[];
  kind?: FindSymbolQuery["kind"];
}

interface CandidateInFile extends FlatSymbol {
  file: string;
}

function formatCandidate(c: CandidateInFile): string {
  return `${c.qualifiedPath.join("::")} (${c.kind}) at ${c.file}:${c.range.startLine}`;
}

function declarationOf(c: CandidateInFile): CppDeclaration {
  return {
    name: c.qualifiedPath.join("::"),
    kind: c.kind,
    file: c.file,
    line: c.range.startLine,
    range: c.range,
    ...(c.namePosition === undefined ? {} : { namePosition: c.namePosition }),
  };
}

/** Runs `matchSymbols` against one file's outline. `undefined` is the cold-index state, not an empty file. */
async function matchInFile(session: LspSession, file: string, query: FindSymbolQuery): Promise<CandidateInFile[] | undefined> {
  const result = await session.documentSymbol(file);
  if (result.state === "cold-empty") return undefined;
  const flat = result.state === "ok" ? flattenOutline(result.symbols) : [];
  return matchSymbols(flat, query).map((s) => ({ ...s, file }));
}

/**
 * One row answers, several are an ambiguity over `scopeText`, and none is `undefined` — which is not a
 * refusal but the caller being told to keep looking somewhere else.
 */
function uniqueOrAmbiguous(
  tool: string,
  matches: CandidateInFile[],
  name: string,
  scopeText: string,
): Step<CppDeclaration> | undefined {
  const only = matches[0];
  if (matches.length === 1 && only) return { ok: true, value: declarationOf(only) };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `${tool} failed: "${name}" is ambiguous ${scopeText}:\n` + matches.map(formatCandidate).join("\n"),
    };
  }
  return undefined;
}

/** The cold-index error, the one empty result that must not read as an answer. */
function coldIndexError(tool: string, file: string, coldContext: string): Step<CppDeclaration> {
  return {
    ok: false,
    error:
      `${tool} failed: "${file}" ${coldContext}produced no symbols while clangd's index for this project ` +
      "was not yet confirmed warm — retry once the index has warmed up.",
  };
}

/** One file's outline searched: the cold-index error, a unique answer, an ambiguity, or `undefined` for none. */
async function answerForFile(
  tool: string,
  session: LspSession,
  file: string,
  query: FindSymbolQuery,
  coldContext: string,
): Promise<Step<CppDeclaration> | undefined> {
  const matches = await matchInFile(session, file, query);
  if (matches === undefined) return coldIndexError(tool, file, coldContext);
  return uniqueOrAmbiguous(tool, matches, query.name, `in "${file}"`);
}

/**
 * The `.cpp` -> declaring-header fallback. The first candidate header that
 * answers decides; nothing answered, so the caller still reports the file it was asked about.
 */
async function searchDeclaringHeaders(
  tool: string,
  session: LspSession,
  scope: Pick<CppAddress, "projectRoot" | "sourceRoots">,
  absoluteFile: string,
  query: FindSymbolQuery,
): Promise<Step<CppDeclaration> | undefined> {
  if (!isCppSourceFile(absoluteFile)) return undefined;
  for (const headerCandidate of candidateHeaders(absoluteFile)) {
    if (!existsSync(headerCandidate)) continue;
    let absoluteHeader: string;
    try {
      // Already absolute: the header fallback is unaffected by the relative-candidate rule.
      absoluteHeader = resolveAndCheckIgnored(scope.projectRoot, headerCandidate, scope.sourceRoots).absolutePath;
    } catch {
      continue;
    }
    const answered = await answerForFile(
      tool,
      session,
      absoluteHeader,
      query,
      `(declaring header for "${absoluteFile}") `,
    );
    if (answered !== undefined) return answered;
  }
  return undefined;
}

/**
 * One `file` argument: resolve it, search it, then fall back to its declaring header. A late failure from
 * clangd is answered here instead of rethrown because only this scope still holds the resolution, and its
 * tried paths are what turn an ENOENT into an error the caller can branch on.
 */
async function searchInFile(
  tool: string,
  session: LspSession,
  scope: CppAddress,
  sourceRoots: CppSourceRootsBlock,
  file: string,
  query: FindSymbolQuery,
): Promise<Step<CppDeclaration>> {
  let resolution: ResolvedPath;
  try {
    resolution = resolveAndCheckIgnored(scope.projectRoot, file, scope.sourceRoots);
  } catch (e) {
    if (isPathResolutionError(e)) {
      const fix = pathFixHint(e, { projectRoot: scope.projectRoot, file, sourceRoots });
      return { ok: false, error: `${tool} failed: ${e.message}${fix}` };
    }
    throw e;
  }
  const absoluteFile = resolution.absolutePath;

  try {
    const inFile = await answerForFile(tool, session, absoluteFile, query, "");
    if (inFile !== undefined) return inFile;

    const viaHeader = await searchDeclaringHeaders(tool, session, scope, absoluteFile, query);
    if (viaHeader !== undefined) return viaHeader;
  } catch (e) {
    const note = resolutionNote(file, resolution) + fileNotFoundHint(e, sourceRoots);
    return { ok: false, error: `${tool} failed: ${messageOf(e)}${note}` };
  }

  return {
    ok: false,
    error: `${tool} failed: no symbol "${query.name}" found in "${absoluteFile}".${resolutionNote(file, resolution)}`,
  };
}

/**
 * Every file this session's `cpp_file_symbols` calls have already opened. `"nothing"` is not a refusal: it is
 * the opened set saying it holds no answer, which is when the index may be asked. A cold index and
 * an ambiguity are refusals here and stay refusals — one of them is a fact the caller must not lose, the other
 * is a choice this server will not make.
 */
async function searchOpenedFiles(
  tool: string,
  session: LspSession,
  query: FindSymbolQuery,
): Promise<Step<CppDeclaration | "nothing">> {
  const openedFiles = session.getOpenedFiles();
  if (openedFiles.length === 0) return { ok: true, value: "nothing" };

  const allMatches: CandidateInFile[] = [];
  for (const file of openedFiles) {
    const matches = await matchInFile(session, file, query);
    if (matches === undefined) return coldIndexError(tool, file, "");
    allMatches.push(...matches);
  }

  if (allMatches.length === 0) return { ok: true, value: "nothing" };
  const scopeText = `across ${openedFiles.length} previously-opened file(s)`;
  return (
    uniqueOrAmbiguous(tool, allMatches, query.name, scopeText) ?? {
      ok: false,
      error: `${tool} failed: no symbol "${query.name}" found ${scopeText}.`,
    }
  );
}

/**
 * The declaration one C++ question is about, addressed by name and never by position: through that file's
 * outline when `file` is given, otherwise through
 * the files this session has already opened and then, when those answer nothing, through clangd's index
 * — which is why the result says `needsIndex` rather than refusing. `cpp_find_symbol` and the
 * use-site and caller questions resolve the same way on purpose, and the texts a refusal carries are the same
 * words with the asking tool's name at the front.
 */
export async function resolveCppDeclaration(
  tool: string,
  session: LspSession,
  input: CppAddress,
  sourceRoots: CppSourceRootsBlock,
): Promise<Step<CppResolution>> {
  const query: FindSymbolQuery = { name: input.name, kind: input.kind };
  const found = input.file
    ? await searchInFile(tool, session, input, sourceRoots, input.file, query)
    : await searchOpenedFiles(tool, session, query);
  if (!found.ok) return found;
  if (found.value === "nothing") return { ok: true, value: { needsIndex: true } };
  return { ok: true, value: { declaration: found.value } };
}

/** How the shared resolver answered: a declaration, or that only clangd's index can supply one. */
export type CppResolution = { readonly declaration: CppDeclaration } | { readonly needsIndex: true };

/**
 * This server's watermark on clangd's symbol list — a bound this server owns, not a claim about clangd. An
 * answer is capped when the RAW count of rows clangd returned, before the exact-name filter, reaches it: the
 * raw count is what matters, because the filter is exactly what a truncated list could have defeated. It must
 * sit at or below clangd's own cap, or the code goes silent on a truncated list. Pinned by the live suite: a
 * query matching 150 classes came back with exactly this many rows.
 */
export const CLANGD_SYMBOL_CAP_WATERMARK = 100;

/** One row of clangd's `workspace/symbol` answer, read as a candidate the outline branch would have found. */
function readSymbolRow(tool: string, name: string, raw: unknown, ordinal: number): Step<CandidateInFile | undefined> {
  const entry = recordOf(raw);
  const location = recordOf(entry.location);
  const file = pathOfUri(location.uri);
  const named = rangeStart(location.range);
  const rowName = typeof entry.name === "string" && entry.name !== "" ? entry.name : undefined;
  // A row with no kind is not a declaration labelled "?" either: `cpp_find_symbol` promises a kind and
  // `cpp_find_callers` refuses by kind, so a row that cannot say what it is cannot be tested against either, and
  // it fails the call where a shorter listing would have hidden it.
  const kind = typeof entry.kind === "number" ? symbolKindName(entry.kind) : undefined;
  if (rowName === undefined || file === undefined || named === undefined || kind === undefined) {
    return {
      ok: false,
      error: unexpectedAnswerText("clangd", tool, raw, name, `entry ${ordinal}`, WORKSPACE_SYMBOL_ANSWER),
    };
  }
  // `containerName` is the declaration's own scope, spelled as clangd spells it, and the row's `range` IS
  // the identifier's span — measured against a real clangd, so the position this server hovers at is the
  // one the outline branch would have used, and no keyword is ever asked about.
  const container =
    typeof entry.containerName === "string" && entry.containerName !== ""
      ? entry.containerName.split("::").filter((segment) => segment !== "")
      : [];
  const end = rangeStart(recordOf(location.range).end);
  return {
    ok: true,
    value: {
      qualifiedPath: [...container, rowName],
      name: rowName,
      kind,
      range: { startLine: named.line + 1, endLine: (end?.line ?? named.line) + 1 },
      ...(named.character === undefined ? {} : { namePosition: { line: named.line, character: named.character } }),
      file,
    },
  };
}

/** What clangd's symbol list said about one name: one declaration, none, or the refusal that states why. */
export interface CppIndexAnswer {
  readonly declaration?: CppDeclaration;
  readonly refusal?: string;
  /** How many rows answered exactly, whatever the listing below shows. */
  readonly matched: number;
  /** Whether the RAW list reached this server's watermark, so an exact match may have been ranked out. */
  readonly capped: boolean;
}

/**
 * clangd's answer to one `workspace/symbol` query, narrowed to candidates the way a file's outline is: the
 * rows are filtered to exact name equality by `matchSymbols`, the same matcher the scoped branch uses, so
 * `paint`, `Widget::paint` and `gizmo::Widget::paint` mean the same thing from either place. clangd's own
 * search is fuzzy, so a near-match is dropped before it can become an answer; one row that this server cannot
 * place fails the call rather than shortening the listing.
 */
export function cppDeclarationFromSymbolRows(
  tool: string,
  projectRoot: string,
  query: FindSymbolQuery,
  rows: unknown,
): Step<CppIndexAnswer> {
  if (rows !== null && rows !== undefined && !Array.isArray(rows)) {
    return {
      ok: false,
      error: unexpectedAnswerText("clangd", tool, rows, query.name, undefined, WORKSPACE_SYMBOL_ANSWER),
    };
  }
  const raw = rows ?? [];
  const candidates: CandidateInFile[] = [];
  for (const [index, value] of (raw as readonly unknown[]).entries()) {
    const read = readSymbolRow(tool, query.name, value, index + 1);
    if (!read.ok) return read;
    if (read.value !== undefined) candidates.push(read.value);
  }
  const matched = matchSymbols(candidates, query);
  const capped = (raw as readonly unknown[]).length >= CLANGD_SYMBOL_CAP_WATERMARK;
  const scopeText = `in clangd's index for "${projectRoot}"`;
  const answered = uniqueOrAmbiguous(tool, matched, query.name, scopeText);
  if (answered !== undefined) {
    return answered.ok
      ? { ok: true, value: { declaration: answered.value, matched: 1, capped } }
      : { ok: true, value: { refusal: answered.error, matched: matched.length, capped } };
  }
  return { ok: true, value: { matched: 0, capped } };
}

/** The declaration a C++ question is about, or its absence, with the cap fact either way. */
export interface CppTarget {
  readonly declaration?: CppDeclaration;
  readonly capped: boolean;
}

/**
 * The declaration a C++ question is about: the shared resolver's answer, or — when the opened outlines said
 * nothing — one row of clangd's symbol index, asked through `askIndex` so the calling tool keeps the query
 * inside its own index window. An absent declaration is not an error here: an index that was still at work
 * and an index that genuinely holds no such name read differently, and only the caller knows which window it
 * just closed.
 */
export async function cppQuestionDeclaration(
  tool: string,
  input: CppAddress,
  resolution: CppResolution,
  askIndex: (query: string) => Promise<unknown>,
): Promise<Step<CppTarget>> {
  if ("declaration" in resolution) {
    return { ok: true, value: { declaration: resolution.declaration, capped: false } };
  }
  const found = cppDeclarationFromSymbolRows(
    tool,
    input.projectRoot,
    { name: input.name, kind: input.kind },
    await askIndex(input.name),
  );
  if (!found.ok) return found;
  const answer = found.value;
  if (answer.refusal !== undefined) return { ok: false, error: answer.refusal };
  return { ok: true, value: { declaration: answer.declaration, capped: answer.capped } };
}

/**
 * A subject the index placed outside every declared source root, for the two questions that cannot be asked
 * without its document. clangd answers a use-site and a caller query from the AST of the file that declares
 * the symbol, so asking either means opening that file — and the rule is that a file beyond the
 * boundary is reported and never opened. `cpp_find_symbol` differs on purpose: it reports such a declaration's
 * location and says in `descriptionUnavailable` why it carries no description.
 */
export function outsideSubjectText(tool: string, name: string, declaration: CppDeclaration): string {
  return (
    `${tool} failed: "${name}" is declared in "${declaration.file}", which is outside every declared source ` +
    "root. clangd answers this question from the document that declares the symbol, so asking it would mean " +
    "opening that file, and a file outside the boundary is reported and never opened. Pass `file` to ask about " +
    "a declaration inside the roots."
  );
}

/**
 * A name no C++ question can be answered about. Only some silences may be reported as absence:
 * only a `quiescent` index's, and a list that came back at this server's watermark says so, because the
 * declaration may have been ranked out rather than never indexed.
 */
export function noIndexDeclarationText(
  tool: string,
  name: string,
  projectRoot: string,
  state: IndexState,
  capped: boolean,
): string {
  const searched = `in clangd's index for "${projectRoot}"`;
  const ranked = capped
    ? " clangd's symbol search returns a bounded list and this one came back at the size this server treats" +
      " as that bound, so a declaration of this name may have been ranked out of it before the exact-name" +
      " filter ran."
    : "";
  if (state === "quiescent") {
    return (
      `${tool} failed: no declaration named "${name}" was found ${searched}. The match is exact, not fuzzy: a ` +
      "qualified name must match the trailing scope segments clangd spells, and a bare name matches one name in " +
      "any scope. The search is clangd's index of the translation units this project's `compile_commands.json` " +
      "names, and of the headers they include: a source that database omits holds declarations this call cannot " +
      "see. It is not bounded by your declared source roots, and a declaration found outside them is reported." +
      ranked
    );
  }
  const why =
    state === "building"
      ? "clangd was indexing while this call ran, so the shards this answer came from are incomplete"
      : "clangd never reported indexing progress to this session, so its index state is not known";
  return (
    `${tool} failed: no declaration named "${name}" was found ${searched}, and that is not reportable as an ` +
    `answer: ${why}. Call again once indexing has settled — a \`quiescent\` index that finds nothing answers ` +
    `as this refusal instead.${ranked}`
  );
}

/**
 * The rule every clangd-backed C++ tool shares: the compile database is proven readable
 * before a session exists, because clangd answers happily from a directory that holds none and says nothing
 * about it. `undefined` when `projectRoot/compile_commands.json` is a file this server can read; the refusal
 * text — the unchanged head plus the nearest directories under `projectRoot` that do hold one — when it is not.
 */
export async function missingCompileDbHint(projectRoot: string): Promise<string | undefined> {
  if (await compileDbReadable(join(projectRoot, "compile_commands.json"))) return undefined;
  return describeMissingCompileDb(projectRoot);
}

/** A directory named `compile_commands.json` is present and unreadable, so the file test comes before the access test. */
async function compileDbReadable(dbPath: string): Promise<boolean> {
  try {
    if (!(await stat(dbPath)).isFile()) return false;
    await access(dbPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every translation unit the compile database names; `undefined` when this call could not list it. */
export function compileDbTus(projectRoot: string): readonly string[] | undefined {
  try {
    return listTranslationUnits(projectRoot);
  } catch (e) {
    if (e instanceof CompileDbNotFoundError) return undefined;
    throw e;
  }
}

/** Every translation unit the database names, or `undefined` for any failure: the derivation read fails open. */
export function readTusFailOpen(projectRoot: string): readonly string[] | undefined {
  try {
    return listTranslationUnits(projectRoot);
  } catch {
    return undefined;
  }
}

/**
 * The source roots for one call: those containment uses beside `projectRoot`, and where they came from.
 * `tus` is the database read the derivation made, so the scope built later need not read it twice; it is
 * `undefined` when a declared list made the read unnecessary or the read failed.
 */
export function resolveCppSourceRoots(
  projectRoot: string,
  declared: readonly string[] | undefined,
): { readonly block: CppSourceRootsBlock; readonly tus: readonly string[] | undefined } {
  const roots = declaredRoots(declared);
  const tus = roots.length > 0 ? undefined : readTusFailOpen(projectRoot);
  return { block: cppSourceRoots(roots, () => deriveSourceRoot(projectRoot, tus)), tus };
}

/** What `resolveCppSourceRoots` answers: the block, and the database read the derivation made. */
export type CppSourceRootsResolution = ReturnType<typeof resolveCppSourceRoots>;

/** One call's input with the roots containment uses in place of the declared ones, and where they came from. */
export function withEffectiveRoots<T extends { readonly projectRoot: string; readonly sourceRoots?: readonly string[] }>(
  raw: T,
): { readonly roots: ReturnType<typeof resolveCppSourceRoots>; readonly input: T & { sourceRoots: string[] } } {
  const roots = resolveCppSourceRoots(raw.projectRoot, raw.sourceRoots);
  return { roots, input: { ...raw, sourceRoots: [...roots.block.roots] } };
}

/**
 * The roots one call declared, as `SourceRootsSchema`'s own default states them when it declared none. A
 * handler reached through the MCP layer always has an array; a hand-built call may not, and the index branch
 * is the first place a C++ handler reads the field before it has resolved anything.
 */
export function declaredRoots(sourceRoots: readonly string[] | undefined): string[] {
  return sourceRoots === undefined ? [] : [...sourceRoots];
}

/**
 * The boundary of a C++ answer: a location is external when it is outside every declared source root, and
 * with none declared the boundary is `projectRoot` alone — the root the compile database was read from,
 * which is the only thing a caller of these tools has named. An external location is reported and never
 * opened, exactly as the Go answers treat a file outside the module.
 */
export function outsideEveryRoot(projectRoot: string, sourceRoots: readonly string[]): BoundaryTest {
  const roots = sourceRoots.length === 0 ? [projectRoot] : sourceRoots;
  return (file) => roots.every((root) => escapesRoot(root, file));
}

/**
 * `scope.index`: the state the index was in across the answer's window, and either the sources that moved
 * since this session's baseline or why that could not be determined. The two arrive from different places —
 * the state is latched over the request from clangd's own progress tokens, the drift is the bounded walk —
 * so they are passed in separately rather than derived from one another.
 */
export type CppIndexBlock = { readonly state: IndexState } & (
  | { readonly staleFiles: CappedList }
  | { readonly driftUnknown: string }
);

export function indexBlock(state: IndexState, drift: IndexDriftVerdict): CppIndexBlock {
  if (drift.kind === "stale") {
    const staleFiles = summariseRanked(rankPaths(drift.files), STALE_FILES_LIMIT);
    return { state, staleFiles };
  }
  if (drift.kind === "current") return { state, staleFiles: { count: 0, files: [] } };
  return { state, driftUnknown: drift.reason };
}

export interface CppScopeFacts {
  readonly projectRoot: string;
  /** The effective roots containment used beside `projectRoot`, and where they came from. */
  readonly sourceRootsBlock: CppSourceRootsBlock;
  readonly index: CppIndexBlock;
  /** What the drift walk saw, or `undefined` when it could not finish — the two signals beside it differ. */
  readonly account?: IndexWalkAccount;
  /** Every TU named in `compile_commands.json`; `undefined` when this call could not list the database. */
  readonly compileDbTus: readonly string[] | undefined;
  readonly capped: boolean;
  /** A caller question: clangd settles a call against the declaration it was written at, never the target. */
  readonly indirectDispatch: boolean;
}

/**
 * `scope.uncoveredSources` and its unavailable twin — the same block the sweep answers with,
 * computed from the walk the drift signal already took rather than from a second traversal. `fingerprint`
 * is present-only here: the drift walk hashes nothing, and the block reads that field only to tell a
 * bounded walk from a completed one.
 */
export function uncoveredBlock(facts: CppScopeFacts): UncoveredSourcesBlock {
  const { account, compileDbTus, projectRoot } = facts;
  const sourceRoots = facts.sourceRootsBlock.roots;
  const bounded = account === undefined || account.bounded;
  const walk: ProjectFingerprint = {
    ...(bounded ? {} : { fingerprint: "index-walk" }),
    entriesScanned: 0,
    // With no declared source root there is nothing to claim a database is missing, exactly as for the
    // sweep: `projectRoot` alone is the build directory, and calling its contents "uncovered sources"
    // would be a different claim from the one `uncoveredSources` makes. An account that is missing while
    // roots *were* declared is not that case — it is a walk that produced nothing, and says so.
    sourceTus: sourceRoots.length === 0 ? undefined : (account?.sources ?? []),
    walkIncomplete: account?.walkIncomplete === true,
    unreachableSourceRoots: account?.unreachableSourceRoots ?? [],
  };
  return uncoveredSourcesBlock({
    roots: [projectRoot, ...sourceRoots],
    walk,
    compileDbTus,
    readIgnoredPaths: () => readIgnoredPatterns(projectRoot),
  });
}

/**
 * The limits of a C++ answer, in a fixed order. `compile-database-only` holds on
 * every one of them, and the index codes appear beside an answer that was read from the index;
 * `indirect-dispatch-not-resolved` belongs to the caller question, and
 * `corresponding-interface-methods-included` never appears here at all: it names Go's interface
 * correspondence, while clangd's own over-report — a virtual call listed under the base and under its
 * overrides — is carried by `indirect-dispatch-not-resolved` itself.
 */
export function cppNavigationLimits(facts: CppScopeFacts): NavigationLimit[] {
  const limits: NavigationLimit[] = ["compile-database-only"];
  const uncovered = uncoveredBlock(facts);
  if ("uncoveredSources" in uncovered && uncovered.uncoveredSources.count > 0) limits.push("uncovered-sources-present");
  if (facts.index.state === "building") limits.push("index-still-building");
  if (facts.index.state === "unknown") limits.push("index-state-unknown");
  if ("staleFiles" in facts.index && facts.index.staleFiles.count > 0) limits.push("index-behind-disk");
  if ("driftUnknown" in facts.index) limits.push("index-drift-unknown");
  if (facts.indirectDispatch) limits.push("indirect-dispatch-not-resolved");
  if (facts.capped) limits.push("listing-capped");
  return limits;
}

/**
 * The whole `scope` block of a C++ reference or caller answer. There is no `freshness` field, on purpose:
 * that word means "proven current" on the Go side and nothing about clangd's index can be. Exactly one of
 * the two blind-spot keys is present, as on every response that carries `sweep`.
 */
export type CppNavigationScope = {
  readonly projectRoot: string;
  readonly sourceRoots: CppSourceRootsBlock;
  readonly index: CppIndexBlock;
  readonly limits: NavigationLimit[];
} & UncoveredSourcesBlock;

/** What an index-backed answer's `scope` is built from: the roots it used, its index window and its drift reading. */
export interface CppAnswerContext {
  readonly projectRoot: string;
  readonly roots: CppSourceRootsResolution;
  readonly index: IndexState;
  readonly reading: IndexDriftReading;
}

/** The `scope` of an index-backed answer; the caller states what only it knows. */
export function cppAnswerScope(
  context: CppAnswerContext,
  fact: Pick<CppScopeFacts, "capped" | "indirectDispatch">,
): CppNavigationScope {
  const { projectRoot, roots, index, reading } = context;
  return cppNavigationScope({
    projectRoot,
    sourceRootsBlock: roots.block,
    index: indexBlock(index, reading.verdict),
    account: reading.account,
    compileDbTus: roots.tus ?? compileDbTus(projectRoot),
    ...fact,
  });
}

export function cppNavigationScope(facts: CppScopeFacts): CppNavigationScope {
  return {
    projectRoot: facts.projectRoot,
    sourceRoots: facts.sourceRootsBlock,
    index: facts.index,
    ...uncoveredBlock(facts),
    limits: cppNavigationLimits(facts),
  };
}
