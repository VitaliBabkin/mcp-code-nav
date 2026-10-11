import { basename, dirname, extname, resolve } from "node:path";
import { defaultTsExec, type TsgoBinary, type TsExecFn, type TsExecResult } from "./binary.js";
import { readConfigGraph, unreadableConfigReason, type ConfigGraph } from "./config-graph.js";
import { isTsOrJsSourceFile } from "./language.js";
import { escapesRoot, pathKey } from "../paths/path-containment.js";
import type { SnapshotDiff } from "../lsp/module-freshness.js";

/**
 * The project map of a workspace: which tsconfig projects exist, which files each one
 * reads, which file this server opens so that project loads, and which sources no project includes.
 * Membership is read from the compiler itself — `tsc --listFilesOnly -p <config>` — and never from a
 * re-implemented glob, because the compiler's include/exclude/types resolution is the thing whose answer tsgo
 * is about to give.
 *
 * A listing says what a project *reads*, which is wider than what it *owns*: a file imported from a sibling
 * project appears in that sibling's listing too. A project's anchor is therefore its first member that the
 * project owns — opening a merely-listed file would load the project that owns it and leave this one out.
 */

/** More projects than this under one root, and the map is dropped rather than half-built. */
export const PROJECT_MAP_LIMIT = 32;

/** How many listings run at once: each is a `tsc.exe` holding a whole program, so this is memory, not speed. */
const LISTING_CONCURRENCY = 4;

const CONFIG_FILE_NAMES = new Set(["tsconfig.json", "jsconfig.json"]);

/** The manifests a structural change is judged by: a changed one alters which projects exist. */
const MANIFEST_NAMES = new Set(["package.json", ...CONFIG_FILE_NAMES]);

/** A path under any `node_modules` directory is a dependency, never a workspace member. */
const IN_NODE_MODULES = /[\\/]node_modules[\\/]/i;

const IS_DECLARATION_FILE = /\.d\.[cm]?ts$/i;

const JS_FAMILY = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/** One project: its config, the file this server holds open for it, and every member the compiler named. */
export interface TsProject {
  readonly config: string;
  /** The first member this project OWNS by the language service's rule; null for a solution config. */
  readonly anchor: string | null;
  readonly members: readonly string[];
}

export type ProjectFailure = { readonly config: string; readonly reason: string };

export type ProjectMap =
  | {
      readonly kind: "mapped";
      readonly projects: readonly TsProject[];
      readonly failed: readonly ProjectFailure[];
      /**
       * Configs that list members and own none of them, every one of those members being owned by a project
       * this map anchors. Such a project needs no anchor of its own:
       * every file it reads sits in a program that IS loaded, so no use in it is missing from an answer.
       */
      readonly subsumed: readonly string[];
      readonly uncovered: readonly string[];
      /**
       * `pathKey` of every walked TS or JS source to the config that owns it; a file no project owns is absent.
       */
      readonly owners: ReadonlyMap<string, string>;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** A map with the file set it was proved against, which is what a later freshness diff is compared with. */
export interface BuiltProjectMap {
  readonly map: ProjectMap;
  readonly closure: readonly string[];
  /**
   * A listing never answered, so the map records a failure that a second try may not reproduce. A cache keeps
   * such a map no longer than the call that built it.
   */
  readonly transient?: boolean;
}

/** One config's own answer about its files, or the reason this server has no answer. */
interface Listing {
  readonly config: string;
  readonly members: readonly string[];
  /**
   * Every member's `pathKey`, computed once for the listing. Membership is then asked per walked file — and a
   * query that scans the member list answers in the size of the project, which makes the whole build
   * quadratic and synchronous: `withinBudget` cannot pre-empt it, so one large project blocks every other
   * tool in this server while its map is made.
   */
  readonly memberKeys: ReadonlySet<string>;
  readonly failure?: ProjectFailure;
  /** The process never answered (timeout, kill, spawn error): a fact about that run, not about the config. */
  readonly transient?: boolean;
}

function extensionOf(path: string): string {
  return extname(path).toLowerCase();
}

/** Every source-family file the compiler named inside the root — deduplicated, in the order it named them. */
function listedMembers(stdout: string, root: string): string[] {
  const seen = new Set<string>();
  const members: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const path = line.trim();
    if (path === "") continue;
    const absolute = resolve(path);
    if (escapesRoot(root, absolute) || IN_NODE_MODULES.test(absolute)) continue;
    if (!isTsOrJsSourceFile(absolute) || IS_DECLARATION_FILE.test(absolute)) continue;
    const key = pathKey(absolute);
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(absolute);
  }
  return members;
}

