// `ts_find_callers`' mocked contract: `go_find_callers`' payload over a TypeScript
// workspace, with the callable gate moved onto `prepareCallHierarchy` itself — tsgo's kind cannot tell an
// arrow-function `const` from data, so the server's own answer decides. No `tsc.exe`, no `npm` and no real
// tsgo runs here: the executable is injected through `resolveBinary`, the project listings through `exec`,
// and every tsgo answer through the fake server's `respond`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import type { LspSession } from "../../src/lsp/session.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import {
  registerTsFindCallers,
  runTsFindCallers,
  TsFindCallersInput,
  type TsFindCallersPayload,
} from "../../src/tools/ts-find-callers.js";
import { CALLERS_LIMIT, REFERENCE_SITES_PER_FILE_LIMIT } from "../../src/tools/navigation-limits.js";
import type { TsQueryDeps } from "../../src/tools/ts-navigation-shared.js";
import type { TsgoBinary, TsExecFn } from "../../src/tsgo/binary.js";
import { dropProjectMap } from "../../src/tsgo/project-map.js";
import { fakeServer, pathOfDocumentId, uriOf, type FakeServer } from "../helpers/fake-lsp.js";

type Result = Awaited<ReturnType<typeof runTsFindCallers>>;
type Input = {
  sourceRoots: string[];
  file: string;
  symbol: string;
  timeBudgetMs: number;
};
type Row = Record<string, unknown>;

const PREPARE_METHOD = "textDocument/prepareCallHierarchy";
const INCOMING_METHOD = "callHierarchy/incomingCalls";

/** What the located package states for itself; the fake process says something else in `initialize`. */
const BINARY: TsgoBinary = {
  executable: "C:/fake/npm-global/typescript/node_modules/@typescript/typescript-win32-x64/lib/tsc.exe",
  version: "7.0.2",
  source: "global",
};
const SERVER_VERSION = "7.0.2";

/** The file that declares the subject. `handler` is an arrow-function `const`: callable, and not a method. */
const MAIN_TEXT = [
  "export interface Storage {",
  "  get(key: string): string;",
  "}",
  "export class Driver {",
  "  run(job: string): string {",
  "    const local = job.trim();",
  "    return local;",
  "  }",
  "  stop(): void {}",
  "}",
  "export const handler = () => {};",
  "export function build() {}",
];

/** A caller in another file of the workspace: the site is inside `caller`, the deepest addressable entry. */
const USES_TEXT = ["export function caller(): void {", "  driver.run(\"j\");", "}"];

/** A caller that is itself a class member, for the row spelling a C++-style deepest-qualified name gives. */
const PANEL_TEXT = ["export class Panel {", "  render(): string {", "    return driver.run(\"k\");", "  }", "}"];

type P = { line: number; character: number };

function at(lines: readonly string[], line: number, needle: string): P {
  const found = lines[line]?.indexOf(needle) ?? -1;
  if (found < 0) throw new Error(`"${needle}" is not on line ${line} of the fixture text`);
  return { line, character: found };
}

function sym(
  lines: readonly string[],
  name: string,
  kind: number,
  start: [number, string],
  end: [number, string],
  selection: [number, string],
  children?: LspDocumentSymbol[],
): LspDocumentSymbol {
  return {
    name,
    kind,
    range: { start: at(lines, start[0], start[1]), end: at(lines, end[0], end[1]) },
    selectionRange: { start: at(lines, selection[0], selection[1]) },
    ...(children === undefined ? {} : { children }),
  };
}

/** tsgo's kind numbers: 11 interface, 5 class, 6 method, 14 constant, 12 function, 13 variable. */
const MAIN_OUTLINE: LspDocumentSymbol[] = [
  sym(MAIN_TEXT, "Storage", 11, [0, "Storage"], [2, "}"], [0, "Storage"], [
    sym(MAIN_TEXT, "get", 6, [1, "get"], [1, ";"], [1, "get"]),
  ]),
  sym(MAIN_TEXT, "Driver", 5, [3, "Driver"], [9, "}"], [3, "Driver"], [
    sym(MAIN_TEXT, "run", 6, [4, "run"], [7, "}"], [4, "run"], [
      sym(MAIN_TEXT, "local", 13, [5, "local"], [5, ";"], [5, "local"]),
    ]),
    sym(MAIN_TEXT, "stop", 6, [8, "stop"], [8, "}"], [8, "stop"]),
  ]),
  sym(MAIN_TEXT, "handler", 14, [10, "handler"], [10, "}"], [10, "handler"]),
  sym(MAIN_TEXT, "build", 12, [11, "build"], [11, "}"], [11, "build"]),
];

