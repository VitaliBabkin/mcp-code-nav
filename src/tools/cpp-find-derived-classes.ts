import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CompileDbNotFoundError, listTranslationUnits } from "../clang-query/compile-db.js";
import { describeMissingCompileDb } from "../clang-query/compile-db-hint.js";
import {
  cppSourceRoots,
  deriveSourceRoot,
  type CppSourceRootsBlock,
} from "../clang-query/derived-source-roots.js";
import {
  DEFAULT_SWEEP_CEILING_MS,
  findDerivedClasses,
  type ClangQueryExecFn,
  type DerivedClassMatch,
  type FailedFile,
  type FindDerivedClassesResult,
  type SweepProgress,
  type UniformSweepFailure,
} from "../clang-query/find-derived-classes.js";
import { computeProjectFingerprint, type ProjectFingerprint } from "../clang-query/project-fingerprint.js";
import type { SweepCache } from "../clang-query/sweep-cache.js";
import {
  inferredFlagsCaveat,
  uncoveredSourcesBlock,
  unlistedTranslationUnits,
  type UncoveredSourcesBlock,
} from "../clang-query/uncovered-sources.js";
import { readIgnoredPatterns } from "../config/ignored-paths.js";
import { errorResult, partialResult, successResult } from "../mcp-response.js";
import { pathKey } from "../paths/path-containment.js";
import { PathEscapeError, resolveWithinAnyRoot } from "../paths/resolve-safe-path.js";
import { PathInput, PathList } from "./input-limits.js";
import { CPP_PROJECT_ROOT_DESCRIPTION, isPathResolutionError, pathFixHint, SourceRootsSchema } from "./shared.js";
import { messageOf } from "../error-message.js";

// Identifier segments separated by `::`, optionally a leading `::` (global-namespace-qualified) — the only
// syntax a valid C++ qualified name can take. Rejects anything that could reach `clang-query`'s generated
// matcher expression with a character that isn't a plain identifier/separator (defensive hardening per
// the project rules — not a shell-injection vector, `clang-query` is invoked via argv, not a shell).
const QUALIFIED_NAME_PATTERN = /^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/;

// One progress notification per completed TU is too chatty over a sweep of 100+ TUs — the spec's
// rate-limiting SHOULD. Tuning constants, not contract.
const PROGRESS_THROTTLE_MS = 500;
const PROGRESS_HEARTBEAT_MS = 5_000;

export const CppFindDerivedClassesInput = z.object({
  projectRoot: PathInput.describe(CPP_PROJECT_ROOT_DESCRIPTION),
  qualifiedName: z
    .string()
    .min(1)
    .max(1024)
    .regex(QUALIFIED_NAME_PATTERN, "must be a valid C++ qualified name (identifier segments separated by ::)")
    .describe("Fully-qualified name of the base class or interface, e.g. `ns::IFoo`."),
  derivation: z
    .enum(["transitive", "direct"])
    .optional()
    .default("transitive")
    .describe(
      "`transitive` (default): every descendant at any depth. `direct`: only classes naming `qualifiedName` " +
        "as a base themselves - the candidates that must react when the base's interface changes, not proof " +
        "of who must add an override (an abstract one passes it down), so check them with cpp_file_symbols. " +
        "Both views come from one cached sweep; an empty `direct` means none in the swept TUs.",
    ),
  files: PathList
    .optional()
    .describe(
      "TUs to sweep instead of the whole compile database (a full parallel sweep, tens of seconds on a " +
        "mid-size project) - absolute, or relative: a relative path is resolved against projectRoot and " +
        "each sourceRoots entry, and must exist under exactly one of them. Results are cached per process " +
        "until a source file changes.",
    ),
  sourceRoots: SourceRootsSchema,
  timeBudgetMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe(
      "Ceiling for this call, default 300000 ms. The sweep is not chunked and needs no second call; to " +
        "bound cost, prefer `files` over lowering this.",
    ),
});

/**
 * What a caller may send rather than what zod emits: a default that reaches the handler as `undefined`
 * is a mid-sweep defect, so the handler resolves it and the type must allow the absent/undefined spelling.
 */
export type CppFindDerivedClassesInputType = z.input<typeof CppFindDerivedClassesInput>;

export interface CppFindDerivedClassesDeps {
  exec?: ClangQueryExecFn;
  readFile?: (path: string) => string;
  cache: SweepCache;
}

/** The subset of the SDK's request-handler `extra` this tool actually uses — kept independent of the
 * SDK's own type so the mocked unit suite can call `runCppFindDerivedClasses` without constructing one. */
export interface RunCppFindDerivedClassesExtra {
  signal?: AbortSignal;
  sendNotification?: (notification: ServerNotification) => Promise<void>;
  progressToken?: string | number;
}

