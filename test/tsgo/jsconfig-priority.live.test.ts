import { dirname, join, relative, resolve, sep } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect } from "vitest";
import { defaultTsExec, type TsgoBinary, type TsExecFn, type TsExecResult } from "../../src/tsgo/binary.js";
import { isTsOrJsSourceFile } from "../../src/tsgo/language.js";
import { buildProjectMap, type ProjectMap, type TsProject } from "../../src/tsgo/project-map.js";
import { walkWorkspace, workspaceSnapshotReason } from "../../src/tsgo/workspace-snapshot.js";
import {
  CALL_BUDGET_MS,
  fixtures,
  itIfTsgoAvailable,
  requireTsgo,
  stampsOf,
} from "../helpers/tsgo-live.js";

/**
 * Live: a directory holding both `tsconfig.json` and
 * `jsconfig.json`, where the former owns its files.
 *
 * `test/fixtures/ts-workspace-jsconfig` is one directory holding both names, and nothing else:
 *
 * - `tsconfig.json` includes `src`; `jsconfig.json` includes `src` and `extra`. So `src/both-configs.ts` is
 *   listed by BOTH configs and `extra/js-only.ts` by the jsconfig alone;
 * - neither config `references` or `extends` the other, and both carry `noEmit: true`. That is a measured
 *   choice, not a simplification: a `references` edge from the tsconfig to the jsconfig makes tsc refuse the
 *   REFERRING project — `tsconfig.json(11,5): error TS6310: Referenced project '…/jsconfig.json' may not
 *   disable emit` — and a refused listing is a `failed` project. That is how this fixture was first measured,
 *   and it pinned nothing: the tsconfig project was not in the map at all, so the question —
 *   which of the two configs owns the file they both list — could not be reached. The priority does not need
 *   the edge. Rule 1.1 takes `tsconfig.json` before `jsconfig.json` in one directory whatever the graph looks
 *   like, and with no `references` there is simply no closure for rule 1.2 to descend.
 *
 * The owner rule read out by hand over the CLIMB branch, which is what `ownerOf` implements:
 *
 * | file | nearest named config | lists it? | `references` closure | climbed to | owner |
 * |---|---|---|---|---|---|
 * | `src/both-configs.ts` | `tsconfig.json` — tsconfig first in its own directory | YES | never searched | never | `tsconfig.json` |
 * | `extra/js-only.ts` | `tsconfig.json` — `extra` holds no config, so the root's tsconfig is the nearest named one | no | empty: the tsconfig references nothing | `dirname(<root>)`, which holds no config of this graph, so the search ends | NONE |
 *
 * So the tsconfig owns the shared file, anchors on it, and is the fixture's only anchored project. The jsconfig
 * reads both files and is the nearest config of nothing — `configsByDirectory` keeps the two names apart and
 * `nearestFrom` takes the tsconfig wherever both sit — so `firstOwned` finds it no anchor, and it is `failed`
 * with the map's own reason "no member file is assigned to this project". It is NOT `subsumed`, and that is the
 * half of the rule this fixture now shows: a project that owns nothing is taken out of `failed` only
 * when EVERY member it lists is owned by an anchored project, and `extra/js-only.ts` is owned by no project at
 * all — the climb cannot reach it, because no config above the fixture root is in the graph. A member with no
 * owner leaves the loading of that file unaccounted for, which stays `failed`. Nothing about it is
 * silent: it is not an `uncovered` row either, because `uncovered` asks only whether some listing named the
 * source, and the jsconfig's listing did. So the map's whole statement about the file is that failed project.
 *
 * The discrimination is worth stating. Under the defect this pin guards against — every project keyed by its directory,
 * last one winning — the jsconfig would be the nearest config of both files, would list and so own both, and
 * would be the anchored project, with the tsconfig left the one owning nothing. Which config is anchored on
 * `src/both-configs.ts`, and which is the config the map reports as owning nothing, IS the priority; both halves
 * are asserted, and an anchor is by definition a member its own project owns, so one file cannot have two
 * owners.
 *
 * Both readings come off the compiler's own `tsc --listFilesOnly` answers — two real listings, one process each,
 * recorded by the very exec the map build used, so the membership quoted below is the same stdout the map
 * parsed and not a second look at the fixture. No LSP session is asked for anything here: no `tsc.exe --lsp`
 * process is started and no `LspSessionManager` is created, so there is no manager to leave undisposed, and
 * `buildProjectMap` (the pure form) caches nothing that could outlive the case.
 */

