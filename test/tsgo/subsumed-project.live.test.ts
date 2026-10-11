import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { buildProjectMap, type ProjectMap, type TsProject } from "../../src/tsgo/project-map.js";
import { walkWorkspace, workspaceSnapshotReason } from "../../src/tsgo/workspace-snapshot.js";
import {
  runTsFindReferences,
  type TsFindReferencesPayload,
  type TsReferenceFile,
} from "../../src/tools/ts-find-references.js";
import type { TsNavigationScope, TsProjectsBlock } from "../../src/tools/ts-navigation-shared.js";
import {
  CALL_BUDGET_MS,
  fixtures,
  itIfTsgoAvailable,
  payloadOf,
  requireTsgo,
  stampsOf,
  tsgoProcessLog,
  type TsgoProcessLog,
} from "../helpers/tsgo-live.js";

/**
 * Live: one fixture case for a project whose members are all
 * owned by a nested config, which appears under `subsumed` with no `projects-not-loaded`.
 *
 * A project that lists files and owns none of them is taken out of `failed` — where it was put before,
 * with `projects-not-loaded` on every answer for a workspace whose ground was in fact fully covered — and reports
 * it in a new `scope.projects.subsumed`, "when **every** member it lists is owned by an anchored project", counted
 * in `count` and adding no limit code. The section's own reason is the thing this fixture makes observable: the
 * project is never loaded and needs no anchor, because every file it reads already sits in a program that IS
 * loaded, so no use is lost.
 *
 * `test/fixtures/ts-workspace-subsumed` is that shape and nothing else:
 *
 * - the workspace-root `tsconfig.json` has `include: ["pkg/src"]` — a directory whose files all belong to a
 *   config further down — so its listing names `pkg/src/first.ts`, `pkg/src/subject.ts`, `pkg/src/uses.ts`;
 * - `pkg/tsconfig.json` has `include: ["src"]`, the same directory seen from one level up, so its listing names
 *   exactly those three as well;
 * - one `package.json`, at the fixture root, declaring no `workspaces`, and none inside `pkg`: a nested manifest
 *   would make `pkg` the package and therefore the `workspaceRoot`, which would put the root
 *   config outside the workspace the answer is rooted at. One manifest keeps this fixture the root of both the map
 *   and the `scope` block.
 *
 * The owner rule read out by hand, with no-ascent as `src/tsgo/project-map.ts` implements it today (it holds "under
 * either rule", and this fixture is on the half of the two rules that agrees: every one of these files IS listed by
 * its nearest named config, so the climb would never fire here and the outcome is the same either way):
 *
 * | file | nearest named config | lists it? | owner |
 * |---|---|---|---|
 * | `pkg/src/first.ts` | `pkg/tsconfig.json` | yes | `pkg/tsconfig.json` |
 * | `pkg/src/subject.ts` | `pkg/tsconfig.json` | yes | `pkg/tsconfig.json` |
 * | `pkg/src/uses.ts` | `pkg/tsconfig.json` | yes | `pkg/tsconfig.json` |
 *
 * `pkg` is the first directory above each file holding a `tsconfig.json` or a `jsconfig.json`, so the nearest-config
 * walk stops there and the root config is never reached as a nearest one; the root config has no `references`, so
 * there is no closure for rule 1.2 to descend either. The root config therefore lists three files and owns none,
 * and `firstOwned` can find it no anchor — the exact condition renamed from `failed` to `subsumed`. The nested
 * config owns all three and anchors on the lexically first (`first.ts` < `subject.ts` < `uses.ts`), so every member
 * the unloaded project lists is owned by a project that IS anchored. And because both listings name every source,
 * nothing lands in `uncovered`: no file of the subsumed project is "a source no project includes", which is the
 * other code that must not appear.
 *
 * Nothing is injected: two real `tsc --listFilesOnly` runs through `buildProjectMap`, as `parent-climb.live.test.ts`
 * does them, and one real `ts_find_references` call for the `scope` half. `subsumed` is new at this writing, so it
 * is read through `subsumedEntries` below, which FAILS naming the missing rule rather than treating an absent field as an empty
 * list — a case that passed quietly while the rule was unimplemented would pin nothing. The 20-entry cap the
 * section gives the list is asserted as far as two projects and three sources allow (the real count is 1);
 * overflowing it needs 21 subsumed configs, which is a mocked unit test's fixture, not a live one.
 */

