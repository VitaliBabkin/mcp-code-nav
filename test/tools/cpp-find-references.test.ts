import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeServer, pathOfDocumentId, type FakeServer } from "../helpers/fake-lsp.js";
import { sessionsFor, symAt } from "../helpers/fake-clangd.js";
import {
  runCppFindReferences,
  type CppReferenceFile,
  type CppFindReferencesPayload,
} from "../../src/tools/cpp-find-references.js";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { clangdConfig } from "../../src/lsp/server-config.js";
import { fileUri } from "../../src/lsp/document-uri.js";
import { outsideEveryRoot } from "../../src/tools/cpp-navigation-shared.js";
import { NAVIGATION_CEILING_MS } from "../../src/tools/navigation-limits.js";
import type { LspSessionManager } from "../../src/lsp/session-manager.js";

/**
 * Mocked suite for the C++ use-site question: the `scope` block (the latched index
 * state, the drift reading, the blind-spot pair, the limit codes), the exact counts against capped
 * listings and its rule that a location outside the boundary is reported and never read, and the
 * limits table as this tool applies it. clangd is faked at the connection; the drift walk is real, over a temp
 * tree, because what that walk can and cannot say is what most of these cases are about.
 *
 * One session per test, on purpose: the drift baseline and the index-state latch are session state, so a
 * case that means to compare two calls has to make both against the same one.
 */

interface Result {
  readonly isError?: boolean;
  readonly content: readonly { readonly text?: string }[];
  readonly structuredContent?: unknown;
}

interface Scope {
  projectRoot: string;
  index: { state: string; staleFiles?: { count: number; files: readonly string[] }; driftUnknown?: string };
  uncoveredSources?: { count: number; files: readonly string[] };
  uncoveredSourcesUnavailable?: string;
  limits: string[];
  freshness?: unknown;
}

const textOf = (result: Result): string => result.content[0]?.text ?? "";

const site = (file: string, line: number, character: number) => ({
  uri: fileUri(file),
  range: { start: { line, character }, end: { line, character: character + 1 } },
});