const root = join(fixtures, "ts-workspace-jsconfig");
const tsConfig = join(root, "tsconfig.json");
const jsConfig = join(root, "jsconfig.json");
const sharedFile = join(root, "src", "both-configs.ts");
const jsOnlyFile = join(root, "extra", "js-only.ts");

/** Both configs, by their path below the fixture root; `namesUnder` sorts them. */
const CONFIGS = ["jsconfig.json", "tsconfig.json"];
/** The fixture's two sources, likewise. */
const SHARED = "src/both-configs.ts";
const JS_ONLY = "extra/js-only.ts";
/** The map's own sentence for a project that lists files and is assigned none of them. */
const OWNS_NOTHING = "no member file is assigned to this project";
/** What `buildProjectMap` asks each config for, one process at a time. */
const LISTING_FLAGS = ["--listFilesOnly", "-p"];

const IS_DECLARATION_FILE = /\.d\.[cm]?ts$/i;
const IN_NODE_MODULES = /[\\/]node_modules[\\/]/i;

// ---------------------------------------------------------------- fixture scaffolding

/** Paths compared the way the map compares them: separators normalised, case folded on this OS. */
const pathKey = (path: string): string => path.replace(/\\/g, "/").toLowerCase();

function samePath(a: string | null | undefined, b: string): boolean {
  return a !== undefined && a !== null && pathKey(a) === pathKey(b);
}

/** `path` under the fixture root in forward slashes; its own spelling when it is not under it at all. */
function under(path: string | null | undefined): string {
  if (path === undefined || path === null) return "<none>";
  const rel = relative(root, path);
  if (!rel.startsWith("..")) return rel.split(sep).join("/");
  // The same directory spelled with another drive-letter case is still under it: `relative` would call that an
  // escape, and the map compares the two case-folded.
  const key = pathKey(root);
  return pathKey(path).startsWith(`${key}/`) ? path.slice(key.length + 1).split("\\").join("/") : path;
}

function namesUnder(paths: readonly string[]): string[] {
  return paths.map((path) => under(path)).sort();
}

/** Whether `path` sits under this fixture root, judged the way the map judges it. */
function isUnderRoot(path: string): boolean {
  const key = pathKey(root);
  const here = pathKey(path);
  return here === key || here.startsWith(`${key}/`);
}

/** The map, or a failure quoting the reason the compiler's own listings gave for not having one. */
function requireMapped(map: ProjectMap): Extract<ProjectMap, { kind: "mapped" }> {
  if (map.kind !== "mapped") throw new Error(`no project map was built: ${map.reason}`);
  return map;
}

function projectFor(map: ProjectMap, config: string): TsProject {
  const mapped = requireMapped(map);
  const needle = pathKey(config);
  const found = mapped.projects.find((project) => pathKey(project.config) === needle);
  if (found !== undefined) return found;
  throw new Error(
    `"${under(config)}" is not a project of "${root}"; the map holds ` +
      `${JSON.stringify(namesUnder(mapped.projects.map((project) => project.config)))} and failed ` +
      `${JSON.stringify(mapped.failed.map((failure) => `${under(failure.config)}: ${failure.reason}`))}`,
  );
}

/** The reason the map gives for one config it refused to anchor, or a failure quoting the whole accounting. */
function failureOf(map: Extract<ProjectMap, { kind: "mapped" }>, config: string): string {
  const found = map.failed.find((failure) => pathKey(failure.config) === pathKey(config));
  if (found === undefined) {
    throw new Error(`"${under(config)}" is not a failed project; the map is ${accountingOf(map)}`);
  }
  return found.reason;
}

/** The walk's entries, or a failure quoting what the walk said it could not finish. */
function requireWalked(): { entries: Map<string, string>; unresolved: readonly string[] } {
  const walked = walkWorkspace(root);
  if (walked === undefined) throw new Error(`the walk of "${root}" did not complete: ${workspaceSnapshotReason(root)}`);
  return walked;
}

/** Every file the walk proved it saw: what a run must leave exactly as it found it. */
const treeStamps = (): Map<string, string> => stampsOf([...requireWalked().entries.keys()]);

// ------------------------------------------------------------------ the listing pass

/** One `tsc --listFilesOnly` the map build actually ran, with the answer it gave. */
interface ListingCall {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly result: TsExecResult;
}

/** The config one recorded call listed; `buildProjectMap` passes it as the third argument after `-p`. */
function configOf(call: ListingCall): string {
  return call.argv[2] ?? "<no config named on the command line>";
}