const root = join(fixtures, "ts-workspace-subsumed");
const rootConfig = join(root, "tsconfig.json");
const nestedConfig = join(root, "pkg", "tsconfig.json");
const anchorFile = join(root, "pkg", "src", "first.ts");
const subjectFile = join(root, "pkg", "src", "subject.ts");
const usesFile = join(root, "pkg", "src", "uses.ts");

/** Every source of the fixture, in the order `firstOwned` sorts them — which is why `first.ts` is the anchor. */
const SOURCE_FILES = [anchorFile, subjectFile, usesFile];
const SUBJECT = "SUBSUMED_SUBJECT";
const USE_ROW = "subsumedUse";

/** The two configs, by their path below the fixture root. */
const ROOT_CONFIG = "tsconfig.json";
const NESTED_CONFIG = "pkg/tsconfig.json";
/** What each real listing names: the same three sources, reached by two `include` spellings of one directory. */
const MEMBERS = ["pkg/src/first.ts", "pkg/src/subject.ts", "pkg/src/uses.ts"];

type Result = Awaited<ReturnType<typeof runTsFindReferences>>;

// ---------------------------------------------------------------- `subsumed` reading

/** Paths compared the way the map compares them: separators normalised, case folded on this OS. */
const pathKey = (path: string): string => path.replace(/\\/g, "/").toLowerCase();

function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && pathKey(a) === pathKey(b);
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

/** One `subsumed` entry as reported: a config path, or the project that path names. */
function configOfSubsumed(entry: unknown): string {
  if (typeof entry === "string") return entry;
  const config = typeof entry === "object" && entry !== null ? (entry as { config?: unknown }).config : undefined;
  if (typeof config !== "string") throw new Error(`a subsumed entry names no config: ${JSON.stringify(entry)}`);
  return config;
}

/** The files one `subsumed` entry reads, for a map that spells the entry as the project rather than its path. */
function membersOfSubsumed(entry: unknown): readonly string[] {
  const members = typeof entry === "object" && entry !== null ? (entry as { members?: unknown }).members : undefined;
  return Array.isArray(members) ? members.filter((member): member is string => typeof member === "string") : [];
}

/**
 * The `subsumed` list of a mapped arm or of `scope.projects`. A missing field is the rule not being implemented, which
 * this pin names as a failure rather than reading as an empty list and passing on it.
 */
function subsumedEntries(container: unknown, where: string): readonly unknown[] {
  const field = (container as { readonly subsumed?: unknown }).subsumed;
  if (field === undefined) {
    throw new Error(
      `${where} carries no "subsumed" field, so the subsumed rule is not implemented; ` +
        `it holds ${JSON.stringify(container)}`,
    );
  }
  if (!Array.isArray(field)) throw new Error(`${where}'s "subsumed" is not a list: ${JSON.stringify(field)}`);
  return field;
}

/** The configs that list names, spelled under this fixture root and sorted, like `namesUnder` spells them. */
function subsumedConfigs(entries: readonly unknown[]): string[] {
  return namesUnder(entries.map((entry) => resolve(root, configOfSubsumed(entry))));
}

/** The files those projects list, or `undefined` when the map carries config paths only and not their members. */
function subsumedMembers(entries: readonly unknown[]): string[] | undefined {
  const members = entries.flatMap(membersOfSubsumed);
  return members.length === 0 ? undefined : members;
}

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

function ask(manager: LspSessionManager, file: string, symbol: string): Promise<Result> {
  return runTsFindReferences(
    manager,
    { sourceRoots: [root], file, symbol, includeDeclaration: false, timeBudgetMs: CALL_BUDGET_MS },
  );
}

