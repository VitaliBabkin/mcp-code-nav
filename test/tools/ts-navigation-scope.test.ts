// `scope`, read off the facts a TypeScript type-aware answer is built from: the
// projects the map proved (or why none could be), the sources none of them lists (or why that set is not
// known), what answered, and the boundary codes in the table's order. No `tsc.exe`, no `npm` and no real tsgo
// runs here: the session is the fake the Go and C++ suites drive, the project facts are `ProjectMap`'s own
// shapes handed to the function that turns them into `scope`, and the one thing read off the disk is the
// workspace's own TypeScript manifest — which is the only disk fact `scope` claims.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import type { FreshnessOutcome } from "../../src/lsp/session.js";
import { budgetOf } from "../../src/tools/budget.js";
import type { Position } from "../../src/tools/lsp-locations.js";
import type { TsSubject } from "../../src/tools/ts-addressing.js";
import {
  mentionNameOf,
  tsNavigationScope,
  tsScopeText,
  tsUncoveredLine,
  tsUncoveredText,
  type TsNavigationScope,
  type TsProjectsBlock,
  type TsQuery,
  type TsScopeFlags,
  type TsUncoveredBlock,
} from "../../src/tools/ts-navigation-shared.js";
import type { TsgoBinary } from "../../src/tsgo/binary.js";
import type { ProjectFailure, TsProject } from "../../src/tsgo/project-map.js";
import { fakeServer, sessionOver } from "../helpers/fake-lsp.js";

/** What the located package says the executable is; one case has the answering process say something else. */
const BINARY: TsgoBinary = { executable: "C:/fake/lib/tsc.exe", version: "7.0.2", source: "global" };
const SERVER_VERSION = "7.0.2";

/** A reference answer for an interface, with nothing dropped by a cap. */
const NO_FLAGS: TsScopeFlags = { capped: false, correspondingMethods: false };

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-tsscope-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A path in the workspace. Config and source paths are facts the map carries; `scope` re-reads none of them. */
const inWorkspace = (...parts: string[]): string => join(tmp, ...parts);

/** The file every case addresses, which is also the document the answer's proof rests on. */
const mainFile = (): string => inWorkspace("src", "main.ts");

/** The sentence a workspace over the project bound is answered with. */
const noMap = (root: string): string => `"${root}" holds 33 tsconfig projects, over the 32 this server maps`;

/** The reason a reload happens for, in its own words. */
const reloadedBecause = (root: string, spec: string, config: string): FreshnessOutcome => ({
  kind: "reloaded",
  reason: `the config closure under "${root}" is not provable: extends resolves to nothing: "${spec}" in "${config}"`,
});

interface Facts {
  readonly projects?: readonly TsProject[];
  readonly failed?: readonly ProjectFailure[];
  readonly subsumed?: readonly string[];
  readonly uncovered?: readonly string[];
  /** Text to write at an uncovered path before the scan reads it; a path with no body is unreadable. */
  readonly bodies?: Readonly<Record<string, string>>;
  readonly projectsUnavailable?: string;
  readonly file?: string;
  readonly freshness?: FreshnessOutcome;
  readonly enclosingWorkspace?: string | null;
  /** What the answer scans the uncovered text for — the subject's key as it is grepped. */
  readonly mentionName?: string;
  /** The call's budget; a spent one is what a type-aware request that ran long leaves the scan. */
  readonly budgetMs?: number;
  /** What the fake process answers `initialize` with; the default names the version that answers. */
  readonly initialize?: unknown;
}

/** The addressed declaration, in the shape the prelude hands on; `scope` reads none of it. */
function subjectAt(file: string, kind: string): TsSubject {
  const entry: LspDocumentSymbol = {
    name: "Storage",
    kind: kind === "method" ? 6 : 11,
    range: { start: { line: 0, character: 17 }, end: { line: 2, character: 1 } },
    selectionRange: { start: { line: 0, character: 17 } },
  };
  const position: Position = { line: 0, character: 17 };
  return { symbol: "Storage", entries: [entry], entry, kind, file, line: 1, position, spelling: "Storage" };
}