/**
 * An exec that runs the real listing through `defaultTsExec` — the production one, so nothing this file believes
 * about a listing is anything but the compiler's own answer — and keeps the call. The pin needs the calls to say
 * how many processes one listing pass costs and to quote the stdout the map parsed.
 */
function recordingExec(calls: ListingCall[]): TsExecFn {
  return async (executable, args, cwd) => {
    const result = await defaultTsExec(executable, args, cwd);
    calls.push({ executable, argv: [...args], cwd, result });
    return result;
  };
}

/** This fixture's project map, built by running one real `tsc --listFilesOnly` per config, recorded as it ran. */
async function liveProjectMap(binary: TsgoBinary, calls: ListingCall[]): Promise<ProjectMap> {
  return buildProjectMap(root, [...requireWalked().entries.keys()], binary, recordingExec(calls));
}

/** The sources one real listing named under this root, filtered the way `listedMembers` filters them. */
function listedSources(calls: readonly ListingCall[], config: string): string[] {
  const call = calls.find((one) => samePath(configOf(one), config));
  if (call === undefined) throw new Error(`the map build ran no listing of "${under(config)}"`);
  if (call.result.exitCode !== 0) {
    throw new Error(
      `tsc refused "${under(config)}" (exit ${String(call.result.exitCode)}, spawn ${String(
        call.result.spawnCode,
      )}): ${call.result.stderr.trim()}`,
    );
  }
  const names = new Set<string>();
  for (const line of call.result.stdout.split(/\r?\n/)) {
    const path = line.trim();
    if (path === "") continue;
    const absolute = resolve(path);
    if (!isUnderRoot(absolute) || IN_NODE_MODULES.test(absolute)) continue;
    if (!isTsOrJsSourceFile(absolute) || IS_DECLARATION_FILE.test(absolute)) continue;
    names.add(under(absolute));
  }
  return [...names].sort();
}

/** A project with no anchor cannot be loaded by opening a file, which is the fact this pin is about. */
function anchorOf(map: ProjectMap, config: string): string {
  const mapped = requireMapped(map);
  const project = projectFor(mapped, config);
  const anchor = project.anchor;
  if (anchor === null) {
    throw new Error(
      `"${under(config)}" anchored on nothing, although it lists ${JSON.stringify(namesUnder(project.members))}; ` +
        `failed projects ${JSON.stringify(
          mapped.failed.map((failure) => `${under(failure.config)}: ${failure.reason}`),
        )}`,
    );
  }
  return under(anchor);
}

/** What the map did with each config it was given, spelled for a failure message that has to stand alone. */
function accountingOf(map: Extract<ProjectMap, { kind: "mapped" }>): string {
  return JSON.stringify({
    anchored: map.projects.map((project) => `${under(project.config)}→${under(project.anchor)}`),
    subsumed: namesUnder(map.subsumed),
    failed: map.failed.map((failure) => `${under(failure.config)}: ${failure.reason}`),
    uncovered: namesUnder(map.uncovered),
  });
}

// ---------------------------------------------------------------------- the case

