// Which files of a project are C++ sources, and which directories hold none of them. The compile-database
// fingerprint and clangd's index-drift walk ask the same two questions of a path, so the answers live here
// once: a list kept in two places is one edit away from having two walks disagree about what a source is,
// and each would then report a different blind spot for the same project.

import { extname } from "node:path";

/**
 * What a `uncoveredSources` claim may be made about. Headers are essentially never compile-database
 * entries, so each would report as uncovered. A source spelled outside this set (`.cppm`, `.c++`, `.cu`,
 * an upper-case extension) is not detected by either walk.
 */
const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".ixx", ".mm"]);
const HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx", ".inl", ".ipp"]);

/** Sources and headers together: the files whose edit changes what a translation unit means, and so what
 *  an index built from it says. */
const TRACKED_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ...HEADER_EXTENSIONS]);

/**
 * Directories that hold nothing this project compiled. `.cache` is in the list because that is where clangd
 * writes its own index shards, and a walk that counted them would report the index against itself.
 */
const SKIPPED_DIR_NAMES = new Set([
  ".git",
  ".claude",
  "node_modules",
  ".cache",
  ".vs",
  ".idea",
  "vcpkg_installed",
  "out",
]);

/** A TU-extension source: one that a compile-database entry could name. */
export function isCppSourceName(name: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(name));
}

/** A source or a header: a file whose change an answer computed from parsed text may be behind. */
export function isCppTrackedName(name: string): boolean {
  return TRACKED_EXTENSIONS.has(extname(name));
}

/** Names a build tree's own directories carry; the sibling search stays inside one build tree with it. */
export function isBuildDirName(name: string): boolean {
  return name.startsWith("build") || name.startsWith("cmake-build") || name === "out";
}

/**
 * A directory neither walk enters. A walk root the caller named is never skipped by this predicate's
 * subject — the caller decides that, because a build directory is the normal `projectRoot`.
 */
export function isSkippedDirName(name: string): boolean {
  return SKIPPED_DIR_NAMES.has(name) || name.startsWith("build") || name.startsWith("cmake-build");
}
