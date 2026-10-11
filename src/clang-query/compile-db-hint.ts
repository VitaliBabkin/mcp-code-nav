// The sentences appended after the missing-compile-database head, naming the directories
// under the caller's `projectRoot` that do hold a `compile_commands.json`. The head itself stays
// byte-identical (`CompileDbNotFoundError.message`) because it is the `compile-db-missing` classifier's anchor.

import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isBuildDirName } from "../paths/cpp-sources.js";
import { CompileDbNotFoundError } from "./compile-db.js";

/** How far below `projectRoot` the search goes, in directory levels. */
export const HINT_MAX_DEPTH = 3;
/** How many `readdir` calls it makes, whichever of the two bounds ends the search first. */
export const HINT_MAX_DIRS = 2000;
/** How long it may take, in milliseconds, counted while a listing runs as well as between them. */
export const HINT_MAX_MS = 1000;
/** How many candidates the text names — the nearest, ties broken lexically. */
export const HINT_MAX_CANDIDATES = 3;
/** The largest `CMakeCache.txt` the generator sentence reads. */
export const CMAKE_CACHE_MAX_BYTES = 1_048_576;
/** How much of a sibling's `compile_commands.json` is read to find its first `"directory"`. */
export const DB_HEAD_BYTES = 65_536;
/** How many sibling directories the sibling search lists. */
export const SIBLING_MAX_LISTINGS = 64;
/** How many host-native sibling databases the text names. */
export const SIBLING_MAX_CANDIDATES = 3;

const COMPILE_DB = "compile_commands.json";

/**
 * Directories the search never enters. Deliberately not `isSkippedDirName`: that walk skips `out`, `build*`
 * and `cmake-build*` because they hold no sources, and this one is looking for a build directory — skipping
 * those names would hide exactly the answer the caller needs.
 */
const SKIPPED_DIR_NAMES = new Set([".git", "node_modules", ".cache", ".vs", ".idea", "vcpkg_installed", ".claude"]);

/** One entry of a directory listing, as `node:fs/promises` reports it. */
export type DirEntry = { readonly name: string; isFile(): boolean; isDirectory(): boolean };

/** The listing seam: one call per directory the search reads, and the only file system fact it asks for. */
export type ReaddirFn = (dir: string) => Promise<readonly DirEntry[]>;

export interface CompileDbHintDeps {
  readonly readdir?: ReaddirFn;
  readonly now?: () => number;
  /** The first `maxBytes` bytes of a regular file as text; `undefined` on any failure or for a non-file. */
  readonly readFile?: (path: string, maxBytes: number) => Promise<string | undefined>;
}

type ReadFileFn = NonNullable<CompileDbHintDeps["readFile"]>;

/** The seams one call resolves once, with the clock reading taken when the downward search started. */
interface HintIo {
  readonly readdir: ReaddirFn;
  readonly readFile: ReadFileFn;
  readonly now: () => number;
  readonly startedAt: number;
}

/** Which bound ended the search, so the text can name it; `undefined` means the search ran out of tree first. */
type StoppedBy = "directories" | "ms";

interface Search {
  /** Listings that answered — the only directories the text may claim to have searched. */
  readonly listings: number;
  readonly candidates: readonly string[];
  /** Why `projectRoot`'s own listing produced nothing, which is when nothing below it can be claimed at all. */
  readonly rootUnreadable?: string;
  readonly stoppedBy?: StoppedBy;
}

type Listing =
  | { readonly kind: "entries"; readonly entries: readonly DirEntry[] }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "bound" };

/**
 * The full missing-database text: the unchanged head, then one of the four variants — a named
 * candidate set, an exhaustive none, an absent root, or a database present but unreadable — with the bound
 * sentence appended when a walk was cut short. A fifth sentence states the one case the four variants do not
 * cover: a root whose own listing could not be read, where "no directory under it holds one" would be a
 * claim this search is not entitled to make. Variants 1, 2 and 5 then carry the CMake generator sentence, and
 * variants 2, 3 and 5 the sibling-build sentences. Never rejects: a diagnostic that cannot
 * be built must not cost the caller the error it was there to explain.
 */