describe("cpp_find_references against a faked clangd", () => {
  let tmp: string;
  let buildDir: string;
  let sourceDir: string;
  let outsideDir: string;
  let widget: string;
  let helper: string;
  let elsewhere: string;
  let locations: () => unknown;
  let indexRows: unknown;
  let duringQuery: (() => void)[];
  let duringIndex: (() => void)[];
  let server: FakeServer;
  let sessions: LspSessionManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-cpp-refs-"));
    buildDir = join(tmp, "build");
    sourceDir = join(tmp, "src");
    outsideDir = join(tmp, "outside");
    mkdirSync(buildDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    widget = join(sourceDir, "widget.cpp");
    helper = join(sourceDir, "helper.cpp");
    elsewhere = join(outsideDir, "elsewhere.cpp");
    writeFileSync(widget, "class Widget {\npublic:\n  int value();\n};\n");
    writeFileSync(helper, "int helper(Widget w) {\n  return w.value();\n}\n");
    writeFileSync(elsewhere, "int elsewhere(Widget w) { return w.value(); }\n");
    writeFileSync(
      join(buildDir, "compile_commands.json"),
      JSON.stringify([
        { directory: sourceDir, command: `clang++ -c "${widget}"`, file: widget },
        { directory: sourceDir, command: `clang++ -c "${helper}"`, file: helper },
      ]),
    );
    locations = () => [site(widget, 5, 6), site(helper, 1, 9)];
    // One row as clangd's project-wide search spells it: the identifier's own span, no scope to compose.
    indexRows = [
      {
        name: "Widget",
        kind: 5,
        location: { uri: fileUri(widget), range: { start: { line: 3, character: 6 }, end: { line: 3, character: 12 } } },
      },
    ];
    duringQuery = [];
    duringIndex = [];
    start();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A clangd answering outlines per file and the reference query from a test-controlled function, with hooks
   * that run as that query is answered — which is how a progress token is begun or ended inside the
   * request's own window, so the latch is tested and not merely the counter.
   */
  function clangd(): FakeServer {
    return fakeServer({
      // clangd answers a reference query from the AST of a held document, so a request about a file this
      // client never added is refused — measured, `trying to get AST for non-added document`. The index
      // branch is the first to resolve a declaration in a file the session has never opened, so the fake
      // has to hold it to the same rule.
      refusesUnaddedDocuments: true,
      respond: (method, params) => {
        if (method === "initialize") return {};
        const file = pathOfDocumentId(params);
        if (method === "textDocument/documentSymbol") {
          // widget.cpp declares `class Widget` on 0-based line 3 with `value` inside it on line 5, so the
          // use at line 5 sits in a member and must be named as one.
          if (file === widget) {
            return [{ ...symAt("Widget", 5, 3, 6), range: { start: { line: 3 }, end: { line: 6 } }, children: [symAt("value", 6, 5, 6)] }];
          }
          if (file === helper) return [symAt("helper", 12, 0, 4)];
          return [symAt("elsewhere", 12, 0, 4)];
        }
        if (method === "workspace/symbol") {
          for (const act of duringIndex) act();
          return indexRows;
        }
        if (method === "textDocument/references") {
          for (const act of duringQuery) act();
          return locations();
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });
  }

  function start(): void {
    server = clangd();
    sessions = sessionsFor(server.process);
  }

  const run = (): Promise<Result> =>
    runCppFindReferences(sessions, {
      projectRoot: buildDir,
      name: "Widget",
      file: widget,
      sourceRoots: [sourceDir],
    } as never);

  const payload = (result: Result): CppFindReferencesPayload => {
    expect(result.isError, textOf(result)).toBeFalsy();
    return result.structuredContent as CppFindReferencesPayload;
  };

  const scope = (result: Result): Scope => payload(result).scope as unknown as Scope;

  /**
   * One ordinary call first: the session only registers its server-to-client handlers when it spawns, so a
   * case that means to drive progress has to make the child exist. The default locations are non-empty, so
   * a warm-up never trips the empty-answer rule the caller is about to test.
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

  /** A round left running: clangd began it and has not ended it by the time the answer comes back. */
  async function beginRound(): Promise<void> {
    await warm();
    await server.createProgress("idx");
    server.sendProgress("idx", { kind: "begin" });
  }

  it("counts every use and names each row by the deepest declaration it sits in", async () => {
    const found = payload(await run());

    expect(found.resolved).toEqual({ name: "Widget", kind: "class", file: widget, line: 4 });
    expect(found.totalReferences).toBe(2);
    expect(found.filesTruncated).toBe(0);
    const inWidget = found.files.find((group) => group.file === widget) as CppReferenceFile;
    const inHelper = found.files.find((group) => group.file === helper) as CppReferenceFile;
    // `Widget::value` is qualified the way `cpp_find_symbol` publishes a member, so a row can be handed
    // straight back as this tool's own `name` input.
    expect(inWidget.sites[0]).toMatchObject({ line: 6, column: 7, in: "Widget::value" });
    expect(inHelper.sites[0]).toMatchObject({ line: 2, column: 10, in: "helper" });
  });

  it("names every row however long this process has already been running", async () => {
    // The naming budget belongs to one call. Taken once when the module was imported, it is exhausted for
    // every call made after the ceiling of process uptime, and rows outside the queried file would come back
    // unnamed with a reason about a budget this call never had.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + NAVIGATION_CEILING_MS + 1);

      const found = payload(await run());
      const inHelper = found.files.find((group) => group.file === helper) as CppReferenceFile;

      expect(inHelper.sites[0]).toMatchObject({ line: 2, column: 10, in: "helper" });
      expect(inHelper.sites[0]?.reason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a location outside every declared source root without ever reading it", async () => {
    locations = () => [site(widget, 3, 6), site(elsewhere, 0, 34)];

    const found = payload(await run());
    const external = found.files.find((group) => group.file === elsewhere) as CppReferenceFile;

    expect(external.external).toBe(true);
    expect(external.count).toBe(1);
    expect(external.sites[0]).toEqual({
      line: 1,
      column: 35,
      in: null,
      reason: "outside every declared source root; not named",
    });
    expect(found.totalReferences).toBe(2);
    const outlined = server.requests
      .filter(([method]) => method === "textDocument/documentSymbol")
      .map(([, params]) => pathOfDocumentId(params));
    expect(outlined).not.toContain(elsewhere);
    // In-boundary groups lead, so what a cap can drop is only ever what was never going to be read.
    expect(found.files.map((group) => group.external)).toEqual([false, true]);
  });

  it("keeps every count exact while both caps bite, and says so", async () => {
    locations = () => [
      ...Array.from({ length: 25 }, (_, index) => site(helper, index, 2)),
      ...Array.from({ length: 45 }, (_, index) => site(join(outsideDir, `extra${index}.cpp`), 1, 1)),
    ];

    const result = await run();
    const found = payload(result);
    const helperGroup = found.files.find((group) => group.file === helper) as CppReferenceFile;

    expect(found.totalReferences).toBe(70);
    expect(found.files).toHaveLength(40);
    expect(found.filesTruncated).toBe(6);
    expect(helperGroup.count).toBe(25);
    expect(helperGroup.sites).toHaveLength(20);
    expect(helperGroup.sitesTruncated).toBe(5);
    expect(scope(result).limits).toContain("listing-capped");
    // In-scope groups lead the listing, so what the cap dropped is entirely outside the boundary: 45
    // external groups existed and 39 survived, and the one in-boundary group is still here.
    const inScope = found.files.filter((group) => !group.external);
    expect(inScope.map((group) => group.file)).toEqual([helper]);
    expect(found.files.filter((group) => group.external)).toHaveLength(39);
    expect(found.filesTruncated).toBe(6);
    expect(found.files[0].external).toBe(false);
  });

  it("says state and drift are both unknown on a first call over these roots", async () => {
    const first = scope(await run());

    expect(first.index.state).toBe("unknown");
    expect(first.index.staleFiles).toBeUndefined();
    expect(first.index.driftUnknown).toMatch(/first index-backed answer over/);
    expect(first.limits).toEqual(["compile-database-only", "index-state-unknown", "index-drift-unknown"]);
    expect(first.freshness).toBeUndefined();
  });

  it("reports a source a rebuild moved as stale, and codes the answer as possibly behind it", async () => {
    await run();
    writeFileSync(widget, "class Widget {\npublic:\n  int value();\n};\n\n// edited after the baseline\n");

    const second = scope(await run());

    expect(second.index.staleFiles).toMatchObject({ count: 1, files: [widget] });
    expect(second.index.driftUnknown).toBeUndefined();
    expect(second.limits).toContain("index-behind-disk");
    expect(second.limits).not.toContain("index-drift-unknown");
  });

  it("pushes the change it found before the query that reports it, exactly once, as a notification", async () => {
    await run();
    writeFileSync(helper, "int helper(Widget w) {\n  return w.value() + 1;\n}\n");
    await run();

    const journal = server.journal;
    const pushed = journal.indexOf("note:workspace/didChangeWatchedFiles");
    expect(pushed).toBeGreaterThanOrEqual(0);
    expect(journal.filter((entry) => entry === "note:workspace/didChangeWatchedFiles")).toHaveLength(1);
    expect(journal.lastIndexOf("req:textDocument/references")).toBeGreaterThan(pushed);
    // It is a notification: the drift push asks nothing the method allow-list has to admit.
    expect(journal).not.toContain("req:workspace/didChangeWatchedFiles");
  });

  it("refuses an empty answer when clangd never reported any progress, and says that is why", async () => {
    locations = () => [];

    const failed = await run();

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/never reported indexing progress to this session/);
    expect(textOf(failed)).toMatch(/is not reportable as an answer/);
  });

  it("refuses an empty answer while a round opened before the window is still outstanding", async () => {
    await beginRound();
    locations = () => [];

    const failed = await run();

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/was indexing while this call ran/);
  });

  it("answers a scoped empty from a quiescent index, with no index-state code attached", async () => {
    await settledRound();
    locations = () => [];

    const quiet = scope(await run());

    // Idle, and nothing moved since this session's baseline: the listing may be empty and the only limit
    // left is the compile database's own boundary.
    expect(quiet.index.state).toBe("quiescent");
    expect(quiet.index.staleFiles).toEqual({ count: 0, files: [] });
    expect(quiet.limits).toEqual(["compile-database-only"]);
  });

  it("codes a non-empty answer whose round is still running with `index-still-building`", async () => {
    await beginRound();

    const busy = scope(await run());

    expect(busy.index.state).toBe("building");
    expect(busy.limits).toContain("index-still-building");
    expect(busy.limits).not.toContain("index-state-unknown");
  });

  it("reads a round that began and finished inside the request window as building, not idle", async () => {
    await warm();
    await server.createProgress("idx");
    duringQuery = [
      () => server.sendProgress("idx", { kind: "begin" }),
      () => server.sendProgress("idx", { kind: "end" }),
    ];

    const inside = scope(await run());

    // The pair opened and closed between the request and its reply, so a state sampled at the reply would
    // read idle. This is the named cell, applied by the tool that has to honour it.
    expect(inside.index.state).toBe("building");
    expect(inside.limits).toContain("index-still-building");
  });

  it("names the source the compile database leaves out, beside every answer", async () => {
    writeFileSync(join(sourceDir, "orphan.cpp"), "int orphan() { return 0; }\n");

    const withBlindSpot = scope(await run());

    expect(withBlindSpot.uncoveredSources).toEqual({ count: 1, files: [join(sourceDir, "orphan.cpp")] });
    expect(withBlindSpot.uncoveredSourcesUnavailable).toBeUndefined();
    expect(withBlindSpot.limits).toContain("uncovered-sources-present");
  });

  it("states the scope exactly", async () => {
    const built = scope(await run());

    expect(Object.keys(built).sort()).toEqual(["index", "limits", "projectRoot", "sourceRoots", "uncoveredSources"]);
    expect(built.projectRoot).toBe(buildDir);
  });

  it("refuses an answer it cannot read as locations rather than dropping part of it", async () => {
    locations = () => [{ uri: "file:///nowhere.cpp" }];

    const failed = await run();

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/cpp_find_references failed: clangd answered the query for "Widget" with entry 1/);
    expect(textOf(failed)).toMatch(/possibly dropping a match/);
  });

  it("refuses to ask about a declaration whose own name clangd did not locate", async () => {
    server = fakeServer({
      respond: (method) =>
        method === "textDocument/documentSymbol"
          ? [{ name: "Widget", kind: 5, range: { start: { line: 3 }, end: { line: 6 } } }]
          : locations(),
    });
    sessions = sessionsFor(server.process);

    const failed = await run();

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/clangd named no position for "Widget"/);
  });

  it("asks at the identifier rather than the keyword, and excludes the declaration itself", async () => {
    await run();

    const request = server.requests.find(([method]) => method === "textDocument/references");

    expect(request?.[1]).toMatchObject({
      textDocument: { uri: fileUri(widget) },
      position: { line: 3, character: 6 },
      context: { includeDeclaration: false },
    });
  });

  it("keeps the shared resolver's refusals, with this tool's name at the front", async () => {
    server = fakeServer({
      respond: (method) =>
        method === "textDocument/documentSymbol" ? [symAt("Widget", 5, 3, 6), symAt("Widget", 5, 8, 6)] : locations(),
    });
    sessions = sessionsFor(server.process);

    const failed = await run();

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/cpp_find_references failed: "Widget" is ambiguous in/);
  });

  it("resolves a subject named without a `file` through clangd's index, in the answer's own window", async () => {
    const unscoped = () =>
      runCppFindReferences(sessions, { projectRoot: buildDir, name: "Widget", sourceRoots: [sourceDir] } as never);

    // A call that fails at its own resolution still leaves its file open, so the session now holds
    // `helper.cpp` — an outline that says nothing about `Widget`. The name can only come from the index.
    const warming = await runCppFindReferences(sessions, {
      projectRoot: buildDir,
      name: "nope",
      file: helper,
      sourceRoots: [sourceDir],
    } as never);
    expect(warming.isError).toBe(true);

    // A round that opens while the symbol query is being answered and settles while the reference query is
    // being answered is inside this answer's span only if the two share one window — which is what
    // the state has to describe.
    await server.createProgress("pair");
    duringIndex = [() => server.sendProgress("pair", { kind: "begin" })];
    duringQuery = [() => server.sendProgress("pair", { kind: "end" })];

    const built = await unscoped();

    expect(payload(built).resolved).toEqual({ name: "Widget", kind: "class", file: widget, line: 4 });
    // The symbol query went first and the reference query was asked at the position its row named: one
    // answer, read from two requests.
    const journal = server.journal;
    expect(journal.indexOf("req:workspace/symbol")).toBeLessThan(journal.indexOf("req:textDocument/references"));
    expect(scope(built).index.state).toBe("building");
  });

  it("refuses a subject the index places outside every declared source root, without opening it", async () => {
    indexRows = [
      {
        name: "Widget",
        kind: 5,
        location: {
          uri: fileUri(elsewhere),
          range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
        },
      },
    ];

    const failed = await runCppFindReferences(sessions, {
      projectRoot: buildDir,
      name: "Widget",
      sourceRoots: [sourceDir],
    } as never);

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('is declared in "');
    expect(textOf(failed)).toContain("outside every declared source root");
    expect(textOf(failed)).toContain("reported and never opened");
    // Neither the question nor its document: the file was never opened and nothing was asked about it.
    expect(server.requests.some(([method]) => method === "textDocument/references")).toBe(false);
    expect(
      server.notifications.filter(([method]) => method === "textDocument/didOpen").map(([, params]) => pathOfDocumentId(params)),
    ).not.toContain(elsewhere);
  });

  it("leaves nothing it resolved through the index in the session's opened set", async () => {
    const unscoped = () =>
      runCppFindReferences(sessions, { projectRoot: buildDir, name: "Widget", sourceRoots: [sourceDir] } as never);

    const built = await unscoped();
    expect(payload(built).resolved.name).toBe("Widget");

    // The hold is transient on purpose: a question that named no file must not change what the session
    // holds. The outline this call read to name its rows is therefore read transiently too — a long-lived
    // open here would make the next unscoped question look like an answer from the opened files.
    expect(sessions.get(buildDir, clangdConfig).getOpenedFiles()).not.toContain(widget);

    const symbol = await runCppFindSymbol(sessions, {
      projectRoot: buildDir,
      name: "Widget",
      sourceRoots: [sourceDir],
    } as never);
    expect((symbol.structuredContent as { scope?: unknown }).scope).toBeDefined();
    // …and the rows in that file are still named, from the transient read rather than a held one.
    const inWidget = (payload(built).files.find((group) => group.file === widget) ?? { sites: [] }) as {
      sites: { in: string | null }[];
    };
    expect(inWidget.sites[0]?.in).toBe("Widget::value");
  });

  it("reads a name the index does not hold as the refusal that says so, not as an empty listing", async () => {
    indexRows = [];

    const failed = await runCppFindReferences(sessions, {
      projectRoot: buildDir,
      name: "Gone",
      sourceRoots: [sourceDir],
    } as never);

    expect(failed.isError).toBe(true);
    // No subject means no reference question was askable, so the answer is about the declaration and says
    // which silence it rests on: clangd here reported no progress at all, so nothing may be called absent.
    expect(textOf(failed)).toContain('no declaration named "Gone" was found in clangd\'s index');
    expect(textOf(failed)).toContain("is not reportable as an answer");
    expect(server.requests.some(([method]) => method === "textDocument/references")).toBe(false);
  });

  it("holds one baseline per root set, so a second caller's roots are not folded into the first", async () => {
    await run();

    const otherRoots = scope(
      await runCppFindReferences(sessions, {
        projectRoot: buildDir,
        name: "Widget",
        file: widget,
        sourceRoots: [sourceDir, outsideDir],
      } as never),
    );

    expect(otherRoots.index.driftUnknown).toMatch(/first index-backed answer over/);
    // The first root set's baseline is untouched: its next call still knows what moved.
    writeFileSync(widget, "class Widget {\npublic:\n  int value();\n};\n\n// touched again\n");
    expect(scope(await run()).index.staleFiles?.files).toEqual([widget]);
  });

  it("treats a declared root contained by another as one tree when naming what is outside", () => {
    const outside = outsideEveryRoot(buildDir, [sourceDir, join(sourceDir, "sub")]);

    expect(outside(join(sourceDir, "sub", "x.cpp"))).toBe(false);
    expect(outside(widget)).toBe(false);
    expect(outside(elsewhere)).toBe(true);
  });
});