/** The view one sweep computes; the core never sees it. */
type Derivation = z.infer<typeof CppFindDerivedClassesInput>["derivation"];

// A type alias, not an interface: the SDK requires `structuredContent` to satisfy `{ [x: string]: unknown }`,
// which only a type alias gets an implicit index signature for.
type RowCounts = { readonly transitive: number; readonly direct: number };

/**
 * `sweep` plus the roots it was bounded by and the pair: every response that carries `sweep`
 * carries `sourceRoots` and exactly one of the two blind-spot keys.
 */
type SweepPayload = FindDerivedClassesResult["sweep"] & { readonly sourceRoots: CppSourceRootsBlock } & UncoveredSourcesBlock;

/** `derivation` is the first key so a payload can never be read as the other view. */
type CppFindDerivedClassesPayload = {
  readonly derivation: Derivation;
  readonly matches: DerivedClassMatch[];
  readonly counts: RowCounts;
  readonly failedFiles?: FailedFile[];
  readonly incomplete?: FindDerivedClassesResult["incomplete"];
  readonly sweep: SweepPayload;
};

interface ProgressReporter {
  notify(info: SweepProgress): void;
  dispose(): void;
}

/**
 * Owns the notification policy the core module deliberately does not: elapsed-ms as the
 * `progress` quantity, because MCP 2025-11-25 §Progress requires monotonicity and a TU count cannot move
 * while the whole pool is wedged inside one parse — the exact window a caller is deciding whether to keep
 * waiting; the TU counts ride in `message`, which is what that field is for. `dispose()` is mandatory on
 * every exit path: the spec forbids notifications after the call completes, and the heartbeat interval
 * would otherwise outlive the request.
 */
function makeProgressReporter(extra: RunCppFindDerivedClassesExtra, ceilingMs: number): ProgressReporter | undefined {
  if (extra.progressToken === undefined || !extra.sendNotification) return undefined;
  const progressToken = extra.progressToken;
  const sendNotification = extra.sendNotification;
  const startedAt = Date.now();
  let last: SweepProgress = { sweptTus: 0, totalTus: 0, elapsedMs: 0 };
  let lastEmittedProgress = 0;
  let lastSentAt = 0;

  const send = (sweptTus: number, totalTus: number, elapsedMs: number): void => {
    // `+ 1`: two emissions inside the same millisecond would otherwise repeat a `progress` value, which
    // the monotonicity MUST forbids.
    lastEmittedProgress = Math.max(elapsedMs, lastEmittedProgress + 1);
    lastSentAt = Date.now();
    // A rejected notification means the transport is already gone; an unhandled rejection would take the
    // server down mid-sweep, and the tool's own response is the channel that still matters.
    void sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: lastEmittedProgress,
        total: ceilingMs,
        message: `${sweptTus}/${totalTus} translation units, ${elapsedMs} ms elapsed`,
      },
    }).catch(() => {});
  };

  const heartbeat = setInterval(
    () => send(last.sweptTus, last.totalTus, Date.now() - startedAt),
    PROGRESS_HEARTBEAT_MS,
  );

  return {
    notify: (info) => {
      last = info;
      if (Date.now() - lastSentAt < PROGRESS_THROTTLE_MS) return;
      send(info.sweptTus, info.totalTus, info.elapsedMs);
    },
    dispose: () => {
      clearInterval(heartbeat);
      send(last.sweptTus, last.totalTus, Date.now() - startedAt);
    },
  };
}

/** What the call's boundary resolves to before anything is swept: one database read, the roots, the `files` entries. */
interface SweepScope {
  readonly listing: DatabaseListing;
  readonly sourceRoots: CppSourceRootsBlock;
  readonly roots: string[];
  readonly translationUnits: string[] | undefined;
}

/** One read of the database serves the derivation, an unscoped sweep's scope and the blind-spot checks. */
function resolveSweepScope(input: CppFindDerivedClassesInputType): SweepScope | { readonly failure: string } {
  const listing = listDatabase(input.projectRoot);
  const sourceRoots = cppSourceRoots(input.sourceRoots ?? [], () =>
    deriveSourceRoot(input.projectRoot, "tus" in listing ? listing.tus : undefined),
  );
  const roots = [input.projectRoot, ...sourceRoots.roots];
  try {
    const translationUnits = input.files?.map((f) => resolveWithinAnyRoot(roots, f).absolutePath);
    return { listing, sourceRoots, roots, translationUnits };
  } catch (e) {
    if (!isPathResolutionError(e)) throw e;
    const file = e instanceof PathEscapeError ? e.candidate : "";
    const fix = pathFixHint(e, { projectRoot: input.projectRoot, file, sourceRoots });
    return { failure: `cpp_find_derived_classes failed: ${e.message}${fix}` };
  }
}

