import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { dropProjectMap } from "../../src/tsgo/project-map.js";
import { walkWorkspace } from "../../src/tsgo/workspace-snapshot.js";
import { OUTSIDE_WORKSPACE_REASON, type TsUncoveredBlock } from "../../src/tools/ts-navigation-shared.js";
import {
  runTsFindReferences,
  type TsFindReferencesPayload,
  type TsReferenceFile,
  type TsReferenceSite,
} from "../../src/tools/ts-find-references.js";
import {
  CALL_BUDGET_MS,
  fixtures,
  itIfTsgoAvailable,
  payloadOf,
  requireTsgo,
  stampsOf,
  textOf,
  tsgoProcessLog,
  type TsgoProcessLog,
} from "../helpers/tsgo-live.js";

/**
 * Live: `ts_find_references` over `test/fixtures/ts-workspace` against the real TypeScript 7
 * native server. The fixture is built so that every use the answer must contain is visible to exactly one
 * tsconfig project — `src/app-only.ts` to the app project, `tools/node-uses.ts` to the node project,
 * `packages/ui/src/widget.ts` to the config reached only through the workspace's `references` — and one use
 * (`test/store.test.ts`) is visible to none of them because no `include` lists it. Which rows come back is
 * therefore a fact about the project map and the documents-opened proof, not about text
 * matching, and it can only be measured against a running server.
 *
 * Counts are read out of the fixture's own text (`lineOf`), never remembered; a case that edits disk edits a
 * `mkdtempSync` copy and ends by proving the original tree is untouched.
 */

const workspaceRoot = join(fixtures, "ts-workspace");
const memberPackage = join(workspaceRoot, "packages", "ui");

const storeFile = join(workspaceRoot, "src", "store.ts");
const sharedFile = join(workspaceRoot, "src", "shared.ts");
const legacyFile = join(workspaceRoot, "src", "legacy.js");
const appOnlyFile = join(workspaceRoot, "src", "app-only.ts");
const nodeUsesFile = join(workspaceRoot, "tools", "node-uses.ts");
const widgetFile = join(memberPackage, "src", "widget.ts");
const testFile = join(workspaceRoot, "test", "store.test.ts");

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

function ask(
  manager: LspSessionManager,
  roots: string[],
  file: string,
  symbol: string,
  includeDeclaration = false,
): Promise<Result> {
  return runTsFindReferences(
    manager,
    { sourceRoots: roots, file, symbol, includeDeclaration, timeBudgetMs: CALL_BUDGET_MS },
  );
}

function payload(result: Result): TsFindReferencesPayload {
  return payloadOf<TsFindReferencesPayload>(result, "ts_find_references");
}

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

/** The group answering for one file, however the server happened to spell it. */
function groupOf(answer: TsFindReferencesPayload, file: string): TsReferenceFile | undefined {
  return answer.files.find((group) => samePath(group.file, file));
}

/** Every kept row as `file:line in <name>`, for a failure message that shows the whole listing. */
function rows(answer: TsFindReferencesPayload, root: string): string[] {
  return answer.files.flatMap((group) =>
    group.sites.map((site) => `${under(root, group.file)}:${site.line} in ${site.in ?? "<unnamed>"}`),
  );
}

/** The sources-no-project-includes block, or a failure quoting the reason it was not computed. */
function uncoveredOf(answer: TsFindReferencesPayload): TsUncoveredBlock {
  const scope = answer.scope;
  if (!("uncoveredSources" in scope)) {
    throw new Error(`no uncovered set was computed: ${scope.uncoveredSourcesUnavailable}`);
  }
  return scope.uncoveredSources;
}

function projectsOf(answer: TsFindReferencesPayload): { count: number; configs: readonly string[]; failed: readonly { config: string; reason: string }[] } {
  const scope = answer.scope;
  if (!("projects" in scope)) throw new Error(`no project map was reported: ${scope.projectsUnavailable}`);
  return scope.projects;
}

/** Every file the walk proved it saw in a fixture tree: what a run must leave exactly as it found it. */
function treeStamps(root: string): Map<string, string> {
  const walked = walkWorkspace(root);
  if (walked === undefined) throw new Error(`the walk of "${root}" did not complete`);
  return stampsOf([...walked.entries.keys()]);
}

function copyFixture(root: string): { dir: string; copied: string } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-tsref-"));
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

