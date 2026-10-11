import { createHash } from "node:crypto";
import { readdirSync, type Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileStamp } from "../lsp/file-stamp.js";
import { isCppSourceName, isCppTrackedName, isSkippedDirName } from "../paths/cpp-sources.js";
import { escapesRoot, isEscapingRelative, pathKey } from "../paths/path-containment.js";

/** Absent `fingerprint` means the project could not be fingerprinted within bounds — caching is off for that call. */
export interface ProjectFingerprint {
  readonly fingerprint?: string;
  readonly reason?: string;
  readonly entriesScanned: number;
  /** TU-extension sources under a declared source root, absolute, before `ignoredPaths`; undefined without source roots. */
  readonly sourceTus?: readonly string[];
  /** ANY `readdirSync` failed, even outside every source root — the walk cannot cheaply attribute a failure. */
  readonly walkIncomplete: boolean;
  /** Declared source roots the nested-root dedupe dropped whose directory the walk never entered. */
  readonly unreachableSourceRoots: readonly string[];
}

const DEFAULT_MAX_ENTRIES = 20_000;

/** A root nested inside another declared root is walked once, from the outer root only. */
function dedupeNestedRoots(roots: string[]): string[] {
  const unique = Array.from(new Set(roots));
  return unique.filter((candidate) => {
    return !unique.some((other) => {
      if (other === candidate) return false;
      // Strictly inside: an empty `relative` is one directory in two spellings, which stays two roots here.
      const rel = relative(other, candidate);
      return rel !== "" && !isEscapingRelative(rel);
    });
  });
}

function statLine(path: string): string {
  // Deterministic rather than silently absent from the hash — an unreadable file must still
  // change the fingerprint if it starts being readable (or vice versa).
  return `${path}|${fileStamp(path) ?? "ERR"}`;
}

interface DroppedRoot {
  readonly root: string;
  readonly key: string;
}

/** One walk's accumulators: the fingerprint's input lines plus the by-products read off the same pass. */
interface WalkState {
  readonly maxEntries: number;
  /** Declared source roots, pre-dedupe: deduplication decides which directories are traversed, never which files qualify. */
  readonly sourceRoots: readonly string[];
  /** `pathKey` of the dropped source roots; only their directories are recorded in `visited`. */
  readonly droppedKeys: ReadonlySet<string>;
  readonly lines: string[];
  readonly sourceTus: string[];
  /** The `droppedKeys` a successful `readdir` entered. */
  readonly visited: Set<string>;
  entriesScanned: number;
  walkIncomplete: boolean;
}

function underSourceRoot(path: string, sourceRoots: readonly string[]): boolean {
  return sourceRoots.some((root) => !escapesRoot(root, path));
}

function isBounded(state: WalkState): boolean {
  return state.entriesScanned > state.maxEntries;
}

function visitFile(path: string, name: string, state: WalkState, inSourceRoot: boolean): void {
  if (!isCppTrackedName(name)) return;
  state.lines.push(statLine(path));
  if (inSourceRoot && isCppSourceName(name)) state.sourceTus.push(path);
}

function visitEntry(entry: Dirent, dir: string, state: WalkState, inSourceRoot: boolean): void {
  if (entry.isSymbolicLink()) return;
  const path = join(dir, entry.name);
  if (entry.isDirectory()) {
    // A walk root's own name is never skipped, only a directory reached through a parent.
    if (!isSkippedDirName(entry.name)) {
      visitDir(path, state, inSourceRoot || underSourceRoot(path, state.sourceRoots));
    }
    return;
  }
  if (entry.isFile()) visitFile(path, entry.name, state, inSourceRoot);
}

/** `true` while this entry is still inside the walk's bound. */
function claimEntry(state: WalkState): boolean {
  if (isBounded(state)) return false;
  state.entriesScanned++;
  return !isBounded(state);
}

function readEntries(dir: string, state: WalkState): Dirent[] | undefined {
  if (isBounded(state)) return undefined;
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    state.walkIncomplete = true;
    return undefined;
  }
}

