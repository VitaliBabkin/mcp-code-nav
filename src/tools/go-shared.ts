import { statSync } from "node:fs";
import { z } from "zod";
import {
  findModuleRoot,
  type ModuleRootOutcome,
  type ModuleRootPathKind,
} from "../gopls/module-root.js";
import { goplsConfig } from "../lsp/server-config.js";
import type { LspSession } from "../lsp/session.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import {
  isExistingFile,
  isExistingFileOrDirectory,
  resolveWithinAnyRoot,
  type ResolvedPath,
} from "../paths/resolve-safe-path.js";
import { type Budget, budgetOf } from "./budget.js";
import { PathInput, PathList } from "./input-limits.js";
import type { Step } from "./navigation-text.js";

/** The ceiling on every Go call, whatever it is spent on. */
const MAX_TIME_BUDGET_MS = 600_000;

/**
 * The Go tools' boundary: there is no `projectRoot`, so the declared roots are the whole of it
 * and at least one is required.
 * `mcp-code-nav.config.json`'s `ignoredPaths` is not honoured here: it is loaded from a `projectRoot`
 * these tools do not have.
 */
export const GoSourceRootsSchema = PathList
  .min(1)
  .describe(
    "Absolute directories bounding this call, at least one; the path you pass and its Go module must lie " +
      "inside one of them.",
  );

/**
 * The declaring file the three type-aware Go questions are addressed by. Stated once: the module a call
 * answers for is read off this path, so the two facts a caller could get wrong are in one place.
 */
export const GoDeclaringFileSchema = PathInput.describe(
  "The file declaring the symbol: absolute, or relative - it must exist under exactly one sourceRoots " +
    "entry. Only its module, the nearest go.mod, is searched.",
);

/** The one `timeBudgetMs` field every Go tool carries, so no tool adds its own account of what it bounds. */
export function timeBudgetSchema(defaultMs: number) {
  return z
    .number()
    .int()
    .positive()
    .max(MAX_TIME_BUDGET_MS)
    .default(defaultMs)
    .describe(
      `Ceiling in ms, default ${defaultMs}; the first call on a module also waits for gopls's package load.`,
    );
}

/**
 * The two non-found outcomes of deriving a file's Go module are both boundary failures with different
 * remedies — one root to add, or a file that is in no module at all — so they get different texts
 *.
 */
export function goModuleRootErrorText(
  tool: string,
  outcome: Exclude<ModuleRootOutcome, { kind: "found" }>,
  file: string,
): string {
  if (outcome.kind === "outside-roots") {
    const roots = outcome.declaredRoots.map((root) => `"${root}"`).join(", ");
    return (
      `${tool} failed: "${file}" belongs to the Go module "${outcome.moduleRoot}" (its nearest go.mod), ` +
      `which is outside every declared sourceRoots entry: ${roots}. Add that module's directory to ` +
      "sourceRoots - this server will not root gopls outside the boundary you declared."
    );
  }
  return (
    `${tool} failed: "${file}" is not inside a Go module - no go.mod exists in "${outcome.searchedFrom}" ` +
    "or any parent directory up to the filesystem root. gopls answers for a module; name a file inside one."
  );
}

export function budgetText(tool: string, budget: Budget, what: string, moduleRoot: string): string {
  return (
    `${tool} failed: gopls did not ${what} within this call's ${budget.ceilingMs} ms budget. The module at ` +
    `"${moduleRoot}" may still be loading its packages; raise timeBudgetMs or call again, and do not read ` +
    "this as an empty answer."
  );
}

/** Where a Go call runs: the file inside its module, the session rooted at that module, and its budget. */
export interface GoTarget {
  readonly file: string;
  /** Kept for the caller's own failure text, which names the spellings it tried. */
  readonly resolution: ResolvedPath;
  readonly moduleRoot: string;
  readonly budget: Budget;
  readonly session: LspSession;
}

export type GoTargetOutcome = Step<GoTarget>;

/**
 * The existence test applied to one candidate spelling. A directory anchor exists as a
 * directory, so the relative-path tie-break must not conclude that a real directory does not exist.
 */
