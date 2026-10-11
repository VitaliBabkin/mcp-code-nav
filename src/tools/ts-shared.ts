import { z } from "zod";
import type { ModuleRootPathKind } from "../gopls/module-root.js";
import { LanguageServerUnavailableError, TSGO_IDENTITY, tsgoConfig } from "../lsp/server-config.js";
import type { LspSession } from "../lsp/session.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import {
  isExistingFile,
  isExistingFileOrDirectory,
  resolveWithinAnyRoot,
  type ResolvedPath,
} from "../paths/resolve-safe-path.js";
import { TS_SOURCE_EXTENSIONS, isTsOrJsSourceFile } from "../tsgo/language.js";
import { resolveTsgoBinary, type TsgoBinary, type TsgoBinaryDeps, type TsgoBinaryResult } from "../tsgo/binary.js";
import type { MentionScanner } from "../tsgo/uncovered-mentions.js";
import { findWorkspaceRoot, type WorkspaceRootOutcome } from "../tsgo/workspace-root.js";
import { budgetOf, withinBudget, type Budget } from "./budget.js";
import { anchorKind } from "./go-shared.js";
import { PathList } from "./input-limits.js";
import type { Step } from "./navigation-text.js";

/**
 * What the `ts_` tools share: the schema pieces, the located server, the workspace a call is rooted at, and
 * the texts every one of them answers with when one of those is not there. Mirrors `go-shared.ts`, whose
 * shape these tools copy; what differs is that tsgo's executable is located rather than named on PATH, so
 * resolving a target is a call that can fail and is awaited.
 */

/** No TS answer is wider than the workspace holding the file, so the first call pays for one project load. */
const MAX_TIME_BUDGET_MS = 600_000;

export const TsSourceRootsSchema = PathList
  .min(1)
  .describe(
    "Absolute directories bounding this call, at least one; the path you pass and its npm workspace must lie " +
      "inside one of them.",
  );

export function timeBudgetSchema(defaultMs: number) {
  return z
    .number()
    .int()
    .positive()
    .max(MAX_TIME_BUDGET_MS)
    .default(defaultMs)
    .describe(
      `Ceiling in ms, default ${defaultMs}; a workspace's first call also waits for its projects to load.`,
    );
}

/** The located executable for the life of this process; `undefined` while nothing has asked yet. */
let located: Promise<TsgoBinaryResult> | undefined;

/**
 * One answer per process, kept only when it found a server: a miss is not a fact about the host (a global
 * install can land while the server runs), so the next call asks `npm root -g` again rather than repeating
 * the failure — the rule the Go toolchain pass runs by too.
 */
export function cachedTsgoBinary(deps: Partial<TsgoBinaryDeps> = {}): Promise<TsgoBinaryResult> {
  if (located !== undefined) return located;
  const asking = resolveTsgoBinary(deps).then((result) => {
    if ("unavailable" in result && asking === located) located = undefined;
    return result;
  });
  located = asking;
  return asking;
}

/** A search that found no executable is the same failure class as a server that would not start. */
function tsgoUnavailable(miss: { unavailable: string; attempted: string }): LanguageServerUnavailableError {
  return new LanguageServerUnavailableError(
    { config: TSGO_IDENTITY, attempted: miss.attempted, fromOverride: false },
    { message: miss.unavailable },
  );
}

/** The outcome `findWorkspaceRoot` reports when it did find one, so a target can name both halves. */
type FoundWorkspace = Extract<WorkspaceRootOutcome, { kind: "found" }>;

export function tsWorkspaceRootErrorText(
  tool: string,
  outcome: Exclude<WorkspaceRootOutcome, FoundWorkspace>,
  file: string,
): string {
  if (outcome.kind === "outside-roots") {
    const roots = outcome.declaredRoots.map((root) => `"${root}"`).join(", ");
    return (
      `${tool} failed: "${file}" belongs to the npm package "${outcome.workspaceRoot}" (its nearest ` +
      `package.json), which is outside every declared sourceRoots entry: ${roots}. Add that package's ` +
      "directory to sourceRoots - this server will not root tsgo outside the boundary you declared."
    );
  }
  return (
    `${tool} failed: "${file}" is not inside an npm package - no package.json exists in ` +
    `"${outcome.searchedFrom}" or any parent directory up to the filesystem root. tsgo answers for the ` +
    "workspace holding a file; name one inside a package."
  );
}

/** The file's own extension is what decides it, so a directory anchor is checked only for its file case. */
function unsupportedFileError(tool: string, file: string): string {
  return (
    `${tool} failed: "${file}" is not a TypeScript or JavaScript source. These tools accept ` +
    `${TS_SOURCE_EXTENSIONS.join(", ")} - the file's extension also decides how tsgo parses it.`
  );
}

/**
 * A call whose budget ran out while the executable was still being looked for. Stated as the search rather
 * than as a server that did not answer, because no server was asked anything: `timeBudgetMs` bounds the whole
 * call, and the first TS call of a process spends part of it on `npm root -g`.
 */
function discoveryBudgetText(tool: string, budget: Budget, workspaceRoot: string): string {
  return (
    `${tool} failed: this server was still looking for the TypeScript 7 native server when this call's ` +
    `${budget.ceilingMs} ms budget ran out. The first TS call of a process asks \`npm root -g\` where the ` +
    `global packages are, and nothing was sent to any server for the workspace at "${workspaceRoot}". Raise ` +
    `timeBudgetMs, or set ${TSGO_IDENTITY.commandEnvOverride} to the native executable's absolute path.`
  );
}

