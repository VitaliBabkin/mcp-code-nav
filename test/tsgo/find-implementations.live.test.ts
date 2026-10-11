import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { walkWorkspace } from "../../src/tsgo/workspace-snapshot.js";
import { runTsFindImplementations, type TsFindImplementationsPayload } from "../../src/tools/ts-find-implementations.js";
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
 * Live: `ts_find_implementations` against the real TypeScript 7 native server, over
 * `test/fixtures/ts-callers-impl`. The question this suite exists to answer is `class Both extends Base
 * implements Handler` — whether tsgo's `implementation` reaches a class through both halves of its heritage
 * clause — and the two answers beside it that a mock would simply repeat from what its author assumed: a class
 * that satisfies the interface only structurally (the measured server behaviour, invisible to the request), and an interface nobody
 * implements (a scoped empty, not an error).
 *
 * Expected lines and names are read out of the fixture's own text (`lineOf`), never remembered, and no case
 * writes into `test/fixtures/**`. The rows are compared as a SET: which classes answer is the contract, and
 * the order tsgo reports them in is not.
 */

const workspaceRoot = join(fixtures, "ts-callers-impl");
const handlerFile = join(workspaceRoot, "src", "handler.ts");

type Result = Awaited<ReturnType<typeof runTsFindImplementations>>;

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

function ask(manager: LspSessionManager, symbol: string, file = handlerFile): Promise<Result> {
  return runTsFindImplementations(manager, { sourceRoots: [workspaceRoot], file, symbol, timeBudgetMs: CALL_BUDGET_MS });
}

function payload(result: Result): TsFindImplementationsPayload {
  return payloadOf<TsFindImplementationsPayload>(result, "ts_find_implementations");
}

const linesOf = (file: string): string[] => readFileSync(file, "utf-8").split(/\r?\n/);