const USES_OUTLINE: LspDocumentSymbol[] = [sym(USES_TEXT, "caller", 12, [0, "caller"], [2, "}"], [0, "caller"])];

const PANEL_OUTLINE: LspDocumentSymbol[] = [
  sym(PANEL_TEXT, "Panel", 5, [0, "Panel"], [4, "}"], [0, "Panel"], [
    sym(PANEL_TEXT, "render", 6, [1, "render"], [3, "}"], [1, "render"]),
  ]),
];

/** One `CallHierarchyItem` as tsgo spells it: a declaration the hierarchy can be asked about. */
function item(path: string, name: string, kind: number, line: number, character = 2): unknown {
  return {
    name,
    kind,
    uri: uriOf(path),
    range: { start: { line, character }, end: { line, character: character + name.length } },
    selectionRange: { start: { line, character }, end: { line, character: character + name.length } },
  };
}

/**
 * One `CallHierarchyIncomingCall`: the calling declaration and the ranges in it that hold the call. `decl` is
 * where that declaration's OWN name sits, because a row is read from the item's `selectionRange` and named from
 * the entry that encloses it — an item pointing at column 0 of a line whose declaration starts later is a location
 * no entry encloses, which is a fake that answers differently than tsgo does.
 */
function incoming(path: string, name: string, kind: number, decl: P, sites: readonly P[]): unknown {
  return {
    from: item(path, name, kind, decl.line, decl.character),
    fromRanges: sites.map((start) => ({ start, end: { line: start.line, character: start.character + 3 } })),
  };
}

/** Where each fixture caller's own declaration is addressed, read off its text like every other position. */
const CALLER_DECL = at(USES_TEXT, 0, "caller");
const RENDER_DECL = at(PANEL_TEXT, 1, "render");
const EXTERNAL_DECL = { line: 70, character: 1 };

interface Harness {
  readonly tmp: string;
  readonly ws: string;
  readonly main: string;
  readonly uses: string;
  readonly panel: string;
  readonly outside: string;
  readonly session: LspSession;
  readonly servers: FakeServer[];
  readonly server: FakeServer;
  outline(path: string, symbols: LspDocumentSymbol[]): void;
  /** What `prepareCallHierarchy` answers with — the callable gate's whole input. */
  prepared(answer: unknown): void;
  /** What `callHierarchy/incomingCalls` answers with. */
  incoming(answer: unknown): void;
  hangPrepare(): void;
  hangIncoming(): void;
  crashNextPrepare(): void;
  /** Another caller's freshness check reloads the session while the query is in flight, then proves its own anchors. */
  reloadBesideAnswer(): void;
  run(overrides?: Partial<Input>): Promise<Result>;
}

const built: { tmp: string; ws: string }[] = [];

