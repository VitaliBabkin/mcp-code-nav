import { pathKey } from "./path-containment.js";

/**
 * The ranking both blind-spot signals emit (`sweep.uncoveredSources`, `scope.osArchExcluded`): one entry
 * per physical file, an exact count, and a capped list of paths in the spelling the caller's walk
 * reported, ordered by the normalised key so the prefix is stable across runs.
 */

/** A path plus the key that dedupes and orders it. */
export interface RankedPath {
  readonly file: string;
  readonly key: string;
}

/** An exact total beside the first `limit` paths of the set. */
export interface CappedList {
  readonly count: number;
  readonly files: readonly string[];
}

export function byNormalisedKey(a: RankedPath, b: RankedPath): number {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

/**
 * One entry per physical file, keeping the spelling first seen and the caller's order — on win32 one file
 * is routinely spelled two ways, and naming both would read as two files.
 */
export function rankPaths(files: Iterable<string>): RankedPath[] {
  const ranked: RankedPath[] = [];
  const keys = new Set<string>();
  for (const file of files) {
    const key = pathKey(file);
    if (keys.has(key)) continue;
    keys.add(key);
    ranked.push({ file, key });
  }
  return ranked;
}

/** The exact count, and the first `limit` files in normalised-key order, in the walked spelling. */
export function summariseRanked(ranked: readonly RankedPath[], limit: number): CappedList {
  const ordered = [...ranked].sort(byNormalisedKey);
  return { count: ordered.length, files: ordered.slice(0, limit).map((entry) => entry.file) };
}

/** Whether the set holds `file`, however it happens to be spelled. */
export function ranksFile(ranked: readonly RankedPath[], file: string): boolean {
  const key = pathKey(file);
  return ranked.some((entry) => entry.key === key);
}