/** The 1-based line a fixture text sits on, or a failure naming the fixture that no longer carries it. */
function lineOf(file: string, needle: string): number {
  const index = linesOf(file).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer declares "${needle}" in ${file}`);
  return index + 1;
}

/** `path` under `root` in forward slashes; its own spelling when it is not under it at all. */
function under(root: string, path: string | null | undefined): string {
  if (path === undefined || path === null) return "<none>";
  const rel = relative(root, path);
  return rel.startsWith("..") ? path : rel.split(sep).join("/");
}

function namesOf(answer: TsFindImplementationsPayload): (string | null)[] {
  return answer.implementations.map((row) => row.name);
}

/** Every row as `<name> (<kind>) <file>:<line>`, which is what a failure has to show to be actionable. */
function listed(answer: TsFindImplementationsPayload): string[] {
  return answer.implementations.map(
    (row) => `${row.name ?? "<unnamed>"} (${row.kind ?? "?"}) ${under(workspaceRoot, row.file)}:${row.line}`,
  );
}

/** One row's `<name> <file>:<line>`, for an assertion that a named class answered at its own declaration. */
function rowOf(answer: TsFindImplementationsPayload, name: string): string {
  const row = answer.implementations.find((candidate) => candidate.name === name);
  if (row === undefined) return `<no row named ${name}>`;
  return `${row.kind} ${under(workspaceRoot, row.file)}:${row.line}`;
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

/** The 1-based line of `needle` at or after the line holding `anchor`, for a member beside lookalikes. */
function lineAfter(file: string, anchor: string, needle: string): number {
  const lines = linesOf(file);
  const from = lines.findIndex((line) => line.includes(anchor));
  if (from < 0) throw new Error(`the fixture no longer holds "${anchor}" in ${file}`);
  const offset = lines.slice(from).findIndex((line) => line.includes(needle));
  if (offset < 0) throw new Error(`"${needle}" does not follow "${anchor}" in ${file}`);
  return from + offset + 1;
}

/** `<name>:<line>` per row, for the message that shows what the server actually answered. */
function rows(answer: TsFindImplementationsPayload): string[] {
  return answer.implementations.map((row) => `${row.name}:${row.line}`);
}

describe("ts_find_implementations against the real tsgo", () => {
  itIfTsgoAvailable(
    "lists every class that names the interface, including the one that also extends an implementer",
    async () => {
      const before = treeStamps(workspaceRoot);
      const manager = freshManager();
      try {
        const answer = payload(await ask(manager, "Handler"));
        try {
          // THE PIN, recorded verbatim whatever it says: `class Both extends Base implements Handler` is the
          // shape whose answer decides whether tsgo reaches a class through both halves of its heritage clause.
          recordAnswer("implementations-Handler", answer.implementations);

          expect(answer.resolved).toEqual({
            name: "Handler",
            kind: "interface",
            file: handlerFile,
            line: lineOf(handlerFile, "export interface Handler"),
          });
          // The set is the contract; the order tsgo reported it in is not, so each name is checked at its own
          // declaration line rather than against a position in the list.
          expect([...namesOf(answer)].sort()).toEqual(["Base", "Both", "Direct"]);
          for (const name of ["Base", "Both", "Direct"]) {
            expect(rowOf(answer, name), JSON.stringify(rows(answer))).toBe(
              `class src/handler.ts:${lineOf(handlerFile, `export class ${name}`)}`,
            );
          }
          expect(answer.truncated).toBe(0);
          expect(answer.implementations.every((row) => !row.external && row.reason === undefined)).toBe(true);

          // the measured server behaviour: a class that satisfies `Handler` member for member and never names it is not reported at
          // all — and every answer this tool gives says so, whatever it listed.
          expect(namesOf(answer)).not.toContain("Structural");
          expect(linesOf(handlerFile).some((line) => line.includes("export class Structural"))).toBe(true);
          expect(answer.scope.limits).toEqual(["one-workspace", "structural-implementers-not-reported"]);

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
    "reaches a derived class through `extends` alone, the other half of the same request",
    async () => {
      const manager = freshManager();
      try {
        // `Both` is in this answer because it derives from `Base`, which says nothing about `Handler`. Beside
        // the case above, this is what separates "names the interface" from "derives from an implementer".
        const answer = payload(await ask(manager, "Base"));
        recordAnswer("implementations-Base", answer.implementations);
        expect(answer.resolved).toMatchObject({ name: "Base", kind: "class" });
        // Measured: tsgo answers a class subject with the class ITSELF beside its derived classes. That row is
        // the subject, so this tool drops it (mocked pin: "never lists the subject among its own
        // implementations"); what is left is the derivation, which is the question.
        expect([...namesOf(answer)].sort()).toEqual(["Both"]);
        expect(rowOf(answer, "Both")).toBe(`class src/handler.ts:${lineOf(handlerFile, "export class Both")}`);
        expect(rowOf(answer, "Base")).toBe("<no row named Base>");
        expect(answer.truncated).toBe(0);
        expect(answer.scope.limits).toContain("structural-implementers-not-reported");
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "asks an interface member, the third of the four kinds, and answers it",
    async () => {
      const manager = freshManager();
      try {
        const answer = payload(await ask(manager, "Handler.handle"));
        recordAnswer("implementations-Handler.handle", answer.implementations);
        expect(answer.resolved).toMatchObject({ name: "Handler.handle", kind: "method" });
        expect(answer.resolved.line).toBe(lineAfter(handlerFile, "export interface Handler", "handle(job: string)"));
        // A method subject answers with MEMBER rows, one per implementing declaration, each named by the
        // row rule so it reads back as this tool's own `symbol`. Without these, `[]`, the classes, or a row-
        // spelling regression would all pass this case.
        expect([...namesOf(answer)].sort()).toEqual(["Base.handle", "Both.handle", "Direct.handle"]);
        for (const [name, anchor] of [
          ["Base.handle", "export class Base"],
          ["Both.handle", "export class Both"],
          ["Direct.handle", "export class Direct"],
        ] as const) {
          expect(rowOf(answer, name), JSON.stringify(rows(answer))).toBe(
            `method src/handler.ts:${lineAfter(handlerFile, anchor, "handle(job: string)")}`,
          );
        }
        expect(answer.truncated).toBe(0);
        expect(answer.implementations.every((row) => !row.external && row.reason === undefined)).toBe(true);
        expect(answer.scope.limits).toContain("structural-implementers-not-reported");
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "refuses a subject of another kind, naming what tsgo reported it as, and asks nothing type-aware",
    async () => {
      const log = tsgoProcessLog();
      const manager = freshManager(log);
      try {
        const result = await ask(manager, "LABEL");
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('ts_find_implementations failed: "LABEL" is a variable');
        expect(textOf(result)).toContain("only an interface, class, method or property has implementations");
        expect(result).not.toHaveProperty("structuredContent");
        // The gate is this server's own read of the outline, so it can refuse before anything is asked.
        expect(log.methods).toEqual(["initialize", "textDocument/documentSymbol"]);
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable(
    "answers an interface nobody implements with a scoped empty, not an error",
    async () => {
      // A fresh session, because the claim is that the FIRST type-aware call can prove the anchors: without
      // The proof this call would wait out its budget and answer with an error instead.
      const manager = freshManager();
      try {
        const result = await ask(manager, "Alone");
        expect(result.isError, textOf(result)).toBeFalsy();
        expect(textOf(result)).not.toMatch(/could not prove|budget|restarted/);

        const answer = payload(result);
        expect(answer.resolved).toEqual({
          name: "Alone",
          kind: "interface",
          file: handlerFile,
          line: lineOf(handlerFile, "export interface Alone"),
        });
        expect(answer.implementations).toEqual([]);
        expect(answer.truncated).toBe(0);
        expect(requireProjects(answer.scope).failed).toEqual([]);
        // The empty is the answer, and the code beside it says which kind of empty: not "nothing satisfies
        // this", but "nothing that NAMES it", because a structural satisfier is invisible to the request.
        expect(answer.scope.limits).toEqual(["one-workspace", "structural-implementers-not-reported"]);
        expect(textOf(result)).toContain("- 0 row(s)");
      } finally {
        manager.disposeAll();
      }
    },
    CALL_BUDGET_MS,
  );
});
