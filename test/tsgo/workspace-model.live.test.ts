import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import { buildProjectMap, dropProjectMap, type ProjectMap, type TsProject } from "../../src/tsgo/project-map.js";
import { unreadableConfigReason } from "../../src/tsgo/config-graph.js";
import {
  takeWorkspaceSnapshot,
  walkWorkspace,
  workspaceSnapshotReason,
  workspaceWalkedPaths,
} from "../../src/tsgo/workspace-snapshot.js";
import {
  runTsFindReferences,
  type TsFindReferencesPayload,
  type TsReferenceFile,
} from "../../src/tools/ts-find-references.js";
import type {
  TsNavigationScope,
  TsProjectsBlock,
  TsUncoveredBlock,
} from "../../src/tools/ts-navigation-shared.js";
import {
  CALL_BUDGET_MS,
  fixtures,
  itIfTsgoAvailable,
  listFilesOnly,
  payloadOf,
  requireTsgo,
  stampsOf,
  textOf,
  tsgoProcessLog,
  type TsgoProcessLog,
} from "../helpers/tsgo-live.js";

/**
 * Live: the workspace model, measured against the real
 * TypeScript 7 native server and the real `tsc --listFilesOnly` answers for `test/fixtures/ts-workspace*`.
 * Nothing is injected here — the listings are compiler subprocesses and the anchors are `didOpen`'d on a
 * running `tsc.exe` — because every earlier backend of this server had a defect that a mock hid.
 *
 * Every expected value is read out of the fixtures themselves (`namesUnder`, `lineOf`, `firstErrorLine`),
 * never remembered from a past run, and no case writes into `test/fixtures/**`: a case that edits disk edits
 * a `mkdtempSync` copy and ends by proving the original tree's stamps are what they were.
 */

const workspaceRoot = join(fixtures, "ts-workspace");
const failedRoot = join(fixtures, "ts-workspace-failed");
const unprovableRoot = join(fixtures, "ts-workspace-unprovable");
const memberPackage = join(workspaceRoot, "packages", "ui");

const storeFile = join(workspaceRoot, "src", "store.ts");
const sharedFile = join(workspaceRoot, "src", "shared.ts");
const appOnlyFile = join(workspaceRoot, "src", "app-only.ts");
const nodeUsesFile = join(workspaceRoot, "tools", "node-uses.ts");
const widgetFile = join(memberPackage, "src", "widget.ts");
const looseTsFile = join(memberPackage, "loose.ts");
const failedSource = join(failedRoot, "src", "a.ts");
const unprovableSource = join(unprovableRoot, "src", "b.ts");
/** The one project of the unprovable workspace whose listing succeeds — the healthy half of the live pin. */
const goodEntryFile = join(unprovableRoot, "good", "entry.ts");
const goodUsesFile = join(unprovableRoot, "good", "uses.ts");

/** The configs the map must name, in the order the `references` lists them. */
const PROJECT_CONFIGS = ["tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "configs/member.json"];
/** The two files `extends` reaches, which a project may never be made from. */
const EXTENDS_ONLY = ["tsconfig.base.json", "compiler-options.json"];
/** Every file in the fixture — which is exactly what the walk must claim it saw. */
const WORKSPACE_ENTRIES = [
  "compiler-options.json",
  "configs/member.json",
  "package.json",
  "packages/ui/loose.js",
  "packages/ui/loose.ts",
  "packages/ui/package.json",
  "packages/ui/src/widget.ts",
  "src/app-only.ts",
  "src/legacy.js",
  "src/owner.ts",
  "src/shared.ts",
  "src/store.ts",
  "test/store.test.ts",
  "tools/node-uses.ts",
  "tsconfig.app.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.node.json",
].sort();
/** The sources no project lists: the two loose files beside `include`, and the test outside it. */
const UNCOVERED = ["packages/ui/loose.js", "packages/ui/loose.ts", "test/store.test.ts"];
/** The same set as the scope block partitions it: every uncovered file grouped by its own directory. */
const UNCOVERED_DIRECTORIES = [
  { directory: "packages/ui", count: 2 },
  { directory: "test", count: 1 },
];

type Result = Awaited<ReturnType<typeof runTsFindReferences>>;

// ---------------------------------------------------------------- live scaffolding

const managers: LspSessionManager[] = [];

/** One manager per case, kept so `afterEach` disposes what a throwing assertion never reached. */
function freshManager(log?: TsgoProcessLog): LspSessionManager {
  const manager = log === undefined ? new LspSessionManager() : new LspSessionManager({ spawn: log.spawn });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.disposeAll();
});