export async function runCppFindDerivedClasses(
  deps: CppFindDerivedClassesDeps,
  input: CppFindDerivedClassesInputType,
  extra: RunCppFindDerivedClassesExtra = {},
) {
  const derivation: Derivation = input.derivation ?? "transitive";
  const resolved = resolveSweepScope(input);
  if ("failure" in resolved) return errorResult(resolved.failure);
  const { listing, sourceRoots, roots, translationUnits } = resolved;

  // Computed unconditionally (not only when caching is possible) so a walk that exceeds its bound
  // still reports why the cache is disabled, rather than a bare "disabled" with no reason.
  const fingerprintResult = computeProjectFingerprint(roots);

  // Held once here so the sweep's bound and the progress notification's `total` cannot disagree.
  const ceilingMs = input.timeBudgetMs ?? DEFAULT_SWEEP_CEILING_MS;
  const reporter = makeProgressReporter(extra, ceilingMs);

  try {
    // An unscoped sweep's scope *is* the database, so its read failure fails the call; a scoped call reads
    // it only for the blind-spot checks and fails open.
    if (translationUnits === undefined && "error" in listing) throw listing.error;
    const db = "tus" in listing ? listing.tus : undefined;
    const sweepScope = translationUnits ?? db ?? [];
    const outcome = await findDerivedClasses({
      projectRoot: input.projectRoot,
      qualifiedName: input.qualifiedName,
      translationUnits: sweepScope,
      exec: deps.exec,
      readFile: deps.readFile,
      cache: deps.cache,
      fingerprint: fingerprintResult.fingerprint,
      timeBudgetMs: ceilingMs,
      signal: extra.signal,
      onProgress: reporter?.notify,
    });

    // Every TU failing the same way means the empty `matches` is the sweep failing, not the hierarchy
    // being empty — an error with no payload that could be read as an answer.
    if (outcome.uniformFailure) {
      const unlisted = unlistedNamedFiles(translationUnits, db);
      return errorResult(uniformFailureText(outcome.uniformFailure, outcome.failedFiles, unlisted));
    }

    const result = buildSweepPayload(
      derivation,
      outcome,
      sweepPayload(outcome, fingerprintResult, { roots, sourceRoots }, input.projectRoot, db),
      annotateFailedFiles(outcome.failedFiles, translationUnits, db),
    );

    // A per-TU clang-query failure never fails the whole call — it is
    // surfaced in `failedFiles` beside whatever the other TUs produced, and `isError` stays false unless the
    // sweep itself was truncated.
    if (outcome.incomplete) {
      return partialResult(ceilingText(outcome.incomplete, ceilingMs, derivation), result);
    }
    return successResult(result);
  } catch (e) {
    if (e instanceof CompileDbNotFoundError) {
      return errorResult(`cpp_find_derived_classes failed: ${await describeMissingCompileDb(e.projectRoot)}`);
    }
    return errorResult(`cpp_find_derived_classes failed: ${messageOf(e)}`);
  } finally {
    reporter?.dispose();
  }
}

/** One read of the compile database: its TUs, or the failure — an unreadable list is not an empty one. */
type DatabaseListing = { readonly tus: string[] } | { readonly error: unknown };

function listDatabase(projectRoot: string): DatabaseListing {
  try {
    return { tus: listTranslationUnits(projectRoot) };
  } catch (error) {
    return { error };
  }
}

/** The `files` entries the compile database's own TU list does not compile — `uncoveredSources` filters too much. */
function unlistedNamedFiles(files: string[] | undefined, db: readonly string[] | undefined): string[] {
  if (files === undefined || db === undefined) return [];
  return unlistedTranslationUnits(files, db);
}

/** The `sweep` block: the stats the core computed, the cache reason the walk supplied, the blind-spot key. */
function sweepPayload(
  outcome: FindDerivedClassesResult,
  walk: ProjectFingerprint,
  scope: { readonly roots: readonly string[]; readonly sourceRoots: CppSourceRootsBlock },
  projectRoot: string,
  db: readonly string[] | undefined,
): SweepPayload {
  const cacheReason =
    outcome.sweep.cache === "disabled" && walk.reason !== undefined ? { cacheReason: walk.reason } : {};
  const block = uncoveredSourcesBlock({
    roots: scope.roots,
    walk,
    compileDbTus: db,
    readIgnoredPaths: () => readIgnoredPatterns(projectRoot),
  });
  return { ...outcome.sweep, ...cacheReason, sourceRoots: scope.sourceRoots, ...block };
}