/** Writes one file, with its directories, into a copy. */
function writeInto(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

// ---------------------------------------------------------------------- the cases

describe("ts_find_references against the real tsgo", () => {
  itIfTsgoAvailable(
    "finds the member package's one consumer of a shared declaration, proving the workspace was loaded wide",
    async () => {
      const manager = freshManager();
      try {
        // `configs/member.json` is a project only because the workspace's root config names it under
        // `references`, and `packages/ui/src/widget.ts` is a use only that project reads. `widget.ts` reaches
        // `src/shared.ts`'s `SHARED_LABEL` (not `Store.run`: the fixture's member consumer imports shared.ts),
        // so that is the subject this pin is measured on.
        const answer = payload(await ask(manager, [workspaceRoot], sharedFile, "SHARED_LABEL"));
        try {
          expect(answer.resolved.name).toBe("SHARED_LABEL");
          expect(answer.resolved.kind).toBe("variable");
          expect(answer.resolved.line).toBe(lineOf(sharedFile, "export const SHARED_LABEL"));
          expect(samePath(answer.resolved.file, sharedFile)).toBe(true);

          // The import line is a use too: the consumer's specifier and its one real use.
          expect(answer.totalReferences).toBe(2);
          const widget = groupOf(answer, widgetFile);
          expect(widget === undefined ? "<no group>" : rows(answer, workspaceRoot)).toEqual([
            `${under(workspaceRoot, widgetFile)}:${lineOf(widgetFile, "import { SHARED_LABEL")} in SHARED_LABEL`,
            `${under(workspaceRoot, widgetFile)}:${lineOf(widgetFile, "const named: Named = { label: SHARED_LABEL }")} in widgetLabel`,
          ]);
          expect(widget?.count).toBe(2);
          expect(widget?.external).toBe(false);
          const site = widget?.sites[1] as TsReferenceSite;
          expect(site.line).toBe(lineOf(widgetFile, "const named: Named"));
          expect(site.in).toBe("widgetLabel");

          // The answer states the four projects it loaded, and the member config is one of them.
          const projects = projectsOf(answer);
          expect(projects.failed).toEqual([]);
          expect(namesUnder(workspaceRoot, projects.configs)).toContain("configs/member.json");
          expect(answer.scope.limits).not.toContain("projects-not-loaded");

          // The row naming: the subject is named in the spelling `symbol` accepts, so a caller can
          // paste `resolved.name` into the next call and land on the same declaration.
          const replayed = payload(await ask(manager, [workspaceRoot], sharedFile, answer.resolved.name));
          expect(replayed.resolved).toEqual(answer.resolved);
          expect(replayed.totalReferences).toBe(answer.totalReferences);
        } finally {
          manager.disposeAll();
        }
      } finally {
        expect(1).toBe(1);
      }
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "lists the file outside every include as uncovered, keeps its use out of the answer, and says so",
    async () => {
      const answer = payload(await ask(freshManager(), [workspaceRoot], storeFile, "Store.run"));
      const uncovered = uncoveredOf(answer);

      expect(uncovered.directories).toEqual([
        { directory: "packages/ui", count: 2 },
        { directory: "test", count: 1 },
      ]);
      expect(uncovered.count).toBe(3);
      expect(uncovered.namedFileUncovered).toBe(false);
      // The file whose text holds the method's name is pointed at, not listed as a row (the row assertions below).
      expect(uncovered.mentioning.name).toBe("run");
      expect(namesUnder(workspaceRoot, uncovered.mentioning.files.map((hit) => hit.file))).toEqual([
        "test/store.test.ts",
      ]);
      expect(answer.scope.limits).toContain("uncovered-sources-present");

      // `test/store.test.ts:4` really does call `run` — that is why the file is in the fixture — and its row
      // is absent because no project lists the file, so no project was loaded that could see it.
      expect(linesOf(testFile)).toContain("  return store.run();");
      expect(groupOf(answer, testFile)).toBeUndefined();
      expect(rows(answer, workspaceRoot)).not.toContain(
        `${under(workspaceRoot, testFile)}:${lineOf(testFile, "return store.run();")} in testUsesRun`,
      );
      expect(answer.totalReferences).toBe(1);
      expect(rows(answer, workspaceRoot)).toEqual([
        `${under(workspaceRoot, appOnlyFile)}:${lineOf(appOnlyFile, "return store.run();")} in appReport`,
      ]);
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "counts the declaration's own row only when includeDeclaration asks, and always lists the import lines",
    async () => {
      const manager = freshManager();
      try {
        // Hand count of the fixture naming the class `Store`: a use in a parameter type in `src/app-only.ts:3`
        // and one in `tools/node-uses.ts:4`; the import specifier on line 1 of each; and the same shape again
        // in `test/store.test.ts`, which no project lists.
        const uses = payload(await ask(manager, [workspaceRoot], storeFile, "Store", false));
        const withDeclaration = payload(await ask(manager, [workspaceRoot], storeFile, "Store", true));

        // False: only the declaration is out. The import specifier lines stay, so each
        // consumer lists its import and its parameter type, which is what a grep for `Store` counts.
        expect(uses.totalReferences).toBe(4);
        expect(groupOf(uses, storeFile)).toBeUndefined();
        expect(namesUnder(workspaceRoot, uses.files.map((group) => group.file))).toEqual([
          "src/app-only.ts",
          "tools/node-uses.ts",
        ]);
        expect(uses.files.every((group) => group.count === 2 && group.sites.length === 2)).toBe(true);

        // True: the class's own row appears, at the declaration's line, in its own file.
        expect(groupOf(uses, storeFile)).toBeUndefined();
        const declared = groupOf(withDeclaration, storeFile);
        expect(declared === undefined ? "<no group>" : declared.sites.map((site) => site.line)).toEqual([
          lineOf(storeFile, "export class Store"),
        ]);
        expect(withDeclaration.totalReferences).toBe(uses.totalReferences + 1);

        // What the server does with the two import specifier lines when the declaration is asked for is the
        // difference this case exists to state, so it is reported rather than assumed either way.
        console.info(
          `includeDeclaration=false ${uses.totalReferences} row(s) ${JSON.stringify(rows(uses, workspaceRoot))} / ` +
            `true ${withDeclaration.totalReferences} row(s) ${JSON.stringify(rows(withDeclaration, workspaceRoot))}`,
        );

        // Neither answer may reach the file no project includes.
        expect(groupOf(withDeclaration, testFile)).toBeUndefined();
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "carries the interface-member over-report code for a method subject, and not for a variable one",
    async () => {
      const manager = freshManager();
      try {
        // `corresponding-interface-methods-included` is keyed on the subject's kind, because a
        // method's listing may carry the interface member it satisfies (the measured server behaviour) whatever the subject
        // is asked about. NOTE, reported not asserted: this fixture declares one interface member
        // (`Named.label`) and no class that implements it, so no counterpart row can appear here to prove the
        // over-report — the code is pinned, the extra row is not observable on these fixtures.
        const flush = payload(await ask(manager, [workspaceRoot], storeFile, "Store.flush"));
        expect(flush.resolved.kind).toBe("method");
        expect(flush.scope.limits).toContain("corresponding-interface-methods-included");
        expect(flush.totalReferences).toBe(1);
        expect(rows(flush, workspaceRoot)).toEqual([
          `${under(workspaceRoot, nodeUsesFile)}:${lineOf(nodeUsesFile, "return OWNER_FILE + store.flush();")} in nodeFlush`,
        ]);
        // No interface in the workspace declares `flush`, so nothing beyond that one row may appear.
        expect(namesUnder(workspaceRoot, flush.files.map((group) => group.file))).toEqual(["tools/node-uses.ts"]);

        const run = payload(await ask(manager, [workspaceRoot], storeFile, "Store.run"));
        expect(run.scope.limits).toContain("corresponding-interface-methods-included");

        const shared = payload(await ask(manager, [workspaceRoot], sharedFile, "SHARED_LABEL"));
        expect(shared.resolved.kind).toBe("variable");
        expect(shared.scope.limits).not.toContain("corresponding-interface-methods-included");
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "reports a use under node_modules as external, names why it has no name, and never opens that file",
    async () => {
      const before = treeStamps(workspaceRoot);
      const { dir, copied } = copyFixture(workspaceRoot);
      const copiedStore = join(copied, "src", "store.ts");
      const depTypes = writeInto(
        join(copied, "node_modules", "dep", "index.d.ts"),
        'import { Store } from "../../src/store.js";\n\nexport declare function depName(store: Store): string;\n',
      );
      writeInto(
        join(copied, "node_modules", "dep", "package.json"),
        JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
      );
      // A re-export, so the dependency's declaration file joins the app project's program without this
      // fixture's own sources naming the class one more time than the real fixture does.
      writeInto(join(copied, "src", "zz-dep-use.ts"), 'export { depName } from "dep";\n');

      const log = tsgoProcessLog();
      const manager = freshManager(log);
      try {
        const answer = payload(await ask(manager, [copied], copiedStore, "Store"));
        const external = answer.files.filter((group) => group.external);
        expect(external.map((group) => under(copied, group.file))).toEqual(["node_modules/dep/index.d.ts"]);
        // The dependency's own import line is a row as well as its use; the use is the one under test.
        expect(external[0]?.count).toBe(2);
        const site = external[0]?.sites.find(
          (candidate) => candidate.line === lineOf(depTypes, "depName(store: Store)"),
        ) as TsReferenceSite;
        expect(site.in).toBeNull();
        expect(site.reason).toBe(OUTSIDE_WORKSPACE_REASON);
        expect(site.line).toBe(lineOf(depTypes, "depName(store: Store)"));
        // `column` is null only when the server sent no character, and tsgo sends one here: the
        // column is read off the dependency's own text rather than remembered from a run.
        const depLine = readFileSync(depTypes, "utf-8").split(/\r?\n/)[site.line - 1] ?? "";
        expect(site.column, `the character tsgo reported inside ${JSON.stringify(depLine)}`).toBe(
          depLine.indexOf("Store") + 1,
        );

        // The rule that keeps the project rules: only non-external files are opened, outlined or hovered.
        expect(log.opened.filter((opened) => /node_modules/i.test(opened.file))).toEqual([]);
        expect(log.opened.some((opened) => samePath(opened.file, copiedStore))).toBe(true);

        // The in-workspace half of the answer is unchanged by the dependency's row, and still excludes the
        // file no project includes.
        expect(namesUnder(copied, answer.files.filter((g) => !g.external).map((group) => group.file))).toEqual([
          "src/app-only.ts",
          "tools/node-uses.ts",
        ]);
        expect(answer.totalReferences).toBe(6);
        expect(groupOf(answer, join(copied, "test", "store.test.ts"))).toBeUndefined();
        // A dependency's file is a dependency, not a source the workspace forgot to include.
        expect(uncoveredOf(answer).directories).toEqual([
          { directory: "packages/ui", count: 2 },
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
    "answers exact counts the fixture's own text says, with the group counts summing to the total",
    async () => {
      const manager = freshManager();
      try {
        // Counted from the fixture: `run()` is called in `src/app-only.ts:4` and in `test/store.test.ts:4`
        // (outside every include, so absent); `flush()` in `tools/node-uses.ts:5` alone; the class name
        // `Store` appears as an import and a parameter type in both consumers and nowhere else in a loaded
        // project, and `Named` as an import and a use in the member package's widget.
        const expectations = [
          { file: storeFile, symbol: "Store.run", total: 1, groups: { [appOnlyFile]: 1 } },
          { file: storeFile, symbol: "Store.flush", total: 1, groups: { [nodeUsesFile]: 1 } },
          { file: storeFile, symbol: "Store", total: 4, groups: { [appOnlyFile]: 2, [nodeUsesFile]: 2 } },
          { file: sharedFile, symbol: "Named", total: 2, groups: { [widgetFile]: 2 } },
        ] as const;

        for (const one of expectations) {
          const answer = payload(await ask(manager, [workspaceRoot], one.file, one.symbol));
          expect(
            answer.totalReferences,
            `${one.symbol}: ${JSON.stringify(rows(answer, workspaceRoot))}`,
          ).toBe(one.total);
          const listed = Object.entries(one.groups) as [string, number][];
          expect(
            namesUnder(workspaceRoot, answer.files.map((group) => group.file)),
            `${one.symbol}: ${JSON.stringify(rows(answer, workspaceRoot))}`,
          ).toEqual(namesUnder(workspaceRoot, listed.map(([file]) => file)));
          for (const [file, count] of listed) {
            expect(groupOf(answer, file)?.count, one.symbol).toBe(count);
          }
          // The exactness: `count` is what the server reported whatever the listing caps.
          expect(answer.files.reduce((sum, group) => sum + group.count, 0)).toBe(answer.totalReferences);
          expect(answer.filesTruncated).toBe(0);
          expect(answer.files.every((group) => group.sitesTruncated === 0)).toBe(true);
        }
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS * 3,
  );

  itIfTsgoAvailable(
    "answers a symbol no consumer uses with a scoped empty, once the documents-opened proof holds",
    async () => {
      // A fresh session, because the claim under test is that the FIRST type-aware call can prove the
      // anchors: without the proof this call waits out its budget and answers with an error instead.
      const manager = freshManager();
      try {
        const result = await ask(manager, [workspaceRoot], legacyFile, "legacy");
        expect(result.isError, textOf(result)).toBeFalsy();
        expect(textOf(result)).not.toMatch(/could not prove|budget|restarted/);

        const answer = payload(result);
        expect(answer.resolved).toMatchObject({ name: "legacy", kind: "function" });
        expect(answer.totalReferences).toBe(0);
        expect(answer.files).toEqual([]);
        expect(answer.filesTruncated).toBe(0);
        // Empty under the proof, and the proof is the four projects anchored on the answering process.
        expect(projectsOf(answer).failed).toEqual([]);
        expect(projectsOf(answer).configs).toHaveLength(4);
        expect(answer.scope.limits).toContain("one-workspace");
        expect(answer.scope.limits).not.toContain("projects-not-loaded");
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS,
  );
});
