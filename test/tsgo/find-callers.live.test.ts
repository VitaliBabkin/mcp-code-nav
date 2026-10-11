import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { dropProjectMap } from "../../src/tsgo/project-map.js";
import { walkWorkspace } from "../../src/tsgo/workspace-snapshot.js";
import {
  runTsFindCallers,
  type TsCallerRow,
  type TsFindCallersPayload,
} from "../../src/tools/ts-find-callers.js";
import type { TsNavigationScope } from "../../src/tools/ts-navigation-shared.js";
import {
  CALL_BUDGET_MS,
  fixtures,
  itIfTsgoAvailable,
  payloadOf,
  recordAnswer,
  stampsOf,
  textOf,
  tsgoProcessLog,
  type TsgoProcessLog,
} from "../helpers/tsgo-live.js";

/**
 * Live: `ts_find_callers` against the real TypeScript 7 native server, over
 * `test/fixtures/ts-callers-impl`. Each pin below is a claim about what tsgo's call hierarchy credits to a
 * declaration — which site is an edge, which mention is not, whether an arrow-function `const` has a hierarchy
 * at all  — and a mock can only repeat what its author already believed about that.
 *
 * Expected lines and names are read out of the fixture's own text (`lineOf`, `lineAfter`), never remembered,
 * and no case writes into `test/fixtures/**`: the one case that must change disk changes a `mkdtempSync` copy.
 */

const workspaceRoot = join(fixtures, "ts-callers-impl");
const handlerFile = join(workspaceRoot, "src", "handler.ts");
const usesFile = join(workspaceRoot, "src", "uses.ts");

type Result = Awaited<ReturnType<typeof runTsFindCallers>>;

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
  return runTsFindCallers(manager, { sourceRoots: roots, file, symbol, timeBudgetMs: CALL_BUDGET_MS });
}

function payload(result: Result): TsFindCallersPayload {
  return payloadOf<TsFindCallersPayload>(result, "ts_find_callers");
}

/** Paths compared the way the workspace model compares them: separators normalised, case folded on this OS. */
function samePath(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const normalise = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  return normalise(a) === normalise(b);
}

const linesOf = (file: string): string[] => readFileSync(file, "utf-8").split(/\r?\n/);