describe("one directory holding both tsconfig.json and jsconfig.json", () => {
  itIfTsgoAvailable(
    "anchors the file both configs list on the tsconfig project, and reports the jsconfig beside it as owning nothing",
    async () => {
      const before = treeStamps();
      const walked = requireWalked();
      expect(walked.unresolved).toEqual([]);
      expect(walked.entries.has(tsConfig)).toBe(true);
      expect(walked.entries.has(jsConfig)).toBe(true);
      expect(walked.entries.has(sharedFile)).toBe(true);
      expect(walked.entries.has(jsOnlyFile)).toBe(true);

      // The fixture this derivation is read against: neither config references the other. A `references` edge
      // from the tsconfig to the jsconfig costs this pin its ground — tsc refuses the referring project's
      // listing with TS6310 because both configs disable emit, and what would be measured is that refusal, not
      // the priority. Said as an assertion, so re-adding the edge fails as a stated thing rather than as a map
      // whose shape no longer matches the table above.
      for (const config of [tsConfig, jsConfig]) {
        expect(
          /"references"\s*:/.test(readFileSync(config, "utf-8")),
          `"${under(config)}" declares a \`references\` edge, which this pin's derivation does not carry`,
        ).toBe(false);
      }

      const binary = requireTsgo();
      const calls: ListingCall[] = [];
      const map = requireMapped(await liveProjectMap(binary, calls));
      const report = accountingOf(map);

      // (1) One process per listing pass: two configs of this directory, so exactly two `tsc --listFilesOnly`
      // runs, each asked in its own directory against the executable this host resolved, each answered by a
      // process that ran to exit 0. Both answers being usable (a refused listing is a failure)
      // is itself part of what is pinned here.
      const listedConfigs = () => namesUnder(calls.map((call) => configOf(call)));
      expect(listedConfigs(), `the listing processes this run started: ${JSON.stringify(listedConfigs())}`).toEqual(
        CONFIGS,
      );
      for (const call of calls) {
        expect(call.argv.slice(0, 2), `listing argv ${JSON.stringify(call.argv)}`).toEqual(LISTING_FLAGS);
        expect(call.executable, `the listing asked ${call.executable}`).toBe(binary.executable);
        expect(samePath(call.cwd, dirname(configOf(call))), `the listing ran in ${call.cwd}`).toBe(true);
        expect(call.result.exitCode, `tsc's stderr for ${under(configOf(call))}: ${call.result.stderr.trim()}`).toBe(
          0,
        );
      }

      // (2) Both configs are projects: each is named by the walk as a config file, the closure is provable, and
      // the map accounts for both — one anchored, one failed, neither vanished. That is the difference from the
      // first measurement of this fixture, where the tsconfig was simply not in the map.
      expect(
        namesUnder([
          ...map.projects.map((project) => project.config),
          ...map.subsumed,
          ...map.failed.map((failure) => failure.config),
        ]),
        report,
      ).toEqual(CONFIGS);
      expect(namesUnder(map.projects.map((project) => project.config)), report).toEqual(["tsconfig.json"]);
      expect(namesUnder(map.subsumed), report).toEqual([]);
      expect(
        map.failed.map((failure) => `${under(failure.config)}: ${failure.reason}`),
        report,
      ).toEqual([`jsconfig.json: ${OWNS_NOTHING}`]);

      // (3) What each listing READS, from the stdout the map itself parsed. Membership is wider than ownership,
      // and the two listings naming the same file is the whole reason a priority rule has to exist.
      expect(listedSources(calls, tsConfig), report).toEqual([SHARED]);
      expect(listedSources(calls, jsConfig), report).toEqual([JS_ONLY, SHARED]);
      const ts = projectFor(map, tsConfig);
      expect(namesUnder(ts.members), report).toEqual([SHARED]);

      // (4) Rule 1.1's priority at the file both configs list: its nearest named config is the tsconfig, that
      // config lists it, so the closure is never searched and no climb is needed. The tsconfig anchors there.
      expect(anchorOf(map, tsConfig), report).toBe(SHARED);
      // And the jsconfig does not own it. Asserted as a count over every anchored project, so a map that anchored
      // BOTH configs on this file — the last-wins directory key's shape — could not pass by carrying the right
      // config in `projects` as well.
      const anchoringShared = map.projects
        .filter((project) => samePath(project.anchor, sharedFile))
        .map((project) => project.config);
      expect(namesUnder(anchoringShared), report).toEqual(["tsconfig.json"]);

      // (5) The jsconfig's standing, exactly as the derivation gives it: a project of the graph, listed by tsc,
      // nearest config of nothing, owner of neither of its two members — `src/both-configs.ts` to the tsconfig
      // and `extra/js-only.ts` to no project at all. Owning nothing with an unowned member is the half of the rule
      // that keeps a project `failed` rather than making it `subsumed`, because no loaded program is proved to
      // hold that file, so its uses could be missing from an answer with this map claiming the project covered.
      expect(failureOf(map, jsConfig), report).toBe(OWNS_NOTHING);
      expect(map.subsumed.some((config) => samePath(config, jsConfig)), report).toBe(false);

      // (6) `uncovered` asks a different question — did ANY listing name this source — and both files were: the
      // jsconfig's listing names the one in `extra`. So no source of the fixture is a blind spot even though one
      // of them has no owner, and the failed project above is the map's whole statement about that file.
      expect(map.uncovered, report).toEqual([]);

      console.info(
        `tsconfig/jsconfig priority pin: ${report}; listings ${JSON.stringify(
          CONFIGS.map((name) => `${name} → ${JSON.stringify(listedSources(calls, join(root, name)))}`),
        )}; one process per listing pass over ${String(calls.length)} configs; no LSP session asked`,
      );
      expect(under(sharedFile)).toBe(SHARED);
      expect(under(jsOnlyFile)).toBe(JS_ONLY);
      expect(treeStamps()).toEqual(before);
    },
    CALL_BUDGET_MS,
  );
});