function payload(result: Result): TsFindReferencesPayload {
  return payloadOf<TsFindReferencesPayload>(result, "ts_find_references");
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

/** Every kept row as `file:line in <name>`, so a message can show the whole listing. */
function rows(answer: TsFindReferencesPayload): string[] {
  return answer.files.flatMap((group) =>
    group.sites.map((site) => `${under(group.file)}:${site.line} in ${site.in ?? "<unnamed>"}`),
  );
}

/** The map, or a failure quoting the reason the compiler's own listings gave for not having one. */
function requireMapped(map: ProjectMap): Extract<ProjectMap, { kind: "mapped" }> {
  if (map.kind !== "mapped") throw new Error(`no project map was built: ${map.reason}`);
  return map;
}

/** An anchored project, or a failure naming what the map did anchor and fail instead. */
function projectFor(map: ProjectMap, config: string): TsProject {
  const mapped = requireMapped(map);
  const needle = pathKey(config);
  const found = mapped.projects.find((project) => pathKey(project.config) === needle);
  if (found !== undefined) return found;
  throw new Error(
    `"${under(config)}" is not an anchored project of "${root}"; the map holds ` +
      `${JSON.stringify(namesUnder(mapped.projects.map((project) => project.config)))} and failed ` +
      `${JSON.stringify(mapped.failed.map((failure) => `${under(failure.config)}: ${failure.reason}`))}`,
  );
}

/** The walk's entries, or a failure quoting what the walk said it could not finish. */
function requireWalked(): { entries: Map<string, string>; unresolved: readonly string[] } {
  const walked = walkWorkspace(root);
  if (walked === undefined) throw new Error(`the walk of "${root}" did not complete: ${workspaceSnapshotReason(root)}`);
  return walked;
}

function requireProjects(scope: TsNavigationScope): TsProjectsBlock {
  if (!("projects" in scope)) throw new Error(`no project map was reported: ${scope.projectsUnavailable}`);
  return scope.projects;
}

function requireUncovered(
  scope: TsNavigationScope,
): { count: number; files: readonly string[]; namedFileUncovered: boolean } {
  if (!("uncoveredSources" in scope)) {
    throw new Error(`no uncovered set was computed: ${scope.uncoveredSourcesUnavailable}`);
  }
  return scope.uncoveredSources;
}

/** Every file the walk proved it saw: what a run must leave exactly as it found it. */
const treeStamps = (): Map<string, string> => stampsOf([...requireWalked().entries.keys()]);

/** The project map of this fixture, built by running one real `tsc --listFilesOnly` per config. */
async function liveProjectMap(): Promise<ProjectMap> {
  return buildProjectMap(root, [...requireWalked().entries.keys()], requireTsgo());
}

/** The whole answer, quoted. The payload is small here, so a failure can carry all of it. */
function evidence(answer: TsFindReferencesPayload, opened: readonly string[]): string {
  return `payload ${JSON.stringify(answer)} || documents opened on the answering process ${JSON.stringify(opened)}`;
}

/** What the map did with the two configs, for the report that has to say which rule was applied. */
function describeMap(map: Extract<ProjectMap, { kind: "mapped" }>, entries: readonly unknown[]): string {
  return JSON.stringify({
    anchored: map.projects.map((project) => ({ config: under(project.config), anchor: under(project.anchor) })),
    subsumed: subsumedConfigs(entries),
    failed: map.failed.map((failure) => `${under(failure.config)}: ${failure.reason}`),
    uncovered: namesUnder(map.uncovered),
  });
}

// ---------------------------------------------------------------------- the cases

describe("a config whose every listed file a nested config owns", () => {
  itIfTsgoAvailable(
    "reports the root config under subsumed — not failed, not anchored — while the nested config anchors on what it owns",
    async () => {
      const before = treeStamps();
      const walked = requireWalked();
      // Both configs are seeds the walk proved it saw, and neither reaches outside this root, so there is a
      // provable map to classify.
      expect(walked.unresolved).toEqual([]);
      expect(walked.entries.has(rootConfig)).toBe(true);
      expect(walked.entries.has(nestedConfig)).toBe(true);

      const map = requireMapped(await liveProjectMap());
      const entries = subsumedEntries(map, "the project map of this fixture");

      // What each listing actually names — membership, read off two real compiler runs. The two configs reach the
      // same three sources by two spellings of one directory, and that identity is what leaves the root config
      // with members and no anchor.
      const nested = projectFor(map, nestedConfig);
      expect(namesUnder(nested.members)).toEqual(MEMBERS);

      // the root config is taken out of `failed`, where "no member file is assigned to
      // this project" put it, and out of the anchored list, where it would have to be for this server to load it
      // by opening one of its files. It is named once, by its own config path.
      expect(map.failed, describeMap(map, entries)).toEqual([]);
      expect(namesUnder(map.projects.map((project) => project.config)), describeMap(map, entries)).toEqual([
        NESTED_CONFIG,
      ]);
      expect(subsumedConfigs(entries), describeMap(map, entries)).toEqual([ROOT_CONFIG]);

      // The nested project owns what its anchor says it owns: an anchor is by definition a member the project
      // itself owns, and this one is the lexically FIRST of the shared listing (`firstOwned`'s sort), which is
      // the arithmetic proving the root config owns nothing — were it the owner of any of these three, that file
      // would be its anchor instead and it would appear above as an anchored project.
      expect(under(nested.anchor)).toBe("pkg/src/first.ts");

      // "every member it lists is owned by an anchored project", as far as the map's shape shows it: the
      // subsumed listing and the one anchored project's listing are the same files, so no other project exists
      // that could own them, and the classification itself is the code's claim that each has that owner.
      const listed = subsumedMembers(entries);
      if (listed !== undefined) {
        expect(namesUnder(listed)).toEqual(MEMBERS);
        const outsideTheAnchoredProject = listed.filter(
          (file) => !nested.members.some((member) => pathKey(member) === pathKey(file)),
        );
        expect(outsideTheAnchoredProject.map((file) => under(file))).toEqual([]);
      }

      // None of the subsumed project's files is "a source no project includes" — they are all included, by both
      // configs — so `uncovered-sources-present` has no ground to stand on either.
      for (const file of listed ?? SOURCE_FILES) {
        expect(
          map.uncovered.some((path) => pathKey(path) === pathKey(file)),
          `uncovered ${JSON.stringify(namesUnder(map.uncovered))} for "${under(file)}"`,
        ).toBe(false);
      }
      expect(namesUnder(map.uncovered)).toEqual([]);

      console.info(`subsumed map: ${describeMap(map, entries)}`);
      expect(treeStamps()).toEqual(before);
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "counts the subsumed project in scope.projects with no projects-not-loaded, and still answers a use in a file it lists",
    async () => {
      const before = treeStamps();
      const log = tsgoProcessLog();
      const manager = freshManager(log);
      try {
        const answer = payload(await ask(manager, subjectFile, SUBJECT));
        const opened = namesUnder([...new Set(log.opened.map((document) => document.file))]);
        const projects = requireProjects(answer.scope);
        const entries = subsumedEntries(projects, "scope.projects of ts_find_references");
        const subsumed = subsumedConfigs(entries);

        // One `package.json` at the fixture root, no `workspaces`: the map and the scope block are rooted at the
        // same directory, which is the only reason the root config is a project of this fixture at all.
        expect(pathKey(answer.scope.workspaceRoot), evidence(answer, opened)).toBe(pathKey(root));
        expect(answer.scope.enclosingWorkspace, evidence(answer, opened)).toBeNull();

        // the sentence through the tool: the config that owns nothing is under `subsumed`, is not `failed`, and
        // is not one of the `configs` this server loaded.
        expect(subsumed, evidence(answer, opened)).toEqual([ROOT_CONFIG]);
        expect(projects.failed, evidence(answer, opened)).toEqual([]);
        expect(namesUnder(projects.configs), evidence(answer, opened)).toEqual([NESTED_CONFIG]);

        // Counted in `count`, and capped at 20 like `configs` — the cap holds and the real count here is 1.
        expect(subsumed.length, evidence(answer, opened)).toBe(1);
        expect(projects.count, evidence(answer, opened)).toBe(2);
        expect(projects.count, evidence(answer, opened)).toBe(
          projects.configs.length + projects.failed.length + subsumed.length,
        );
        expect(subsumed.length).toBeLessThanOrEqual(20);
        expect(projects.configs.length).toBeLessThanOrEqual(20);

        // Adds no limit code: `one-workspace` is every TS answer's own, and neither the unloaded project nor the
        // files it reads put anything beside it.
        expect(answer.scope.limits, evidence(answer, opened)).toContain("one-workspace");
        expect(answer.scope.limits, evidence(answer, opened)).not.toContain("projects-not-loaded");
        expect(answer.scope.limits, evidence(answer, opened)).not.toContain("uncovered-sources-present");

        // No file of the fixture is a blind spot, and the named file is not one either.
        const uncovered = requireUncovered(answer.scope);
        expect(uncovered.count, evidence(answer, opened)).toBe(0);
        expect(uncovered.directories, evidence(answer, opened)).toEqual([]);
        expect(uncovered.namedFileUncovered, evidence(answer, opened)).toBe(false);

        // The subject, addressed on the file that declares it, and the loaded project that answers for it.
        expect(answer.resolved.name).toBe(SUBJECT);
        expect(answer.resolved.kind).toBe("variable");
        expect(answer.resolved.line).toBe(lineOf(subjectFile, "export const SUBSUMED_SUBJECT"));
        expect(samePath(answer.resolved.file, subjectFile)).toBe(true);

        // The documents opened on the process that answered include the nested project's own anchor — the ONLY
        // anchor this fixture has, since the root config is left with none — and the call's named file. (The
        // naming step's transient read of `pkg/src/uses.ts` may join them; that open comes after the references
        // request, so it cannot be what made the use below visible.)
        expect(opened, evidence(answer, opened)).toContain("pkg/src/first.ts");
        expect(opened, evidence(answer, opened)).toContain(under(subjectFile));

        // the payoff, asserted rather than argued: `pkg/src/uses.ts` is listed by the project that was never
        // loaded and owned by the one that was, so its use of the subject is in this answer.
        const group = groupOf(answer, usesFile);
        expect(group === undefined ? "<no group for pkg/src/uses.ts>" : under(group.file), evidence(answer, opened)).toBe(
          "pkg/src/uses.ts",
        );
        expect(group?.external, evidence(answer, opened)).toBe(false);
        const useLine = lineOf(usesFile, "return SUBSUMED_SUBJECT;");
        const site = (group?.sites ?? []).find((candidate) => candidate.line === useLine);
        expect(site === undefined ? "<no site at the use line>" : site.in, evidence(answer, opened)).toBe(USE_ROW);

        // The exactness, and nothing external in the listing.
        expect(answer.files.reduce((sum, one) => sum + one.count, 0), evidence(answer, opened)).toBe(
          answer.totalReferences,
        );
        expect(answer.filesTruncated, evidence(answer, opened)).toBe(0);
        for (const one of answer.files) {
          expect(one.external, evidence(answer, opened)).toBe(false);
        }

        console.info(
          `subsumed scope: count=${String(projects.count)} ` +
            `configs=${JSON.stringify(namesUnder(projects.configs))} subsumed=${JSON.stringify(subsumed)} ` +
            `failed=${String(projects.failed.length)} limits=${JSON.stringify(answer.scope.limits)} ` +
            `totalReferences=${String(answer.totalReferences)} files=${JSON.stringify(rows(answer))} ` +
            `opened=${JSON.stringify(opened)}`,
        );
      } finally {
        manager.disposeAll();
      }
      expect(treeStamps()).toEqual(before);
    },
    CALL_BUDGET_MS,
  );
});