/** A tsgo whose outlines, call hierarchy and project listings the test supplies, over a real temp workspace. */
function harness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-tscallers-"));
  const ws = resolve(join(tmp, "ws"));
  built.push({ tmp, ws });
  const src = join(ws, "packages", "ui", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
  writeFileSync(join(ws, "packages", "ui", "package.json"), JSON.stringify({ name: "@mono/ui" }));
  const config = join(ws, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: {} }));
  const main = join(src, "main.ts");
  writeFileSync(main, `${MAIN_TEXT.join("\n")}\n`);
  const uses = join(src, "uses.ts");
  writeFileSync(uses, `${USES_TEXT.join("\n")}\n`);
  const panel = join(src, "panel.ts");
  writeFileSync(panel, `${PANEL_TEXT.join("\n")}\n`);
  const outside = join(tmp, "outside", "io.ts");

  const outlines = new Map<string, LspDocumentSymbol[]>([
    [main, MAIN_OUTLINE],
    [uses, USES_OUTLINE],
    [panel, PANEL_OUTLINE],
  ]);
  const listing = new Map<string, readonly string[]>([[config, [main, uses, panel]]]);
  const exec: TsExecFn = async (_executable, args) => {
    const answer = listing.get(args[2] ?? "");
    return answer === undefined
      ? { stdout: "", stderr: "", exitCode: 0 }
      : { stdout: answer.join("\n"), stderr: "", exitCode: 0 };
  };

  let prepared: unknown = [];
  let incomingCalls: unknown = [];
  let hangingPrepare = false;
  let hangingIncoming = false;
  let crashing = false;
  let alive = true;
  /** Run beside the answer to a query, by the case that wants a second caller on the same session. */
  let beside: (() => Promise<unknown>) | undefined;
  const servers: FakeServer[] = [];
  const manager = new LspSessionManager({
    spawn: () => {
      const server = fakeServer({
        alive: () => alive,
        respond: (method, params) => {
          if (method === "initialize") return { serverInfo: { name: "tsgo", version: SERVER_VERSION } };
          if (method === "textDocument/documentSymbol") return outlines.get(pathOfDocumentId(params) ?? "") ?? [];
          if (method === PREPARE_METHOD) {
            if (hangingPrepare) return new Promise<unknown>(() => {});
            if (crashing) {
              crashing = false;
              alive = false;
              throw new Error("connection got disposed");
            }
            return prepared;
          }
          if (method === INCOMING_METHOD) {
            if (hangingIncoming) return new Promise<unknown>(() => {});
            if (beside !== undefined) return beside().then(() => incomingCalls);
            return incomingCalls;
          }
          throw new Error(`unexpected request: ${method}`);
        },
      });
      servers.push(server);
      alive = true;
      return server.process;
    },
    sleep: async () => {},
  });
  const deps: TsQueryDeps = { resolveBinary: async () => ({ binary: BINARY }), exec };
  const session = manager.get(ws, tsgoConfig(BINARY));
  return {
    tmp,
    ws,
    main,
    uses,
    panel,
    outside,
    session,
    servers,
    get server() {
      const last = servers[servers.length - 1];
      if (last === undefined) throw new Error("this run started no tsgo process");
      return last;
    },
    outline: (path, symbols) => outlines.set(path, symbols),
    prepared: (answer) => {
      prepared = answer;
    },
    incoming: (answer) => {
      incomingCalls = answer;
    },
    hangPrepare: () => {
      hangingPrepare = true;
    },
    hangIncoming: () => {
      hangingIncoming = true;
    },
    crashNextPrepare: () => {
      crashing = true;
    },
    reloadBesideAnswer: () => {
      beside = async () => {
        session.dispose();
        await session.openAnchors([uses]);
      };
    },
    run: (overrides = {}) =>
      runTsFindCallers(
        manager,
        { sourceRoots: [ws], file: main, symbol: "Driver.run", timeBudgetMs: 60_000, ...overrides },
        deps,
      ),
  };
}

function payload(result: Result): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

function scopeOf(result: Result): Record<string, unknown> {
  return payload(result).scope as Record<string, unknown>;
}

function limitsOf(result: Result): string[] {
  return scopeOf(result).limits as string[];
}

function rowsOf(result: Result): Row[] {
  return payload(result).callers as Row[];
}

function textOf(result: Result): string {
  return (result.content ?? [])[0]?.text ?? "";
}

function countOf(server: FakeServer, method: string): number {
  return server.methods.filter((name) => name === method).length;
}

function requestFor(server: FakeServer, method: string): Record<string, unknown> {
  return (server.requests.find(([name]) => name === method)?.[1] ?? {}) as Record<string, unknown>;
}

/** Every path a `didOpen` named, in order — which documents this server holds, and which it only borrowed. */
function openedPaths(server: FakeServer): (string | undefined)[] {
  return server.notifications.filter(([method]) => method === "textDocument/didOpen").map(([, p]) => pathOfDocumentId(p));
}

function closedPaths(server: FakeServer): (string | undefined)[] {
  return server.notifications.filter(([method]) => method === "textDocument/didClose").map(([, p]) => pathOfDocumentId(p));
}

/** The `scope` the temp workspace's one loaded project and an untouched disk produce, for a method subject. */
function cleanScope(h: Harness): Record<string, unknown> {
  return {
    workspaceRoot: h.ws,
    enclosingWorkspace: null,
    freshness: { kind: "unchanged" },
    server: { version: SERVER_VERSION },
    workspaceTypescript: null,
    projects: { count: 1, configs: [join(h.ws, "tsconfig.json")], failed: [], subsumed: [] },
    uncoveredSources: {
      count: 0,
      grepRequired: false,
      directories: [],
      directoriesTruncated: 0,
      mentioning: { name: expect.any(String), count: 0, files: [], filesTruncated: 0, unchecked: 0 },
      namedFileUncovered: false,
    },
    limits: ["one-workspace", "corresponding-interface-methods-included", "indirect-dispatch-not-resolved", "uncalled-mentions-included"],
  };
}

