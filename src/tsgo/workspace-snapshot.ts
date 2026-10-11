import { readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { fileStamp } from "../lsp/file-stamp.js";
import type { ModuleSnapshotFn } from "../lsp/module-freshness.js";
import { pathKey } from "../paths/path-containment.js";
import { readConfigGraph } from "./config-graph.js";
import { isTsOrJsSourceFile } from "./language.js";

/**
 * The workspace walk behind what tsgo is told about the disk, and what a project map is
 * built from. It is the module walk's shape over a wider subject — a TS answer depends on every source the
 * compiler may load, on the manifests that decide the root, and on every config the config set reaches by
 * resolution, not merely on the files whose names look like configs.
 */

/**
 * The shared entry bound, the same number the Go module walk runs on. Over it the walk reports
 * nothing rather than a partial set: a snapshot that has missed a file would report the disk unchanged.
 */
const MAX_WALK_ENTRIES = 20_000;

/** Linked dependencies are a compiler's own business, and never part of a workspace's source set. */
const SKIPPED_DIR_NAMES = new Set(["node_modules"]);

/** The manifests a workspace's shape depends on: the root's links, and every config by its own name. */
const MANIFEST_NAMES = new Set(["package.json", "tsconfig.json", "jsconfig.json"]);

const UNSTATTABLE = "unreadable";

interface WalkState {
  readonly maxEntries: number;
  readonly entries: Map<string, string>;
  /** The config filenames the walk found, which are the seeds of the closure. */
  readonly configs: string[];
  scanned: number;
  incomplete: boolean;
  /** A directory this server was told to walk could not be listed - a different fact than "too large". */
  unreadable: boolean;
}

/** Why the last walk of a root could not prove its closure, kept so a reload can name the config. */
const unprovable = new Map<string, string>();

/**
 * The paths the last completed walk of a root saw, kept for the project map when the closure could not be
 * proved. The walk also returns what it could not resolve, so the project map is still built from the paths
 * it did see: an unprovable closure withholds the SNAPSHOT, which makes every call answer from a fresh
 * process, and does not make the workspace's projects unknown (the project set and its `failed` entries are
 * still reported).
 *
 * Recorded only while the closure is unprovable — while it is provable the caller reads the session's own
 * baseline — and dropped by any later walk of the same root that either proves the closure or does not finish,
 * so a partial view of a tree is never handed out as a set the map may be built from.
 */
const walkedPaths = new Map<string, readonly string[]>();

function isSkippedDirName(name: string): boolean {
  return SKIPPED_DIR_NAMES.has(name) || name.startsWith(".");
}

function isTrackedFile(name: string): boolean {
  return MANIFEST_NAMES.has(name) || isTsOrJsSourceFile(name);
}

function claimEntry(state: WalkState): boolean {
  if (state.scanned >= state.maxEntries) {
    state.incomplete = true;
    return false;
  }
  state.scanned++;
  return true;
}

function visitFile(state: WalkState, path: string, name: string): void {
  if (!isTrackedFile(name)) return;
  state.entries.set(path, fileStamp(path) ?? UNSTATTABLE);
  if (name === "tsconfig.json" || name === "jsconfig.json") state.configs.push(path);
}

function visitDir(state: WalkState, dir: string): void {
  let listed: Dirent[];
  try {
    listed = readdirSync(dir, { withFileTypes: true });
  } catch {
    state.incomplete = true;
    state.unreadable = true;
    return;
  }
  for (const entry of listed) {
    if (!claimEntry(state)) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isSkippedDirName(entry.name)) visitDir(state, path);
    } else if (entry.isFile()) {
      visitFile(state, path, entry.name);
    }
  }
}

/**
 * The closure's own files, added to the snapshot so an edit to any of them is a change. A config the graph
 * resolved is stat'ed under the name it resolved to, which is how `compiler-options.json` — a file no config
 * filename rule would ever look at — ends up watched.
 */
function stampClosure(state: WalkState, closure: readonly string[]): void {
  for (const path of closure) {
    if (state.entries.has(path)) continue;
    state.entries.set(path, fileStamp(path) ?? UNSTATTABLE);
  }
}

/**
 * One workspace's disk state: every TS/JS source, `package.json`, `tsconfig.json` and `jsconfig.json` under
 * `root` — skipping `node_modules` and dot-prefixed directories — plus every file those configs reach through
 * `references` and `extends`.
 *
 * `undefined` means the walk could not finish, which is a different fact from `unresolved` being non-empty:
 * the first says the tree was too large to see, the second that a config's closure leads somewhere this
 * server cannot follow. Both leave a type-aware answer unprovable; only the second can name the config.
 */
export function walkWorkspace(
  root: string,
): { readonly entries: Map<string, string>; readonly unresolved: readonly string[] } | undefined {
  const start = resolve(root);
  const state: WalkState = {
    maxEntries: MAX_WALK_ENTRIES,
    entries: new Map(),
    configs: [],
    scanned: 0,
    incomplete: false,
    unreadable: false,
  };
  visitDir(state, start);
  if (state.incomplete) {
    // Nothing was proved about this tree, so nothing may be handed to the map builder from it either.
    walkedPaths.delete(pathKey(start));
    unprovable.set(
      pathKey(start),
      state.unreadable
        ? `the workspace walk under "${start}" could not list a directory it was told to walk`
        : `the workspace walk under "${start}" did not complete within its ${MAX_WALK_ENTRIES}-entry bound`,
    );
    return undefined;
  }
  const graph = readConfigGraph(state.configs, start);
  stampClosure(state, graph.closure);
  if (graph.unresolved.length > 0) {
    // The reload says which spec could not be followed and in which config, and how
    // many others joined it — a list of one is the common case and reading it should not cost a sentence.
    const [first = "", ...others] = graph.unresolved;
    const tail = others.length === 0 ? "" : `, and ${others.length} other unresolved ${others.length === 1 ? "member" : "members"}`;
    unprovable.set(pathKey(start), `the config closure under "${start}" is not provable: ${first}${tail}`);
    walkedPaths.set(pathKey(start), [...state.entries.keys()]);
  } else {
    unprovable.delete(pathKey(start));
    walkedPaths.delete(pathKey(start));
  }
  return { entries: state.entries, unresolved: graph.unresolved };
}

/**
 * Why a workspace's snapshot could not be taken: the entry bound, or a config whose closure leads to
 * nothing or outside the root. `undefined` when the last walk proved everything, so a caller states the
 * reason it actually has rather than the one its template knows.
 */
export function workspaceSnapshotReason(root: string): string | undefined {
  return unprovable.get(pathKey(resolve(root)));
}

/**
 * The paths the last walk of `root` saw, when that walk proved its closure could not be proved. `undefined`
 * while the closure is provable — the session's own baseline is the set a caller should then read — and after
 * a walk that did not finish, which saw nothing it would vouch for.
 */
export function workspaceWalkedPaths(root: string): readonly string[] | undefined {
  return walkedPaths.get(pathKey(resolve(root)));
}

/**
 * The snapshot function. An unprovable closure yields no snapshot, which makes every call reload the
 * session and answer from a fresh process — slow, and never stale. The paths the walk did see are kept beside
 * it for the project map, which is built from them anyway (`workspaceWalkedPaths`).
 */
export const takeWorkspaceSnapshot: ModuleSnapshotFn = (root) => {
  const walked = walkWorkspace(root);
  if (walked === undefined) return undefined;
  return walked.unresolved.length > 0 ? undefined : walked.entries;
};
