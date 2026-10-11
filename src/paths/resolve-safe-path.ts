import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { containingRoot, pathKey } from "./path-containment.js";

/**
 * Thrown when a caller-supplied path resolves outside every declared root, either lexically or, when
 * `realPath` is set, through a link whose target lies outside them.
 */
export class PathEscapeError extends Error {
  constructor(
    public readonly roots: string[],
    public readonly candidate: string,
    public readonly realPath?: string,
  ) {
    const rootList = roots.map((r) => `"${r}"`).join(", ");
    const linkNote =
      realPath === undefined
        ? ""
        : ` - the path resolves through a link to "${realPath}"; to read it, add that location to sourceRoots`;
    super(`path "${candidate}" escapes every declared root: ${rootList}${linkNote}`);
    this.name = "PathEscapeError";
  }
}

/**
 * `realpath` of `path`, where the part that does not exist yet is kept as written: the nearest existing
 * ancestor is resolved and the missing remainder joined back, so a missing file still fails downstream as
 * the ENOENT it is. `undefined` when the real path cannot be established (any other error, such as
 * EACCES or ELOOP): the caller must treat that as a denial.
 */
function realpathLoose(path: string): string | undefined {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...missing.reverse());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const parent = dirname(existing);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === existing) return undefined;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/**
 * Whether `winner` leaves every real root. `undefined` when it stays inside; otherwise an object whose
 * `real` is the link target, or absent when the real path of `winner` could not be established. A root whose
 * real path cannot be established contains nothing.
 */
function linkEscape(absoluteRoots: readonly string[], winner: string): { real?: string } | undefined {
  const real = realpathLoose(winner);
  if (real === undefined) return {};
  const realRoots = absoluteRoots.flatMap((root) => realpathLoose(root) ?? []);
  return containingRoot(realRoots, real) === undefined ? { real } : undefined;
}

/**
 * Thrown when a relative path exists under more than one declared root. Choosing between them by root
 * order would be a guess dressed as an answer, so the caller is asked for the one
 * spelling that cannot be ambiguous.
 */
export class AmbiguousRelativePathError extends Error {
  constructor(
    public readonly candidate: string,
    public readonly candidates: readonly string[],
  ) {
    const candidateList = candidates.map((c) => `"${c}"`).join(", ");
    super(`path "${candidate}" exists under more than one declared root: ${candidateList} - pass an absolute path`);
    this.name = "AmbiguousRelativePathError";
  }
}

export interface ResolvedPath {
  absolutePath: string;
  /** Whichever root in `roots` actually contained `candidate` — not always `roots[0]`. */
  matchedRoot: string;
  /** Every spelling the resolver considered, in root order; length 1 for an absolute input or one root. */
  readonly triedPaths: readonly string[];
}

type ContainedCandidate = Pick<ResolvedPath, "absolutePath" | "matchedRoot">;

/**
 * A candidate is the same physical file as one already kept when the normalised keys match, so two roots
 * spelling one file differently are not an ambiguity.
 */
function distinctCandidates(candidates: ContainedCandidate[]): ContainedCandidate[] {
  const seen = new Set<string>();
  const distinct: ContainedCandidate[] = [];
  for (const candidate of candidates) {
    const key = pathKey(candidate.absolutePath);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(candidate);
  }
  return distinct;
}

/** Existence is a stat of the file itself: a directory at the candidate path does not satisfy it. */
export function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Either kind of path, for a caller whose argument may be a file or a directory — a Go module anchor is
 * one path whose own kind decides the question asked of it, so the ambiguity rule must be applied to
 * both shapes rather than silently treating a directory as absent.
 */
export function isExistingFileOrDirectory(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() || stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Existence selects the winner among candidates containment already allowed: one distinct
 * existing path wins, several distinct existing paths are an error naming them, and none existing leaves
 * the choice to root order, so a missing file still fails downstream as the ENOENT it is. `undefined` only
 * for an empty `contained`.
 */
function pickExisting(
  contained: ContainedCandidate[],
  exists: (path: string) => boolean,
  candidate: string,
): ContainedCandidate | undefined {
  if (contained.length === 1) return contained[0];
  const existing = distinctCandidates(contained.filter((c) => exists(c.absolutePath)));
  if (existing.length > 1) {
    throw new AmbiguousRelativePathError(
      candidate,
      existing.map((c) => c.absolutePath),
    );
  }
  return existing[0] ?? contained[0];
}

/**
 * Every path `candidate` could mean: itself when absolute, otherwise one spelling per declared root in
 * `roots` order, deduplicated because a caller may repeat a root.
 */
function candidatePaths(absoluteRoots: string[], candidate: string): string[] {
  if (isAbsolute(candidate)) return [resolve(candidate)];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const root of absoluteRoots) {
    const path = resolve(root, candidate);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Resolves `candidate` against every root in `roots` and verifies it stays within at least one of them:
 * containment first, then existence selects among the contained spellings, then the winner's real path
 * (links followed) must still lie within a real root.
 * Throws `PathEscapeError` or `AmbiguousRelativePathError`.
 */
export function resolveWithinAnyRoot(
  roots: string[],
  candidate: string,
  exists: (path: string) => boolean = isExistingFile,
): ResolvedPath {
  const absoluteRoots = roots.map((root) => resolve(root));
  const triedPaths = candidatePaths(absoluteRoots, candidate);
  const contained: ContainedCandidate[] = [];
  for (const path of triedPaths) {
    const matchedRoot = containingRoot(absoluteRoots, path);
    if (matchedRoot !== undefined) contained.push({ absolutePath: path, matchedRoot });
  }
  const winner = pickExisting(contained, exists, candidate);
  if (winner === undefined) throw new PathEscapeError(absoluteRoots, candidate);
  const realEscape = linkEscape(absoluteRoots, winner.absolutePath);
  if (realEscape !== undefined) throw new PathEscapeError(absoluteRoots, candidate, realEscape.real);
  return { ...winner, triedPaths };
}

/** Single-root convenience wrapper over `resolveWithinAnyRoot`. */
export function resolveSafePath(root: string, candidate: string): string {
  return resolveWithinAnyRoot([root], candidate).absolutePath;
}