function existsAs(kind: ModuleRootPathKind): (path: string) => boolean {
  if (kind === "file") return isExistingFile;
  return (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };
}

/**
 * The module, session and budget behind one resolved path. Split out of `resolveGoTarget` because an
 * anchor whose kind a `stat` decided reaches the same boundary by a different
 * existence test, and the two must not grow separate rules about containment.
 */
function targetAt(
  tool: string,
  input: { sourceRoots: string[]; timeBudgetMs: number },
  sessions: LspSessionManager,
  resolution: ResolvedPath,
  kind: ModuleRootPathKind,
): GoTargetOutcome {
  const module = findModuleRoot(resolution.absolutePath, input.sourceRoots, kind);
  if (module.kind !== "found") {
    return { ok: false, error: goModuleRootErrorText(tool, module, resolution.absolutePath) };
  }
  return {
    ok: true,
    value: {
      file: resolution.absolutePath,
      resolution,
      moduleRoot: module.moduleRoot,
      budget: budgetOf(input.timeBudgetMs),
      session: sessions.get(module.moduleRoot, goplsConfig),
    },
  };
}

/**
 * The prelude every Go tool shares: resolve the named path within the declared roots before anything
 * touches the disk, derive its module root, and hand back the session rooted there. A path that escapes
 * the boundary throws to the caller's own handler; a module outside it is reported, not rooted in
 *. `kind` decides where the upward search for `go.mod` starts and what the
 * existence test accepts, so a directory anchor roots at its own `go.mod` rather than its parent's.
 */
export function resolveGoTarget(
  tool: string,
  sessions: LspSessionManager,
  input: { sourceRoots: string[]; file: string; timeBudgetMs: number },
  kind: ModuleRootPathKind = "file",
): GoTargetOutcome {
  const resolution = resolveWithinAnyRoot(input.sourceRoots, input.file, existsAs(kind));
  return targetAt(tool, input, sessions, resolution, kind);
}

/** A Go call addressed by one path whose own kind decides the search, as resolved inside the boundary. */
export type GoAnchor = GoTarget & { readonly kind: ModuleRootPathKind };

/**
 * The `go_find_symbol` anchor: containment first, then the one `stat` that decides which of the two
 * lookups answers, then the module that path belongs to — the same upward search a file gets, started at
 * the directory itself when that is what the caller named. A path that escapes
 * every declared root throws to the caller's handler; one that does not exist is reported here, because
 * for an anchor there is no outline read downstream whose ENOENT would say the same thing more vaguely.
 */
export function resolveGoAnchor(
  tool: string,
  sessions: LspSessionManager,
  input: { sourceRoots: string[]; anchor: string; timeBudgetMs: number },
): Step<GoAnchor> {
  const resolution = resolveWithinAnyRoot(input.sourceRoots, input.anchor, isExistingFileOrDirectory);
  const kind = anchorKind(tool, resolution.absolutePath);
  if (!kind.ok) return kind;
  const target = targetAt(tool, input, sessions, resolution, kind.value);
  return target.ok ? { ok: true, value: { ...target.value, kind: kind.value } } : target;
}

/**
 * What an anchor path is: the kind that decides which lookup answers, or the reason nothing was searched.
 * Containment is settled before this runs, so the `stat` only ever touches a path the declared roots
 * allow. A dangling symlink, a device, and anything else that is neither an existing file
 * nor an existing directory are reported rather than searched, because the two searches answer differently.
 */
export function anchorKind(tool: string, absolutePath: string): Step<ModuleRootPathKind> {
  try {
    const stats = statSync(absolutePath);
    if (stats.isFile()) return { ok: true, value: "file" };
    if (stats.isDirectory()) return { ok: true, value: "directory" };
    return {
      ok: false,
      error: `${tool} failed: the anchor "${absolutePath}" is neither a file nor a directory, so this server cannot tell which lookup to run.`,
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "does not exist" : `could not be read${code ? ` (${code})` : ""}`;
    return { ok: false, error: `${tool} failed: the anchor "${absolutePath}" ${why}, so nothing was searched.` };
  }
}
