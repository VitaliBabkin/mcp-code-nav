// the source root a C++ call gets when its caller declared none. Pure over the translation
// units the compile database lists, so every handler states the same boundary for the same database.

import { basename, dirname, resolve } from "node:path";
import { escapesRoot, pathKey } from "../paths/path-containment.js";
import { isSkippedDirName } from "../paths/cpp-sources.js";

/** How far above `projectRoot` a derived source root may sit; four covers `out/build/<preset>` plus one. */
export const SOURCE_ROOT_MAX_ASCENT = 4;

/** Why no root was derived; `sources-under-project-root` is not a failure - projectRoot alone is the tree. */
export type SourceRootDerivationReason =
  | "compile-db-unlistable"
  | "sources-under-project-root"
  | "no-ancestor-holds-sources";

export type SourceRootDerivation =
  | { readonly kind: "derived"; readonly root: string; readonly tusOutsideRoots: number }
  | { readonly kind: "none"; readonly reason: SourceRootDerivationReason };

/**
 * The ancestors of `projectRoot`, nearest first: at most `SOURCE_ROOT_MAX_ASCENT` levels up, never a filesystem
 * root. Every level counts, whether or not the caller later passes over it.
 */
export function boundedAncestors(projectRoot: string): string[] {
  const ancestors: string[] = [];
  let current = resolve(projectRoot);
  for (let level = 1; level <= SOURCE_ROOT_MAX_ASCENT; level++) {
    const parent = dirname(current);
    if (parent === current || dirname(parent) === parent) break;
    current = parent;
    ancestors.push(current);
  }
  return ancestors;
}

/**
 * The nearest ancestor of `projectRoot` that holds a translation unit the database names outside `projectRoot`,
 * within `SOURCE_ROOT_MAX_ASCENT` levels, never a filesystem root and never a directory the fingerprint walk
 * skips by name. `tus` undefined means the database could not be listed.
 */
export function deriveSourceRoot(projectRoot: string, tus: readonly string[] | undefined): SourceRootDerivation {
  if (tus === undefined) return { kind: "none", reason: "compile-db-unlistable" };
  const outside = tus.filter((tu) => escapesRoot(pathKey(projectRoot), pathKey(tu)));
  if (outside.length === 0) return { kind: "none", reason: "sources-under-project-root" };

  for (const ancestor of boundedAncestors(projectRoot)) {
    if (isSkippedDirName(basename(ancestor))) continue;
    const held = outside.filter((tu) => !escapesRoot(pathKey(ancestor), pathKey(tu)));
    if (held.length > 0) return { kind: "derived", root: ancestor, tusOutsideRoots: outside.length - held.length };
  }
  return { kind: "none", reason: "no-ancestor-holds-sources" };
}

/** The block every C++ `scope` / `sweep` carries. `roots` is exactly what containment used beside projectRoot. */
export type CppSourceRootsBlock =
  | { readonly origin: "declared"; readonly roots: readonly string[] }
  | { readonly origin: "derived"; readonly roots: readonly [string]; readonly tusOutsideRoots: number }
  | { readonly origin: "project-root-only"; readonly roots: readonly []; readonly reason: SourceRootDerivationReason };

/** Declared non-empty wins and derives nothing; otherwise the derivation decides. */
export function cppSourceRoots(declared: readonly string[], derive: () => SourceRootDerivation): CppSourceRootsBlock {
  if (declared.length > 0) return { origin: "declared", roots: declared };
  const derivation = derive();
  if (derivation.kind === "derived") {
    return { origin: "derived", roots: [derivation.root], tusOutsideRoots: derivation.tusOutsideRoots };
  }
  return { origin: "project-root-only", roots: [], reason: derivation.reason };
}