export async function describeMissingCompileDb(
  projectRoot: string,
  deps: CompileDbHintDeps = {},
): Promise<string> {
  const head = new CompileDbNotFoundError(projectRoot).message;
  const now = deps.now ?? Date.now;
  const io: HintIo = {
    readdir: deps.readdir ?? readEntries,
    readFile: deps.readFile ?? readHead,
    now,
    startedAt: now(),
  };
  if (!existsSync(projectRoot)) {
    return `${head}. That directory does not exist.${await siblingSentences(projectRoot, io)}`;
  }
  if (existsSync(join(projectRoot, COMPILE_DB))) return `${head}. The file is present but could not be read.`;

  const search = await searchBelowRoot(projectRoot, io);
  const generator = await generatorSentence(projectRoot, io.readFile);
  const siblings = search.candidates.length === 0 ? await siblingSentences(projectRoot, io) : "";
  if (search.rootUnreadable !== undefined) {
    return (
      `${head}. That directory's own listing could not be read (${search.rootUnreadable}), ` +
      `so nothing below it was searched.${generator}${siblings}`
    );
  }
  const body =
    search.candidates.length === 0
      ? `. No directory under it holds one (searched ${search.listings} directories to depth ${HINT_MAX_DEPTH}). ` +
        "projectRoot must be the directory that holds compile_commands.json, from a native build on this host."
      : `. Directories under it that hold a compile_commands.json, nearest first: ` +
        `${quoteAll(search.candidates)}. Pass one of them as projectRoot.`;
  return `${head}${body}${boundSentence(search.stoppedBy)}${generator}${siblings}`;
}

async function readEntries(dir: string): Promise<readonly DirEntry[]> {
  return readdir(dir, { withFileTypes: true });
}

/** One directory in the search's frontier, with how far below `projectRoot` it sits. */
type Frontier = { readonly dir: string; readonly depth: number };

/**
 * Breadth-first over `projectRoot`'s descendants only, listing the root to reach depth 1 and stopping at
 * depth 3. Never leaves the root and never follows a symlink: a `Dirent` reports a symlink as neither file
 * nor directory, so a linked directory is not entered and a linked `compile_commands.json` is not a candidate.
 * `projectRoot` itself is never a candidate — a database there is the caller's own file, which is variant 4's
 * case or no error at all.
 */
async function searchBelowRoot(root: string, io: HintIo): Promise<Search> {
  const { readdir: readdirFn, now, startedAt } = io;
  const candidates: string[] = [];
  // The frontier is the queue: appending a directory's children while this loop walks the array is what reads
  // the tree one level at a time, each level in lexical order, which is the order the text claims.
  const frontier: Frontier[] = [{ dir: root, depth: 0 }];
  let listings = 0;
  let reads = 0;
  let rootUnreadable: string | undefined;

  // Nothing has answered only while the root's own listing is outstanding, so a bound struck before the first
  // answer belongs to the root exactly as a refused listing does.
  const stopped = (bound: StoppedBy): Search => ({
    listings,
    candidates,
    stoppedBy: bound,
    rootUnreadable: listings === 0 ? boundReason() : rootUnreadable,
  });

  for (const { dir, depth } of frontier) {
    if (reads >= HINT_MAX_DIRS) return stopped("directories");
    const budgetMs = HINT_MAX_MS - (now() - startedAt);
    if (budgetMs <= 0) return stopped("ms");
    reads++;
    const read = await listed(readdirFn, dir, budgetMs);
    if (read.kind === "bound") return stopped("ms");
    if (read.kind === "failed") {
      // A subdirectory that will not open is a hole the count keeps honest about; the root refusing is a
      // different fact, because every other directory was reached through it.
      if (listings === 0) rootUnreadable = read.reason;
      continue;
    }
    listings++;
    if (depth > 0 && holdsCompileDb(read.entries)) {
      candidates.push(dir);
      if (candidates.length >= HINT_MAX_CANDIDATES) return { listings, candidates };
    }
    frontier.push(...childrenOf(dir, read.entries, depth));
  }
  return { listings, candidates, rootUnreadable };
}

/** A directory is a candidate when its own listing holds a `compile_commands.json` that is a file. */
function holdsCompileDb(entries: readonly DirEntry[]): boolean {
  return entries.some((entry) => entry.name === COMPILE_DB && entry.isFile());
}

/**
 * The next level one listing hands on, in lexical order: real directories only, so a symlink is never entered;
 * none of the names that never hold a database; and nothing once the search has reached its depth, because a
 * depth-3 listing's own subdirectories would never be read.
 */
function childrenOf(dir: string, entries: readonly DirEntry[], depth: number): Frontier[] {
  if (depth >= HINT_MAX_DEPTH) return [];
  return entries
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIR_NAMES.has(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort()
    .map((path) => ({ dir: path, depth: depth + 1 }));
}

/**
 * `readdir` is not cancellable, so the search walks away from a listing that overruns the budget instead of
 * waiting for it. Both of the reading's outcomes are settled here, which is also what keeps a listing that
 * fails after the bound from surfacing as an unhandled rejection.
 */
async function listed(readdirFn: ReaddirFn, dir: string, budgetMs: number): Promise<Listing> {
  const read = await withinBudget(() => readdirFn(dir), budgetMs);
  return read.kind === "done" ? { kind: "entries", entries: read.value } : read;
}

type Raced<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "bound" };

