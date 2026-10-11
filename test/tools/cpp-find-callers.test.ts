import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeServer, pathOfDocumentId, type FakeServer } from "../helpers/fake-lsp.js";
import { sessionsFor, symAt } from "../helpers/fake-clangd.js";
import { runCppFindCallers, type CppFindCallersPayload } from "../../src/tools/cpp-find-callers.js";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { clangdConfig } from "../../src/lsp/server-config.js";
import { NAVIGATION_CEILING_MS } from "../../src/tools/navigation-limits.js";
import { fileUri } from "../../src/lsp/document-uri.js";
import type { LspSessionManager } from "../../src/lsp/session-manager.js";

/**
 * Mocked suite for the C++ caller question: that its rows are named by a
 * transient-outline fan-out, that its counts stay exact while its two caps bite, that a caller outside the
 * declared roots is reported and never read, and — the rule this tool exists to honour — that
 * `prepareCallHierarchy` and `callHierarchy/incomingCalls` are ONE index window, while the naming that
 * follows it is not. clangd is faked at the connection; the drift walk is real, over a temp tree.
 *
 * One session per test: the drift baseline and the index-state latch are session state, so a case that
 * compares two calls has to make both against the same one.
 */

interface Result {
  readonly isError?: boolean;
  readonly content: readonly { readonly text?: string }[];
  readonly structuredContent?: unknown;
}

interface Scope {
  projectRoot: string;
  index: { state: string; staleFiles?: { count: number }; driftUnknown?: string };
  uncoveredSources?: { count: number; files: readonly string[] };
  limits: string[];
  freshness?: unknown;
}

type Action = () => void | Promise<void>;

const textOf = (result: Result): string => result.content[0]?.text ?? "";

const range = (startLine: number, endLine: number) => ({
  start: { line: startLine, character: 0 },
  end: { line: endLine, character: 40 },
});

/** A callable as a call hierarchy states it: its own declaration range, and where its name is. */
const hierarchyItem = (name: string, kind: number, file: string, startLine: number, nameLine: number) => ({
  name,
  kind,
  uri: fileUri(file),
  range: range(startLine, startLine + 4),
  selectionRange: range(nameLine, nameLine),
});

const callSite = (line: number, character: number) => ({
  start: { line, character },
  end: { line, character: character + 6 },
});

/** A caller declaration with the sites it made, in the shape `callHierarchy/incomingCalls` answers with. */
const incoming = (name: string, file: string, startLine: number, sites: readonly number[]) => ({
  from: hierarchyItem(name, 12, file, startLine, startLine),
  fromRanges: sites.map((line) => callSite(line, 2)),
});