const SCOPE_SENTENCE =
  ` under workspace "{ws}": 1 project(s) found, 1 loaded, 0 failed, answered by tsgo 7.0.2,` +
  " freshness: unchanged";

describe("TsFindCallersInput", () => {
  it("needs a root to bound the call, defaults the budget to 60000 ms and takes no other parameter", () => {
    const parsed = TsFindCallersInput.parse({ sourceRoots: ["C:/ws"], file: "src/main.ts", symbol: "Driver.run" });
    expect(parsed.timeBudgetMs).toBe(60_000);
    expect(Object.keys(TsFindCallersInput.shape).sort()).toEqual(["file", "sourceRoots", "symbol", "timeBudgetMs"]);
    expect(TsFindCallersInput.safeParse({ sourceRoots: [], file: "a.ts", symbol: "f" }).success).toBe(false);
    expect(
      TsFindCallersInput.safeParse({ sourceRoots: ["C:/ws"], file: "a.ts", symbol: "f", timeBudgetMs: 600_001 })
        .success,
    ).toBe(false);
  });
});

/** One tool's registered `description`, read back through a stub server, the way cpp-tool-text reads clangd's. */
function descriptionOf(register: (server: McpServer) => void): string {
  const registerTool = vi.fn();
  register({ registerTool } as unknown as McpServer);
  const config = registerTool.mock.calls[0]?.[1] as { description?: string };
  return config.description ?? "";
}