/** `inSourceRoot` is decided once per directory: everything below a directory inside a source root is too. */
function visitDir(dir: string, state: WalkState, inSourceRoot: boolean): void {
  const entries = readEntries(dir, state);
  if (entries === undefined) return;
  if (state.droppedKeys.size > 0) {
    const key = pathKey(dir);
    if (state.droppedKeys.has(key)) state.visited.add(key);
  }
  for (const entry of entries) {
    if (!claimEntry(state)) return;
    visitEntry(entry, dir, state, inSourceRoot);
  }
}

/** Both returns carry these: the reason code, not an absent field, tells the caller a bounded walk's mean nothing. */
function byProducts(
  state: WalkState,
  dropped: readonly DroppedRoot[],
): Pick<ProjectFingerprint, "sourceTus" | "walkIncomplete" | "unreachableSourceRoots"> {
  return {
    sourceTus: state.sourceRoots.length === 0 ? undefined : state.sourceTus,
    walkIncomplete: state.walkIncomplete,
    unreachableSourceRoots: dropped.filter(({ key }) => !state.visited.has(key)).map(({ root }) => root),
  };
}

/**
 * SHA-1 over path-sorted `"<abs>|<size>|<mtimeMs>"` lines for the compile database and every C/C++
 * source under `roots`. `roots` is `[projectRoot, ...sourceRoots]` by convention — `roots[0]` names
 * `projectRoot` for the always-included `compile_commands.json` line.
 *
 * The walk skips every directory `isSkippedDirName` names — `.git`, `.claude`, `node_modules`, `.cache`,
 * `.vs`, `.idea`, `vcpkg_installed`, `out`, and any name starting `build` or `cmake-build` — but never a
 * walk root itself, even if its own name matches (a build directory is the normal `projectRoot`).
 * Symlinked directories are not followed.
 *
 * The walk is bounded by `maxEntries` (default 20000), counted over every enumerated directory entry
 * so the walk's own cost is bounded regardless of what is skipped. Exceeding it disables the
 * fingerprint entirely rather than returning a partial one — a fingerprint that cannot prove itself
 * complete must never be treated as valid.
 *
 * Besides the hash it collects the sources it visited: one call's walk is the evidence
 * behind `uncoveredSources`, so no second walk and no cache entry is needed for that field.
 */
export function computeProjectFingerprint(
  roots: readonly string[],
  options?: { readonly maxEntries?: number },
): ProjectFingerprint {
  const resolvedRoots = roots.map((r) => resolve(r));
  const sourceRoots = resolvedRoots.slice(1);
  const walkedRoots = dedupeNestedRoots(resolvedRoots);
  const dropped: DroppedRoot[] = sourceRoots
    .filter((root) => !walkedRoots.includes(root))
    .map((root) => ({ root, key: pathKey(root) }));
  const state: WalkState = {
    maxEntries: options?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    sourceRoots,
    droppedKeys: new Set(dropped.map(({ key }) => key)),
    lines: [],
    sourceTus: [],
    visited: new Set<string>(),
    entriesScanned: 0,
    walkIncomplete: false,
  };
  const projectRoot = resolvedRoots[0];
  if (projectRoot !== undefined) {
    state.lines.push(statLine(join(projectRoot, "compile_commands.json")));
  }

  for (const root of walkedRoots) {
    visitDir(root, state, underSourceRoot(root, sourceRoots));
    if (isBounded(state)) break;
  }
  const collected = byProducts(state, dropped);

  if (isBounded(state)) {
    return {
      reason: `directory walk enumerated more than ${state.maxEntries} entries — caching disabled for this call`,
      entriesScanned: state.entriesScanned,
      ...collected,
    };
  }

  state.lines.sort();
  const fingerprint = createHash("sha1").update(state.lines.join("\n")).digest("hex");
  return { fingerprint, entriesScanned: state.entriesScanned, ...collected };
}