/** Adds the missing-entry reason to already-produced rows for files the caller named; never creates a row. */
function annotateFailedFiles(
  failedFiles: FailedFile[],
  files: string[] | undefined,
  db: readonly string[] | undefined,
): FailedFile[] {
  if (failedFiles.length === 0) return failedFiles;
  const unlisted = unlistedNamedFiles(files, db);
  if (unlisted.length === 0) return failedFiles;
  const named = new Set(unlisted.map(pathKey));
  return failedFiles.map((row) => (named.has(pathKey(row.file)) ? addDbReason(row) : row));
}

function addDbReason(row: FailedFile): FailedFile {
  const reason = `no compile-database entry; ${inferredFlagsCaveat(false)}`;
  return { ...row, error: `${row.error} - ${reason}` };
}

/**
 * The whole-sweep-failure text: unlisted `files` are named first, and `Failed file: <path>` stays last so a
 * caller can read the path off the end.
 */
function uniformFailureText(
  failure: UniformSweepFailure,
  failedFiles: FailedFile[],
  unlisted: readonly string[],
): string {
  const text =
    `cpp_find_derived_classes failed on all ${failure.failedTus} translation units with the same error, so the ` +
    "empty result is a sweep failure, not an empty hierarchy - check that the clang-query on PATH " +
    `supports this query. Shared error: ${failure.error}` +
    blindSpotSentence(unlisted);
  if (failure.failedTus !== 1) return text;
  const only = failedFiles.find((entry) => entry.error === failure.error);
  return only === undefined ? text : `${text} Failed file: ${only.file}`;
}

function blindSpotSentence(unlisted: readonly string[]): string {
  if (unlisted.length === 0) return "";
  const list = unlisted.map((file) => `"${file}"`).join(", ");
  return (
    ` These files are named in \`files\` but have no compile-database entry; ${inferredFlagsCaveat(true)}: ${list}.`
  );
}

/**
 * MCP's structuredContent is spec'd as a JSON object, not a bare array — the payload is an array of {...}
 * objects, wrapped here under `matches` to satisfy that constraint.
 */
function buildSweepPayload(
  derivation: Derivation,
  outcome: FindDerivedClassesResult,
  sweep: SweepPayload,
  failedFiles: FailedFile[],
): CppFindDerivedClassesPayload {
  const rows = outcome.matches;
  const directRows = rows.filter((row) => row.direct);
  return {
    derivation,
    matches: derivation === "direct" ? directRows : rows,
    // Both counts over the unfiltered rows — their gap is the signal a single-view answer lacks.
    counts: { transitive: rows.length, direct: directRows.length },
    ...(failedFiles.length > 0 ? { failedFiles } : {}),
    ...(outcome.incomplete ? { incomplete: outcome.incomplete } : {}),
    sweep,
  };
}

function ceilingText(
  incomplete: NonNullable<FindDerivedClassesResult["incomplete"]>,
  ceilingMs: number,
  derivation: Derivation,
): string {
  return (
    `cpp_find_derived_classes swept ${incomplete.sweptTus}/${incomplete.totalTus} translation ` +
    `units within its ${ceilingMs} ms ceiling (${incomplete.reason}), answering ` +
    `derivation: "${derivation}" — a normally-sized project does not reach it. ` +
    "Pass `files` to scope the sweep, raise `timeBudgetMs`, or call again to resume from the cached " +
    "translation units."
  );
}

export function registerCppFindDerivedClasses(server: McpServer, deps: CppFindDerivedClassesDeps) {
  server.registerTool(
    "cpp_find_derived_classes",
    {
      title: "Find C++ class hierarchy",
      description:
        "Find every class deriving from a C++ class or interface, grandchildren included, via clang-query " +
        "over the compile database - grep on `class X : public Y` and single-level lookups miss the " +
        "indirect ones. `derivation` picks transitive (default) or direct-only. One call returns the " +
        "complete answer even when it takes tens of seconds; do not retry a timed-out or truncated call " +
        "expecting a different result. `counts` are matched source locations (one per template form, test " +
        "fixtures included), not classes - count distinct `className` values in `matches`. " +
        "`sweep.uncoveredSources` names sources under `sourceRoots` that no compile-database entry compiles " +
        "- a class defined only there cannot appear. Its `count: 0` covers only the sources the walk visits " +
        "(not build, vendored, VCS or `.claude` directories, `ignoredPaths` matches or symlinks) and says " +
        "nothing about which TUs were swept.",
      inputSchema: CppFindDerivedClassesInput.shape,
    },
    async (args, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) =>
      runCppFindDerivedClasses(deps, args as CppFindDerivedClassesInputType, {
        signal: extra.signal,
        sendNotification: extra.sendNotification,
        progressToken: extra._meta?.progressToken,
      }),
  );
}