describe("runTsFindCallers", () => {
  afterEach(() => {
    for (const root of built.splice(0)) {
      dropProjectMap(root.ws);
      rmSync(root.tmp, { recursive: true, force: true });
    }
  });

  // A call site in a file no project includes is never a row, and is pointed at.
  it("names an uncovered file that mentions the method, scanning for its last segment, and lists no row for it", async () => {
    const h = harness();
    const orphan = join(dirname(h.main), "orphan.test.ts");
    writeFileSync(orphan, "const d = new Driver();\nd.run();\n// run again\n");
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([]);

    const out = await h.run();
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(payload(out).callers).toEqual([]);
    expect((scopeOf(out) as { uncoveredSources: unknown }).uncoveredSources).toEqual({
      count: 1,
      grepRequired: true,
      directories: [{ directory: "packages/ui/src", count: 1 }],
      directoriesTruncated: 0,
      mentioning: { name: "run", count: 1, files: [{ file: orphan, matchingLines: 2 }], filesTruncated: 0, unchecked: 0 },
      namedFileUncovered: false,
    });
    const lines = textOf(out).split("\n");
    expect(lines[0]).not.toContain("not searched");
    expect(lines[1]).toBe(
      `INCOMPLETE: 1 file(s) no tsconfig project includes were not searched (packages/ui/src 1). 1 of them contain "run" and may hold more results - grep "run" in: ${orphan} (2 matching lines). Do not report this answer as complete until you have.`,
    );
    expect(lines[2]).toMatch(/^limits: /);
    // The same two lines are structuredContent's first key, with no limits line and no rows.
    const structured = (out as { structuredContent?: object }).structuredContent;
    expect(JSON.stringify(structured).startsWith('{"summary":"')).toBe(true);
    expect(payload(out).summary).toBe(lines.slice(0, 2).join("\n"));
    expect(scopeOf(out).uncoveredSources).toMatchObject({ grepRequired: true });
  });

  it("asks the hierarchy at the addressed identifier and lists one row per calling declaration", async () => {
    const h = harness();
    const offered = item(h.main, "run", 6, 4, 2);
    h.prepared([offered]);
    h.incoming([
      incoming(h.uses, "caller", 12, CALLER_DECL, [at(USES_TEXT, 1, "driver.run")]),
      incoming(h.panel, "render", 6, RENDER_DECL, [at(PANEL_TEXT, 2, "driver.run")]),
    ]);

    const out = await h.run();
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(payload(out)).toEqual({
      summary: expect.any(String),
      resolved: { name: "Driver.run", kind: "method", file: h.main, line: 5 },
      totalCallers: 2,
      callers: [
        {
          name: "caller",
          kind: "function",
          file: h.uses,
          line: 1,
          external: false,
          callSites: [{ line: 2, column: at(USES_TEXT, 1, "driver.run").character + 1 }],
          callSitesTruncated: 0,
        },
        {
          name: "Panel.render",
          kind: "method",
          file: h.panel,
          line: 2,
          external: false,
          callSites: [{ line: 3, column: at(PANEL_TEXT, 2, "driver.run").character + 1 }],
          callSitesTruncated: 0,
        },
      ],
      callersTruncated: 0,
      scope: cleanScope(h),
    });
    expect(requestFor(h.server, PREPARE_METHOD)).toEqual({
      textDocument: { uri: uriOf(h.main) },
      position: at(MAIN_TEXT, 4, "run"),
    });
    expect(requestFor(h.server, INCOMING_METHOD)).toEqual({ item: offered });
    expect(textOf(out)).toBe(
      `Callers of method "Driver.run" (${h.main}:5)${SCOPE_SENTENCE.replaceAll("{ws}", h.ws)} - 2 caller(s) ` +
        "listed from 2 found.\n" +
        "limits: one-workspace, corresponding-interface-methods-included, indirect-dispatch-not-resolved, uncalled-mentions-included\n" +
        `  caller (function) ${h.uses}:1\n` +
        `    called at 2:${at(USES_TEXT, 1, "driver.run").character + 1}\n` +
        `  Panel.render (method) ${h.panel}:2\n` +
        `    called at 3:${at(PANEL_TEXT, 2, "driver.run").character + 1}`,
    );
  });

  it("publishes the Go keys in order, `reason` only on an unnamed row, and no `direction` anywhere", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([incoming(h.outside, "external", 12, EXTERNAL_DECL, [at(USES_TEXT, 1, "driver.run")])]);

    const out = await h.run();
    expect(Object.keys(payload(out))).toEqual(["summary", "resolved", "totalCallers", "callers", "callersTruncated", "scope"]);
    expect(Object.keys(payload(out).resolved as object)).toEqual(["name", "kind", "file", "line"]);
    expect(Object.keys(rowsOf(out)[0] ?? {})).toEqual([
      "name",
      "kind",
      "file",
      "line",
      "external",
      "reason",
      "callSites",
      "callSitesTruncated",
    ]);
    expect(Object.keys((rowsOf(out)[0]?.callSites as object[])[0] ?? {})).toEqual(["line", "column"]);
    expect(Object.keys(scopeOf(out))).toEqual([
      "workspaceRoot",
      "enclosingWorkspace",
      "freshness",
      "server",
      "workspaceTypescript",
      "projects",
      "uncoveredSources",
      "limits",
    ]);
    expect(JSON.stringify(payload(out))).not.toContain("direction");
  });

  it("merges one declaration reported twice into one row carrying every call site", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([
      incoming(h.uses, "caller", 12, CALLER_DECL, [at(USES_TEXT, 1, "driver.run")]),
      incoming(h.uses, "caller", 12, CALLER_DECL, [{ line: 1, character: 12 }]),
    ]);

    const out = await h.run();
    // One row per CALLING DECLARATION, and `totalCallers` counts those rows: the same declaration reported
    // twice with different ranges is one caller carrying two sites, which is what "who calls this" asks.
    expect(payload(out).totalCallers).toBe(1);
    expect(rowsOf(out)).toEqual([
      {
        name: "caller",
        kind: "function",
        file: h.uses,
        line: 1,
        external: false,
        callSites: [
          { line: 2, column: at(USES_TEXT, 1, "driver.run").character + 1 },
          { line: 2, column: 13 },
        ],
        callSitesTruncated: 0,
      },
    ]);
  });

  it("keeps a call site the server gave no character for, with its column left null", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([
      {
        from: item(h.uses, "caller", 12, CALLER_DECL.line, CALLER_DECL.character),
        fromRanges: [{ start: { line: 1 }, end: { line: 1 } }],
      },
    ]);

    const out = await h.run();
    expect(rowsOf(out)[0]?.callSites).toEqual([{ line: 2, column: null }]);
  });

  it("asks the hierarchy for an arrow-function const, because tsgo's kind cannot tell it from data", async () => {
    const h = harness();
    h.prepared([item(h.main, "handler", 14, 10, 13)]);
    h.incoming([incoming(h.uses, "caller", 12, CALLER_DECL, [at(USES_TEXT, 1, "driver.run")])]);

    const out = await h.run({ symbol: "handler" });
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(h.server.methods).toContain(PREPARE_METHOD);
    expect(payload(out).resolved).toMatchObject({ name: "handler", kind: "constant" });
    // a member mentioned as `x.m` is a caller at that site on EVERY answer of this
    // tool, so the code sits beside the indirect-dispatch one it complements — the extraction present, the
    // later call through it absent.
    expect(limitsOf(out)).toEqual([
      "one-workspace",
      "indirect-dispatch-not-resolved",
      "uncalled-mentions-included",
    ]);
  });

  it("keeps JSX use as a call, reporting whatever site tsgo credits to the calling declaration", async () => {
    const h = harness();
    h.prepared([item(h.main, "build", 12, 11, 16)]);
    h.incoming([incoming(h.uses, "caller", 12, CALLER_DECL, [{ line: 1, character: 4 }])]);

    const out = await h.run({ symbol: "build" });
    expect(rowsOf(out)).toHaveLength(1);
    expect(payload(out).totalCallers).toBe(1);
  });

  it.each([
    ["an empty list", []],
    ["a null answer", null],
  ])("refuses a declaration tsgo holds no call hierarchy for (%s), and will not substitute references", async (_label: string, answer: unknown) => {
    const h = harness();
    h.prepared(answer);
    h.incoming([incoming(h.uses, "caller", 12, CALLER_DECL, [at(USES_TEXT, 1, "driver.run")])]);

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_callers failed: tsgo offers no call hierarchy for "Driver.run" in "${h.main}", so it is not ` +
        "callable - a variable, a constant that is not a function, a type or a plain object member never has " +
        "callers. This server will not answer the question with a references list instead: a mention is not a " +
        "call. Name the function, method or callable `const` and call again.",
    );
    expect(h.server.methods).not.toContain(INCOMING_METHOD);
  });

  it("lists every item tsgo offers for one position and never picks one", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2), item(h.uses, "caller", 12, 0, 16)]);

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      "ts_find_callers failed: tsgo offered 2 call-hierarchy items for \"Driver.run\", and picking one would " +
        "be a guess, so they are listed:\n" +
        `  - run (method) at ${h.main}:5\n` +
        `  - caller (function) at ${h.uses}:1`,
    );
    expect(h.server.methods).not.toContain(INCOMING_METHOD);
  });

  it("refuses a call-hierarchy answer it cannot read rather than reporting fewer callers", async () => {
    const h = harness();
    h.prepared({ item: 1 });

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("answered the caller query for \"Driver.run\"");
    expect(textOf(out)).toContain("It expects `CallHierarchyItem` and `IncomingCall` entries: {\"item\":1}");
    expect(h.server.methods).not.toContain(INCOMING_METHOD);
  });

  it("fails loudly on an incoming call it cannot read, naming the entry", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([{ from: { nonsense: true }, fromRanges: [] }]);

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("with entry 1 this server cannot read");
    expect(textOf(out)).toContain("possibly dropping a caller");
    expect(textOf(out)).toContain('"Driver.run"');
  });

  it("reports a caller outside the workspace, says why it has no name, and never opens its file", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([
      incoming(h.outside, "external", 12, EXTERNAL_DECL, [at(USES_TEXT, 1, "driver.run")]),
      incoming(h.uses, "caller", 12, CALLER_DECL, [at(USES_TEXT, 1, "driver.run")]),
    ]);

    const out = await h.run();
    expect(rowsOf(out)).toEqual([
      {
        name: "caller",
        kind: "function",
        file: h.uses,
        line: 1,
        external: false,
        callSites: [{ line: 2, column: at(USES_TEXT, 1, "driver.run").character + 1 }],
        callSitesTruncated: 0,
      },
      {
        name: null,
        kind: null,
        file: h.outside,
        line: 71,
        external: true,
        reason: "outside the workspace root; not named",
        callSites: [{ line: 2, column: at(USES_TEXT, 1, "driver.run").character + 1 }],
        callSitesTruncated: 0,
      },
    ]);
    expect(textOf(out)).toContain(`${h.outside}:71 outside the workspace`);
    // An external file is never opened, not even transiently. The kept in-workspace row's file is,
    // borrow-and-return: opened, outlined, closed again — and the named file stays held because it is the
    // answer's own proof document.
    expect(openedPaths(h.server)).toEqual([h.main, h.uses]);
    expect(closedPaths(h.server)).toEqual([h.uses]);
    expect(h.session.getOpenedFiles()).toEqual([h.main]);
  });

  it("names a caller whose item range starts at a leading comment by its identifier", async () => {
    // tsgo's call-hierarchy `range` starts at the declaration's JSDoc, above where `documentSymbol`'s range
    // starts, so only the item's `selectionRange` lands inside the outline entry.
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([
      {
        from: {
          ...(item(h.panel, "render", 6, 1, 2) as Record<string, unknown>),
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 3 } },
        },
        fromRanges: [{ start: at(PANEL_TEXT, 2, "driver.run"), end: { line: 2, character: 14 } }],
      },
    ]);

    const out = await h.run();
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(rowsOf(out)[0]).toMatchObject({ name: "Panel.render", kind: "method", line: 2 });
  });

  it("keeps a source-file item at module scope when the file's first declaration starts at 0:0", async () => {
    // USES_TEXT opens with `caller` at line 0, column 0 - the position tsgo gives the source-file item (kind
    // Module, empty selection). Outline containment alone would credit the site to `caller`.
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([
      {
        from: {
          name: h.uses,
          kind: 2,
          uri: uriOf(h.uses),
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
        fromRanges: [{ start: at(USES_TEXT, 1, "driver.run"), end: { line: 1, character: 12 } }],
      },
    ]);

    const out = await h.run();
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(rowsOf(out)[0]).toMatchObject({
      name: null,
      kind: null,
      reason: "at module scope; no declaration encloses this site",
    });
  });

  it("names a caller credited to the source file as module scope, not as a naming failure", async () => {
    // TypeScript credits a site with no enclosing callable to the SOURCE FILE, so
    // this row is not a declaration this server failed to name — it is a module-scope mention, and the reason
    // says which. The generic text belongs to the listings that really do fail to name a row.
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([
      {
        from: item(h.uses, "uses.ts", 13, 9, 12),
        fromRanges: [{ start: { line: 9, character: 2 }, end: { line: 9, character: 8 } }],
      },
    ]);

    const out = await h.run();
    const [row] = rowsOf(out);
    expect(row).toMatchObject({ name: null, kind: null, external: false });
    expect(row?.reason).toBe("at module scope; no declaration encloses this site");
    expect(textOf(out)).toContain("<unnamed>");
  });

  it("counts every caller tsgo reported when the row cap drops whole rows, external ones first", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    const external = Array.from({ length: CALLERS_LIMIT + 2 }, (_unused, index) =>
      incoming(join(h.tmp, "outside", `f${index}.ts`), `caller${index}`, 12, { line: 3, character: 1 }, [
        { line: 3, character: 1 },
      ]),
    );
    h.incoming([...external, incoming(h.uses, "caller", 12, CALLER_DECL, [at(USES_TEXT, 1, "driver.run")])]);

    const out = await h.run();
    const rows = rowsOf(out);
    expect(payload(out).totalCallers).toBe(external.length + 1);
    expect(rows).toHaveLength(CALLERS_LIMIT);
    expect(payload(out).callersTruncated).toBe(3);
    expect(rows[0]).toMatchObject({ name: "caller", file: h.uses, external: false });
    expect(rows.slice(1).every((row) => row.external)).toBe(true);
    expect(limitsOf(out)).toContain("listing-capped");
    expect(textOf(out)).toContain(`${CALLERS_LIMIT}-caller cap`);
    // Naming ran after the caps: one transient read, for the one kept in-workspace row's file.
    expect(countOf(h.server, "textDocument/documentSymbol")).toBe(2);
    expect(h.session.getOpenedFiles()).toEqual([h.main]);
  });

  it("counts every call site tsgo reported when the per-caller site cap narrows a row", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    const sites = Array.from({ length: REFERENCE_SITES_PER_FILE_LIMIT + 3 }, (_unused, index) => ({
      line: 1,
      character: index + 1,
    }));
    h.incoming([incoming(h.uses, "caller", 12, CALLER_DECL, sites)]);

    const out = await h.run();
    expect(payload(out).totalCallers).toBe(1);
    expect(payload(out).callersTruncated).toBe(0);
    expect(rowsOf(out)[0]).toMatchObject({ callSitesTruncated: 3 });
    expect(rowsOf(out)[0]?.callSites).toHaveLength(REFERENCE_SITES_PER_FILE_LIMIT);
    expect(limitsOf(out)).toContain("listing-capped");
    expect(textOf(out)).toContain("3 call site(s) not listed");
  });

  it.each([["an empty hierarchy", []], ["a null answer", null]])(
    "answers a callable nobody calls with %s as a scoped empty, because the anchors were proved",
    async (_label: string, answer: unknown) => {
      const h = harness();
      h.prepared([item(h.main, "run", 6, 4, 2)]);
      h.incoming(answer);

      const out = await h.run();
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(payload(out)).toMatchObject({ totalCallers: 0, callers: [], callersTruncated: 0 });
      expect(limitsOf(out)).toEqual([
        "one-workspace",
        "corresponding-interface-methods-included",
        "indirect-dispatch-not-resolved",
        "uncalled-mentions-included",
      ]);
      expect(textOf(out)).toBe(
        `Callers of method "Driver.run" (${h.main}:5)${SCOPE_SENTENCE.replaceAll("{ws}", h.ws)} - 0 caller(s) ` +
          "listed from 0 found.\n" +
          "limits: one-workspace, corresponding-interface-methods-included, indirect-dispatch-not-resolved, uncalled-mentions-included",
      );
      expect(textOf(out)).not.toMatch(/did not answer|could not prove/);
    },
  );

  it("carries no interface-method code for a function subject, and the code for a method one", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([]);
    const method = await h.run();
    expect(limitsOf(method)).toContain("corresponding-interface-methods-included");

    h.prepared([item(h.main, "build", 12, 11, 16)]);
    h.incoming([]);
    const fn = await h.run({ symbol: "build" });
    expect(limitsOf(fn)).not.toContain("corresponding-interface-methods-included");
    expect(limitsOf(fn)).toContain("indirect-dispatch-not-resolved");
  });

  it("refuses a name the declaring file does not carry before asking anything type-aware", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);

    const out = await h.run({ symbol: "Absent" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("declares nothing named \"Absent\"");
    expect(h.server.methods).toEqual(["initialize", "textDocument/documentSymbol"]);
  });

  it("refuses an answer from a tsgo that was replaced while the hierarchy was being prepared", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([incoming(h.uses, "caller", 12, CALLER_DECL, [at(USES_TEXT, 1, "driver.run")])]);
    h.crashNextPrepare();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("ts_find_callers failed: tsgo restarted during the query about \"Driver.run\"");
    expect(h.servers).toHaveLength(2);
    expect(countOf(h.server, PREPARE_METHOD)).toBe(1);
  });

  it("refuses an answer from a process another call reloaded and proved while this one was in flight", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([incoming(h.uses, "caller", 12, CALLER_DECL, [at(USES_TEXT, 1, "driver.run")])]);
    h.reloadBesideAnswer();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("tsgo restarted during the query");
    expect(h.session.isWorkspaceLoaded()).toBe(true);
    expect(h.servers).toHaveLength(2);
  });

  it("fails at the budget when the preparation never answers, and says which step", async () => {
    const h = harness();
    h.hangPrepare();

    const out = await h.run({ timeBudgetMs: 100 });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_callers failed: tsgo did not prepare the call hierarchy for "Driver.run" within this call's ` +
        `100 ms budget. The workspace at "${h.ws}" may still be loading its projects; raise timeBudgetMs or ` +
        "call again, and do not read this as an empty answer.",
    );
    expect(out).not.toHaveProperty("structuredContent");
    expect(countOf(h.server, PREPARE_METHOD)).toBe(1);
  });

  it("fails at the budget when the incoming calls never arrive, naming that step", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.hangIncoming();

    const out = await h.run({ timeBudgetMs: 100 });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('did not return the incoming calls of "Driver.run"');
    expect(textOf(out)).toContain("100 ms budget");
  });

  it("asks tsgo only the methods its config allows, in the order the proof needs", async () => {
    const h = harness();
    h.prepared([item(h.main, "run", 6, 4, 2)]);
    h.incoming([incoming(h.uses, "caller", 12, CALLER_DECL, [at(USES_TEXT, 1, "driver.run")])]);

    await h.run();
    expect(h.server.methods).toEqual([
      "initialize",
      "textDocument/documentSymbol",
      PREPARE_METHOD,
      INCOMING_METHOD,
      "textDocument/documentSymbol",
    ]);
    expect(h.server.requests[0]?.[1]).toMatchObject({ rootUri: uriOf(h.ws) });
  });
});