/** Writes `<root>/node_modules/typescript/package.json`, where the workspace's own compiler is read from. */
function workspaceTypeScript(body: unknown): void {
  const path = inWorkspace("node_modules", "typescript", "package.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * The `scope` a call would publish for these map facts, over a real temp workspace and a fake tsgo that has
 * answered `initialize`. Opening the named file is what makes the handshake happen, so the version reported
 * below is the answering process's own answer and not a value this file could have written anywhere. The
 * uncovered block reads text, so a path a case wants mentioned gets its body written here.
 */
async function scopeOf(facts: Facts = {}, flags: TsScopeFlags = NO_FLAGS): Promise<TsNavigationScope> {
  const file = facts.file ?? mainFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export interface Storage {}\n");
  for (const [path, body] of Object.entries(facts.bodies ?? {})) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf-8");
  }
  const server = fakeServer({
    respond: (method) =>
      method === "initialize"
        ? (facts.initialize ?? { serverInfo: { name: "tsgo", version: SERVER_VERSION } })
        : [],
  });
  const session = sessionOver(server, {
    root: tmp,
    config: tsgoConfig(BINARY),
    readFile: () => "export interface Storage {}\n",
  });
  await session.openAnchors([file]);

  const projects = facts.projects ?? [];
  const subject = subjectAt(file, "interface");
  return await tsNavigationScope(
    {
      session,
      budget: budgetOf(facts.budgetMs ?? 60_000),
      binary: BINARY,
      workspaceRoot: tmp,
      enclosingWorkspace: facts.enclosingWorkspace ?? null,
      file,
      freshness: facts.freshness ?? { kind: "unchanged" },
      projects,
      failed: facts.failed ?? [],
      subsumed: facts.subsumed ?? [],
      uncovered: facts.projectsUnavailable === undefined ? (facts.uncovered ?? []) : undefined,
      projectsUnavailable: facts.projectsUnavailable,
      anchors: projects.flatMap((project) => (project.anchor === null ? [] : [project.anchor])),
      symbols: [],
      subject,
      resolved: { name: subject.spelling, kind: subject.kind, file, line: subject.line },
    },
    flags,
    facts.mentionName ?? "Storage",
  );
}

/** One loaded, anchored project, for the cases whose subject is the scope rather than the map's shape. */
function loadedProject(): TsProject {
  const main = mainFile();
  return { config: inWorkspace("tsconfig.json"), anchor: main, members: [main] };
}

/** The loaded-project block of a scope that proved one. */
function projectsOf(scope: TsNavigationScope): TsProjectsBlock {
  if (!("projects" in scope)) throw new Error(`this scope names no loaded projects: ${JSON.stringify(scope)}`);
  return scope.projects;
}

/** The uncovered block of a scope that proved one. */
function uncoveredOf(scope: TsNavigationScope): TsUncoveredBlock {
  if (!("uncoveredSources" in scope)) throw new Error(`this scope gives no uncovered block: ${JSON.stringify(scope)}`);
  return scope.uncoveredSources;
}

/** The block of a workspace every project covers: nothing to scan, so nothing found and nothing unchecked. */
function noUncovered(name: string): TsUncoveredBlock {
  return {
    count: 0,
    grepRequired: false,
    directories: [],
    directoriesTruncated: 0,
    mentioning: { name, count: 0, files: [], filesTruncated: 0, unchecked: 0 },
    namedFileUncovered: false,
  };
}

/** A body the scan can read that never names `Storage`. */
const SILENT = "export const other = 1;\n";

/** The reason a scope gave instead of an uncovered block. */
function unavailableOf(scope: TsNavigationScope): string {
  if (!("uncoveredSourcesUnavailable" in scope)) {
    throw new Error(`this scope proves its uncovered sources: ${JSON.stringify(scope)}`);
  }
  return scope.uncoveredSourcesUnavailable;
}

describe("tsNavigationScope", () => {
  it("publishes the whole ground of a clean, fully mapped answer, with one-workspace as its only code", async () => {
    const project = loadedProject();

    const scope = await scopeOf({ projects: [project] });

    expect(scope).toEqual({
      workspaceRoot: tmp,
      enclosingWorkspace: null,
      freshness: { kind: "unchanged" },
      server: { version: SERVER_VERSION },
      workspaceTypescript: null,
      projects: { count: 1, configs: [project.config], failed: [], subsumed: [] },
      uncoveredSources: noUncovered("Storage"),
      limits: ["one-workspace"],
    });
    // The keys and their order are the contract, and `visibility` is not among them: TypeScript's export test
    // needs a syntactic read this server does not add, and `one-workspace` already says that
    // code outside the root is unseen.
    expect(Object.keys(scope)).toEqual([
      "workspaceRoot",
      "enclosingWorkspace",
      "freshness",
      "server",
      "workspaceTypescript",
      "projects",
      "uncoveredSources",
      "limits",
    ]);
    expect(JSON.stringify(scope)).not.toContain("visibility");
  });

  it("carries projects-not-loaded for a failed project, and says the uncovered set is not known because of it", async () => {
    const kept = loadedProject();
    const broken = inWorkspace("packages", "app", "tsconfig.json");
    // A listing that never stated an outcome: `scope` reports a failed entry whatever its reason, and the
    // ownership reason now belongs to a project with an unowned member, which is the map's own test.
    const failure: ProjectFailure = { config: broken, reason: "the listing gave no exit code" };

    const scope = await scopeOf({ projects: [kept], failed: [failure], uncovered: [inWorkspace("test", "a.ts")] });

    expect(projectsOf(scope)).toEqual({ count: 2, configs: [kept.config], failed: [failure], subsumed: [] });
    // A listing that failed says nothing about the files it would have named, so with one in the set "no
    // project includes this file" is unprovable rather than answered with a set that quietly omits a project.
    expect(scope).not.toHaveProperty("uncoveredSources");
    expect(unavailableOf(scope)).toBe(
      `the project listing for "${broken}" failed, so which sources no project includes is not known`,
    );
    expect(scope.limits).toEqual(["one-workspace", "projects-not-loaded"]);

    const other = inWorkspace("packages", "node", "tsconfig.json");
    const two = await scopeOf({ projects: [kept], failed: [failure, { config: other, reason: "the listing exited with code 2" }] });
    expect(two.limits).toEqual(["one-workspace", "projects-not-loaded"]);
    expect(unavailableOf(two)).toBe(
      `the project listings for "${broken}", "${other}" failed, so which sources no project includes is not known`,
    );
  });

  it("carries both unavailable fields and projects-not-loaded when no map could be proved", async () => {
    const reason = noMap(tmp);

    const scope = await scopeOf({ projectsUnavailable: reason });

    // The call opened only the named file, so it knows neither which projects exist nor which sources none of
    // them includes, and both halves state the map's own reason.
    expect(scope).toEqual({
      workspaceRoot: tmp,
      enclosingWorkspace: null,
      freshness: { kind: "unchanged" },
      server: { version: SERVER_VERSION },
      workspaceTypescript: null,
      projectsUnavailable: reason,
      uncoveredSourcesUnavailable: reason,
      limits: ["one-workspace", "projects-not-loaded"],
    });
    expect(Object.keys(scope)).toEqual([
      "workspaceRoot",
      "enclosingWorkspace",
      "freshness",
      "server",
      "workspaceTypescript",
      "projectsUnavailable",
      "uncoveredSourcesUnavailable",
      "limits",
    ]);
  });

  it("puts uncovered-sources-present before the interface-method code for a method's listing", async () => {
    const orphan = inWorkspace("test", "store.test.ts");

    const scope = await scopeOf(
      { projects: [loadedProject()], uncovered: [orphan] },
      { capped: false, correspondingMethods: true },
    );

    // The orphan is not on disk, which the block states as one unchecked file rather than a quiet zero.
    expect(uncoveredOf(scope)).toEqual({
      count: 1,
      grepRequired: true,
      directories: [{ directory: "test", count: 1 }],
      directoriesTruncated: 0,
      mentioning: { name: "Storage", count: 0, files: [], filesTruncated: 0, unchecked: 1 },
      namedFileUncovered: false,
    });
    expect(scope.limits).toEqual([
      "one-workspace",
      "uncovered-sources-present",
      "corresponding-interface-methods-included",
    ]);

    // A listing whose subject is not a method is never told about a correspondence it did not over-report.
    const plain = await scopeOf({ projects: [loadedProject()], uncovered: [orphan] });
    expect(plain.limits).toEqual(["one-workspace", "uncovered-sources-present"]);

    const capped = await scopeOf(
      { projects: [loadedProject()], uncovered: [orphan] },
      { capped: true, correspondingMethods: true },
    );
    expect(capped.limits).toEqual([
      "one-workspace",
      "uncovered-sources-present",
      "corresponding-interface-methods-included",
      "listing-capped",
    ]);
  });

  it("adds workspace-typescript-differs where the workspace compiles with another major than the answer", async () => {
    workspaceTypeScript({ name: "typescript", version: "5.9.3" });

    const scope = await scopeOf({ projects: [loadedProject()] });

    expect(scope.workspaceTypescript).toBe("5.9.3");
    expect(scope.server).toEqual({ version: "7.0.2" });
    expect(scope.limits).toEqual(["one-workspace", "workspace-typescript-differs"]);

    // A project that did not load is still reported first; the differing compiler is a second, independent fact.
    const kept = loadedProject();
    const broken = inWorkspace("packages", "app", "tsconfig.json");
    const both = await scopeOf({
      projects: [kept],
      failed: [{ config: broken, reason: "the listing exited with code 2" }],
    });
    expect(both.limits).toEqual(["one-workspace", "projects-not-loaded", "workspace-typescript-differs"]);
  });

  it("states the differing compiler before what the answer is missing, as the table's order has it", async () => {
    workspaceTypeScript({ name: "typescript", version: "5.9.3" });
    const orphan = inWorkspace("test", "store.test.ts");

    const scope = await scopeOf(
      { projects: [loadedProject()], uncovered: [orphan] },
      { capped: false, correspondingMethods: true },
    );

    expect(scope.limits).toEqual([
      "one-workspace",
      "workspace-typescript-differs",
      "uncovered-sources-present",
      "corresponding-interface-methods-included",
    ]);
  });

  // The two codes the TS tools add, in the rows of the table they are listed on: the structural
  // one third (it is about what an implementation answer cannot hold, beside the project code that says what
  // it did not load), the indirect-dispatch one after the interface-method over-report and before the cap.
  it("puts the structural and indirect-dispatch codes at their table rows, whatever else the answer carries", async () => {
    workspaceTypeScript({ name: "typescript", version: "5.9.3" });
    const kept = loadedProject();
    const broken = inWorkspace("packages", "app", "tsconfig.json");
    const failure: ProjectFailure = { config: broken, reason: "the listing exited with code 2" };

    const implementation = await scopeOf(
      { projects: [kept], failed: [failure] },
      { capped: false, correspondingMethods: false, structuralImplementers: true },
    );
    expect(implementation.limits).toEqual([
      "one-workspace",
      "projects-not-loaded",
      "structural-implementers-not-reported",
      "workspace-typescript-differs",
    ]);

    const caller = await scopeOf(
      { projects: [kept], failed: [failure] },
      { capped: true, correspondingMethods: true, indirectDispatch: true, uncalledMentions: true },
    );
    expect(caller.limits).toEqual([
      "one-workspace",
      "projects-not-loaded",
      "workspace-typescript-differs",
      "corresponding-interface-methods-included",
      "indirect-dispatch-not-resolved",
      // The complementary pair sits side by side, the absence and the presence, and
      // the cap last.
      "uncalled-mentions-included",
      "listing-capped",
    ]);

    // Every code one TS answer can carry at once. `projects-not-loaded` cannot join this shape: a failed
    // listing makes the uncovered set unprovable, so `uncovered-sources-present` has nothing to be counted from
    // beside it — the two cases above are the halves of the table an answer can hold.
    const everyCode = await scopeOf(
      { projects: [kept], uncovered: [inWorkspace("test", "a.ts")] },
      {
        capped: true,
        correspondingMethods: true,
        structuralImplementers: true,
        indirectDispatch: true,
        uncalledMentions: true,
      },
    );
    expect(everyCode.limits).toEqual([
      "one-workspace",
      "structural-implementers-not-reported",
      "workspace-typescript-differs",
      "uncovered-sources-present",
      "corresponding-interface-methods-included",
      "indirect-dispatch-not-resolved",
      "uncalled-mentions-included",
      "listing-capped",
    ]);
  });

  it("says nothing about a differing TypeScript where the comparison has no second half to it", async () => {
    // Same major: the answer and the workspace's compiler agree on the language, which is all the code claims.
    workspaceTypeScript({ name: "typescript", version: "7.1.0" });
    const sameMajor = await scopeOf({ projects: [loadedProject()] });
    expect(sameMajor.workspaceTypescript).toBe("7.1.0");
    expect(sameMajor.limits).toEqual(["one-workspace"]);

    // The process named no version for itself, so there is no answer to compare with.
    const noVersion = await scopeOf({ projects: [loadedProject()], initialize: {} });
    expect(noVersion.server).toEqual({ version: null });
    expect(noVersion.workspaceTypescript).toBe("7.1.0");
    expect(noVersion.limits).toEqual(["one-workspace"]);
    expect(tsScopeText(noVersion)).toBe(
      ` under workspace "${tmp}": 1 project(s) found, 1 loaded, 0 failed, freshness: unchanged`,
    );

    // The workspace carries no TypeScript of its own: a fact about the install, not a difference from the answer.
    rmSync(inWorkspace("node_modules"), { recursive: true, force: true });
    const noPackage = await scopeOf({ projects: [loadedProject()] });
    expect(noPackage.workspaceTypescript).toBe(null);
    expect(noPackage.limits).toEqual(["one-workspace"]);
  });

  it("reads what the workspace compiles with, and says null rather than guessing when the manifest says nothing", async () => {
    const missing = await scopeOf({ projects: [loadedProject()] });
    expect(missing.workspaceTypescript).toBe(null);

    workspaceTypeScript("{ not json");
    expect((await scopeOf({ projects: [loadedProject()] })).workspaceTypescript).toBe(null);

    workspaceTypeScript({ name: "typescript" });
    expect((await scopeOf({ projects: [loadedProject()] })).workspaceTypescript).toBe(null);

    workspaceTypeScript({ version: 7 });
    expect((await scopeOf({ projects: [loadedProject()] })).workspaceTypescript).toBe(null);

    // Read from `<root>/node_modules/typescript/package.json` and stated as the manifest states it.
    workspaceTypeScript({ version: " 5.9.3 " });
    expect((await scopeOf({ projects: [loadedProject()] })).workspaceTypescript).toBe("5.9.3");
  });

  it("reports the version the answering process stated for itself, never the one the located package stated", async () => {
    // `BINARY.version` says 7.0.2, and a host may hold two global TypeScript 7 installs; only this process's
    // `initialize` answer says which one answered.
    workspaceTypeScript({ version: "7.0.2" });
    const scope = await scopeOf({
      projects: [loadedProject()],
      initialize: { serverInfo: { name: "typescript-go", version: "7.1.0" } },
    });

    expect(scope.server).toEqual({ version: "7.1.0" });
    // The comparison is against the answer's own process, so a workspace on 7.0.2 is not a differing major.
    expect(scope.limits).toEqual(["one-workspace"]);
    expect(tsScopeText(scope)).toBe(
      ` under workspace "${tmp}": 1 project(s) found, 1 loaded, 0 failed, answered by tsgo 7.1.0, freshness: unchanged`,
    );
  });

  it("counts every project that exists and names only twenty of them", async () => {
    const projects = Array.from({ length: 25 }, (_unused, index) => {
      const directory = `p${String(index).padStart(2, "0")}`;
      const anchor = inWorkspace(directory, "src", "a.ts");
      return { config: inWorkspace(directory, "tsconfig.json"), anchor, members: [anchor] };
    });
    const failed: ProjectFailure[] = [
      { config: inWorkspace("broken-a", "tsconfig.json"), reason: "the listing exited with code 2" },
      { config: inWorkspace("broken-b", "tsconfig.json"), reason: "the listing gave no exit code" },
    ];

    const scope = await scopeOf({ projects, failed });

    // `count` is the project set, mapped plus failed plus subsumed; `configs` is what a payload may name. A cap
    // that moved the count would make the field a fact about the listing rather than about the workspace.
    expect(projectsOf(scope).count).toBe(27);
    expect(projectsOf(scope).configs).toHaveLength(20);
    expect(projectsOf(scope).configs).toEqual(projects.slice(0, 20).map((project) => project.config));
    expect(projectsOf(scope).failed).toEqual(failed);
    expect(scope.limits).toEqual(["one-workspace", "projects-not-loaded"]);
  });

  it("caps the subsumed configs at twenty while count holds all twenty-one, and names no limit code for them", async () => {
    const subsumed = Array.from({ length: 21 }, (_unused, index) =>
      inWorkspace(`s${String(index).padStart(2, "0")}`, "tsconfig.json"),
    );

    const scope = await scopeOf({ subsumed });

    // A subsumed project lists members and owns none, every one of them read by a project that IS anchored
    //: it is counted and named up to the same twenty as `configs`, while
    // `count` stays the exact size of the project set. Nothing failed to load, so no `projects-not-loaded`, and
    // the uncovered set stays provable rather than becoming an unprovable one.
    expect(projectsOf(scope)).toEqual({ count: 21, configs: [], failed: [], subsumed: subsumed.slice(0, 20) });
    expect(projectsOf(scope).subsumed).toHaveLength(20);
    expect(uncoveredOf(scope)).toEqual(noUncovered("Storage"));
    expect(scope.limits).toEqual(["one-workspace"]);
  });

  it("counts every uncovered source exactly, partitions it by directory, and flags the named file wherever it is", async () => {
    const orphaned = Array.from({ length: 21 }, (_unused, index) =>
      inWorkspace(`u${String(index + 1).padStart(2, "0")}.ts`),
    );
    const bodies = Object.fromEntries(orphaned.map((path) => [path, SILENT]));

    const notNamed = await scopeOf({ projects: [loadedProject()], uncovered: orphaned, bodies });
    expect(uncoveredOf(notNamed)).toEqual({
      count: 21,
      grepRequired: false,
      directories: [{ directory: ".", count: 21 }],
      directoriesTruncated: 0,
      mentioning: { name: "Storage", count: 0, files: [], filesTruncated: 0, unchecked: 0 },
      namedFileUncovered: false,
    });
    expect(uncoveredOf(notNamed)).not.toHaveProperty("files");
    expect(notNamed.limits).toEqual(["one-workspace", "uncovered-sources-present"]);

    const named = inWorkspace("zz-named.ts");
    const flagged = await scopeOf({
      projects: [loadedProject()],
      uncovered: [...orphaned, named],
      bodies: { ...bodies, [named]: SILENT },
      file: named,
    });
    expect(uncoveredOf(flagged)).toMatchObject({ count: 22, namedFileUncovered: true });
  });

  it("caps the directory list at twenty, largest group first, with the rest counted in directoriesTruncated", async () => {
    const dirs = Array.from({ length: 23 }, (_unused, index) => `d${String(index + 1).padStart(2, "0")}`);
    const orphaned = dirs.map((directory) => inWorkspace(directory, "a.ts"));
    // The biggest group is the lexically last directory, so only the ordering by count can show it.
    const big = [inWorkspace("zz", "a.ts"), inWorkspace("zz", "b.ts"), inWorkspace("zz", "c.ts")];
    const all = [...orphaned, ...big];

    const scope = await scopeOf({
      projects: [loadedProject()],
      uncovered: all,
      bodies: Object.fromEntries(all.map((path) => [path, SILENT])),
    });
    const block = uncoveredOf(scope);
    expect(block.count).toBe(26);
    expect(block.directories).toHaveLength(20);
    expect(block.directories[0]).toEqual({ directory: "zz", count: 3 });
    expect(block.directories[1]).toEqual({ directory: "d01", count: 1 });
    expect(block.directoriesTruncated).toBe(4);
    expect(tsUncoveredLine(scope)).toContain(", +4 more directories)");
  });

  // 72 uncovered files, none of them listed, the two that matter named.
  it("summarises 72 uncovered files whole, names the ones holding the subject, and counts what it could not read", async () => {
    const names = (directory: string, count: number): string[] =>
      Array.from({ length: count }, (_unused, index) =>
        inWorkspace(directory, `f${String(index).padStart(2, "0")}.ts`),
      );
    const driverTest = inWorkspace("test", "exec-driver.test.ts");
    const jobTools = inWorkspace("test", "tools", "codex-job-tools.test.ts");
    const huge = inWorkspace("test", "huge.ts");
    const unreadable = inWorkspace("scripts", "unreadable.ts");
    const uncovered = [
      ...names("scripts", 19),
      unreadable,
      ...names("test", 43),
      driverTest,
      huge,
      ...names("test/tools", 4),
      jobTools,
      ...names("evals", 2),
    ];
    expect(uncovered).toHaveLength(72);
    const bodies = Object.fromEntries(
      uncovered
        .filter((path) => path !== unreadable)
        .map((path) => [path, SILENT]),
    );
    bodies[driverTest] = "new ExecDriver();\nExecDriver.run();\n// ExecDriver\n";
    bodies[jobTools] = "const d = new ExecDriver();\nd.stop(ExecDriver);\n";
    bodies[huge] = "x".repeat(1_048_577);

    const scope = await scopeOf({ projects: [loadedProject()], uncovered, bodies, mentionName: "ExecDriver" });

    expect(uncoveredOf(scope)).toEqual({
      count: 72,
      grepRequired: true,
      directories: [
        { directory: "test", count: 45 },
        { directory: "scripts", count: 20 },
        { directory: "test/tools", count: 5 },
        { directory: "evals", count: 2 },
      ],
      directoriesTruncated: 0,
      mentioning: {
        name: "ExecDriver",
        count: 2,
        files: [
          { file: driverTest, matchingLines: 3 },
          { file: jobTools, matchingLines: 2 },
        ],
        filesTruncated: 0,
        unchecked: 2,
      },
      namedFileUncovered: false,
    });
    // The scan changes no code: the set is present, and nothing here claims the listing was capped.
    expect(scope.limits).toEqual(["one-workspace", "uncovered-sources-present"]);
    expect(tsUncoveredLine(scope)).toBe(
      "INCOMPLETE: 72 file(s) no tsconfig project includes were not searched (test 45, scripts 20, test/tools 5, evals 2). " +
        `2 of them contain "ExecDriver" and may hold more results - grep "ExecDriver" in: ${driverTest} (3 matching lines), ` +
        `${jobTools} (2 matching lines). 2 file(s) could not be checked - grep them too. ` +
        "Do not report this answer as complete until you have.",
    );
    // The head line keeps everything but the uncovered set, which is the second line's alone.
    expect(tsScopeText(scope)).not.toContain("not searched");
  });

  it("counts every mentioning file exactly and publishes at most twenty, most lines first", async () => {
    const orphaned = Array.from({ length: 23 }, (_unused, index) =>
      inWorkspace("test", `m${String(index + 1).padStart(2, "0")}.test.ts`),
    );
    // File n holds the name on n lines, so the order the cap keeps is the line count, not the path.
    const bodies = Object.fromEntries(
      orphaned.map((path, index) => [path, Array.from({ length: index + 1 }, () => "Storage.get();").join("\n")]),
    );

    const scope = await scopeOf({ projects: [loadedProject()], uncovered: orphaned, bodies });
    const { mentioning } = uncoveredOf(scope);
    expect(mentioning.count).toBe(23);
    expect(mentioning.files).toHaveLength(20);
    expect(mentioning.files[0]).toEqual({ file: orphaned[22], matchingLines: 23 });
    expect(mentioning.files.at(-1)).toEqual({ file: orphaned[3], matchingLines: 4 });
    expect(mentioning.filesTruncated).toBe(3);
    expect(mentioning.unchecked).toBe(0);
    expect(tsUncoveredLine(scope)).toContain('23 of them contain "Storage"');
    expect(tsUncoveredLine(scope)).toContain(", and 3 more files in the directories above. Do not report");
  });

  it("serialises a mention as { file, matchingLines } with no lines key, and the cap is shown as filesTruncated", async () => {
    const many = Array.from({ length: 31 }, (_unused, index) =>
      inWorkspace("test", `t${String(index + 1).padStart(2, "0")}.test.ts`),
    );
    const scope = await scopeOf({
      projects: [loadedProject()],
      uncovered: many,
      bodies: Object.fromEntries(many.map((path) => [path, "Storage.get();\n"])),
    });
    const { mentioning } = uncoveredOf(scope);
    expect(mentioning.count).toBe(31);
    expect(mentioning.files).toHaveLength(20);
    expect(mentioning.filesTruncated).toBe(11);
    expect(Object.keys(mentioning.files[0] ?? {})).toEqual(["file", "matchingLines"]);
    expect(JSON.stringify(mentioning)).not.toContain('"lines"');
    expect(tsUncoveredLine(scope)).toContain(", and 11 more files in the directories above");

    const three = many.slice(0, 3);
    const few = await scopeOf({
      projects: [loadedProject()],
      uncovered: three,
      bodies: Object.fromEntries(three.map((path) => [path, "Storage.get();\n"])),
    });
    expect(uncoveredOf(few).mentioning.filesTruncated).toBe(0);
    expect(tsUncoveredLine(few)).not.toContain("more files");
  });

  it("answers with the whole set unchecked rather than failing when the call's budget is already spent", async () => {
    const orphan = inWorkspace("test", "store.test.ts");

    const scope = await scopeOf({
      projects: [loadedProject()],
      uncovered: [orphan],
      bodies: { [orphan]: "Storage.get();\n" },
      budgetMs: 0,
    });
    expect(uncoveredOf(scope).mentioning).toEqual({ name: "Storage", count: 0, files: [], filesTruncated: 0, unchecked: 1 });
    expect(scope.limits).toEqual(["one-workspace", "uncovered-sources-present"]);
  });

  it("leads every answer's limits with one-workspace and says nothing of visibility, whatever else it carries", async () => {
    workspaceTypeScript({ version: "5.9.3" });
    const kept = loadedProject();
    const broken: ProjectFailure = {
      config: inWorkspace("packages", "app", "tsconfig.json"),
      reason: "the listing did not answer (ENOENT)",
    };
    const shapes = [
      await scopeOf({ projects: [kept] }),
      await scopeOf({ projects: [kept], failed: [broken] }),
      await scopeOf({ projectsUnavailable: noMap(tmp) }),
      await scopeOf(
        { projects: [kept], uncovered: [inWorkspace("test", "a.ts")] },
        { capped: true, correspondingMethods: true },
      ),
      await scopeOf({ projects: [kept], freshness: reloadedBecause(tmp, "./gone.json", kept.config) }),
    ];

    // `one-workspace` holds on every answer on purpose: a scope statement that lists only what varies states
    // no scope.
    for (const scope of shapes) {
      expect(scope.limits[0]).toBe("one-workspace");
      expect(JSON.stringify(scope)).not.toContain("visibility");
    }
  });
});

describe("tsUncoveredText and tsScopeText", () => {
  it("says nothing when nothing is missing, and counts the set when something is", async () => {
    const clean = await scopeOf({ projects: [loadedProject()] });
    expect(tsUncoveredText(clean)).toBe("");
    expect(tsScopeText(clean)).toBe(
      ` under workspace "${tmp}": 1 project(s) found, 1 loaded, 0 failed, answered by tsgo ${SERVER_VERSION}, freshness: unchanged`,
    );

    const named = inWorkspace("test", "store.test.ts");
    const build = inWorkspace("scripts", "build.mts");
    const orphaned = [named, build];
    const bodies = { [named]: "import { Storage } from 'x';\nStorage.get();\n", [build]: SILENT };
    const TAIL = "Do not report this answer as complete until you have.";

    // Variant A, one file, `(2 matching lines)`; the line is the second one, so the head carries none of it.
    const withOrphans = await scopeOf({ projects: [loadedProject()], uncovered: orphaned, bodies });
    expect(tsUncoveredLine(withOrphans)).toBe(
      "INCOMPLETE: 2 file(s) no tsconfig project includes were not searched (scripts 1, test 1). " +
        `1 of them contain "Storage" and may hold more results - grep "Storage" in: ${named} (2 matching lines). ${TAIL}`,
    );
    expect(tsUncoveredText(withOrphans)).toBe("");

    const namedToo = await scopeOf({ projects: [loadedProject()], uncovered: orphaned, bodies, file: named });
    expect(tsUncoveredLine(namedToo)).toContain(
      "were not searched (scripts 1, test 1), the named file among them. 1 of them contain",
    );

    // `(1 matching line)` is singular.
    const single = await scopeOf({
      projects: [loadedProject()],
      uncovered: orphaned,
      bodies: { [named]: "Storage.get();\n", [build]: SILENT },
    });
    expect(tsUncoveredLine(single)).toContain(`${named} (1 matching line). ${TAIL}`);

    // Variant A with an unreadable file: the `could not be checked` tail sits before the instruction.
    rmSync(build);
    const withUnread = await scopeOf({ projects: [loadedProject()], uncovered: orphaned, bodies: { [named]: bodies[named] } });
    expect(tsUncoveredLine(withUnread)).toBe(
      "INCOMPLETE: 2 file(s) no tsconfig project includes were not searched (scripts 1, test 1). " +
        `1 of them contain "Storage" and may hold more results - grep "Storage" in: ${named} (2 matching lines). ` +
        `1 file(s) could not be checked - grep them too. ${TAIL}`,
    );

    // Variant B: nothing matches among the files it could read, one it could not.
    rmSync(named);
    const unchecked = await scopeOf({ projects: [loadedProject()], uncovered: orphaned, bodies: { [build]: SILENT } });
    expect(tsUncoveredLine(unchecked)).toBe(
      "INCOMPLETE: 2 file(s) no tsconfig project includes were not searched (scripts 1, test 1). " +
        `None of the checked files contains "Storage"; 1 file(s) could not be checked - grep them for "Storage". ${TAIL}`,
    );

    // Variant C: every file read, none matches. It states its scope and carries no INCOMPLETE.
    const silent = await scopeOf({
      projects: [loadedProject()],
      uncovered: orphaned,
      bodies: { [named]: SILENT, [build]: SILENT },
    });
    expect(tsUncoveredLine(silent)).toBe(
      '2 file(s) no tsconfig project includes were not searched (scripts 1, test 1); none of them contains "Storage" as text.',
    );

    // `grepRequired` is exactly the INCOMPLETE verdict (a match or an unchecked file), as a field.
    expect(uncoveredOf(withOrphans).grepRequired).toBe(true);
    expect(uncoveredOf(unchecked).grepRequired).toBe(true);
    expect(uncoveredOf(silent).grepRequired).toBe(false);
    expect(Object.keys(uncoveredOf(silent)).slice(0, 2)).toEqual(["count", "grepRequired"]);

    // An unknown set has no line, and its head text stays as it was.
    const unknown = await scopeOf({ projectsUnavailable: noMap(tmp) });
    expect(tsUncoveredLine(unknown)).toBe("");
    expect(tsUncoveredText(unknown)).toBe(`; ${noMap(tmp)}`);
  });

  it("reads the scan name off the subject's key: the last dotted segment, with no selector prefix", () => {
    expect(mentionNameOf("Driver.run")).toBe("run");
    expect(mentionNameOf("static ExecDriver.run")).toBe("run");
    expect(mentionNameOf("value Widget")).toBe("Widget");
    expect(mentionNameOf("type Widget")).toBe("Widget");
    expect(mentionNameOf("Ns.Inner.x")).toBe("x");
    expect(mentionNameOf("Storage")).toBe("Storage");
  });

  it("phrases an unprovable set by its reason, and an unavailable map by the same words twice", async () => {
    const broken = inWorkspace("packages", "app", "tsconfig.json");
    const failed = await scopeOf({
      projects: [loadedProject()],
      failed: [{ config: broken, reason: "the listing exited with code 2" }],
      freshness: { kind: "pushed", changedFiles: 3 },
    });
    expect(tsUncoveredText(failed)).toBe(
      `; the project listing for "${broken}" failed, so which sources no project includes is not known`,
    );
    // `count` is mapped plus failed plus subsumed, so the sentence names every one of its numbers rather than
    // calling the whole set loaded beside a count of what was not.
    expect(tsScopeText(failed)).toBe(
      ` under workspace "${tmp}": 2 project(s) found, 1 loaded, 1 failed, answered by tsgo ${SERVER_VERSION}` +
        `; the project listing for "${broken}" failed, so which sources no project includes is not known` +
        ", freshness: pushed 3 changed file(s)",
    );

    const reason = noMap(tmp);
    const unmapped = await scopeOf({ projectsUnavailable: reason });
    expect(tsScopeText(unmapped)).toBe(
      ` under workspace "${tmp}": ${reason}, answered by tsgo ${SERVER_VERSION}; ${reason}, freshness: unchanged`,
    );
  });

  it("names the reload the answer came from and the npm workspace it did not span", async () => {
    const above = inWorkspace("above");
    const config = loadedProject().config;
    const scope = await scopeOf({
      projects: [loadedProject()],
      enclosingWorkspace: above,
      freshness: reloadedBecause(tmp, "./compiler-options.json", config),
    });

    // A dangling `extends` is a `freshness` fact, not a `projects.failed`
    // one, so the answer carries no new code and says in `freshness` that it came from a reloaded process.
    // `scope` passes the reason through as the freshness engine composed it (pinned in test/lsp/freshness).
    expect(scope.limits).toEqual(["one-workspace"]);
    expect(tsScopeText(scope)).toBe(
      ` under workspace "${tmp}": 1 project(s) found, 1 loaded, 0 failed, answered by tsgo ${SERVER_VERSION}` +
        `; npm workspace "${above}" not spanned, freshness: reloaded - ` +
        `the config closure under "${tmp}" is not provable: ` +
        `extends resolves to nothing: "./compiler-options.json" in "${config}"`,
    );
  });
});