/** Races one read against the remaining budget, settling both of its outcomes so a late failure cannot go unhandled. */
async function withinBudget<T>(read: () => Promise<T>, budgetMs: number): Promise<Raced<T>> {
  const reading: Promise<Raced<T>> = read().then(
    (value): Raced<T> => ({ kind: "done", value }),
    (error: unknown): Raced<T> => ({ kind: "failed", reason: errorCode(error) }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<Raced<T>>((settle) => {
    timer = setTimeout(() => settle({ kind: "bound" }), budgetMs);
  });
  try {
    return await Promise.race([reading, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/** The errno code alone: the head already names `projectRoot`, so a path repeated here is noise to branch on. */
function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "no error code";
}

function boundSentence(stoppedBy: StoppedBy | undefined): string {
  if (stoppedBy === undefined) return "";
  const bound = stoppedBy === "directories" ? `${HINT_MAX_DIRS} directories` : `${HINT_MAX_MS} ms`;
  return ` The search stopped at its bound (${bound}), so it may have missed candidates.`;
}

function boundReason(): string {
  return `the ${HINT_MAX_MS} ms bound`;
}

function quoteAll(paths: readonly string[]): string {
  return paths.map((path) => `"${path}"`).join(", ");
}

/** The first `"directory"` value of a compile database; the entry's working directory, an absolute path on its host. */
const FIRST_DIRECTORY = /"directory"\s*:\s*"((?:[^"\\]|\\.)*)"/;

const VS_GENERATOR_PREFIX = "Visual Studio";
const CMAKE_TRUTH_VALUES = new Set(["ON", "1", "YES", "TRUE", "Y"]);

/**
 * What `<projectRoot>/CMakeCache.txt` says about why no database was written: a generator that never writes one,
 * or an export switch left off. Empty when the cache is absent, unreadable, oversized or unremarkable — the hint
 * never rejects. The seam is asked for one byte past the bound, so a cache over it reads as oversized, and the
 * read gets its own `HINT_MAX_MS` rather than what the downward search left, which may be nothing.
 */
async function generatorSentence(projectRoot: string, readFile: ReadFileFn): Promise<string> {
  try {
    const cachePath = join(projectRoot, "CMakeCache.txt");
    const read = await withinBudget(() => readFile(cachePath, CMAKE_CACHE_MAX_BYTES + 1), HINT_MAX_MS);
    const text = read.kind === "done" ? read.value : undefined;
    if (text === undefined || Buffer.byteLength(text) > CMAKE_CACHE_MAX_BYTES) return "";
    const generator = cacheValue(text, "CMAKE_GENERATOR:INTERNAL");
    if (generator === undefined) return "";
    if (generator.startsWith(VS_GENERATOR_PREFIX) || generator === "Xcode") {
      return (
        ` This is a CMake build with the "${generator}" generator, which never writes compile_commands.json: ` +
        "configure a Ninja or Makefile build of it with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON and pass that build " +
        "directory as projectRoot."
      );
    }
    const exported = cacheValue(text, "CMAKE_EXPORT_COMPILE_COMMANDS:BOOL");
    if (exported !== undefined && CMAKE_TRUTH_VALUES.has(exported.toUpperCase())) return "";
    return (
      " This is a CMake build configured without CMAKE_EXPORT_COMPILE_COMMANDS=ON: reconfigure it with " +
      "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON to get one."
    );
  } catch {
    return "";
  }
}

/** The value of the first `<key>=<value>` line of a CMake cache. */
function cacheValue(cache: string, key: string): string | undefined {
  for (const line of cache.split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return undefined;
}

interface SiblingSearch {
  readonly natives: readonly string[];
  /** Sibling databases whose `"directory"` is not a directory on this host. */
  readonly foreign: number;
  readonly stoppedBy?: StoppedBy;
}

/**
 * The sibling-build sentences: host-native databases beside `projectRoot`, a count of the foreign ones, and
 * the bound that cut the search short. Empty when `projectRoot` has no parent to read.
 */
async function siblingSentences(projectRoot: string, io: HintIo): Promise<string> {
  try {
    const parent = dirname(projectRoot);
    if (parent === projectRoot) return "";
    const found = await searchSiblings(projectRoot, parent, io);
    const native =
      found.natives.length === 0
        ? ""
        : ` Sibling build directories that hold one from this host: ${quoteAll(found.natives)}. ` +
          "Pass one of them as projectRoot if it is the build you meant.";
    const foreign =
      found.foreign === 0
        ? ""
        : ` Skipped ${found.foreign} sibling compile_commands.json naming paths that do not exist on this host.`;
    return `${native}${foreign}${siblingBoundSentence(found.stoppedBy)}`;
  } catch {
    return "";
  }
}

function siblingBoundSentence(stoppedBy: StoppedBy | undefined): string {
  if (stoppedBy === undefined) return "";
  const bound = stoppedBy === "directories" ? `${SIBLING_MAX_LISTINGS} directories` : `${HINT_MAX_MS} ms`;
  return ` The sibling search stopped at its bound (${bound}), so it may have missed candidates.`;
}

/**
 * Visits the directories beside `projectRoot` in lexical order. A sibling is offered only inside one build tree
 * — a build-named parent or a build-named sibling — so a repository-root `projectRoot` never reaches a
 * neighbouring project. The parent's own listing is not one of the `SIBLING_MAX_LISTINGS`.
 */
async function searchSiblings(projectRoot: string, parent: string, io: HintIo): Promise<SiblingSearch> {
  const remaining = (): number => HINT_MAX_MS - (io.now() - io.startedAt);
  let budget = remaining();
  if (budget <= 0) return { natives: [], foreign: 0, stoppedBy: "ms" };
  const parentListing = await listed(io.readdir, parent, budget);
  if (parentListing.kind === "bound") return { natives: [], foreign: 0, stoppedBy: "ms" };
  if (parentListing.kind === "failed") return { natives: [], foreign: 0 };

  const inBuildTree = isBuildDirName(basename(parent));
  const names = parentListing.entries
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIR_NAMES.has(entry.name))
    .filter((entry) => entry.name !== basename(projectRoot))
    .map((entry) => entry.name)
    .filter((name) => inBuildTree || isBuildDirName(name))
    .sort();

  const natives: string[] = [];
  let foreign = 0;
  let listings = 0;
  for (const name of names) {
    if (listings >= SIBLING_MAX_LISTINGS) return { natives, foreign, stoppedBy: "directories" };
    budget = remaining();
    if (budget <= 0) return { natives, foreign, stoppedBy: "ms" };
    listings++;
    const dir = join(parent, name);
    const verdict = await classifySibling(dir, io, budget);
    if (verdict === "bound") return { natives, foreign, stoppedBy: "ms" };
    if (verdict === "foreign") foreign++;
    if (verdict === "native") {
      natives.push(dir);
      if (natives.length >= SIBLING_MAX_CANDIDATES) break;
    }
  }
  return { natives, foreign };
}

/** `none` when the sibling holds no database file; `native` when its recorded working directory exists here. */
async function classifySibling(
  dir: string,
  io: HintIo,
  budgetMs: number,
): Promise<"none" | "native" | "foreign" | "bound"> {
  const read = await listed(io.readdir, dir, budgetMs);
  if (read.kind === "bound") return "bound";
  if (read.kind === "failed" || !holdsCompileDb(read.entries)) return "none";
  const remaining = HINT_MAX_MS - (io.now() - io.startedAt);
  if (remaining <= 0) return "bound";
  const head = await withinBudget(() => io.readFile(join(dir, COMPILE_DB), DB_HEAD_BYTES), remaining);
  if (head.kind === "bound") return "bound";
  if (head.kind !== "done" || head.value === undefined) return "foreign";
  const named = await namesHostDirectory(head.value, remaining);
  if (named === "bound") return "bound";
  return named ? "native" : "foreign";
}

/**
 * Whether the database head's first `"directory"` is an absolute path to a directory that exists here. The path
 * comes from file content and may sit on a share that never answers, so the `stat` runs inside the budget.
 */
async function namesHostDirectory(head: string, budgetMs: number): Promise<boolean | "bound"> {
  const raw = FIRST_DIRECTORY.exec(head)?.[1];
  if (raw === undefined) return false;
  let directory: unknown;
  try {
    directory = JSON.parse(`"${raw}"`);
  } catch {
    return false;
  }
  if (typeof directory !== "string" || !isAbsolute(directory)) return false;
  const checked = await withinBudget(async () => (await stat(directory)).isDirectory(), budgetMs);
  if (checked.kind === "bound") return "bound";
  return checked.kind === "done" && checked.value;
}

/** Reads at most `maxBytes` from the start of a regular file; `undefined` for anything else or any failure. */
async function readHead(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    // `stat` before `open`: opening a FIFO blocks until a writer appears.
    if (!(await stat(path)).isFile()) return undefined;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