/** The 1-based line a fixture text sits on, or a failure naming the fixture that no longer carries it. */
function lineOf(file: string, needle: string): number {
  const index = linesOf(file).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer declares "${needle}" in ${file}`);
  return index + 1;
}

/**
 * The 1-based line of `needle` at or after the line holding `anchor` — the shape a class member needs,
 * because four of this fixture's classes declare a `handle` with one body line each.
 */
function lineAfter(file: string, anchor: string, needle: string): number {
  const lines = linesOf(file);
  const from = lines.findIndex((line) => line.includes(anchor));
  if (from < 0) throw new Error(`the fixture no longer holds "${anchor}" in ${file}`);
  const offset = lines.slice(from).findIndex((line) => line.includes(needle));
  if (offset < 0) throw new Error(`"${needle}" does not follow "${anchor}" in ${file}`);
  return from + offset + 1;
}

/** The 1-based column `token` starts at on the line of `file` that holds `needle` — what tsgo reports a call at. */
function columnOf(file: string, needle: string, token: string): number {
  const line = linesOf(file)[lineOf(file, needle) - 1] ?? "";
  const index = line.indexOf(token);
  if (index < 0) throw new Error(`"${token}" is not on the line of ${file} holding "${needle}"`);
  return index + 1;
}

/** `path` under `root` in forward slashes; its own spelling when it is not under it at all. */
function under(root: string, path: string | null | undefined): string {
  if (path === undefined || path === null) return "<none>";
  const rel = relative(root, path);
  return rel.startsWith("..") ? path : rel.split(sep).join("/");
}

/** Every kept site as `<file>:<site line>:<column>`, in report order: what the server actually credited. */
function sitesOf(answer: TsFindCallersPayload): string[] {
  return answer.callers.flatMap((row) => row.callSites.map((site) => `${under(workspaceRoot, row.file)}:${site.line}:${site.column ?? "-"}`));
}

/** Every kept row as `<name>@<its line>`, which is what a failure has to show to be actionable. */
function rows(answer: TsFindCallersPayload): string[] {
  return answer.callers.map((row) => `${row.name ?? "<unnamed>"}@${row.line}${row.reason ? ` (${row.reason})` : ""}`);
}

function rowNamed(answer: TsFindCallersPayload, name: string): TsCallerRow | undefined {
  return answer.callers.find((row) => row.name === name);
}

/** The site lines one calling declaration carries, in report order. */
function siteLines(answer: TsFindCallersPayload, name: string): number[] {
  return (rowNamed(answer, name)?.callSites ?? []).map((site) => site.line);
}

function requireProjects(scope: TsNavigationScope): { count: number; configs: readonly string[]; failed: readonly { config: string; reason: string }[] } {
  if (!("projects" in scope)) throw new Error(`no project map was reported: ${scope.projectsUnavailable}`);
  return scope.projects;
}

/** Every file the walk proved it saw: what a run must leave exactly as it found it. */
function treeStamps(root: string): Map<string, string> {
  const walked = walkWorkspace(root);
  if (walked === undefined) throw new Error(`the walk of "${root}" did not complete`);
  return stampsOf([...walked.entries.keys()]);
}

/** A copy of the fixture, for the case that has to change disk to make a real workspace hold an empty answer. */
function copyFixture(root: string): { dir: string; copied: string } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-tscallers-"));
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

describe("ts_find_callers against the real tsgo", () => {
  itIfTsgoAvailable(
    "carries a method's direct call site and its interface-dispatch site, and omits the function-value call",
    async () => {
      const before = treeStamps(workspaceRoot);
      const manager = freshManager();
      try {
        const answer = payload(await ask(manager, [workspaceRoot], handlerFile, "Direct.handle"));
        try {
          expect(answer.resolved.name).toBe("Direct.handle");
          expect(answer.resolved.kind).toBe("method");
          expect(samePath(answer.resolved.file, handlerFile)).toBe(true);
          expect(answer.resolved.line).toBe(lineAfter(handlerFile, "export class Direct", "handle(job: string)"));

          // the measured server behaviour: the call made through a `Handler` value is credited to the implementing method beside the
          // one made on the concrete class. Both are here, at the token tsgo puts a property-access call at —
          // the method name, not the receiver — and the third edge is the one the brief's pin is about.
          const directLine = lineOf(usesFile, 'return worker.handle("a")');
          const throughLine = lineOf(usesFile, 'return worker.handle("b")');
          const referenceLine = lineOf(usesFile, "const picked = new Direct().handle");
          const registerLine = lineOf(usesFile, "return [1].map(new Direct().handle)");
          const boundLine = lineOf(usesFile, "return new Direct().handle.bind(null)");
          const indirectLine = lineOf(usesFile, 'return picked("c")');
          const handleColumn = (line: number): number => columnOf(usesFile, linesOf(usesFile)[line - 1] ?? "", "handle");
          expect(
            answer.callers.flatMap((row) => row.callSites.map((site) => `${site.line}:${site.column}`)).sort(),
            JSON.stringify(rows(answer)),
          ).toEqual(
            [
              `${directLine}:${handleColumn(directLine)}`,
              `${throughLine}:${handleColumn(throughLine)}`,
              `${referenceLine}:${handleColumn(referenceLine)}`,
              `${registerLine}:${handleColumn(registerLine)}`,
              `${boundLine}:${handleColumn(boundLine)}`,
            ].sort(),
          );
          expect(answer.callers.every((row) => samePath(row.file, usesFile))).toBe(true);
          expect(answer.totalCallers).toBe(5);
          expect(answer.callersTruncated).toBe(0);

          // The named rows: the two real calls, and the two MENTIONS credited
          // to their enclosing function because each is the right side of a property access.
          for (const name of ["directCall", "interfaceCall", "register", "boundToNull"]) {
            expect(rowNamed(answer, name), JSON.stringify(rows(answer))).toBeDefined();
            expect(rowNamed(answer, name)?.kind).toBe("function");
            expect(rowNamed(answer, name)?.external).toBe(false);
          }
          // `directCall` has a JSDoc above it, so tsgo's item range starts on the comment: the row is still named,
          // and it reports the declaration's own line, not the comment's.
          expect(rowNamed(answer, "directCall")?.line).toBe(lineOf(usesFile, "export function directCall"));
          expect(siteLines(answer, "directCall")).toEqual([directLine]);
          expect(siteLines(answer, "interfaceCall")).toEqual([throughLine]);
          expect(siteLines(answer, "register")).toEqual([registerLine]);
          expect(siteLines(answer, "boundToNull")).toEqual([boundLine]);

          // THE ABSENCE: `picked("c")`, the call through the stored function value, is no hierarchy edge. What IS
          // credited is the extraction above it, credited to the SOURCE FILE because no callable encloses it — and
          // that row's reason says so rather than reads as a naming failure.
          expect(rowNamed(answer, "functionValueCall")).toBeUndefined();
          expect(answer.callers.flatMap((row) => row.callSites.map((site) => site.line))).not.toContain(indirectLine);
          const moduleScope = answer.callers.filter((row) => row.name === null);
          expect(moduleScope, JSON.stringify(rows(answer))).toHaveLength(1);
          expect(moduleScope[0]?.kind).toBeNull();
          expect(moduleScope[0]?.reason).toBe("at module scope; no declaration encloses this site");
          expect(moduleScope[0]?.callSites.map((site) => site.line)).toEqual([referenceLine]);
          recordAnswer("callers-Direct.handle", answer.callers);

          expect(answer.scope.limits).toEqual([
            "one-workspace",
            // A method's listing is the over-reporting kind; then the complementary pair — the later call through
            // a stored value absent, the uncalled mention present — and no cap was reached.
            "corresponding-interface-methods-included",
            "indirect-dispatch-not-resolved",
            "uncalled-mentions-included",
          ]);

          const projects = requireProjects(answer.scope);
          expect(projects.failed).toEqual([]);
          expect(answer.scope.limits).not.toContain("projects-not-loaded");
          expect(answer.scope.freshness.kind).toBe("unchanged");
        } finally {
          manager.disposeAll();
        }
      } finally {
        expect(treeStamps(workspaceRoot)).toEqual(before);
      }
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "reports a module-scope mention as module scope even when the file's first declaration starts at its first character",
    async () => {
      const manager = freshManager();
      try {
        const scriptFile = join(workspaceRoot, "src", "script.ts");
        const answer = payload(await ask(manager, [workspaceRoot], scriptFile, "Target.run"));
        expect(answer.totalCallers, JSON.stringify(rows(answer))).toBe(1);
        expect(rowNamed(answer, "firstDeclaration")).toBeUndefined();
        const [row] = answer.callers;
        expect(row).toMatchObject({
          name: null,
          kind: null,
          reason: "at module scope; no declaration encloses this site",
        });
        expect(row?.callSites.map((site) => site.line)).toEqual([lineOf(scriptFile, "export const stored")]);
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "asks the hierarchy for an arrow-function const, because its kind cannot tell a callable from data",
    async () => {
      const manager = freshManager();
      try {
        const answer = payload(await ask(manager, [workspaceRoot], handlerFile, "runJob"));
        expect(answer.resolved.name).toBe("runJob");
        expect(answer.resolved.line).toBe(lineOf(handlerFile, "export const runJob"));
        // tsgo reports a `const` with the variable kind, which is no hint of what it holds — the reason this
        // tool's gate is the server's own answer rather than a kind table.
        expect(answer.resolved.kind).toBe("variable");
        const arrowLine = lineOf(usesFile, 'return runJob("d")');
        expect(
          answer.callers.flatMap((row) => row.callSites.map((site) => `${site.line}:${site.column}`)),
          JSON.stringify(rows(answer)),
        ).toEqual([`${arrowLine}:${columnOf(usesFile, 'return runJob("d")', "runJob")}`]);
        expect(answer.totalCallers).toBe(1);
        // the boundary pin: `[1].map(runJob)` passes the function BARE — not the right side of a property
        // access — so TypeScript's rule does not credit it, and this row is absent. A `Direct`-type member
        // mentioned the same way IS credited (the case above), which is what makes the pair the boundary.
        expect(rowNamed(answer, "passJobBare")).toBeUndefined();
        expect(answer.callers.some((row) => row.callSites.some((site) => site.line === lineOf(usesFile, "return [1].map(runJob)")))).toBe(false);
        recordAnswer("callers-runJob", answer.callers);
        expect(rowNamed(answer, "arrowCall")).toMatchObject({
          kind: "function",
          external: false,
          line: lineOf(usesFile, "export function arrowCall"),
        });
        expect(samePath(rowNamed(answer, "arrowCall")?.file, usesFile)).toBe(true);
        // A `const` is not a method, so the over-report code is absent; the two indirect-dispatch codes are not.
        expect(answer.scope.limits).toEqual([
          "one-workspace",
          "indirect-dispatch-not-resolved",
          "uncalled-mentions-included",
        ]);
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "refuses a declaration tsgo holds no call hierarchy for, saying not callable rather than answering with mentions",
    async () => {
      const log = tsgoProcessLog();
      const manager = freshManager(log);
      try {
        const result = await ask(manager, [workspaceRoot], handlerFile, "LABEL");
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`no call hierarchy for "LABEL"`);
        expect(textOf(result)).toContain("it is not callable");
        expect(textOf(result)).toContain("a mention is not a call");
        expect(result).not.toHaveProperty("structuredContent");
        expect(textOf(result)).not.toMatch(/did not answer|could not prove/);
        // The refusal costs the outline and the one request that IS the gate. No incoming-calls request follows
        // it, and no references request either - the substitution the text refuses, checked against what this
        // client actually sent rather than against what the case hopes.
        expect(log.methods).toEqual(["initialize", "textDocument/documentSymbol", "textDocument/prepareCallHierarchy"]);
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "answers a callable nobody calls with a scoped empty, once every anchor is open on the answering process",
    async () => {
      // A copy, because the only way a real workspace holds an uncalled function is to remove its caller — and
      // the original fixture must stay exactly as the other cases read it.
      const { dir, copied } = copyFixture(workspaceRoot);
      const manager = freshManager();
      try {
        writeFileSync(join(copied, "src", "uses.ts"), 'export const NOTHING_HERE = "no call of runJob in this fixture";\n');

        const result = await ask(manager, [copied], join(copied, "src", "handler.ts"), "runJob");
        expect(result.isError, textOf(result)).toBeFalsy();
        const answer = payload(result);
        expect(answer.totalCallers).toBe(0);
        expect(answer.callers).toEqual([]);
        expect(answer.callersTruncated).toBe(0);
        // Empty under the proof: the project's own anchor and the named file were opened on the process that
        // answered, which is all the proof can say and the whole reason an empty here is an answer.
        expect(requireProjects(answer.scope).failed).toEqual([]);
        expect(under(copied, requireProjects(answer.scope).configs[0] ?? "")).toBe("tsconfig.json");
        expect(answer.scope.limits).toEqual([
          "one-workspace",
          "indirect-dispatch-not-resolved",
          "uncalled-mentions-included",
        ]);
        expect(textOf(result)).toContain("0 caller(s) listed from 0 found");
      } finally {
        manager.disposeAll();
        dropProjectMap(copied);
        await removeTree(dir);
      }
    },
    CALL_BUDGET_MS * 2,
  );
});
