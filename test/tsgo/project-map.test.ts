import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, parse, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TsgoBinary, TsExecFn, TsExecResult } from "../../src/tsgo/binary.js";
import { unreadableConfigReason } from "../../src/tsgo/config-graph.js";
import {
  PROJECT_MAP_LIMIT,
  buildProjectMap,
  buildProjectMapWithClosure,
  cachedProjectMap,
  dropProjectMap,
  projectMapNeedsRebuild,
  type ProjectMap,
  type TsProject,
} from "../../src/tsgo/project-map.js";

/**
 * The project map, with `tsc --listFilesOnly` answered by the injection seam in
 * `src/tsgo/binary.ts`: no real `tsc.exe` and no real `npm` runs anywhere here. The configs themselves are
 * real files, because the closure their `references` and `extends` name is resolved by `config-graph`'s own
 * read of the disk; the sources they list are only ever path strings, which is exactly what the map is built
 * from — the walk's paths and the compiler's listing, never a second traversal.
 *
 * The owner cases are the rule `ownerOf` implements: a file's nearest NAMED config is that directory's
 * `tsconfig.json` (or, where the directory holds no tsconfig, its `jsconfig.json`) and nothing else
 *; a file that config does not list is assigned to the first config in its
 * `references` closure, depth-first in listed order, that does; and when neither question answers, the search
 * continues from the parent of that config's directory to the next named config and asks both again — the climb
 * branch that was ruled in advance and measured on a running `tsgo` (the answer was
 * CLIMB). The search stops at the first owner; only a file none of them names belongs to no project.
 */

const BINARY: TsgoBinary = { executable: "C:/fake/lib/tsc.exe", version: "7.0.2", source: "global" };

/** A compiler library beside the install, which resolves outside every workspace root. */
const LIB_FILE = resolve("/typescript/lib/lib.es5.d.ts");

/** One config's answer: the lines its listing printed, or the whole process outcome when it did not answer. */
type ListingAnswer = readonly string[] | TsExecResult;

interface ListingHarness {
  readonly exec: TsExecFn;
  /** Every call the map made, in the order it made them. */
  readonly asked: { readonly executable: string; readonly args: readonly string[]; readonly cwd: string }[];
}

/** The `exec` seam: one answer per config, and a run of nothing for any config a case did not answer. */
function listings(answers: Record<string, ListingAnswer>): ListingHarness {
  const asked: ListingHarness["asked"] = [];
  const exec: TsExecFn = async (executable, args, cwd) => {
    asked.push({ executable, args, cwd });
    const answer = answers[args[2] ?? ""];
    if (answer === undefined) return { stdout: "", stderr: "", exitCode: 0 };
    return Array.isArray(answer)
      ? { stdout: (answer as readonly string[]).join("\n"), stderr: "", exitCode: 0 }
      : (answer as TsExecResult);
  };
  return { exec, asked };
}

/** The mapped half of an answer, or a failure naming what came back instead of one. */
function mapped(map: ProjectMap): Extract<ProjectMap, { kind: "mapped" }> {
  if (map.kind !== "mapped") throw new Error(`expected a mapped project map, got ${JSON.stringify(map)}`);
  return map;
}

/** The project one config produced, or `undefined` when the map holds no project for it. */
function projectOf(map: ProjectMap, config: string): TsProject | undefined {
  return mapped(map).projects.find((project) => project.config === config);
}

const noChange = { created: [], changed: [], deleted: [] };

/**
 * The answering process a cached map is proved against. The session's own number is what a caller passes
 *; here it is a constant the cache cases move on purpose.
 */
const GENERATION = 0;

