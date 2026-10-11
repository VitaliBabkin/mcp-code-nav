import { isAbsolute, resolve } from "node:path";
import { boundedAncestors, type CppSourceRootsBlock } from "../clang-query/derived-source-roots.js";
import { loadIgnoredPaths, isIgnoredPath } from "../config/ignored-paths.js";
import { PathList } from "./input-limits.js";
import { LanguageServerUnavailableError } from "../lsp/server-config.js";
import { escapesRoot, pathKey } from "../paths/path-containment.js";
import {
  AmbiguousRelativePathError,
  PathEscapeError,
  resolveWithinAnyRoot,
  type ResolvedPath,
} from "../paths/resolve-safe-path.js";

/**
 * Shared across the C++ tools' input schemas so the wording stays identical
 * rather than drifting across copies.
 */
export const SourceRootsSchema = PathList
  .optional()
  .default([])
  .describe(
    "Absolute directories `file`/`files` may resolve within, besides projectRoot. Omitted or empty: the source " +
      "tree derived from compile_commands.json.",
  );

/**
 * The C++ `projectRoot`, stated once for every tool that takes it: the directory the compile database
 * sits in, which for an out-of-tree build is not the source tree.
 */
export const CPP_PROJECT_ROOT_DESCRIPTION =
  "Absolute path of the directory holding compile_commands.json, from a native build on this host.";

export class IgnoredPathError extends Error {
  constructor(public readonly file: string) {
    super(`"${file}" is pre-excluded by this project's mcp-code-nav.config.json ignoredPaths`);
    this.name = "IgnoredPathError";
  }
}

/** The failures `resolveAndCheckIgnored` raises on purpose; anything else is a defect and propagates. */
export function isPathResolutionError(
  e: unknown,
): e is PathEscapeError | AmbiguousRelativePathError | IgnoredPathError {
  return e instanceof PathEscapeError || e instanceof AmbiguousRelativePathError || e instanceof IgnoredPathError;
}

/**
 * Resolves `file` safely within `projectRoot` or one of the caller's `sourceRoots` (rejecting a
 * `..`-escape from every declared root — see `resolveWithinAnyRoot`, the requirements) and
 * rejects it if it matches the project's `ignoredPaths` config — checked BEFORE the
 * file is ever handed to clangd/clang-query. `ignoredPaths` glob matching is always keyed off
 * `projectRoot`'s own `mcp-code-nav.config.json`, but the relative path fed to the matcher is computed
 * against whichever root actually contained `file` — a `sourceRoots` entry otherwise could never match
 * a pattern written relative to it.
 *
 * Returns the whole `ResolvedPath`, not just the path: a tool whose own text names a missing file needs
 * `triedPaths` to say which spellings it looked at.
 */
export function resolveAndCheckIgnored(
  projectRoot: string,
  file: string,
  sourceRoots: string[] = [],
): ResolvedPath {
  const absoluteRoot = resolve(projectRoot);
  const resolved = resolveWithinAnyRoot([absoluteRoot, ...sourceRoots], file);
  const ignoredPaths = loadIgnoredPaths(absoluteRoot);
  if (isIgnoredPath(resolved.matchedRoot, resolved.absolutePath, ignoredPaths)) {
    throw new IgnoredPathError(resolved.absolutePath);
  }
  return resolved;
}

/**
 * What "read-only" means on this server, in its own words. A `clangd` session
 * leaves the project's tracked files untouched and does write one thing: its own index shards, under
 * `.cache/clangd`, beside a `.gitignore` clangd writes there itself. The full sentence belongs to the
 * server `instructions`, which every session reads once; the text an agent pays per tool is the short
 * `CLANGD_DISK_CLAUSE` instead.
 */
export const READ_ONLY_CLANGD_SENTENCE =
  "This server never writes to your sources; clangd keeps its own index under `.cache/clangd` in " +
  "`projectRoot`, beside a `.gitignore` it writes itself.";

/**
 * The disk fact a clangd-backed tool description carries, so the side effect is visible at the point of
 * choice without paying the full sentence in every agent's tool list. Never on `cpp_find_derived_classes`,
 * whose sweep starts no clangd session.
 */
export const CLANGD_DISK_CLAUSE = "Read-only, except clangd's own index under `.cache/clangd`.";

/**
 * The `Resolved "a/b.h" to "<winner>" (tried: "<r1>/a/b.h", "<r2>/a/b.h").` sentence appended
 * to a failure text, empty unless the winner was one of several spellings — an absolute input or a
 * single-root caller has nothing tried to report. Only the two tools with a file-not-found text of their
 * own emit it; `cpp_find_derived_classes` hands resolved paths straight to `clang-query` and has none.
 */
export function resolutionNote(candidate: string, resolved: ResolvedPath | undefined): string {
  if (resolved === undefined || resolved.triedPaths.length < 2) return "";
  const tried = resolved.triedPaths.map((p) => `"${p}"`).join(", ");
  return ` Resolved "${candidate}" to "${resolved.absolutePath}" (tried: ${tried}).`;
}

const PROJECT_ROOT_ONLY_HINT =
  " Only projectRoot was a root, and an out-of-tree build keeps its sources outside it: pass the source tree as " +
  "sourceRoots";

/**
 * The deepest common ancestor of `file` and `projectRoot` under the bounds (`boundedAncestors`) - at most
 * `SOURCE_ROOT_MAX_ASCENT` levels above `projectRoot`, never a filesystem root - or `undefined`.
 */
function commonAncestor(projectRoot: string, file: string): string | undefined {
  return boundedAncestors(projectRoot).find((ancestor) => !escapesRoot(pathKey(ancestor), pathKey(file)));
}

/**
 * the sentence a path-resolution failure's text gains, chosen by where the call's roots came
 * from. Only a `PathEscapeError` gets one; the head it follows stays byte-identical, which is what the
 * `path-escape` classifier anchors on. The suggestion is JSON-escaped and is text, never a root.
 */
export function pathFixHint(
  e: PathEscapeError | AmbiguousRelativePathError | IgnoredPathError,
  ctx: { readonly projectRoot: string; readonly file: string; readonly sourceRoots: CppSourceRootsBlock },
): string {
  if (!(e instanceof PathEscapeError)) return "";
  const { sourceRoots } = ctx;
  if (sourceRoots.origin === "declared") return " To read a file outside these roots, add its source tree to sourceRoots.";
  if (sourceRoots.origin === "derived") {
    return (
      ` "${sourceRoots.roots[0]}" was derived from compile_commands.json because sourceRoots was omitted; to read ` +
      "a file outside it, pass that file's source tree as sourceRoots."
    );
  }
  const suggestion = isAbsolute(ctx.file) ? commonAncestor(ctx.projectRoot, ctx.file) : undefined;
  return suggestion === undefined
    ? `${PROJECT_ROOT_ONLY_HINT}.`
    : `${PROJECT_ROOT_ONLY_HINT}, e.g. sourceRoots: [${JSON.stringify(suggestion)}].`;
}

/**
 * The file-not-found sentence; "" unless `code === "ENOENT"` and only `projectRoot` was a root. A language
 * server missing from PATH carries the same code and is not a missing file.
 */
export function fileNotFoundHint(error: unknown, sourceRoots: CppSourceRootsBlock): string {
  if (error instanceof LanguageServerUnavailableError) return "";
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code !== "ENOENT" || sourceRoots.origin !== "project-root-only") return "";
  return " Only projectRoot was searched; if the file lives in a source tree outside it, pass that tree as sourceRoots.";
}