/** The first line that says what went wrong, from either stream: a failed listing keeps its first error line. */
function errorLine(result: TsExecResult): string | undefined {
  const printed = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .find((line) => /error TS\d+/i.test(line));
  if (printed !== undefined) return printed.trim();
  if (result.spawnCode !== undefined) return `the listing did not answer (${result.spawnCode})`;
  if (result.exitCode === undefined) return "the listing gave no exit code";
  if (result.exitCode !== 0) return `the listing exited with code ${result.exitCode}`;
  return undefined;
}

function readListing(config: string, result: TsExecResult, root: string): Listing {
  const failure = errorLine(result);
  if (failure !== undefined) {
    return {
      config,
      members: [],
      memberKeys: new Set(),
      failure: { config, reason: failure },
      transient: result.spawnCode !== undefined,
    };
  }
  const members = listedMembers(result.stdout, root);
  return { config, members, memberKeys: new Set(members.map(pathKey)) };
}

/** A worker pool over `items`, so one workspace's projects do not become that many `tsc.exe` at once. */
async function inBatches<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

const NEAREST_CONFIG_TS = "tsconfig.json";
const NEAREST_CONFIG_JS = "jsconfig.json";

/** The projects that could be some file's nearest config, kept apart by the two names that can be one. */
interface DirectoryConfigs {
  readonly tsconfig?: string;
  readonly jsconfig?: string;
}

/**
 * Only a `tsconfig.json` or a `jsconfig.json` can be a file's nearest config. A solution layout's `tsconfig.app.json` reaches its files through `references`, not by living
 * beside them, and a directory holding both names keeps them apart with tsconfig first.
 */
function configsByDirectory(projects: readonly string[]): Map<string, DirectoryConfigs> {
  const byDirectory = new Map<string, DirectoryConfigs>();
  for (const config of projects) {
    const name = basename(config).toLowerCase();
    if (name !== NEAREST_CONFIG_TS && name !== NEAREST_CONFIG_JS) continue;
    const key = pathKey(dirname(config));
    const found: DirectoryConfigs = byDirectory.get(key) ?? {};
    byDirectory.set(
      key,
      name === NEAREST_CONFIG_TS ? { ...found, tsconfig: config } : { ...found, jsconfig: config },
    );
  }
  return byDirectory;
}

function listsFile(listings: ReadonlyMap<string, Listing>, config: string, file: string): boolean {
  return listings.get(config)?.memberKeys.has(pathKey(file)) ?? false;
}

/**
 * The nearest named config at or above `directory`, with the directory that holds it, so the search can be
 * resumed from that directory's parent.
 */