describe("buildProjectMap", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-pmap-"));
  });

  afterEach(() => {
    dropProjectMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Writes a config file at `parts` under the workspace root and returns its path. */
  function config(body: Record<string, unknown>, ...parts: string[]): string {
    const path = join(tmp, ...parts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  /** A workspace source at `parts`; the map reads its path, it never stats the file. */
  function source(...parts: string[]): string {
    const path = join(tmp, ...parts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export const x = 1;\n");
    return path;
  }

  it("takes a project's members from its own listing, filtered to the workspace's source files", async () => {
    const cfg = config({}, "tsconfig.json");
    const ts = source("src", "a.ts");
    const tsx = source("src", "b.tsx");
    const js = source("src", "c.js");
    const mjs = source("src", "d.mjs");
    const dependency = source("node_modules", "dep", "index.js");
    const declaration = source("src", "a.d.ts");
    const notes = source("notes.md");
    const h = listings({ [cfg]: [ts, tsx, js, mjs, dependency, declaration, notes, LIB_FILE, ts] });

    const map = await buildProjectMap(tmp, [cfg, ts, tsx, js, mjs], BINARY, h.exec);

    // A listing says what a project reads, including the lib files and the dependencies it reads; a member
    // is what this server may answer about, and that is the workspace's own source set.
    expect(map).toEqual({
      kind: "mapped",
      projects: [{ config: cfg, anchor: ts, members: [ts, tsx, js, mjs] }],
      failed: [],
      subsumed: [],
      uncovered: [],
      owners: expect.any(Map),
    });
    expect(h.asked).toEqual([
      { executable: BINARY.executable, args: ["--listFilesOnly", "-p", cfg], cwd: tmp },
    ]);
  });

  it("anchors a project on the lexically first member it owns, not the first one its listing named", async () => {
    const app = config({ references: [{ path: "./packages/b" }] }, "tsconfig.json");
    const sibling = config({}, "packages", "b", "tsconfig.json");
    const siblingFile = source("packages", "b", "src", "b.ts");
    const last = source("src", "z.ts");
    const first = source("src", "a.ts");
    const h = listings({ [app]: [siblingFile, last, first], [sibling]: [siblingFile] });

    const map = await buildProjectMap(tmp, [app, sibling, first, last, siblingFile], BINARY, h.exec);

    // Opening the file this project merely imports would load the sibling's project and leave this one out.
    expect(projectOf(map, app)?.members).toEqual([siblingFile, last, first]);
    expect(projectOf(map, app)?.anchor).toBe(first);
    expect(projectOf(map, sibling)?.anchor).toBe(siblingFile);
    expect(mapped(map).failed).toEqual([]);
    expect(mapped(map).uncovered).toEqual([]);
  });

  it("assigns a file the nearest config does not list to the first config in its references closure that does, and subsumes the closure config that owns none", async () => {
    const root = config({ references: [{ path: "./packages/app" }] }, "tsconfig.json");
    const app = config({ references: [{ path: "./configs/gen-a.json" }, { path: "./configs/gen-b.json" }] }, "packages", "app", "tsconfig.json");
    const genA = config({}, "packages", "app", "configs", "gen-a.json");
    const genB = config({}, "packages", "app", "configs", "gen-b.json");
    const generated = source("packages", "app", "src", "api.ts");
    const owned = source("packages", "app", "src", "app.ts");
    const h = listings({ [app]: [owned], [genA]: [generated], [genB]: [generated] });

    const map = await buildProjectMap(tmp, [root, app, genA, genB, generated, owned], BINARY, h.exec);

    // `api.ts` sits under `app`, its nearest config, and `app` does not list it, so the search goes down
    // `app`'s `references` in the order they are listed: `gen-a.json` is named first and wins the file both
    // of them list. A referenced config is a project whatever it is called, so it is asked for a listing too.
    expect(mapped(map).projects.map((project) => project.config)).toEqual([root, app, genA]);
    expect(projectOf(map, genA)?.anchor).toBe(generated);
    expect(projectOf(map, app)?.anchor).toBe(owned);
    // `gen-b.json` lists the same generated file and owns none of it; `gen-a.json` owns it and IS anchored, so
    // the loading of that file is accounted for and this config is `subsumed` rather than `failed`
    //.
    expect(mapped(map).failed).toEqual([]);
    expect(mapped(map).subsumed).toEqual([genB]);
  });

  it("never makes a solution config's neighbour a file's nearest config, so the Vite layout owns through references", async () => {
    const solution = config(
      { references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] },
      "tsconfig.json",
    );
    const app = config({}, "tsconfig.app.json");
    const nodeConfig = config({}, "tsconfig.node.json");
    const page = source("src", "TradingTable.tsx");
    const vite = source("vite.config.ts");
    const h = listings({ [solution]: [], [app]: [page], [nodeConfig]: [vite] });

    const map = await buildProjectMap(tmp, [solution, app, nodeConfig, page, vite], BINARY, h.exec);

    // Only `tsconfig.json` and `jsconfig.json` can be a nearest config, so `src/**` reaches `tsconfig.app.json` through the solution's `references` and
    // `vite.config.ts` reaches the node config the same way. Keying every project by its directory instead —
    // last one winning — made the node config the nearest of everything, orphaned the app project, and put
    // `projects-not-loaded` on every answer for a workspace whose projects all loaded.
    expect(map).toEqual({
      kind: "mapped",
      projects: [
        { config: solution, anchor: null, members: [] },
        { config: app, anchor: page, members: [page] },
        { config: nodeConfig, anchor: vite, members: [vite] },
      ],
      failed: [],
      subsumed: [],
      uncovered: [],
      owners: expect.any(Map),
    });
    // The solution lists nothing and owns nothing, so it needs no anchor and is no failure.
    expect(h.asked).toHaveLength(3);
  });

  it("takes a directory's tsconfig.json ahead of its jsconfig.json for the files both list", async () => {
    const tsconfig = config({ references: [{ path: "./jsconfig.json" }] }, "tsconfig.json");
    const jsconfig = config({}, "jsconfig.json");
    const listedByBoth = source("src", "shared.ts");
    const listedByJsOnly = source("src", "legacy.js");
    const h = listings({ [tsconfig]: [listedByBoth], [jsconfig]: [listedByBoth, listedByJsOnly] });

    const map = await buildProjectMap(tmp, [tsconfig, jsconfig, listedByBoth, listedByJsOnly], BINARY, h.exec);

    // The language service looks for those two names per directory, tsconfig first, so the file both list is
    // the tsconfig's; the sibling keeps the file the tsconfig does not name. It reaches that sibling through the
    // tsconfig's `references` closure, which is asked before the search is allowed to climb — and there is no
    // named config above this one to climb to, so the closure is the only route the jsconfig has.
    expect(map).toEqual({
      kind: "mapped",
      projects: [
        { config: tsconfig, anchor: listedByBoth, members: [listedByBoth] },
        { config: jsconfig, anchor: listedByJsOnly, members: [listedByBoth, listedByJsOnly] },
      ],
      failed: [],
      subsumed: [],
      uncovered: [],
      owners: expect.any(Map),
    });
  });

  it("reports a config the graph could not read as a failed project, and runs no listing for it", async () => {
    const cfg = config({ references: [{ path: "./packages/broken/tsconfig.json" }] }, "tsconfig.json");
    // A manifest that is not a JSONC object this server can read: `config-graph` answers `undefined` for it,
    // which is the same fact as a config that is not JSON at all.
    const broken = join(tmp, "packages", "broken", "tsconfig.json");
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, "[]");
    const member = source("src", "a.ts");
    const reason = `no config this server can read at "${broken}"`;
    const h = listings({ [cfg]: [member] });

    const map = await buildProjectMap(tmp, [cfg, broken, member], BINARY, h.exec);

    // The language service will still try to load this project, so it is reported
    // failed with that read error rather than dropped, and `projects-not-loaded` follows in the answer.
    expect(mapped(map).failed).toEqual([{ config: broken, reason }]);
    expect(reason).toBe(unreadableConfigReason(broken));
    expect(mapped(map).projects.map((project) => project.config)).toEqual([cfg]);
    // No `tsc.exe` is started for it: a listing of a config this server cannot name to the compiler would
    // trade a stated read error for the compiler's own confusion about its config file.
    expect(h.asked.map((ask) => ask.args[2])).toEqual([cfg]);
    expect(mapped(map).uncovered).toEqual([]);
  });

  it("climbs past a nearest config that neither lists a file nor references one, to the next named config above it", async () => {
    const root = config({ references: [{ path: "./packages/app" }] }, "tsconfig.json");
    const app = config({}, "packages", "app", "tsconfig.json");
    const owned = source("src", "a.ts");
    const unassigned = source("packages", "app", "test", "store.test.ts");
    const h = listings({ [root]: [unassigned, owned], [app]: [] });

    const map = await buildProjectMap(tmp, [root, app, owned, unassigned], BINARY, h.exec);

    // `store.test.ts` sits under `packages/app`, whose `tsconfig.json` lists nothing and references nothing that
    // would, so both questions fail there and the search continues from the parent of `packages/app`: the root
    // `tsconfig.json` is the next named config and it lists the file, so it owns it (the climb
    // branch, which is what the pin measured). The file is listed, so it is no blind spot; `app` names no
    // member at all, so it anchors nothing and is no failure; and the root's anchor is the climbed file, because
    // `firstOwned` takes the lexically first member a project owns and `packages\app\test\store.test.ts` sorts
    // ahead of `src\a.ts`.
    expect(projectOf(map, root)?.members).toEqual([unassigned, owned]);
    expect(projectOf(map, root)?.anchor).toBe(unassigned);
    expect(projectOf(map, app)?.anchor).toBeNull();
    expect(mapped(map).failed).toEqual([]);
    expect(mapped(map).subsumed).toEqual([]);
    expect(mapped(map).uncovered).toEqual([]);
  });

  it("gives a config whose listing holds nothing inside the workspace no anchor, and is not a failure", async () => {
    const solution = config({ files: [], references: [] }, "tsconfig.json");

    const map = await buildProjectMap(tmp, [solution], BINARY, listings({}).exec);

    expect(map).toEqual({
      kind: "mapped",
      projects: [{ config: solution, anchor: null, members: [] }],
      failed: [],
      subsumed: [],
      uncovered: [],
      owners: expect.any(Map),
    });
  });

  it("climbs an unlisted member of a sibling project into the reading config, which then owns it and anchors on it", async () => {
    const app = config({ references: [{ path: "./packages/b" }] }, "tsconfig.json");
    const sibling = config({}, "packages", "b", "tsconfig.json");
    const siblingFile = source("packages", "b", "src", "b.ts");
    // `orphan.ts` sits beside `b.ts`, so `sibling` is its nearest named config, does not name it, and references
    // nothing that does. Both questions fail there, so the search continues from the parent of `packages\b` and
    // the root `tsconfig.json` — the next named config up — lists it: `app` owns the file it merely reads.
    const orphan = source("packages", "b", "src", "orphan.ts");
    const h = listings({ [app]: [siblingFile, orphan], [sibling]: [siblingFile] });

    const map = await buildProjectMap(tmp, [app, sibling, siblingFile, orphan], BINARY, h.exec);

    // So this is no longer the unowned-member case: `orphan.ts` HAS an owner now, `b.ts` belongs to
    // the sibling that lists it, and each config anchors on a file of its own — nothing failed, nothing
    // subsumed. (the `failed` branch needs a member no ascent path can reach: a file some project lists while
    // neither the file's nearest named config, nor any closure of a config on the way up, nor any config above
    // them names it. This shape — a reading config sitting ABOVE the file — no longer produces one.)
    expect(mapped(map).projects.map((project) => project.config)).toEqual([app, sibling]);
    expect(projectOf(map, app)?.anchor).toBe(orphan);
    expect(projectOf(map, sibling)?.anchor).toBe(siblingFile);
    expect(mapped(map).subsumed).toEqual([]);
    expect(mapped(map).failed).toEqual([]);
  });

  it("keeps the first line that says what went wrong as a failed listing's reason, and its files out of the map", async () => {
    const cfg = config({}, "tsconfig.json");
    const listed = source("src", "a.ts");
    const reason = `error TS6053: File '${join(tmp, "missing.ts")}' not found.`;
    const h = listings({
      [cfg]: { stdout: `${listed}\n   ${reason}\nerror TS18003: a later line`, stderr: "error TS9999: from stderr", exitCode: 2 },
    });

    const map = await buildProjectMap(tmp, [cfg, listed], BINARY, h.exec);

    expect(map).toEqual({
      kind: "mapped",
      projects: [],
      failed: [{ config: cfg, reason }],
      subsumed: [],
      // The listing named the file and never became a member set, so the workspace's own source is a blind spot.
      uncovered: [listed],
      owners: expect.any(Map),
    });
  });

  it.each([
    {
      shape: "a non-zero exit with no error line",
      result: { stdout: "", stderr: "tsc: the given path is not a directory", exitCode: 2 } satisfies TsExecResult,
      reason: "the listing exited with code 2",
    },
    {
      shape: "a process that never started",
      result: { stdout: "", stderr: "", exitCode: undefined, spawnCode: "ENOENT" } satisfies TsExecResult,
      reason: "the listing did not answer (ENOENT)",
    },
    {
      shape: "an outcome that stated no exit code",
      result: { stdout: "", stderr: "", exitCode: undefined } satisfies TsExecResult,
      reason: "the listing gave no exit code",
    },
  ])("names $shape as the project's reason: $reason", async ({ result, reason }) => {
    const cfg = config({}, "tsconfig.json");
    const member = source("src", "a.ts");

    const map = await buildProjectMap(tmp, [cfg, member], BINARY, listings({ [cfg]: result }).exec);

    expect(map).toEqual({
      kind: "mapped",
      projects: [],
      failed: [{ config: cfg, reason }],
      subsumed: [],
      uncovered: [member],
      owners: expect.any(Map),
    });
  });

  it("reports a walked source that no project lists, and never a declaration file", async () => {
    const cfg = config({}, "tsconfig.json");
    const listed = source("src", "listed.ts");
    const orphan = source("src", "a-orphan.ts");
    const declaration = source("src", "types.d.ts");

    const map = await buildProjectMap(tmp, [cfg, listed, orphan, declaration], BINARY, listings({ [cfg]: [listed] }).exec);

    expect(mapped(map).uncovered).toEqual([orphan]);
  });

  it("counts a JS-family source among the uncovered only where some listing named a JS member", async () => {
    const cfg = config({}, "tsconfig.json");
    const listed = source("src", "listed.ts");
    const listedJs = source("src", "listed.js");
    const looseJs = source("src", "a-loose.js");
    const snapshot = [cfg, listed, listedJs, looseJs];

    // Without a JS member anywhere in the map, this project set does not read JavaScript, and a `.js` file
    // beside it is not a blind spot in the answer.
    const tsOnly = await buildProjectMap(tmp, snapshot, BINARY, listings({ [cfg]: [listed] }).exec);
    expect(mapped(tsOnly).uncovered).toEqual([]);

    // On an `allowJs` project, where the compiler did name one, the JavaScript files no project lists are.
    const allowJs = await buildProjectMap(tmp, snapshot, BINARY, listings({ [cfg]: [listed, listedJs] }).exec);
    expect(mapped(allowJs).uncovered).toEqual([looseJs]);
  });

  it("assigns eight thousand members of one project in one pass, not one scan per query", async () => {
    const cfg = config({}, "tsconfig.json");
    const members = Array.from({ length: 8_000 }, (_unused, index) =>
      join(tmp, "src", `f${String(index).padStart(5, "0")}.ts`),
    );
    const h = listings({ [cfg]: members });

    const began = performance.now();
    const map = await buildProjectMap(tmp, [cfg, ...members], BINARY, h.exec);
    const took = performance.now() - began;

    expect(mapped(map).projects).toHaveLength(1);
    expect(mapped(map).uncovered).toEqual([]);
    // Membership is asked per walked path, so a query that scans its listing's whole member list makes the
    // build quadratic in the project's size — and it is synchronous, so `withinBudget` cannot pre-empt it and
    // every other tool in this server waits. One listing's keys are a set built once, which makes it a pass.
    expect(took, `a map of 8000 listed members took ${took.toFixed(0)} ms`).toBeLessThan(1_000);
  }, 120_000);

  it("ends the owner search at a workspace that is a filesystem root", async () => {
    // `dirname` of a root is the root itself, so a climb without its own stop would ask one directory forever.
    const fsRoot = parse(tmp).root;
    const cfg = join(fsRoot, "tsconfig.json");
    const orphan = join(fsRoot, "mcp-code-nav-no-such-dir", "a.ts");

    const map = await buildProjectMap(fsRoot, [cfg, orphan], BINARY, listings({}).exec);

    expect(mapped(map).projects).toEqual([]);
  }, 10_000);

  it("maps no project at all when the workspace holds more projects than the map may carry", async () => {
    expect(PROJECT_MAP_LIMIT).toBe(32);
    const configs = Array.from({ length: PROJECT_MAP_LIMIT + 1 }, (_unused, index) =>
      config({}, `p${index}`, "tsconfig.json"),
    );
    const h = listings({});

    const map = await buildProjectMap(tmp, configs, BINARY, h.exec);

    expect(map).toEqual({
      kind: "unavailable",
      reason: `"${tmp}" holds 33 tsconfig projects, over the 32 this server maps`,
    });
    // Refused before any listing was asked for: no `tsc.exe` was started for a map this server will not keep.
    expect(h.asked).toEqual([]);
  });

  it("says no config was found when the walk named none, and asks nothing for a listing", async () => {
    const sourceFile = source("src", "a.ts");
    const h = listings({});

    const map = await buildProjectMap(tmp, [sourceFile, join(tmp, "package.json")], BINARY, h.exec);

    expect(map).toEqual({ kind: "unavailable", reason: `no tsconfig.json or jsconfig.json was found under "${tmp}"` });
    expect(h.asked).toEqual([]);
  });
});

describe("cachedProjectMap", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-pmap-cache-"));
  });

  afterEach(() => {
    dropProjectMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
  });

  function config(body: Record<string, unknown>, ...parts: string[]): string {
    const path = join(tmp, ...parts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  function source(...parts: string[]): string {
    const path = join(tmp, ...parts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export const x = 1;\n");
    return path;
  }

  it("builds one map per root for callers that arrive together", async () => {
    const cfg = config({}, "tsconfig.json");
    const a = source("src", "a.ts");
    const h = listings({ [cfg]: [a] });

    const [first, second] = await Promise.all([
      cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, h.exec),
      cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, h.exec),
    ]);

    // One pass of listings for the pair, and the same map object for both callers.
    expect(h.asked).toHaveLength(1);
    expect(first).toBe(second);
  });

  it("knows the closure it is still listing while a build is in flight", async () => {
    const cfg = config({ extends: "./compiler-options.json" }, "tsconfig.json");
    const options = join(tmp, "compiler-options.json");
    writeFileSync(options, "{}");
    const a = source("src", "a.ts");
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const exec: TsExecFn = async () => {
      await held;
      return { stdout: a, stderr: "", exitCode: 0 };
    };

    // Started, not awaited: the listings are still running, which is the window a warm workspace sits in for
    // as long as a `--listFilesOnly` per project takes.
    const building = cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, exec);

    // The entry has to know from the start that `compiler-options.json` is one of the files this map was
    // proved against. Recorded only when the listings answer, an edit that lands during the build is invisible
    // to the rebuild question, and the map listed before the edit stays the answer for every later call.
    expect(projectMapNeedsRebuild(tmp, { ...noChange, changed: [options] }, GENERATION)).toBe(true);

    release();
    expect(await building).toMatchObject({ kind: "mapped" });
    expect(projectMapNeedsRebuild(tmp, { ...noChange, changed: [options] }, GENERATION)).toBe(true);
  }, 30_000);

  it("does not keep a map whose listing never answered, so the next call lists again", async () => {
    const cfg = config({}, "tsconfig.json");
    const a = source("src", "a.ts");
    let asked = 0;
    const exec: TsExecFn = async () => {
      asked += 1;
      return asked === 1
        ? { stdout: "", stderr: "", exitCode: undefined, spawnCode: "ETIMEDOUT" }
        : { stdout: a, stderr: "", exitCode: 0 };
    };

    const first = await cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, exec);
    expect(first).toMatchObject({ kind: "mapped", failed: [{ config: cfg }] });

    const second = await cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, exec);
    expect(asked).toBe(2);
    expect(second).toMatchObject({ kind: "mapped", failed: [], projects: [{ config: cfg }] });
  });

  it("keeps a map whose listing failed with the compiler's own error, which a retry would only repeat", async () => {
    const cfg = config({}, "tsconfig.json");
    const a = source("src", "a.ts");
    let asked = 0;
    const exec: TsExecFn = async () => {
      asked += 1;
      return { stdout: "error TS5083: Cannot read file.", stderr: "", exitCode: 1 };
    };

    await cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, exec);
    await cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, exec);
    expect(asked).toBe(1);
  });

  it("binds the cached map to the answering process, and discards it when that process is replaced", async () => {
    const cfg = config({}, "tsconfig.json");
    const a = source("src", "a.ts");
    const h = listings({ [cfg]: [a] });

    const first = await cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, h.exec);
    // The same process asks twice and the listings run once: the map is a function of the disk it was read off.
    expect(await cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, h.exec)).toBe(first);
    expect(h.asked).toHaveLength(1);
    expect(projectMapNeedsRebuild(tmp, noChange, GENERATION)).toBe(false);

    // The replacement took a fresh baseline at spawn, so a
    // structural change made while the old process was dying never shows up as a diff. A map proven against
    // the dead process would silently miss a project created in that gap.
    expect(projectMapNeedsRebuild(tmp, noChange, GENERATION + 1)).toBe(true);

    const rebuilt = await cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION + 1, h.exec);
    expect(h.asked).toHaveLength(2);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt).toEqual(first);
    expect(projectMapNeedsRebuild(tmp, noChange, GENERATION + 1)).toBe(false);
    // The old process's number no longer describes the live one, so a caller holding it is not served.
    expect(projectMapNeedsRebuild(tmp, noChange, GENERATION)).toBe(true);
  });

  it("rebuilds only for a structural change, a changed manifest, or a changed file of the config closure", async () => {
    const cfg = config({ extends: "./compiler-options.json" }, "tsconfig.json");
    const options = join(tmp, "compiler-options.json");
    writeFileSync(options, "{}");
    const a = source("src", "a.ts");
    const h = listings({ [cfg]: [a] });

    const built = await buildProjectMapWithClosure(tmp, [cfg, a], BINARY, h.exec);
    expect(built.closure).toContain(options);
    // Nothing is cached under this root yet, so a caller has no map to reuse.
    expect(projectMapNeedsRebuild(tmp, noChange, GENERATION)).toBe(true);

    await cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, h.exec);

    expect(projectMapNeedsRebuild(tmp, { ...noChange, created: [join(tmp, "src", "new.ts")] }, GENERATION)).toBe(true);
    expect(projectMapNeedsRebuild(tmp, { ...noChange, deleted: [a] }, GENERATION)).toBe(true);
    // A content edit to a source leaves the same projects over the same files.
    expect(projectMapNeedsRebuild(tmp, { ...noChange, changed: [a] }, GENERATION)).toBe(false);
    expect(projectMapNeedsRebuild(tmp, { ...noChange, changed: [options] }, GENERATION)).toBe(true);
    expect(projectMapNeedsRebuild(tmp, { ...noChange, changed: [cfg] }, GENERATION)).toBe(true);
    expect(projectMapNeedsRebuild(tmp, { ...noChange, changed: [join(tmp, "package.json")] }, GENERATION)).toBe(true);

    // Two listings so far: the uncached build above and the one the cache made.
    expect(h.asked).toHaveLength(2);

    dropProjectMap(tmp);
    expect(projectMapNeedsRebuild(tmp, noChange, GENERATION)).toBe(true);

    await cachedProjectMap(tmp, [cfg, a], BINARY, GENERATION, h.exec);
    expect(h.asked).toHaveLength(3);
  });

  it("runs no more than four listings at once, however many projects the workspace holds", async () => {
    const configs = Array.from({ length: 9 }, (_unused, index) => config({}, `p${index}`, "tsconfig.json"));
    let running = 0;
    let peak = 0;
    const exec: TsExecFn = async () => {
      running += 1;
      peak = Math.max(peak, running);
      // Every runner is inside a listing at this point, so a pool wider than four would show up here.
      await new Promise((done) => setTimeout(done, 5));
      running -= 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const map = await buildProjectMap(tmp, configs, BINARY, exec);

    expect(mapped(map).projects).toHaveLength(9);
    expect(peak).toBe(4);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