describe("cpp_find_callers against a faked clangd", () => {
  let tmp: string;
  let buildDir: string;
  let sourceDir: string;
  let outsideDir: string;
  let widget: string;
  let helper: string;
  let elsewhere: string;
  let prepared: unknown;
  let callers: unknown;
  let indexRows: unknown;
  let onIndex: Action[];
  let onPrepare: Action[];
  let onCalls: Action[];
  let onOutline: ((file: string) => void | Promise<void>)[];
  let server: FakeServer;
  let sessions: LspSessionManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-cpp-callers-"));
    buildDir = join(tmp, "build");
    sourceDir = join(tmp, "src");
    outsideDir = join(tmp, "outside");
    mkdirSync(buildDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    widget = join(sourceDir, "widget.cpp");
    helper = join(sourceDir, "helper.cpp");
    elsewhere = join(outsideDir, "elsewhere.cpp");
    writeFileSync(widget, "class Widget {\npublic:\n  int value();\n};\n\nint Widget::value() {\n  return helper()\n    + helper()\n    + helper();\n}\n");
    writeFileSync(helper, "int helper() {\n  return 1;\n}\n");
    writeFileSync(elsewhere, "int elsewhere() { return helper(); }\n");
    writeFileSync(
      join(buildDir, "compile_commands.json"),
      JSON.stringify([
        { directory: sourceDir, command: `clang++ -c "${helper}"`, file: helper },
        { directory: sourceDir, command: `clang++ -c "${widget}"`, file: widget },
      ]),
    );
    // `helper` is declared on 0-based line 2 with its name starting at character 4: the position the call
    // hierarchy is prepared at, since a query must resolve rather than be refused as a member.
    prepared = [hierarchyItem("helper", 12, helper, 2, 2)];
    // `Widget::value` is a member inside a class, so a row about it can only come from the deepest
    // enclosing declaration of the caller item's own position.
    callers = [incoming("value", widget, 5, [6, 7, 8])];
    onPrepare = [];
    onCalls = [];
    onOutline = [];
    // One row as clangd's project-wide search spells a free function: the identifier's own span, and the
    // declaration's scope in `containerName` — empty here, because `helper` sits at global scope.
    indexRows = [
      {
        name: "helper",
        kind: 12,
        location: { uri: fileUri(helper), range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } },
      },
    ];
    onIndex = [];
    start();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A clangd whose call hierarchy is answered from the two values above, with hooks that run while each of
   * the two requests is being answered — which is how a progress token is begun between them, so the one
   * window this tool must hold is tested and not merely asserted.
   */
  function clangd(): FakeServer {
    return fakeServer({
      // The call hierarchy is answered from the AST of a held document too, so a `prepareCallHierarchy`
      // about a file this client never added is refused exactly as clangd refuses it.
      refusesUnaddedDocuments: true,
      respond: async (method, params) => {
        if (method === "initialize") return {};
        const file = pathOfDocumentId(params);
        if (method === "textDocument/documentSymbol") {
          for (const act of onOutline) await act(file);
          if (file === helper) {
            return [{ ...symAt("helper", 12, 2, 4), range: range(2, 2) }];
          }
          return [
            {
              ...symAt("Widget", 5, 2, 6),
              range: range(2, 9),
              children: [{ ...symAt("value", 12, 5, 12), range: range(5, 9) }],
            },
          ];
        }
        if (method === "workspace/symbol") {
          for (const act of onIndex) await act();
          return indexRows;
        }
        if (method === "textDocument/prepareCallHierarchy") {
          for (const act of onPrepare) await act();
          return prepared;
        }
        if (method === "callHierarchy/incomingCalls") {
          for (const act of onCalls) await act();
          return callers;
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });
  }

  function start(): void {
    server = clangd();
    sessions = sessionsFor(server.process);
  }

  /** The same question every case asks, spelled once. */
  const asked = (name = "helper", file = helper, roots: readonly string[] = [sourceDir]) => ({
    projectRoot: buildDir,
    name,
    file,
    sourceRoots: roots,
  });

  const run = (): Promise<Result> => runCppFindCallers(sessions, asked() as never);

  const payload = (result: Result): CppFindCallersPayload => {
    expect(result.isError, textOf(result)).toBeFalsy();
    return result.structuredContent as CppFindCallersPayload;
  };

  const scope = (result: Result): Scope => payload(result).scope as unknown as Scope;

  /**
   * One ordinary call first: the session only registers its server-to-client handlers when it spawns, so a
   * case that means to drive progress has to make the child exist. The default answer is non-empty, so a
   * warm-up never trips the empty-answer rule the caller is about to test.
   */
  async function warm(): Promise<void> {
    await run();
  }

  /** A whole index round, announced and settled, before the measured request is issued. */
  async function settledRound(): Promise<void> {
    await warm();
    await server.createProgress("idx");
    server.sendProgress("idx", { kind: "begin" });
    server.sendProgress("idx", { kind: "end" });
  }

  /** A round left running: announced before the measured request and never ended. */
  async function beginRound(): Promise<void> {
    await warm();
    await server.createProgress("idx");
    server.sendProgress("idx", { kind: "begin" });
  }

  it("counts the call sites exactly and names the caller by its deepest declaration", async () => {
    const found = payload(await run());

    expect(found.resolved).toEqual({ name: "helper", kind: "function", file: helper, line: 3 });
    expect(found.totalCallers).toBe(1);
    expect(found.callersTruncated).toBe(0);
    const only = found.callers[0];
    // `Widget::value` is qualified the way `cpp_find_symbol` publishes a member, so a row can be handed
    // straight back as this tool's own `name` input.
    expect(only).toMatchObject({
      name: "Widget::value",
      kind: "function",
      file: widget,
      line: 6,
      external: false,
      callSitesTruncated: 0,
    });
    expect(only.callSites).toEqual([
      { line: 7, column: 3 },
      { line: 8, column: 3 },
      { line: 9, column: 3 },
    ]);
  });

  it("names every row however long this process has already been running", async () => {
    // The naming budget belongs to one call. Taken once when the module was imported, it is exhausted for
    // every call made after the ceiling of process uptime, and rows outside the queried file would come back
    // unnamed with a reason about a budget this call never had.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + NAVIGATION_CEILING_MS + 1);

      const found = payload(await run());

      expect(found.callers[0]).toMatchObject({ file: widget, name: "Widget::value", kind: "function" });
      expect(found.callers[0]?.reason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges the sites one declaration made and keeps a second declaration as its own row", async () => {
    callers = [
      incoming("value", widget, 5, [6, 7]),
      incoming("value", widget, 5, [8]),
      incoming("other", widget, 2, [3]),
    ];

    const found = payload(await run());

    // The second entry repeats the first declaration, so it adds a site; the third is a different
    // declaration in the same file — and, at line 3, one that sits in the class and not in its member.
    expect(found.totalCallers).toBe(2);
    expect(found.callers.map((row) => `${row.name}:${row.line}`)).toEqual(["Widget::value:6", "Widget:3"]);
    expect(found.callers[1]?.callSites).toEqual([{ line: 4, column: 3 }]);
  });

  it("answers a caller-less function from a settled index as a scoped empty", async () => {
    await settledRound();
    callers = [];

    const found = payload(await run());

    expect(found.totalCallers).toBe(0);
    expect(found.callers).toEqual([]);
    // `indirect-dispatch-not-resolved` belongs to every caller answer, including the empty one: clangd
    // records no edge for a call that reaches the subject through a base declaration or a function value.
    expect(found.scope.limits).toEqual(["compile-database-only", "indirect-dispatch-not-resolved"]);
    expect(found.scope.index).toEqual({ state: "quiescent", staleFiles: { count: 0, files: [] } });
  });

  it("refuses to answer what cannot be called", async () => {
    prepared = [hierarchyItem("Widget", 5, widget, 2, 2)];

    const failed = await runCppFindCallers(sessions, asked("Widget", widget) as never);

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('"Widget" is a class declared at');
    expect(textOf(failed)).toContain("a class is not called, so no one calls it");
    expect(textOf(failed)).toContain("Ask `cpp_find_references` for where it is used instead");
    // The refusal comes before the hierarchy: a class has no callers to ask about, so clangd is not asked.
    expect(server.requests.some(([method]) => method === "textDocument/prepareCallHierarchy")).toBe(false);
  });

  it("refuses a call hierarchy that prepared nothing rather than answering nobody calls it", async () => {
    prepared = [];

    const failed = await run();

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('clangd prepared no call-hierarchy item for "helper"');
    expect(textOf(failed)).toContain("The declaration was found; the caller relation was not");
  });

  it("lists several prepared callables instead of picking one", async () => {
    prepared = [
      hierarchyItem("helper", 12, helper, 2, 2),
      hierarchyItem("helper", 12, helper, 9, 9),
    ];

    const failed = await run();

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("clangd offered 2 call-hierarchy items for \"helper\"");
    expect(textOf(failed)).toContain("  - helper (function) at ");
    expect(textOf(failed)).toMatch(/helper \(function\) at .*:10$/m);
    expect(server.requests.some(([method]) => method === "callHierarchy/incomingCalls")).toBe(false);
  });

  it("refuses an entry it cannot read as a caller rather than dropping part of the listing", async () => {
    callers = [{ from: null, fromRanges: [] }];

    const failed = await run();

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('clangd answered the caller query for "helper" with entry 1');
    expect(textOf(failed)).toContain("possibly dropping a caller");
    expect(textOf(failed)).toContain("It expects `CallHierarchyItem` and `IncomingCall` entries");
  });

  it("refuses a hierarchy it cannot read either, rather than guessing at the shape", async () => {
    prepared = { name: "helper" };

    const failed = await run();

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain(
      'clangd answered the caller query for "helper" with an object this server cannot read',
    );
    expect(textOf(failed)).toContain("possibly dropping a caller");
    expect(textOf(failed)).toContain("It expects `CallHierarchyItem` and `IncomingCall` entries");
  });

  it("holds one index window over both the prepare and the incoming-calls request", async () => {
    await warm();
    await server.createProgress("round");
    // The round opens between the two requests. A state sampled after the first one would read idle, which
    // is the reading this rule exists to prevent.
    onPrepare.push(() => server.sendProgress("round", { kind: "begin" }));

    const busy = scope(await run());

    expect(busy.index.state).toBe("building");
    expect(busy.limits).toContain("index-still-building");
  });

  it("names the listing through a window that has already closed", async () => {
    await settledRound();
    let opened = false;
    onOutline.push(async (file) => {
      if (file !== widget || opened) return;
      opened = true;
      await server.createProgress("late");
      server.sendProgress("late", { kind: "begin" });
    });

    const found = scope(await run());

    // A round that opens while the rows are being named is not this answer's index state: the window covers
    // the two hierarchy requests and closes before the fan-out that names them.
    expect(found.index.state).toBe("quiescent");
    expect(found.limits).not.toContain("index-still-building");
    const journal = server.journal;
    expect(journal.indexOf("req:textDocument/documentSymbol")).toBeLessThan(
      journal.indexOf("req:textDocument/prepareCallHierarchy"),
    );
    expect(journal.lastIndexOf("req:textDocument/documentSymbol")).toBeGreaterThan(
      journal.indexOf("req:callHierarchy/incomingCalls"),
    );
  });

  it("refuses an empty answer while the index it came from was at work", async () => {
    await beginRound();
    callers = [];

    const building = await run();

    expect(building.isError).toBe(true);
    expect(textOf(building)).toMatch(/was indexing while this call ran/);
  });

  it("refuses an empty answer from an index it has never seen report anything", async () => {
    callers = [];

    const unknown = await run();

    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/never reported indexing progress to this session/);
  });

  it("keeps every count exact while both caps bite, and says so", async () => {
    const extras = Array.from({ length: 45 }, (_, index) =>
      incoming(`caller${index}`, join(outsideDir, `c${index}.cpp`), 1, [1]),
    );
    callers = [incoming("value", widget, 5, Array.from({ length: 25 }, (_, index) => index + 10)), ...extras];

    const found = payload(await run());
    const first = found.callers[0];

    expect(found.totalCallers).toBe(46);
    expect(found.callers).toHaveLength(40);
    expect(found.callersTruncated).toBe(6);
    expect(first?.callSites).toHaveLength(20);
    expect(first?.callSitesTruncated).toBe(5);
    // In-boundary rows lead, so what the row cap dropped is entirely outside the declared roots.
    expect(found.callers.filter((row) => row.external)).toHaveLength(39);
    expect(first?.external).toBe(false);
    expect(found.scope.limits).toContain("listing-capped");
  });

  it("reports a caller outside every declared source root without ever reading it", async () => {
    callers = [incoming("elsewhere", elsewhere, 0, [0])];

    const found = payload(await run());
    const external = found.callers[0];

    expect(external).toMatchObject({
      name: null,
      kind: null,
      file: elsewhere,
      line: 1,
      external: true,
      reason: "outside every declared source root; not named",
    });
    const outlined = server.requests
      .filter(([method]) => method === "textDocument/documentSymbol")
      .map(([, params]) => pathOfDocumentId(params));
    expect(outlined).not.toContain(elsewhere);
  });

  it("states the scope exactly, with no freshness key", async () => {
    const built = scope(await run());

    expect(Object.keys(built).sort()).toEqual(["index", "limits", "projectRoot", "sourceRoots", "uncoveredSources"]);
    expect(built.projectRoot).toBe(buildDir);
    expect(built.freshness).toBeUndefined();
    // A first call over these roots cannot say what moved, and its index state is unobserved: both codes,
    // and the dispatch limit that belongs to every caller answer.
    expect(built.limits).toEqual([
      "compile-database-only",
      "index-state-unknown",
      "index-drift-unknown",
      "indirect-dispatch-not-resolved",
    ]);
  });

  it("asks the hierarchy about the declaration it resolved, at the position of its own name", async () => {
    await run();

    const request = server.requests.find(([method]) => method === "textDocument/prepareCallHierarchy");

    expect(request?.[1]).toMatchObject({
      textDocument: { uri: fileUri(helper) },
      position: { line: 2, character: 4 },
    });
  });

  it("resolves a callable named without a `file` through clangd's index", async () => {
    const built = await runCppFindCallers(sessions, {
      projectRoot: buildDir,
      name: "helper",
      sourceRoots: [sourceDir],
    } as never);

    const found = payload(built);

    expect(found.resolved).toEqual({ name: "helper", kind: "function", file: helper, line: 3 });
    expect(found.totalCallers).toBe(1);
    expect(found.callers[0]).toMatchObject({ name: "Widget::value", file: widget });
    // Three requests, one answer: the symbol search that found the subject, then the hierarchy it was asked
    // of. The journal is the proof the window covers all of it, because the state beside the answer is
    // latched across exactly that span.
    const journal = server.journal;
    expect(journal.indexOf("req:workspace/symbol")).toBeLessThan(journal.indexOf("req:textDocument/prepareCallHierarchy"));
    expect(journal.indexOf("req:textDocument/prepareCallHierarchy")).toBeLessThan(
      journal.indexOf("req:callHierarchy/incomingCalls"),
    );
  });

  it("refuses a name the index holds no callable for, before asking clangd anything about calls", async () => {
    indexRows = [];

    const failed = await runCppFindCallers(sessions, {
      projectRoot: buildDir,
      name: "Gone",
      sourceRoots: [sourceDir],
    } as never);

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('no declaration named "Gone" was found in clangd\'s index');
    expect(server.requests.some(([method]) => method === "textDocument/prepareCallHierarchy")).toBe(false);
  });

  it("leaves nothing it resolved through the index in the session's opened set", async () => {
    const unscoped = () =>
      runCppFindCallers(sessions, { projectRoot: buildDir, name: "helper", sourceRoots: [sourceDir] } as never);

    const built = await unscoped();
    expect(payload(built).resolved.name).toBe("helper");

    // The hold is transient on purpose, and so is the outline that named the rows: a question that
    // named no file must not change what the session holds. Were `helper.cpp` kept open, the next unscoped
    // question about `helper` would resolve from the opened outlines and answer with no `scope` at all — a
    // payload that hides which place the name came from.
    expect(sessions.get(buildDir, clangdConfig).getOpenedFiles()).not.toContain(helper);

    const symbol = await runCppFindSymbol(sessions, {
      projectRoot: buildDir,
      name: "helper",
      sourceRoots: [sourceDir],
    } as never);
    expect((symbol.structuredContent as { scope?: unknown }).scope).toBeDefined();
    // …and the naming still worked from the transient read: the row keeps the name the outline gives it.
    expect(payload(built).callers[0]).toMatchObject({ name: "Widget::value", file: widget });
  });

  it("refuses a callable the index places outside every declared source root, without opening it", async () => {
    indexRows = [
      {
        name: "helper",
        kind: 12,
        location: {
          uri: fileUri(elsewhere),
          range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
        },
      },
    ];

    const failed = await runCppFindCallers(sessions, {
      projectRoot: buildDir,
      name: "helper",
      sourceRoots: [sourceDir],
    } as never);

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("outside every declared source root");
    expect(textOf(failed)).toContain("reported and never opened");
    expect(server.requests.some(([method]) => method === "textDocument/prepareCallHierarchy")).toBe(false);
    expect(
      server.notifications
        .filter(([method]) => method === "textDocument/didOpen")
        .map(([, params]) => pathOfDocumentId(params)),
    ).not.toContain(elsewhere);
  });

  it("hands the prepared item to the second request unchanged", async () => {
    await run();

    const request = server.requests.find(([method]) => method === "callHierarchy/incomingCalls");

    expect(request?.[1]).toEqual({ item: (prepared as readonly unknown[])[0] });
  });
});