/** One answer's target: the file, the workspace rooted at, and the session that will answer for it. */
export interface TsTarget {
  readonly file: string;
  readonly resolution: ResolvedPath;
  readonly workspaceRoot: string;
  /** The workspace above `workspaceRoot` that was declined for lying outside every declared root. */
  readonly enclosingWorkspace: string | null;
  readonly budget: Budget;
  readonly session: LspSession;
  readonly binary: TsgoBinary;
  /** The scan of the uncovered sources this call runs; `undefined` is the one every real call runs. */
  readonly mentionScan?: MentionScanner;
}

export interface TsTargetInput {
  readonly sourceRoots: string[];
  readonly timeBudgetMs: number;
}

export interface TsTargetDeps {
  readonly resolveBinary?: (deps?: Partial<TsgoBinaryDeps>) => Promise<TsgoBinaryResult>;
  readonly binaryDeps?: Partial<TsgoBinaryDeps>;
  /**
   * Seam for the scan over the sources no project includes, which reads the disk. The live cost case runs the same call with and without it to price what the scan adds.
   */
  readonly mentionScan?: MentionScanner;
}

function existsAs(kind: ModuleRootPathKind): (path: string) => boolean {
  return kind === "directory" ? isExistingFileOrDirectory : isExistingFile;
}

/**
 * One `ts_` call's boundaries, in the order that costs least: the path inside the declared roots, the
 * extension tsgo can be asked about, the workspace that holds it, and only then the executable — so a call
 * that could not be answered does not start a server to find that out.
 *
 * The budget is the first thing made, because `timeBudgetMs` is a ceiling on the whole call and the search for
 * the executable is part of the call: the first TS call of a process asks `npm root -g`, which costs hundreds
 * of milliseconds and can hang. An expired ceiling returns without a session and without a request, and the
 * search it was waiting on keeps running in the cache, so the next call awaits that one answer rather than
 * starting a second `npm`.
 */
export async function resolveTsTarget(
  tool: string,
  sessions: LspSessionManager,
  input: TsTargetInput & { readonly file: string },
  kind: ModuleRootPathKind,
  deps: TsTargetDeps = {},
): Promise<Step<TsTarget>> {
  const budget = budgetOf(input.timeBudgetMs);
  const resolution = resolveWithinAnyRoot(input.sourceRoots, input.file, existsAs(kind));
  return targetAt(tool, sessions, input, budget, resolution, kind, deps);
}

/** A TS call addressed by one path whose own kind decides the search, as resolved inside the boundary. */
export type TsAnchorTarget = TsTarget & { readonly kind: ModuleRootPathKind };

/**
 * The `ts_find_symbol` anchor: containment first, then the one `stat` that decides which of the two lookups
 * answers, then the workspace that path belongs to — the same upward search a file gets, started at the
 * directory itself when that is what the caller named. A path that escapes every
 * declared root throws to the caller's handler; one that does not exist is reported here, because for an
 * anchor there is no outline read downstream whose ENOENT would say the same thing more vaguely.
 */
export async function resolveTsAnchor(
  tool: string,
  sessions: LspSessionManager,
  input: TsTargetInput & { readonly anchor: string },
  deps: TsTargetDeps = {},
): Promise<Step<TsAnchorTarget>> {
  const budget = budgetOf(input.timeBudgetMs);
  const resolution = resolveWithinAnyRoot(input.sourceRoots, input.anchor, isExistingFileOrDirectory);
  const kind = anchorKind(tool, resolution.absolutePath);
  if (!kind.ok) return kind;
  const target = await targetAt(tool, sessions, input, budget, resolution, kind.value, deps);
  return target.ok ? { ok: true, value: { ...target.value, kind: kind.value } } : target;
}

/**
 * The part of a target both entry points share, in the order that costs least: the extension tsgo can be asked
 * about (a file's own extension decides, so a directory is never checked for one), the workspace that holds
 * the path, and only then the executable.
 */
async function targetAt(
  tool: string,
  sessions: LspSessionManager,
  input: TsTargetInput,
  budget: Budget,
  resolution: ResolvedPath,
  kind: ModuleRootPathKind,
  deps: TsTargetDeps,
): Promise<Step<TsTarget>> {
  if (kind === "file" && !isTsOrJsSourceFile(resolution.absolutePath)) {
    return { ok: false, error: unsupportedFileError(tool, resolution.absolutePath) };
  }
  const workspace = findWorkspaceRoot(resolution.absolutePath, input.sourceRoots, kind);
  if (workspace.kind !== "found") {
    return { ok: false, error: tsWorkspaceRootErrorText(tool, workspace, resolution.absolutePath) };
  }
  const located = await withinBudget((deps.resolveBinary ?? cachedTsgoBinary)(deps.binaryDeps), budget);
  if (located === undefined) return { ok: false, error: discoveryBudgetText(tool, budget, workspace.workspaceRoot) };
  if ("unavailable" in located) throw tsgoUnavailable(located);
  return {
    ok: true,
    value: {
      file: resolution.absolutePath,
      resolution,
      workspaceRoot: workspace.workspaceRoot,
      enclosingWorkspace: workspace.enclosingWorkspace,
      budget,
      session: sessions.get(workspace.workspaceRoot, tsgoConfig(located.binary)),
      binary: located.binary,
      mentionScan: deps.mentionScan,
    },
  };
}

/**
 * A TS answer's human summary as the two shapes it is carried in: `summary`
 * is the lines before `limits:`, which ride inside `structuredContent`, and `text` is the full summary for the
 * `content` block.
 */
export interface HumanSummary {
  readonly summary: string;
  readonly text: string;
}

export { withSummary, type WithSummary } from "../mcp-response.js";
