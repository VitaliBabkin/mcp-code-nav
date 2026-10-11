import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
 * Live: a nested `tsconfig.json` whose `include` leaves out a
 * file that an ancestor `tsconfig.json` includes, read under the climb branch that the pin
 * measured (the answer was CLIMB: opening only the disputed file made tsgo answer the ancestor's own consumer).
 * So ownership ASCENDS, and `ownerOf` implements it: at the nearest named config C, C's own listing, then C's
 * `references` closure depth-first in listed order, then the same two questions at the next named config above
 * C's directory, stopping at the first owner.
 *
 * `test/fixtures/ts-workspace-parent-climb` is that shape and nothing else:
 *
 * - the root `tsconfig.json` includes BOTH `src` and `nested`, so its listing names `nested/shared.ts`;
 * - `nested/tsconfig.json` includes only `inner`, so `nested/shared.ts` is left out of its nearest named config
 *   — which is the only config a search may stop at on that directory, since no other filename qualifies as a
 *   nearest config — and the nested config has no `references` for the closure question to reach;
 * - `src/uses.ts` is the disputed file's one consumer, and it sits where only the ancestor config reaches.
 *
 * Both questions fail at `nested/tsconfig.json`, so the search continues from the parent of `nested`, where the
 * root `tsconfig.json` is the next named config and does list the disputed file: the ANCESTOR owns it. That is
 * visible in the anchors by pure lexical arithmetic, which is what the first case asserts. `firstOwned` takes
 * the lexically first member a project owns, and of the ancestor's three listed members it now owns two —
 * `nested/shared.ts` and `src/uses.ts` — which sort `nested\shared.ts` before `src\uses.ts`. So the ancestor's
 * anchor IS the disputed file, and the nested project still owns and anchors `nested/inner/owned.ts`, the only
 * member its own listing names. No project owns nothing, so neither is `failed` nor `subsumed`.
 *
 * The second case is a fact about a running `tsc.exe`, and under the climb rule it is no longer the
 * discriminating one: the ancestor's anchor is the disputed file itself, so this server loads the ancestor
 * before asking, which is exactly the situation that answers either way. It still pins what a
 * real call does on the map the climb produces — the use in `src/uses.ts` found and named, both projects mapped,
 * anchored and loaded, nothing `failed`, nothing `subsumed`, no blind spot reported, and the caps not reached —
 * and `test/tsgo/ownership-ascent.live.test.ts`, which opens only the disputed file and anchors nothing, is the
 * test that decides the ownership rule.
 *
 * Nothing is softened here: the use is asserted found, because under the implemented rule that is the answer the
 * loaded ancestor must give, and a failure carries the whole payload, so the observed answer is reportable
 * without a re-run.
 */

const root = join(fixtures, "ts-workspace-parent-climb");
const parentConfig = join(root, "tsconfig.json");
const nestedConfig = join(root, "nested", "tsconfig.json");
const sharedFile = join(root, "nested", "shared.ts");
const ownedFile = join(root, "nested", "inner", "owned.ts");
const usesFile = join(root, "src", "uses.ts");

/** The disputed file's only symbol, and the name its one consumer spells. */
const SYMBOL = "SHARED_CLIMB";
const CONSUMER = "ancestorUse";

/** The two configs, by their path below the fixture root. */
const CONFIGS = ["nested/tsconfig.json", "tsconfig.json"];
/** What each compiler listing actually names: membership, which is not ownership. */
const PARENT_MEMBERS = ["nested/inner/owned.ts", "nested/shared.ts", "src/uses.ts"];
const NESTED_MEMBERS = ["nested/inner/owned.ts"];

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

function ask(manager: LspSessionManager, file: string, symbol: string): Promise<Result> {
  return runTsFindReferences(
    manager,
    { sourceRoots: [root], file, symbol, includeDeclaration: false, timeBudgetMs: CALL_BUDGET_MS },
  );
}

function payload(result: Result): TsFindReferencesPayload {
  return payloadOf<TsFindReferencesPayload>(result, "ts_find_references");
}

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
function evidence(answer: TsFindReferencesPayload, opened: string[]): string {
  return `payload ${JSON.stringify(answer)} || documents opened on the answering process ${JSON.stringify(opened)}`;
}

// ---------------------------------------------------------------------- the cases

describe("a nested config that leaves a file out, against the real tsgo", () => {
  itIfTsgoAvailable(
    "gives the disputed file its ancestor as owner, so the ancestor config anchors on that file and not on `src/uses.ts`",
    async () => {
      const before = treeStamps();
      const walked = requireWalked();
      // Both configs are seeds of the map, and the closure is provable, so there is a map to be judged.
      expect(walked.unresolved).toEqual([]);
      expect(walked.entries.has(parentConfig)).toBe(true);
      expect(walked.entries.has(nestedConfig)).toBe(true);

      const map = requireMapped(await liveProjectMap());
      expect(namesUnder(map.projects.map((project) => project.config))).toEqual(CONFIGS);
      // Each config owns a member of its own, so neither is `failed` for owning nothing and neither is
      // `subsumed` — which is what a map with a wrong nearest config would have said about one of them.
      expect(map.failed).toEqual([]);
      expect(map.subsumed).toEqual([]);

      const parent = projectFor(map, parentConfig);
      const nested = projectFor(map, nestedConfig);

      // Membership is what a project READS: the ancestor reads all three sources, the disputed one included,
      // while the nested project never even names it.
      expect(namesUnder(parent.members)).toEqual(PARENT_MEMBERS);
      expect(namesUnder(nested.members)).toEqual(NESTED_MEMBERS);

      // Ownership is narrower than that, and the anchors are where it shows. The nested config anchors inside
      // `inner`, on the one member its own listing names. The disputed file fails both questions at that nested
      // config — it is not listed there, and the nested config references nothing — so the search continues from
      // the parent of `nested` to the root `tsconfig.json`, which lists it: the ancestor OWNS it. `firstOwned` then takes the lexically first member a project owns, and of the two the
      // ancestor owns, `nested\shared.ts` sorts ahead of `src\uses.ts` — so the ancestor's anchor is the disputed
      // file, and `src/uses.ts` is read by the ancestor without anchoring it.
      expect(under(nested.anchor)).toBe("nested/inner/owned.ts");
      expect(under(parent.anchor)).toBe("nested/shared.ts");

      // And the disputed file is not reported as a source nothing includes either: a project lists it, so the
      // uncovered set is empty, and the call that names it is not a blind spot.
      expect(map.uncovered).toEqual([]);
      expect(treeStamps()).toEqual(before);
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "answers the disputed file from the ancestor project the climb anchors on it, with its consumer in `src/uses.ts` named",
    async () => {
      const before = treeStamps();
      const log = tsgoProcessLog();
      const manager = freshManager(log);
      try {
        const answer = payload(await ask(manager, sharedFile, SYMBOL));
        const opened = namesUnder([...new Set(log.opened.map((document) => document.file))]);

        // The subject is the disputed file's own declaration, addressed on the first call about a file its
        // nearest config leaves out and its ancestor owns — so this file IS the ancestor's anchor as well as the
        // call's named file, and the open that addresses it is the open that loads the ancestor.
        expect(answer.resolved.name).toBe(SYMBOL);
        expect(answer.resolved.kind).toBe("variable");
        expect(answer.resolved.line).toBe(lineOf(sharedFile, "export const SHARED_CLIMB"));
        expect(samePath(answer.resolved.file, sharedFile)).toBe(true);

        // Both projects of the fixture were mapped, anchored and loaded: the ancestor by `nested/shared.ts` (the
        // climb made it that project's owner), the nested config by `nested/inner/owned.ts`, and the named file
        // itself on top of them. `src/uses.ts` is among the documents the process was shown because the naming
        // step opens each distinct in-workspace file a row fell in, to spell that row's name — not because it
        // anchors anything: the ancestor anchors on the disputed file, and this is the file it merely reads.
        const projects = requireProjects(answer.scope);
        expect(projects.failed).toEqual([]);
        expect(projects.subsumed).toEqual([]);
        expect(namesUnder(projects.configs)).toEqual(CONFIGS);
        expect(answer.scope.limits).not.toContain("projects-not-loaded");
        for (const one of [usesFile, ownedFile, sharedFile]) {
          expect(opened, `documents opened on the answering process: ${JSON.stringify(opened)}`).toContain(under(one));
        }
        // The disputed file is read and now owned by the ancestor, so it is not "a source no project includes".
        const uncovered = requireUncovered(answer.scope);
        expect(uncovered.count).toBe(0);
        expect(uncovered.namedFileUncovered).toBe(false);

        const useLine = lineOf(usesFile, "return SHARED_CLIMB;");
        const climbed = groupOf(answer, usesFile) !== undefined;
        const record = climbed
          ? `the ANCESTOR project answered its own consumer in ${under(usesFile)}, which the climb rule predicts`
          : `the ancestor project did NOT answer its own consumer in ${under(usesFile)}, although the climb ` +
            "anchors it on the very file this call named — a contradiction with the rule this server implements";
        console.info(
          `parent-climb pin: tsgo answered "${SYMBOL}" (${under(sharedFile)}:${answer.resolved.line}) with ` +
            `totalReferences=${String(answer.totalReferences)}, files=${JSON.stringify(rows(answer))}, ` +
            `limits=${JSON.stringify(answer.scope.limits)} — ${record}`,
        );

        // The use in `src/uses.ts` is in the answer: under the climb the ancestor owns the disputed file, is
        // anchored on it, and its program holds the consumer, so this call has no other answer to give.
        const group = groupOf(answer, usesFile);
        expect(group === undefined ? "<no group for src/uses.ts>" : under(group.file), evidence(answer, opened)).toBe(
          under(usesFile),
        );
        expect(group?.external, evidence(answer, opened)).toBe(false);
        const site = (group?.sites ?? []).find((candidate) => candidate.line === useLine);
        expect(site === undefined ? "<no site at the use line>" : site.in, evidence(answer, opened)).toBe(CONSUMER);

        // The exactness, whatever the answer turned out to be.
        expect(answer.files.reduce((sum, one) => sum + one.count, 0), evidence(answer, opened)).toBe(
          answer.totalReferences,
        );
        expect(answer.filesTruncated).toBe(0);
      } finally {
        manager.disposeAll();
      }
      expect(treeStamps()).toEqual(before);
    },
    CALL_BUDGET_MS,
  );
});
