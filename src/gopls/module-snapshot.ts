import { existsSync, readdirSync, type Dirent } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileStamp } from "../lsp/file-stamp.js";

/**
 * Entries one walk may enumerate before it gives up. Counted over every directory entry seen, not over
 * the files kept, so the walk's own cost is bounded regardless of what a module contains. An
 * incomplete walk yields no snapshot at all: a snapshot that cannot prove itself complete must never be
 * treated as one.
 */
const MAX_SNAPSHOT_ENTRIES = 20_000;

/**
 * Directories whose contents are not part of this module's package graph, plus
 * `node_modules`: a frontend tree beside a Go module is never in the graph and is routinely large enough
 * to blow the entry bound on its own.
 */
const SKIPPED_DIR_NAMES = new Set(["vendor", "testdata", "node_modules"]);

const UNSTATTABLE = "unreadable";

interface WalkState {
  readonly maxEntries: number;
  readonly entries: Map<string, string>;
  scanned: number;
  /** No snapshot is produced once set, whether by the bound or by a directory the walk could not read. */
  incomplete: boolean;
}

function isSkippedDirName(name: string): boolean {
  return SKIPPED_DIR_NAMES.has(name) || name.startsWith("_") || name.startsWith(".");
}

/** A directory carrying its own `go.mod` is a separate module, so none of its files are in this graph. */
function isNestedModule(dir: string): boolean {
  return existsSync(join(dir, "go.mod"));
}

/** `.go` sources plus the module and workspace files, which are the only ones the graph depends on. */
function isTrackedFile(name: string): boolean {
  return extname(name) === ".go" || name === "go.mod" || name === "go.work";
}

function visitFile(dir: string, name: string, state: WalkState): void {
  if (!isTrackedFile(name)) return;
  const path = join(dir, name);
  // A file that cannot be stat'ed is recorded as such rather than dropped: it must still count as a
  // change if it becomes readable, the way the C++ fingerprint records an unreadable path.
  state.entries.set(path, fileStamp(path) ?? UNSTATTABLE);
}

function visitEntry(state: WalkState, dir: string, entry: Dirent): void {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) {
    if (!isSkippedDirName(entry.name) && !isNestedModule(path)) visitDir(state, path);
    return;
  }
  // A symlink is neither a file nor a directory to `readdir(withFileTypes)`, so it is neither followed nor
  // reported: nothing behind one is stat'ed through or named to the server as a file this module owns.
  if (entry.isFile()) visitFile(dir, entry.name, state);
}

/** `true` while this entry is still inside the walk's bound. */
function claimEntry(state: WalkState): boolean {
  if (state.scanned >= state.maxEntries) {
    state.incomplete = true;
    return false;
  }
  state.scanned++;
  return true;
}

function visitDir(state: WalkState, dir: string): void {
  let listed: Dirent[];
  try {
    listed = readdirSync(dir, { withFileTypes: true });
  } catch {
    state.incomplete = true;
    return;
  }
  for (const entry of listed) {
    if (!claimEntry(state)) return;
    visitEntry(state, dir, entry);
  }
}

/**
 * Every `.go`, `go.mod` and `go.work` file under `moduleRoot`, keyed by absolute path with a
 * `size|mtimeMs` value — the state a language server's loaded package graph must be proven against
 * before a type-aware answer is served from it. `undefined` means the walk could not complete within
 * its bound, which is reported as no proof rather than as a smaller snapshot.
 *
 * A deliberately separate walk from `src/clang-query/project-fingerprint.ts`: that one keys on the
 * compile database and C++ extensions to answer a different question, and the two invalidation
 * policies have no reason to move together.
 */
export function takeModuleSnapshot(
  moduleRoot: string,
  options?: { readonly maxEntries?: number },
): Map<string, string> | undefined {
  const state: WalkState = {
    maxEntries: options?.maxEntries ?? MAX_SNAPSHOT_ENTRIES,
    entries: new Map(),
    scanned: 0,
    incomplete: false,
  };
  visitDir(state, resolve(moduleRoot));
  return state.incomplete ? undefined : state.entries;
}
