import { resolve } from "node:path";
import { isIgnoredPath } from "../config/ignored-paths.js";
import { containingRoot, pathKey } from "../paths/path-containment.js";
import { rankPaths, summariseRanked, type CappedList, type RankedPath } from "../paths/ranked-paths.js";
import type { ProjectFingerprint } from "./project-fingerprint.js";

/** Sources the fingerprint walk VISITED under the declared source roots that no compile-database entry
 *  compiles — the project rules's scope limit, made visible. Directories the walk skips are outside the
 *  claim, as is the sweep's own scope. `count` is exact; `files` is capped, in the walked spelling. */
export type UncoveredSources = CappedList;

/** Why the set could not be determined; first match in this order wins. Exactly one of this and
 *  `UncoveredSources` is present on every response carrying `sweep`. `compile-db-unlistable` is reachable
 *  only on a `files`-scoped call — an unscoped one already fails on a missing database. */
export type UncoveredSourcesUnavailable =
  | "no-source-roots"
  | "walk-bounded"
  | "walk-incomplete"
  | "root-under-skipped-dir"
  | "ignored-paths-unreadable"
  | "compile-db-unlistable";

/** Capped so a misconfigured project (wrong build directory) cannot flood the payload; `count` stays exact. */
export const UNCOVERED_SOURCES_LIMIT = 20;

/** What the detection needs that only the calling layer can read, stated as facts rather than flags. */
export interface UncoveredSourceFacts {
  /** `[projectRoot, ...sourceRoots]`, in root order — `ignoredPaths` is keyed against whichever of these
   *  first contains a source, exactly as the resolver keys it. */
  readonly roots: readonly string[];
  /** This call's fingerprint walk, by-products included. */
  readonly walk: ProjectFingerprint;
  /** Every TU named in `compile_commands.json`; `undefined` when this call could not list the database. */
  readonly compileDbTus: readonly string[] | undefined;
  /** The project's `ignoredPaths`, `undefined` when its config failed to load. Called only once the walk's
   *  own proofs have held, so a signal refused for a cheaper reason costs no config read. */
  readonly readIgnoredPaths: () => readonly string[] | undefined;
}

/** The two mutually exclusive keys; a response carrying `sweep` always has exactly one. */
export type UncoveredSourcesBlock =
  | { readonly uncoveredSources: UncoveredSources }
  | { readonly uncoveredSourcesUnavailable: UncoveredSourcesUnavailable };

/**
 * A file with no compile-database entry is not rejected by clang-query (measured, 22.1.3): it is run with
 * flags inferred from a neighbouring entry, so the absence can corrupt a result as easily as cause a failure.
 * `plural` selects the wording for several files.
 */
export function inferredFlagsCaveat(plural: boolean): string {
  const [ran, subject] = plural ? ["them", "them"] : ["it", "this file"];
  return (
    `clang-query ran ${ran} with flags inferred from other entries, ` +
    `so a failure or a result for ${subject} may reflect the wrong flags`
  );
}

/** The sources of `translationUnits` no entry in `compileDbTus` compiles, one per physical file, keyed once. */
function rankUnlisted(translationUnits: readonly string[], compileDbTus: readonly string[]): RankedPath[] {
  const excluded = new Set<string>();
  for (const tu of compileDbTus) excluded.add(pathKey(tu));
  return rankPaths(translationUnits.filter((tu) => !excluded.has(pathKey(tu))));
}

/**
 * The `translationUnits` no entry in `compileDbTus` compiles, in the caller's order and spelling, one per
 * physical file. Both sides are normalised: a compile database need not spell a path the way a walk or a
 * caller does, and on win32 a case difference alone would otherwise claim every source is uncovered.
 */
export function unlistedTranslationUnits(
  translationUnits: readonly string[],
  compileDbTus: readonly string[],
): string[] {
  return rankUnlisted(translationUnits, compileDbTus).map((entry) => entry.file);
}

/** Set difference between what the walk visited and what the compile database compiles, summarised. */
export function computeUncoveredSources(
  compileDbTus: readonly string[],
  sourceTus: readonly string[],
  limit: number = UNCOVERED_SOURCES_LIMIT,
): UncoveredSources {
  return summariseRanked(rankUnlisted(sourceTus, compileDbTus), limit);
}

/**
 * Drops the sources the project's `ignoredPaths` matches, keyed like `resolveAndCheckIgnored`: the first
 * root of `roots` containing the file supplies the relative path handed to the matcher, so a pattern
 * written against a `sourceRoots` entry can match at all. Case-sensitive, because `isIgnoredPath` is. A
 * source under none of the roots is kept — the filter never silently removes something it cannot place.
 */
export function filterIgnoredSources(
  sourceTus: readonly string[],
  roots: readonly string[],
  patterns: readonly string[],
): string[] {
  if (patterns.length === 0) return [...sourceTus];
  const absoluteRoots = roots.map((root) => resolve(root));
  return sourceTus.filter((source) => {
    const root = containingRoot(absoluteRoots, source);
    return root === undefined || !isIgnoredPath(root, source, patterns);
  });
}

function unavailable(reason: UncoveredSourcesUnavailable): UncoveredSourcesBlock {
  return { uncoveredSourcesUnavailable: reason };
}

/**
 * The uncovered-source decision in the precedence order. The project config is read only after the
 * walk's own proofs hold, so a call already refused on the walk costs no disk access.
 */
export function uncoveredSourcesBlock(facts: UncoveredSourceFacts): UncoveredSourcesBlock {
  const { roots, walk, compileDbTus, readIgnoredPaths } = facts;
  const sourceTus = walk.sourceTus;
  if (sourceTus === undefined) return unavailable("no-source-roots");
  // No fingerprint means the walk stopped at its entry bound, so nothing it collected can be trusted.
  if (walk.fingerprint === undefined) return unavailable("walk-bounded");
  if (walk.walkIncomplete) return unavailable("walk-incomplete");
  if (walk.unreachableSourceRoots.length > 0) return unavailable("root-under-skipped-dir");
  const ignoredPaths = readIgnoredPaths();
  if (ignoredPaths === undefined) return unavailable("ignored-paths-unreadable");
  if (compileDbTus === undefined) return unavailable("compile-db-unlistable");
  const unlisted = rankUnlisted(sourceTus, compileDbTus);
  const visible = new Set(
    filterIgnoredSources(
      unlisted.map((entry) => entry.file),
      roots,
      ignoredPaths,
    ),
  );
  return {
    uncoveredSources: summariseRanked(unlisted.filter((entry) => visible.has(entry.file)), UNCOVERED_SOURCES_LIMIT),
  };
}