function nearestFrom(
  directory: string,
  byDirectory: ReadonlyMap<string, DirectoryConfigs>,
): { readonly config: string; readonly directory: string } | undefined {
  let current = directory;
  for (;;) {
    const found = byDirectory.get(pathKey(current));
    const config = found?.tsconfig ?? found?.jsconfig;
    if (config !== undefined) return { config, directory: current };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The project that owns `file`, following the language service's search: at the file's nearest named
 * config C, C owns the file when its own listing names it; otherwise the first config in C's `references` closure, depth-first in listed
 * order, that names it; otherwise the same two questions at the next named config above C's directory. The
 * search ends at the first owner, and a config outside the workspace is never in the graph to be asked.
 */
function ownerOf(
  file: string,
  listings: ReadonlyMap<string, Listing>,
  graph: ConfigGraph,
  byDirectory: ReadonlyMap<string, DirectoryConfigs>,
  workspaceRoot: string,
): string | undefined {
  let from = dirname(file);
  for (;;) {
    const start = nearestFrom(from, byDirectory);
    if (start === undefined) return undefined;
    if (listsFile(listings, start.config, file)) return start.config;
    const inClosure = firstInClosure(start.config, file, listings, graph);
    if (inClosure !== undefined) return inClosure;
    const above = dirname(start.directory);
    // The climb ends once the named config nearest the workspace root has been
    // tried. That bound is also this loop's only termination — `dirname("C:\\")` is `C:\\`, so a config living
    // at a filesystem root would otherwise make it ask the same directory forever, synchronously, inside a
    // budget that cannot pre-empt synchronous work.
    if (above === start.directory || escapesRoot(workspaceRoot, above)) return undefined;
    from = above;
  }
}

/** The first config in `start`'s `references` closure, depth-first in listed order, that lists `file`. */
function firstInClosure(
  start: string,
  file: string,
  listings: ReadonlyMap<string, Listing>,
  graph: ConfigGraph,
): string | undefined {
  const seen = new Set<string>([start]);
  const search = (config: string): string | undefined => {
    for (const child of graph.referencesOf.get(config) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      if (listsFile(listings, child, file)) return child;
      const deeper = search(child);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };
  return search(start);
}

/** A source no project lists, in the order the walk found them. The JS family counts only where JS is read. */
function uncoveredOf(snapshotPaths: readonly string[], listings: ReadonlyMap<string, Listing>, anyJs: boolean): string[] {
  const listed = new Set<string>();
  for (const listing of listings.values()) {
    for (const key of listing.memberKeys) listed.add(key);
  }
  return snapshotPaths
    .filter((path) => {
      if (!isTsOrJsSourceFile(path) || IS_DECLARATION_FILE.test(path)) return false;
      if (JS_FAMILY.has(extensionOf(path)) && !anyJs) return false;
      return !listed.has(pathKey(path));
    })
    .sort((left, right) => (left < right ? -1 : 1));
}

/** The configs the walk saw, by the filenames a project is allowed to have. */
function configSeeds(snapshotPaths: readonly string[]): string[] {
  return snapshotPaths.filter((path) => CONFIG_FILE_NAMES.has(basename(path).toLowerCase()));
}

function firstOwned(listing: Listing, owners: ReadonlyMap<string, string>): string | null {
  const owned = listing.members
    .filter((member) => owners.get(pathKey(member)) === listing.config)
    .sort((left, right) => (left < right ? -1 : 1));
  return owned.length === 0 ? null : (owned[0] as string);
}

/**
 * The map of one workspace, built from the paths the walk proved it saw, with the closure it was proved
 * against. A project whose listing failed is reported and keeps its consumers out of the answer; a workspace
 * with more than `PROJECT_MAP_LIMIT` projects, or no config at all, gets no map and says why.
 */
export async function buildProjectMapWithClosure(
  root: string,
  snapshotPaths: readonly string[],
  binary: TsgoBinary,
  exec: TsExecFn = defaultTsExec,
): Promise<BuiltProjectMap> {
  const workspaceRoot = resolve(root);
  const graph = readConfigGraph(configSeeds(snapshotPaths), workspaceRoot);
  if (graph.projects.length === 0) {
    return unavailable(`no tsconfig.json or jsconfig.json was found under "${workspaceRoot}"`, graph.closure);
  }
  if (graph.projects.length > PROJECT_MAP_LIMIT) {
    return unavailable(
      `"${workspaceRoot}" holds ${graph.projects.length} tsconfig projects, over the ${PROJECT_MAP_LIMIT} this server maps`,
      graph.closure,
    );
  }

  // A config a spec named that this server cannot read is a project the language service will still try to
  // load, so it is reported failed with that read error rather than listed — listing it would trade a stated read error for tsc's own confusion about its config file.
  const listable = graph.projects.filter((config) => !graph.unreadable.includes(config));
  const listings = await inBatches(listable, LISTING_CONCURRENCY, async (config) =>
    readListing(config, await exec(binary.executable, ["--listFilesOnly", "-p", config], dirname(config)), workspaceRoot),
  );
  const byConfig = new Map(listings.map((listing) => [listing.config, listing]));
  const byDirectory = configsByDirectory(graph.projects);
  const owners = new Map<string, string>();
  for (const path of snapshotPaths) {
    if (!isTsOrJsSourceFile(path)) continue;
    const owner = ownerOf(path, byConfig, graph, byDirectory, workspaceRoot);
    if (owner !== undefined) owners.set(pathKey(path), owner);
  }

  const projects: TsProject[] = [];
  const failed: ProjectFailure[] = graph.unreadable.map((config) => ({
    config,
    reason: unreadableConfigReason(config),
  }));
  const subsumed: string[] = [];
  for (const listing of listings) {
    if (listing.failure !== undefined) {
      failed.push(listing.failure);
      continue;
    }
    const anchor = firstOwned(listing, owners);
    if (anchor === null && listing.members.length > 0) {
      // A project that owns nothing is `subsumed` when every file it reads is owned by another project, which
      // owns at least that one file and is therefore anchored (its files all sit
      // in a program that IS loaded). A member no config owns at all leaves the loading of that file
      // unaccounted for, which stays `failed`.
      const everyMemberOwnedElsewhere = listing.members.every((member) => {
        const owner = owners.get(pathKey(member));
        return owner !== undefined && owner !== listing.config;
      });
      if (everyMemberOwnedElsewhere) subsumed.push(listing.config);
      else failed.push({ config: listing.config, reason: "no member file is assigned to this project" });
      continue;
    }
    projects.push({ config: listing.config, anchor, members: listing.members });
  }
  const anyJs = listings.some((listing) => listing.members.some((member) => JS_FAMILY.has(extensionOf(member))));
  return {
    map: { kind: "mapped", projects, failed, subsumed, uncovered: uncoveredOf(snapshotPaths, byConfig, anyJs), owners },
    closure: graph.closure,
    transient: listings.some((listing) => listing.transient === true),
  };
}

function unavailable(reason: string, closure: readonly string[]): BuiltProjectMap {
  return { map: { kind: "unavailable", reason }, closure };
}

/** The contract's shape: the map alone, for a caller that has no cache of its own. */
export function buildProjectMap(
  root: string,
  snapshotPaths: readonly string[],
  binary: TsgoBinary,
  exec: TsExecFn = defaultTsExec,
): Promise<ProjectMap> {
  return buildProjectMapWithClosure(root, snapshotPaths, binary, exec).then((built) => built.map);
}

interface CacheEntry {
  readonly promise: Promise<BuiltProjectMap>;
  closure: ReadonlySet<string>;
  /** The answering process this map was proved against. */
  readonly generation: number;
}

/** One map per workspace root, kept until the disk's structure or the answering process says otherwise. */
const built = new Map<string, CacheEntry>();

/**
 * The config closure of the paths one walk saw, without waiting for any listing — which is what a cache entry
 * has to know while its own build is still running. The manifests are re-read to get it: a handful of file
 * reads, beside the `--listFilesOnly` subprocesses the build itself is about to wait on.
 */
function closureOf(root: string, snapshotPaths: readonly string[]): readonly string[] {
  return readConfigGraph(configSeeds(snapshotPaths), resolve(root)).closure;
}

/**
 * The map for a workspace, built once and reused while the disk's structure holds. A
 * concurrent caller awaits the one in-flight build rather than starting a second pass of listings.
 *
 * `generation` is the caller's session's process generation. A map proven against one process's baseline
 * cannot describe the next one: the replacement takes a fresh baseline at spawn, so a structural change made
 * while the old process was dying would never appear as a diff, and a project created in that gap would be
 * missing from every later answer with nothing saying so.
 */
export async function cachedProjectMap(
  root: string,
  snapshotPaths: readonly string[],
  binary: TsgoBinary,
  generation: number,
  exec: TsExecFn = defaultTsExec,
): Promise<ProjectMap> {
  const key = pathKey(root);
  const running = built.get(key);
  if (running !== undefined && running.generation === generation) return (await running.promise).map;
  const promise = buildProjectMapWithClosure(root, snapshotPaths, binary, exec);
  // Recorded before the listings are awaited: an edit to a closure file that lands while this build is running
  // has to count as a change against the map it is about to produce, or the map listed BEFORE the edit stays
  // the answer for every call after it.
  const entry: CacheEntry = { promise, closure: new Set(closureOf(root, snapshotPaths).map(pathKey)), generation };
  built.set(key, entry);
  const result = await promise;
  // A listing that never answered is not a verdict on its config; keeping it would put `projects-not-loaded`
  // on every later answer until a structural change or a respawn. Callers already awaiting this build still
  // share it; the next call starts a fresh one.
  if (result.transient === true && built.get(key) === entry) built.delete(key);
  return result.map;
}

/**
 * Whether the map for `root` has to be rebuilt: a different answering process, a created or deleted path, a
 * changed manifest, or a changed file of the config closure. Content edits to sources reuse the map, which is
 * what makes the second call cheap.
 */
export function projectMapNeedsRebuild(root: string, diff: SnapshotDiff, generation: number): boolean {
  const entry = built.get(pathKey(root));
  if (entry === undefined) return true;
  if (entry.generation !== generation) return true;
  if (diff.created.length > 0 || diff.deleted.length > 0) return true;
  return diff.changed.some((path) => entry.closure.has(pathKey(path)) || MANIFEST_NAMES.has(basename(path).toLowerCase()));
}

/** Forget the map for a root: the rebuild path, and the test seam. */
export function dropProjectMap(root: string): void {
  built.delete(pathKey(root));
}