function ask(manager: LspSessionManager, roots: string[], file: string, symbol: string): Promise<Result> {
  return runTsFindReferences(
    manager,
    { sourceRoots: roots, file, symbol, includeDeclaration: false, timeBudgetMs: CALL_BUDGET_MS },
  );
}

function payload(result: Result): TsFindReferencesPayload {
  return payloadOf<TsFindReferencesPayload>(result, "ts_find_references");
}

/** Paths compared the way the map compares them: separators normalised, case folded on this OS. */
function samePath(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const normalise = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  return normalise(a) === normalise(b);
}

/** `path` under `root` in forward slashes; its own spelling when it is not under it at all. */
function under(root: string, path: string | null | undefined): string {
  if (path === undefined || path === null) return "<none>";
  const rel = relative(root, path);
  return rel.startsWith("..") ? path : rel.split(sep).join("/");
}

function namesUnder(root: string, paths: readonly string[]): string[] {
  return paths.map((path) => under(root, path)).sort();
}

const linesOf = (file: string): string[] => readFileSync(file, "utf-8").split(/\r?\n/);

/** The 1-based line a fixture text sits on, or a failure naming the fixture that no longer carries it. */
function lineOf(file: string, needle: string): number {
  const index = linesOf(file).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer declares "${needle}" in ${file}`);
  return index + 1;
}

/** The group answering for one file, however that file happens to be spelled by the server. */
function groupOf(answer: TsFindReferencesPayload, file: string): TsReferenceFile | undefined {
  return answer.files.find((group) => samePath(group.file, file));
}

/** The map, or a failure quoting the reason the compiler's own listings gave for not having one. */
function requireMapped(map: ProjectMap): Extract<ProjectMap, { kind: "mapped" }> {
  if (map.kind !== "mapped") throw new Error(`no project map was built: ${map.reason}`);
  return map;
}

function projectFor(map: ProjectMap, root: string, config: string): TsProject {
  const mapped = requireMapped(map);
  const found = mapped.projects.find((project) => under(root, project.config) === config);
  if (found !== undefined) return found;
  throw new Error(
    `"${config}" is not a project of "${root}"; the map holds ` +
      `${JSON.stringify(namesUnder(root, mapped.projects.map((project) => project.config)))} and failed ` +
      `${JSON.stringify(mapped.failed)}`,
  );
}

/** The walk's entries, or a failure quoting what the walk said it could not finish. */
function requireWalked(root: string): { entries: Map<string, string>; unresolved: readonly string[] } {
  const walked = walkWorkspace(root);
  if (walked === undefined) {
    throw new Error(`the walk of "${root}" did not complete: ${workspaceSnapshotReason(root)}`);
  }
  return walked;
}

function requireProjects(scope: TsNavigationScope): TsProjectsBlock {
  if (!("projects" in scope)) throw new Error(`no project map was reported: ${scope.projectsUnavailable}`);
  return scope.projects;
}

function requireUncovered(scope: TsNavigationScope): TsUncoveredBlock {
  if (!("uncoveredSources" in scope)) {
    throw new Error(`no uncovered set was computed: ${scope.uncoveredSourcesUnavailable}`);
  }
  return scope.uncoveredSources;
}

function requireReloaded(scope: TsNavigationScope): string {
  if (scope.freshness.kind !== "reloaded") {
    throw new Error(`freshness answered "${scope.freshness.kind}", not the required reload`);
  }
  return scope.freshness.reason;
}

/** Every file the walk proved it saw, which is what a run must leave exactly as it found it. */
const treeStamps = (root: string): Map<string, string> => stampsOf([...requireWalked(root).entries.keys()]);

/** A copy of a fixture tree under a fresh temp directory, returned with that copy's own root. */
function copyFixture(root: string): { dir: string; copied: string } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-tsws-"));
  const copied = join(dir, basename(root));
  cpSync(root, copied, { recursive: true });
  return { dir, copied };
}

/** `child.kill()` does not wait, and on Windows the killed `tsc.exe` held this directory as its cwd. */
async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= 9) throw e;
      await new Promise((done) => setTimeout(done, 300));
    }
  }
}

/** The compiler's own first line saying what went wrong, which is the reason kept. */
async function firstErrorLine(configPath: string): Promise<string> {
  const listing = await listFilesOnly(requireTsgo(), configPath);
  const printed = `${listing.stdout}\n${listing.stderr}`
    .split(/\r?\n/)
    .find((line) => /error TS\d+/i.test(line));
  if (printed === undefined) {
    throw new Error(
      `the listing of "${configPath}" printed no error line (exit ${String(listing.exitCode)}): ` +
        `${JSON.stringify(listing.stdout.slice(0, 400))} ${JSON.stringify(listing.stderr.slice(0, 400))}`,
    );
  }
  return printed.trim();
}

/** The project map of a fixture, built by running one real `tsc --listFilesOnly` per config. */
async function liveProjectMap(root: string): Promise<ProjectMap> {
  return buildProjectMap(root, [...requireWalked(root).entries.keys()], requireTsgo());
}

// ---------------------------------------------------------------------- the cases

describe("the TypeScript workspace model against the real tsgo", () => {
  itIfTsgoAvailable(
    "maps the solution config, the app config, the node config and the referenced configs/member.json, in that order",
    async () => {
      const map = requireMapped(await liveProjectMap(workspaceRoot));

      // A referenced config is a project whatever it is called, and the solution config is a project
      // although it lists nothing. `references` order is the order the owner rule searches in.
      expect(namesUnder(workspaceRoot, map.projects.map((project) => project.config))).toEqual(
        [...PROJECT_CONFIGS].sort(),
      );
      expect(map.projects.map((project) => under(workspaceRoot, project.config))).toEqual(PROJECT_CONFIGS);
      expect(map.failed).toEqual([]);

      // The same four through the tool, because `count` is projects plus failures and `configs` is the
      // mapped half of them.
      const scope = payload(await ask(freshManager(), [workspaceRoot], storeFile, "Store.run")).scope;
      const projects = requireProjects(scope);
      expect(projects.count).toBe(map.projects.length + map.failed.length);
      expect(namesUnder(workspaceRoot, projects.configs)).toEqual([...PROJECT_CONFIGS].sort());
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "refuses tsconfig.base.json and compiler-options.json as projects, and anchors the solution config on nothing",
    async () => {
      const map = await liveProjectMap(workspaceRoot);
      const configs = namesUnder(workspaceRoot, requireMapped(map).projects.map((project) => project.config));
      for (const extendsOnly of EXTENDS_ONLY) {
        // `extends` configures a project; it does not make one — the language service's own rule.
        expect(configs).not.toContain(extendsOnly);
      }

      // `{"files": [], "references": [...]}` reads nothing, so it needs no anchor and is not a failure.
      const solution = projectFor(map, workspaceRoot, "tsconfig.json");
      expect(solution.anchor).toBeNull();
      expect(solution.members).toEqual([]);
      expect(requireMapped(map).failed).toEqual([]);
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "anchors the node project on the file under tools it owns, not the first file its listing names",
    async () => {
      const map = await liveProjectMap(workspaceRoot);
      const node = projectFor(map, workspaceRoot, "tsconfig.node.json");

      // A listing says what a project READS: `tools/node-uses.ts` imports `src/owner.ts`, which the app
      // project owns, so that file is in this listing and is not this project's anchor.
      expect(namesUnder(workspaceRoot, node.members)).toContain("src/owner.ts");
      const lexicallyFirst = [...node.members].sort()[0] as string;
      expect(under(workspaceRoot, lexicallyFirst)).toBe("src/owner.ts");
      expect(under(workspaceRoot, node.anchor)).toBe("tools/node-uses.ts");
      expect(node.anchor).not.toBe(lexicallyFirst);

      // The other two anchors are the same rule read off the members each project owns.
      expect(under(workspaceRoot, projectFor(map, workspaceRoot, "tsconfig.app.json").anchor)).toBe(
        "src/app-only.ts",
      );
      expect(under(workspaceRoot, projectFor(map, workspaceRoot, "configs/member.json").anchor)).toBe(
        "packages/ui/src/widget.ts",
      );
      expect(namesUnder(workspaceRoot, requireMapped(map).uncovered)).toEqual(UNCOVERED);
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "finds the one consumer each project can see, and still finds all three after an unrelated file is opened",
    async () => {
      const manager = freshManager();
      // Each row below is in exactly one project's program: `app-only.ts` in the app project, `node-uses.ts`
      // in the node project, `widget.ts` in the referenced member project. A missing row is a project whose
      // anchor was never opened — or was dropped — on the process that answered.
      const subjects = [
        { declaring: storeFile, symbol: "Store.run", consumer: appOnlyFile, in: "appReport", total: 1 },
        { declaring: storeFile, symbol: "Store.flush", consumer: nodeUsesFile, in: "nodeFlush", total: 1 },
        // The widget's import line is a row too: its specifier and its one use.
        { declaring: sharedFile, symbol: "SHARED_LABEL", consumer: widgetFile, in: "widgetLabel", total: 2 },
      ] as const;

      const readAll = async (): Promise<TsFindReferencesPayload[]> => {
        const answers: TsFindReferencesPayload[] = [];
        for (const subject of subjects) {
          answers.push(payload(await ask(manager, [workspaceRoot], subject.declaring, subject.symbol)));
        }
        return answers;
      };

      expect((await readAll()).map((answer) => answer.totalReferences)).toEqual([1, 1, 2]);

      // `packages/ui/loose.ts` is a source no project lists, so opening it gives tsgo an inferred project to
      // swap in — the stated exception, and the eviction the measured server behaviour could not measure.
      expect((await ask(manager, [workspaceRoot], looseTsFile, "LOOSE_MEMBER")).isError).toBeFalsy();

      const after = await readAll();
      for (const [index, subject] of subjects.entries()) {
        const answer = after[index] as TsFindReferencesPayload;
        const projects = requireProjects(answer.scope);
        expect(projects.failed).toEqual([]);
        expect(namesUnder(workspaceRoot, projects.configs)).toEqual([...PROJECT_CONFIGS].sort());
        expect(answer.scope.limits).not.toContain("projects-not-loaded");
        expect(answer.totalReferences).toBe(subject.total);
        expect(answer.resolved.name).toBe(subject.symbol);
        const group = groupOf(answer, subject.consumer);
        expect(group === undefined ? "<no group>" : under(workspaceRoot, group.file)).toBe(
          under(workspaceRoot, subject.consumer),
        );
        expect(group?.count).toBe(subject.total);
        expect(group?.sites.map((site) => site.in)).toContain(subject.in);
      }
    },
    CALL_BUDGET_MS * 3,
  );

  itIfTsgoAvailable(
    "pushes a created using file into the answer and takes it back when it is deleted, in a copy",
    async () => {
      const before = treeStamps(workspaceRoot);
      const { dir, copied } = copyFixture(workspaceRoot);
      const copiedStore = join(copied, "src", "store.ts");
      const extra = join(copied, "src", "zz-extra.ts");
      const manager = freshManager();
      try {
        const baseline = payload(await ask(manager, [copied], copiedStore, "Store.run"));
        expect(baseline.totalReferences).toBe(1);
        expect(baseline.scope.freshness.kind).toBe("unchanged");

        // `zz-` sorts last, so the new file cannot move the app project's anchor out from under the session.
        writeFileSync(
          extra,
          'import { Store } from "./store.js";\n\nexport function zzExtra(store: Store): string {\n  return store.run();\n}\n',
        );
        const created = payload(await ask(manager, [copied], copiedStore, "Store.run"));
        expect(created.scope.freshness).toMatchObject({ kind: "pushed", changedFiles: 1 });
        expect(created.totalReferences).toBe(2);
        expect(namesUnder(copied, created.files.map((group) => group.file))).toEqual([
          "src/app-only.ts",
          "src/zz-extra.ts",
        ]);
        expect(groupOf(created, extra)?.sites[0]?.in).toBe("zzExtra");
        expect(groupOf(created, extra)?.sites[0]?.line).toBe(lineOf(extra, "return store.run();"));
        // A created path is structural, so the map is rebuilt and the new file is listed by the app project:
        // it must not show up as a source nothing includes.
        expect(requireUncovered(created.scope).directories).toEqual(UNCOVERED_DIRECTORIES);

        rmSync(extra);
        const deleted = payload(await ask(manager, [copied], copiedStore, "Store.run"));
        expect(deleted.scope.freshness).toMatchObject({ kind: "pushed", changedFiles: 1 });
        expect(deleted.totalReferences).toBe(1);
        expect(namesUnder(copied, deleted.files.map((group) => group.file))).toEqual(["src/app-only.ts"]);
      } finally {
        manager.disposeAll();
        dropProjectMap(copied);
        await removeTree(dir);
      }
      expect(treeStamps(workspaceRoot)).toEqual(before);
    },
    CALL_BUDGET_MS * 3,
  );

  itIfTsgoAvailable(
    "tracks a config reached only through references: editing configs/member.json is pushed and rebuilds the map",
    async () => {
      const before = treeStamps(workspaceRoot);
      const { dir, copied } = copyFixture(workspaceRoot);
      const copiedStore = join(copied, "src", "store.ts");
      const memberConfig = join(copied, "configs", "member.json");
      const manager = freshManager();
      try {
        // Not named `tsconfig.json`, in a directory named `configs`: no filename rule reaches it. The
        // closure does, because the workspace's root config lists it under `references`.
        expect(requireWalked(copied).entries.has(memberConfig)).toBe(true);
        const first = payload(await ask(manager, [copied], copiedStore, "Store.run"));
        expect(requireUncovered(first.scope).directories).toEqual(UNCOVERED_DIRECTORIES);

        writeFileSync(
          memberConfig,
          JSON.stringify({ extends: "../tsconfig.base.json", include: ["../packages/ui"] }),
        );
        const widened = payload(await ask(manager, [copied], copiedStore, "Store.run"));
        expect(widened.scope.freshness).toMatchObject({ kind: "pushed", changedFiles: 1 });
        // Only a REBUILT map knows that the member project now reads `packages/ui/loose.ts`; a reused one
        // would still name it uncovered, which is the stale answer this server refuses to give.
        expect(requireUncovered(widened.scope).directories).toEqual([
          { directory: "packages/ui", count: 1 },
          { directory: "test", count: 1 },
        ]);
      } finally {
        manager.disposeAll();
        dropProjectMap(copied);
        await removeTree(dir);
      }
      expect(treeStamps(workspaceRoot)).toEqual(before);
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "tracks a config reached only through extends: touching compiler-options.json is a change, not an unchanged disk",
    async () => {
      const before = treeStamps(workspaceRoot);
      const { dir, copied } = copyFixture(workspaceRoot);
      const options = join(copied, "compiler-options.json");
      const manager = freshManager();
      try {
        // Neither a source nor a config by name: the resolution rule is the only reason this is held.
        expect(requireWalked(copied).entries.has(options)).toBe(true);

        const first = payload(await ask(manager, [copied], join(copied, "src", "store.ts"), "Store.run"));
        expect(first.scope.freshness.kind).toBe("unchanged");

        // A no-op option. The claim is that the edit is SEEN, not that it changes what a project means.
        const parsed = JSON.parse(readFileSync(options, "utf-8")) as { compilerOptions?: Record<string, unknown> };
        expect(parsed.compilerOptions).toBeDefined();
        writeFileSync(
          options,
          `${JSON.stringify({ compilerOptions: { ...parsed.compilerOptions, pretty: false } }, null, 2)}\n`,
        );

        const second = payload(await ask(manager, [copied], join(copied, "src", "store.ts"), "Store.run"));
        expect(second.scope.freshness).toMatchObject({ kind: "pushed", changedFiles: 1 });
      } finally {
        manager.disposeAll();
        dropProjectMap(copied);
        await removeTree(dir);
      }
      expect(treeStamps(workspaceRoot)).toEqual(before);
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "keeps a failed listing as a failed project carrying the compiler's own first error line",
    async () => {
      const brokenConfig = join(failedRoot, "tsconfig.broken.json");
      const expected = await firstErrorLine(brokenConfig);
      const map = requireMapped(await liveProjectMap(failedRoot));

      expect(namesUnder(failedRoot, map.projects.map((project) => project.config))).toEqual([
        "tsconfig.good.json",
        "tsconfig.json",
      ]);
      expect(map.failed).toEqual([{ config: brokenConfig, reason: expected }]);

      // The solution config reads nothing; the good project's one source is its own to anchor on.
      expect(projectFor(map, failedRoot, "tsconfig.json").anchor).toBeNull();
      expect(under(failedRoot, projectFor(map, failedRoot, "tsconfig.good.json").anchor)).toBe("src/a.ts");
      expect(map.uncovered).toEqual([]);
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "answers the failed-config workspace with the failed project named and no computed uncovered set",
    async () => {
      const scope = payload(await ask(freshManager(), [failedRoot], failedSource, "A")).scope;

      const projects = requireProjects(scope);
      expect(basename(projects.failed[0]?.config ?? "")).toBe("tsconfig.broken.json");
      expect(projects.failed[0]?.reason).toMatch(/error TS\d+/);
      expect(projects.count).toBe(3);
      expect(scope.limits).toContain("projects-not-loaded");
      // A listing that failed says nothing about the files it would have named, so the uncovered set is
      // reported as unprovable rather than computed from listings known to be incomplete.
      expect("uncoveredSources" in scope).toBe(false);
      expect(scope.uncoveredSourcesUnavailable).toContain("tsconfig.broken.json");
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "maps the projects an unprovable closure did reach, reloads every call, and names the config",
    async () => {
      const unreadableConfig = join(unprovableRoot, "tsconfig.unreadable.json");
      const before = treeStamps(unprovableRoot);
      const walked = requireWalked(unprovableRoot);
      expect(walked.unresolved.join("; ")).toContain("gone.json");
      expect(takeWorkspaceSnapshot(unprovableRoot)).toBeUndefined();
      expect(workspaceSnapshotReason(unprovableRoot)).toContain("gone.json");
      // The walk is one that also returns what it could not resolve, so the map
      // is built from the paths it DID see. Withholding the snapshot makes every call reload; it does not make
      // the workspace's projects unknown.
      expect(workspaceWalkedPaths(unprovableRoot)?.length, "the walk saw the files it tracked").toBeGreaterThan(0);

      const log = tsgoProcessLog();
      const manager = freshManager(log);
      try {
        // The first call of a session cannot know: the freshness check compares a baseline the spawn has not
        // taken yet. Every call after it reloads and maps again with it.
        const warm = payload(await ask(manager, [unprovableRoot], unprovableSource, "B"));
        console.info(`first call of a fresh session answered freshness "${warm.scope.freshness.kind}"`);
        expect(requireProjects(warm.scope).count).toBe(3);

        for (const call of [2, 3]) {
          const again = payload(await ask(manager, [unprovableRoot], unprovableSource, "B"));
          const scope = again.scope;
          const projects = requireProjects(scope);
          expect(requireReloaded(scope)).toContain("gone.json");

          // Live: a config this server cannot read is still a project the language service will try
          // to load, so it is in `projects.failed` with that read error. It could never get there on the real
          // server while an unreadable config also left the map unbuildable.
          expect(namesUnder(unprovableRoot, projects.failed.map((failure) => failure.config)))
            .toContain("tsconfig.unreadable.json");
          expect(projects.failed.map((failure) => failure.reason)).toContain(unreadableConfigReason(unreadableConfig));
          // tsc cannot follow the dangling `extends` either, so the config that
          // carries it fails its listing through the ordinary path, with the compiler's line as its reason.
          expect(projects.failed.some((failure) => /error TS\d+/.test(failure.reason)), JSON.stringify(projects.failed))
            .toBe(true);
          // Three projects exist, two of them broken; the third lists fine and is the one this answer anchors,
          // which is what is meant by "the map is still built from the paths the walk did see".
          expect(namesUnder(unprovableRoot, projects.failed.map((failure) => failure.config))).toEqual([
            "tsconfig.json",
            "tsconfig.unreadable.json",
          ]);
          expect(namesUnder(unprovableRoot, projects.configs)).toEqual(["tsconfig.good.json"]);
          expect(projects.count).toBe(3);
          expect(scope.limits).toContain("projects-not-loaded");
          // A listing that failed says nothing about the files it would have named.
          expect("uncoveredSources" in scope).toBe(false);
          expect(scope.uncoveredSourcesUnavailable).toContain("tsconfig");
          // "answers from a fresh process" is a claim about children: one more `tsc.exe` per call.
          expect(log.pids, `call ${call}`).toHaveLength(call);
        }
      } finally {
        manager.disposeAll();
      }
      expect(treeStamps(unprovableRoot)).toEqual(before);
    },
    CALL_BUDGET_MS * 3,
  );

  // An unprovable closure reloads the session on every call, and the project map is still built
  // from the paths the walk did see. Both of this fixture's other configs fail their listings, so the case
  // below measures the state no other live case of this fixture can show: a HEALTHY project, mapped and
  // anchored, answering across its own files while the session reloads.
  itIfTsgoAvailable(
    "anchors the working project of an unprovable workspace and answers across its own two files",
    async () => {
      const before = treeStamps(unprovableRoot);
      const log = tsgoProcessLog();
      const manager = freshManager(log);
      try {
        // The first call of a session has no process to reload; the second is the one that says so, and this
        // case pins the healthy project on THAT answer — reloaded, mapped and complete for its own project.
        await ask(manager, [unprovableRoot], goodEntryFile, "goodName");
        const answer = payload(await ask(manager, [unprovableRoot], goodEntryFile, "goodName"));
        const scope = answer.scope;

        expect(requireReloaded(scope)).toContain("gone.json");
        expect(namesUnder(unprovableRoot, requireProjects(scope).configs)).toEqual(["tsconfig.good.json"]);
        // Two of this fixture's three projects did not load, and the answer says so — while the third still
        // answers in full. The code states a narrowing; it does not empty the answer.
        expect(scope.limits).toContain("projects-not-loaded");
        // The import line of `goodName` and its one call.
        expect(answer.totalReferences).toBe(2);
        const uses = groupOf(answer, goodUsesFile);
        expect(uses === undefined ? `<no group; the answer holds ${JSON.stringify(namesUnder(unprovableRoot, answer.files.map((group) => group.file)))}>` : under(unprovableRoot, uses.file)).toBe("good/uses.ts");
        expect(uses?.count).toBe(2);
        expect(uses?.sites.map((site) => site.line)).toEqual([
          lineOf(goodUsesFile, "import { goodName }"),
          lineOf(goodUsesFile, "return goodName();"),
        ]);
        expect(uses?.sites.map((site) => site.in)).toEqual(["goodName", "callGood"]);

        // The project was loaded by opening a file of it on the answering process — the whole proof —
        // and the reload really did cost a new child, which is the stated price.
        expect(log.opened.map((opened) => under(unprovableRoot, opened.file))).toContain("good/entry.ts");
        expect(log.pids.length).toBeGreaterThanOrEqual(2);
      } finally {
        manager.disposeAll();
      }
      expect(treeStamps(unprovableRoot)).toEqual(before);
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "walks every source, every manifest and the closure-only files, and nothing under node_modules or a dot",
    async () => {
      const walked = requireWalked(workspaceRoot);
      expect(walked.unresolved).toEqual([]);
      expect(namesUnder(workspaceRoot, [...walked.entries.keys()])).toEqual(WORKSPACE_ENTRIES);
      // The two files that no config-name rule would look at, tracked because the closure resolves.
      expect(walked.entries.has(join(workspaceRoot, "configs", "member.json"))).toBe(true);
      expect(walked.entries.has(join(workspaceRoot, "compiler-options.json"))).toBe(true);
      for (const path of walked.entries.keys()) {
        // Below the root, not absolute: the checkout may itself live under a dot-directory, and the rule being
        // stated is that the walk never descends into a dot-directory or a node_modules.
        expect(path.slice(workspaceRoot.length)).not.toMatch(/[\\/](?:node_modules|\.)/);
      }

      const snapshot = takeWorkspaceSnapshot(workspaceRoot);
      expect(snapshot === undefined ? "<no snapshot>" : namesUnder(workspaceRoot, [...snapshot.keys()])).toEqual(
        WORKSPACE_ENTRIES,
      );
      expect(workspaceSnapshotReason(workspaceRoot)).toBeUndefined();
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "roots the answer at the npm workspace holding the file, and at the package when the workspace is not declared",
    async () => {
      const wide = payload(await ask(freshManager(), [workspaceRoot], widgetFile, "widgetLabel"));
      expect(samePath(wide.scope.workspaceRoot, resolve(workspaceRoot))).toBe(true);
      expect(wide.scope.enclosingWorkspace).toBeNull();
      // The member package's consumer is inside this root, so its project is one of those loaded.
      expect(namesUnder(workspaceRoot, requireProjects(wide.scope).configs)).toContain("configs/member.json");
      expect(wide.scope.limits).toContain("one-workspace");

      const narrow = payload(await ask(freshManager(), [memberPackage], widgetFile, "widgetLabel"));
      expect(samePath(narrow.scope.workspaceRoot, resolve(memberPackage))).toBe(true);
      // `go.work`'s treatment: the wider workspace is named as what was NOT spanned, never rooted at.
      expect(samePath(narrow.scope.enclosingWorkspace ?? undefined, resolve(workspaceRoot))).toBe(true);
      // No config inside the package, so no map, and the answer says that instead of claiming a project set.
      expect("projects" in narrow.scope).toBe(false);
      expect(narrow.scope.projectsUnavailable).toContain("jsconfig");
      expect(narrow.scope.limits).toContain("projects-not-loaded");
      expect("uncoveredSources" in narrow.scope).toBe(false);

      // And a file of the wider workspace is not reachable through the narrow root: refused, not answered.
      const escaped = await ask(freshManager(), [memberPackage], sharedFile, "SHARED_LABEL");
      expect(escaped.isError).toBe(true);
      expect(textOf(escaped)).toContain("shared.ts");
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "reports the version the answering process stated, and holds scope's lists inside their caps",
    async () => {
      const manager = freshManager();
      try {
        const scope = payload(await ask(manager, [workspaceRoot], storeFile, "Store.run")).scope;
        const projects = requireProjects(scope);
        const uncovered = requireUncovered(scope);

        // `server.version` is `initialize`'s answer from the process that replied, read here off
        // that same session rather than off the package the executable was located in.
        const stated = manager.get(workspaceRoot, tsgoConfig(requireTsgo())).serverInfo();
        expect(scope.server.version).toBe(stated?.version);
        const located = requireTsgo();
        if (located.version !== scope.server.version) {
          console.info(
            `REPORT: scope.server.version="${scope.server.version}" while the located package states ` +
              `"${located.version}" at "${located.executable}"`,
          );
        }

        // The fixture is far too small to overflow a cap; what is pinned is that the cap holds and that the
        // exact count beside it does not move when it does.
        expect(projects.configs.length).toBeLessThanOrEqual(20);
        expect(projects.configs.length).toBe(projects.count - projects.failed.length);
        expect(uncovered.directories.length).toBeLessThanOrEqual(20);
        expect(uncovered.directories.reduce((sum, one) => sum + one.count, 0)).toBe(uncovered.count);
        expect(uncovered.directoriesTruncated).toBe(0);
        expect(uncovered.mentioning.files.length).toBeLessThanOrEqual(20);
        expect(uncovered.count).toBe(UNCOVERED.length);
        expect(uncovered.namedFileUncovered).toBe(false);

        // No `node_modules/typescript` inside the fixture, so nothing may claim the majors differ.
        expect(scope.workspaceTypescript).toBeNull();
        expect(scope.limits).not.toContain("workspace-typescript-differs");
        expect(scope.limits[0]).toBe("one-workspace");
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS,
  );
});
