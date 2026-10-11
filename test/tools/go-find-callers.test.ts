import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGoFindCallers } from "../../src/tools/go-find-callers.js";
import { CALLERS_LIMIT, REFERENCE_SITES_PER_FILE_LIMIT } from "../../src/tools/navigation-limits.js";
import { WINDOWS_AMD64 } from "../helpers/fake-go.js";
import { uriOf } from "../helpers/fake-lsp.js";
import {
  buildGoToolHarness,
  cleanupGoToolHarnesses,
  countOf,
  limitsOf,
  missingGoplsSpawn,
  openedPaths,
  payload,
  requestFor,
  runUntilBudgetExpires,
  scopeOf,
  symbol,
  textOf,
  type GoToolHarness,
  type GoToolHarnessOptions,
} from "../helpers/go-tool-harness.js";

type Result = Awaited<ReturnType<typeof runGoFindCallers>>;
type Input = { sourceRoots: string[]; file: string; symbol: string; timeBudgetMs: number };
type CallerRow = Record<string, unknown>;

const PREPARE_METHOD = "textDocument/prepareCallHierarchy";
const INCOMING_METHOD = "callHierarchy/incomingCalls";
const CALL_METHODS = [PREPARE_METHOD, INCOMING_METHOD];

interface Harness extends GoToolHarness {
  prepared(items: unknown[]): void;
  incoming(calls: unknown[]): void;
  /** Kills the child the next time it is asked to prepare a call hierarchy, then answers from its replacement. */
  failNextPrepare(): void;
  /** Never resolves the `callHierarchy/incomingCalls` request, so the call's budget has to run out. */
  hangIncomingCalls(): void;
  /** Makes the call-hierarchy requests reject with this message, the way a refused file does. */
  refuseCallHierarchy(message: string): void;
  run(overrides?: Partial<Input>): Promise<Result>;
}

/** What the test wants that `go`, or the child process, answers differently. */
type HarnessOptions = Pick<GoToolHarnessOptions, "go" | "spawn">;

const STORE = symbol("Store", 23, 10, 12);
const GET = symbol("(*Store).Get", 6, 21, 24);

/** One `CallHierarchyItem` as gopls spells it: 0-based positions throughout. */
function item(path: string, name: string, kind: number, line: number, character = 0): unknown {
  return {
    name,
    kind,
    uri: uriOf(path),
    range: { start: { line, character }, end: { line: line + 6, character: 0 } },
    selectionRange: { start: { line, character: character + 4 } },
  };
}

/** An item that carries no name at all, which gopls sometimes does not either. */
function anonymousItem(path: string, line: number): unknown {
  return {
    kind: 12,
    uri: uriOf(path),
    range: { start: { line, character: 0 }, end: { line: line + 6, character: 0 } },
    selectionRange: { start: { line, character: 5 } },
  };
}

/** One `IncomingCall`: the calling declaration plus the ranges where it calls. */
function incoming(from: unknown, sites: Array<{ line: number; character: number }>): unknown {
  return {
    from,
    fromRanges: sites.map((start) => ({ start, end: { line: start.line, character: start.character + 3 } })),
  };
}

function callSites(count: number, firstLine = 43): Array<{ line: number; character: number }> {
  return Array.from({ length: count }, (_unused, index) => ({ line: firstLine + index, character: 11 }));
}

/** A gopls whose outlines and call-hierarchy answers the test supplies, rooted at a real temp module. */
function harness(options: HarnessOptions = {}): Harness {
  const core = buildGoToolHarness({
    prefix: "mcp-code-nav-gocallers-",
    fileName: "store.go",
    outline: [STORE, GET],
    expects: CALL_METHODS,
    go: options.go,
    spawn: options.spawn,
  });
  return {
    ...core,
    prepared: (items) => core.query.answer(PREPARE_METHOD, items),
    incoming: (calls) => core.query.answer(INCOMING_METHOD, calls),
    failNextPrepare: () => core.query.crashNext(PREPARE_METHOD),
    hangIncomingCalls: () => core.query.hang(INCOMING_METHOD),
    refuseCallHierarchy: (message) => CALL_METHODS.forEach((method) => core.query.refuse(method, message)),
    run: (overrides) =>
      runGoFindCallers(
        core.manager,
        { sourceRoots: [core.mod], file: core.file, symbol: "(*Store).Get", timeBudgetMs: 60_000, ...overrides },
        { exec: core.go.exec },
      ),
  };
}

function callersOf(result: Result): CallerRow[] {
  return payload(result).callers as CallerRow[];
}

/** Caller names, sorted — the tool's own order is in-module first, so a test comparing a name set sorts. */
function names(result: Result): string[] {
  return callersOf(result)
    .map((row) => String(row.name))
    .sort();
}

/** A method subject that is exported, over a module with nothing filename-excluded in it. */
const METHOD_LIMITS = [
  "one-module",
  "one-port",
  "exported-symbol-importers-invisible",
  "corresponding-interface-methods-included",
  "indirect-dispatch-not-resolved",
];

describe("runGoFindCallers", () => {
  afterEach(() => cleanupGoToolHarnesses());

  it("answers one row per calling declaration, named by its own outline, with the boundary codes", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    const outside = join(h.tmp, "outside", "io.go");
    h.outline(pg, [symbol("Serve", 12, 39, 45)]);
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([
      incoming(item(pg, "Serve", 12, 39), [{ line: 43, character: 11 }]),
      incoming(item(outside, "Handle", 12, 70), [{ line: 75, character: 2 }]),
    ]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(payload(out)).toEqual({
      resolved: { name: "(*Store).Get", kind: "method", file: h.file, line: 22 },
      totalCallers: 2,
      callers: [
        {
          name: "Serve",
          kind: "function",
          file: pg,
          line: 40,
          external: false,
          callSites: [{ line: 44, column: 12 }],
          callSitesTruncated: 0,
        },
        {
          name: null,
          kind: null,
          file: outside,
          line: 71,
          external: true,
          reason: "outside the module root; not named",
          callSites: [{ line: 76, column: 3 }],
          callSitesTruncated: 0,
        },
      ],
      callersTruncated: 0,
      scope: {
        moduleRoot: resolve(h.mod),
        freshness: { kind: "unchanged" },
        visibility: "exported",
        environment: WINDOWS_AMD64,
        osArchExcluded: { count: 0, files: [], namedFileExcluded: false },
        limits: METHOD_LIMITS,
      },
    });
    expect(textOf(out)).toContain('Callers of method "(*Store).Get"');
    expect(textOf(out)).toContain("2 caller(s) listed from 2 found");
    expect(textOf(out)).toContain("corresponding-interface-methods-included");
    // One transient outline read for the one in-module caller file, and nothing for the external one.
    expect(countOf(h.server, "textDocument/documentSymbol")).toBe(3);
    expect(openedPaths(h.server)).toEqual([h.file, pg]);
  });

  it("names a caller from the outline, never from the name and kind gopls put on the item", async () => {
    const h = harness();
    // gopls spells a method's call-hierarchy item with the bare member name and a function kind; the row
    // has to read the way this tool's own `symbol` input would spell that declaration. The second item
    // carries no name at all and sits at its own position, so the nameless half is a case of its own.
    h.outline(h.file, [
      STORE,
      GET,
      symbol("(*Store).Read", 6, 40, 44),
      symbol("(*Store).Flush", 6, 50, 54),
    ]);
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([
      incoming(item(h.file, "Read", 12, 40), [{ line: 43, character: 8 }]),
      incoming(anonymousItem(h.file, 50), [{ line: 52, character: 4 }]),
    ]);
    await h.ready();

    const out = await h.run();
    expect(names(out)).toEqual(["(*Store).Flush", "(*Store).Read"]);
    expect(payload(out).totalCallers).toBe(2);
    const [named, nameless] = callersOf(out);
    expect(named).toMatchObject({ name: "(*Store).Read", kind: "method", file: h.file, line: 41, external: false });
    expect(named).not.toHaveProperty("reason");
    expect(nameless).toMatchObject({ name: "(*Store).Flush", kind: "method", file: h.file, line: 51, external: false });
    expect(nameless).not.toHaveProperty("reason");
    // Both callers are in the queried file, whose outline is already in hand: no extra read.
    expect(countOf(h.server, "textDocument/documentSymbol")).toBe(2);
  });

  it("asks about the name and not the keyword: the position is selectionRange.start", async () => {
    const h = harness();
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    await h.ready();
    await h.run();

    expect(requestFor(h.server, "textDocument/prepareCallHierarchy")).toEqual({
      textDocument: { uri: uriOf(h.file) },
      position: { line: 21, character: 5 },
    });
  });

  it("hands the item gopls offered back to incomingCalls unchanged", async () => {
    const h = harness();
    const offered = item(h.file, "(*Store).Get", 6, 21, 1);
    h.prepared([offered]);
    await h.ready();
    await h.run();

    expect(requestFor(h.server, "callHierarchy/incomingCalls")).toEqual({ item: offered });
  });

  it("merges the entries a server reports for one caller into that caller's row", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 60), symbol("Warm", 12, 80, 90)]);
    const caller = item(pg, "Serve", 12, 39);
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([
      incoming(caller, [{ line: 43, character: 11 }]),
      incoming(caller, [{ line: 50, character: 4 }]),
      incoming(item(pg, "Warm", 12, 80), [{ line: 84, character: 2 }]),
    ]);
    await h.ready();

    const out = await h.run();
    expect(payload(out).totalCallers).toBe(2);
    expect(names(out)).toEqual(["Serve", "Warm"]);
    const row = callersOf(out).find((one) => one.name === "Serve");
    expect(row).toMatchObject({
      kind: "function",
      callSites: [{ line: 44, column: 12 }, { line: 51, column: 5 }],
      callSitesTruncated: 0,
    });
    // Two callers, one file: one transient read serves both rows.
    expect(countOf(h.server, "textDocument/documentSymbol")).toBe(3);
  });

  it("counts every caller gopls reported even when both caps drop part of the listing", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 70), symbol("Warm", 12, 100, 110)]);
    const noisy = incoming(item(pg, "Serve", 12, 39), callSites(REFERENCE_SITES_PER_FILE_LIMIT + 5));
    const inModule = [noisy, incoming(item(pg, "Warm", 12, 100), [{ line: 104, character: 2 }])];
    const external = Array.from({ length: CALLERS_LIMIT + 1 }, (_unused, index) =>
      incoming(item(join(h.tmp, "outside", `f${index}.go`), "Handle", 12, 5), [{ line: 9, character: 1 }]),
    );
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([...inModule, ...external]);
    await h.ready();

    const out = await h.run();
    const rows = callersOf(out);
    expect(payload(out).totalCallers).toBe(43);
    expect(rows).toHaveLength(CALLERS_LIMIT);
    expect(payload(out).callersTruncated).toBe(3);
    // The exact per-caller count survives the site cap, which narrows only what is listed.
    expect(rows[0]).toMatchObject({ name: "Serve", kind: "function", external: false, callSitesTruncated: 5 });
    expect(rows[0]?.callSites as unknown[]).toHaveLength(REFERENCE_SITES_PER_FILE_LIMIT);
    expect(rows.filter((row) => !row.external)).toHaveLength(2);
    // Both in-module rows are still listed — but they were reported first here, so this case proves
    // nothing about which side of the cap a drop falls on. The ordering case below owns that claim.
    expect(callersOf(out).slice(0, 2).map((row) => String(row.name)).sort()).toEqual(["Serve", "Warm"]);
    expect(limitsOf(out)).toContain("listing-capped");
    // The summary tells listed apart from found, which is only visible once a cap has bitten.
    expect(textOf(out)).toContain(`${CALLERS_LIMIT} caller(s) listed from ${CALLERS_LIMIT + 3} found`);
    // The fan-out stopped at the rows that survived the cap: one read for pg.go, and none for any of the
    // 38 external rows that were listed.
    expect(countOf(h.server, "textDocument/documentSymbol")).toBe(3);
  });

  it("keeps the in-module caller when gopls reported the external ones first and the cap bit", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 45)]);
    const externalFirst = Array.from({ length: CALLERS_LIMIT + 2 }, (_unused, index) =>
      incoming(item(join(h.tmp, "outside", `f${index}.go`), "Handle", 12, 5), [{ line: 9, character: 1 }]),
    );
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([...externalFirst, incoming(item(pg, "Serve", 12, 39), [{ line: 43, character: 11 }])]);
    await h.ready();

    const out = await h.run();
    const rows = callersOf(out);
    expect(payload(out).totalCallers).toBe(CALLERS_LIMIT + 3);
    expect(rows).toHaveLength(CALLERS_LIMIT);
    // The in-module caller was reported last and survived; every dropped row was an external one.
    expect(rows[0]).toMatchObject({ name: "Serve", kind: "function", file: pg, external: false });
    expect(rows.filter((row) => !row.external)).toHaveLength(1);
    expect(rows.slice(1).every((row) => row.external)).toBe(true);
    expect(payload(out).callersTruncated).toBe(3);
    expect(textOf(out)).toContain(`${CALLERS_LIMIT} caller(s) listed from ${CALLERS_LIMIT + 3} found`);
  });

  it("carries listing-capped when only the per-caller site cap bites, with totalCallers exact", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 70)]);
    const many = REFERENCE_SITES_PER_FILE_LIMIT + 5;
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([incoming(item(pg, "Serve", 12, 39), callSites(many))]);
    await h.ready();

    const out = await h.run();
    const [row] = callersOf(out);
    expect(payload(out).totalCallers).toBe(1);
    expect(payload(out).callersTruncated).toBe(0);
    expect(row).toMatchObject({ name: "Serve", external: false, callSitesTruncated: 5 });
    expect(row?.callSites as unknown[]).toHaveLength(REFERENCE_SITES_PER_FILE_LIMIT);
    // One cap biting is enough for the code: it says the listing narrowed, not that both caps did.
    expect(limitsOf(out)).toContain("listing-capped");
  });

  it("answers a function nobody calls with a scoped empty, which is what proves readiness was observed", async () => {
    const h = harness();
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(payload(out).totalCallers).toBe(0);
    expect(callersOf(out)).toEqual([]);
    expect(payload(out).callersTruncated).toBe(0);
    expect(textOf(out)).toContain("0 caller(s)");
    expect(textOf(out)).not.toMatch(/cannot be proven complete/);
  });

  it("keeps a caller its outline cannot name, with the reason beside it instead of dropping the row", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 45)]);
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([incoming(item(pg, "Loose", 12, 60), [{ line: 62, character: 2 }])]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(payload(out).totalCallers).toBe(1);
    expect(callersOf(out)).toEqual([
      {
        name: null,
        kind: null,
        file: pg,
        line: 61,
        external: false,
        reason: "no top-level declaration in this file encloses the reported location",
        callSites: [{ line: 63, column: 3 }],
        callSitesTruncated: 0,
      },
    ]);
  });

  it("keeps a caller whose file gopls refuses to outline, with the server's reason beside it", async () => {
    const h = harness();
    const broken = join(h.mod, "broken.go");
    h.failToOutline(broken);
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([incoming(item(broken, "Broken", 12, 3), [{ line: 6, character: 2 }])]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    const [row] = callersOf(out);
    expect(row).toMatchObject({ name: null, kind: null, file: broken, line: 4, external: false });
    expect(String(row?.reason)).toContain("no package metadata for file");
  });

  it("reports a caller from outside the module as unnamed, and never opens or reads its file", async () => {
    const h = harness();
    const outside = join(h.tmp, "outside", "io.go");
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([incoming(item(outside, "Handle", 12, 70), [{ line: 75, character: 2 }])]);
    await h.ready();

    const out = await h.run();
    expect(callersOf(out)).toEqual([
      {
        name: null,
        kind: null,
        file: outside,
        line: 71,
        external: true,
        reason: "outside the module root; not named",
        callSites: [{ line: 76, column: 3 }],
        callSitesTruncated: 0,
      },
    ]);
    expect(h.read.mock.calls.every((call) => call[0] !== outside)).toBe(true);
    expect(openedPaths(h.server)).toEqual([h.file]);
  });

  it("reads the visibility of a method from its own name, never from its receiver type", async () => {
    const exported = harness();
    exported.outline(exported.file, [STORE, symbol("(*store).Get", 6, 21, 24)]);
    exported.prepared([item(exported.file, "(*store).Get", 6, 21, 1)]);
    await exported.ready();

    // An exported method of an unexported type: importers reach it through values of the type, so the
    // importer code belongs beside `visibility: exported`.
    const upper = await exported.run({ symbol: "(*store).Get" });
    expect(upper.isError, textOf(upper)).toBeFalsy();
    expect(scopeOf(upper).visibility).toBe("exported");
    expect(limitsOf(upper)).toEqual(METHOD_LIMITS);

    const privateMethod = harness();
    privateMethod.outline(privateMethod.file, [STORE, symbol("(*store).get", 6, 21, 24)]);
    privateMethod.prepared([item(privateMethod.file, "(*store).get", 6, 21, 1)]);
    await privateMethod.ready();

    const lower = await privateMethod.run({ symbol: "(*store).get" });
    expect(lower.isError, textOf(lower)).toBeFalsy();
    expect(scopeOf(lower).visibility).toBe("package-private");
    expect(limitsOf(lower)).toEqual([
      "one-module",
      "one-port",
      "corresponding-interface-methods-included",
      "indirect-dispatch-not-resolved",
    ]);
  });

  it("addresses a generic-receiver method by its base type", async () => {
    const h = harness();
    h.outline(h.file, [symbol("(*Store[K, V]).Get", 6, 30, 33)]);
    h.prepared([item(h.file, "(*Store[K, V]).Get", 6, 30, 1)]);
    await h.ready();

    for (const spelling of ["Store.Get", "(*Store).Get", "(*Store[K, V]).Get", "(s *Store[K,V]).Get"]) {
      const out = await h.run({ symbol: spelling });
      expect(out.isError, `${spelling}: ${textOf(out)}`).toBeFalsy();
      expect(payload(out).resolved).toMatchObject({ name: "(*Store[K, V]).Get", kind: "method" });
    }
  });

  it("carries the correspondence code for a method subject and not for a function", async () => {
    const h = harness();
    h.outline(h.file, [STORE, GET, symbol("Load", 12, 40, 44)]);
    h.prepared([item(h.file, "Load", 12, 40, 1)]);
    await h.ready();

    const method = await h.run();
    expect(limitsOf(method)).toContain("corresponding-interface-methods-included");

    const fn = await h.run({ symbol: "Load" });
    expect(scopeOf(fn).visibility).toBe("exported");
    // Every callers answer keeps the narrowed dispatch code; the correspondence code is a method's alone.
    expect(limitsOf(fn)).toEqual([
      "one-module",
      "one-port",
      "exported-symbol-importers-invisible",
      "indirect-dispatch-not-resolved",
    ]);
  });

  it("adds osarch-excluded-files when the module holds a file its filename excludes", async () => {
    const h = harness();
    writeFileSync(join(h.mod, "disk_linux.go"), "package mod\n");
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    await h.ready();

    const out = await h.run();
    expect(scopeOf(out).osArchExcluded).toMatchObject({ count: 1 });
    expect(limitsOf(out)).toEqual([
      "one-module",
      "one-port",
      "osarch-excluded-files",
      "exported-symbol-importers-invisible",
      "corresponding-interface-methods-included",
      "indirect-dispatch-not-resolved",
    ]);
  });

  it.each([
    ["an interface", 11],
    ["a struct", 23],
    ["a variable", 13],
    ["a constant", 14],
    ["a field", 8],
  ])("refuses %s, naming the kind with the right article", async (article: string, kind: number) => {
    const h = harness();
    h.outline(h.file, [symbol("Decl", kind, 8)]);
    await h.ready();

    const out = await h.run({ symbol: "Decl" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(`is ${article}`);
    expect(textOf(out)).toMatch(/only a function or a method has callers/);
    expect(textOf(out)).toContain("go_find_references");
    expect(h.server.methods).not.toContain("textDocument/prepareCallHierarchy");
  });

  it.each([
    ["function", 12],
    ["method", 6],
  ])("lets a %s through the kind gate and on to the server", async (_kindName: string, kind: number) => {
    const h = harness();
    h.outline(h.file, [symbol("Do", kind, 8)]);
    h.prepared([]);
    await h.ready();

    const out = await h.run({ symbol: "Do" });
    expect(textOf(out)).not.toMatch(/only a function or a method has callers/);
    expect(textOf(out)).toMatch(/no call-hierarchy item/);
    expect(h.server.methods).toContain("textDocument/prepareCallHierarchy");
  });

  it.each([
    ["an empty list", []],
    ["null", null],
  ])("refuses when prepareCallHierarchy answers %s, and will not substitute references", async (_name: string, answer: unknown) => {
    const h = harness();
    h.prepared(answer as unknown[]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/no call-hierarchy item/);
    expect(textOf(out)).toMatch(/a mention is not a call/);
    expect(h.server.methods).not.toContain("callHierarchy/incomingCalls");
  });

  it("lists every item when prepareCallHierarchy offers several, and never picks one", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.prepared([item(pg, "First", 6, 12), item(pg, "Second", 12, 44)]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/offered 2 call-hierarchy items/);
    expect(textOf(out)).toMatch(/picking one would be a guess/);
    expect(textOf(out)).toContain("First (method) at");
    expect(textOf(out)).toContain("Second (function) at");
    expect(h.server.methods).not.toContain("callHierarchy/incomingCalls");
  });

  it("fails loudly on an incoming call it cannot read rather than reporting fewer callers", async () => {
    const h = harness();
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([{ from: { nonsense: true }, fromRanges: [] }]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/cannot read/);
    expect(textOf(out)).toMatch(/entry 1/);
    expect(textOf(out)).toContain('"(*Store).Get"');
  });

  it("fails at the budget when the initial workspace load was never proven, asking nothing type-aware", async () => {
    const h = harness();
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);

    // The clock is held, so the expiry can only land on the readiness wait: every step above it answers on
    // a microtask, so a starved host cannot spend the 40 ms before the step under test is reached.
    const out = await runUntilBudgetExpires(() => h.run({ timeBudgetMs: 40 }), 40);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/initial workspace load/);
    expect(textOf(out)).toContain("40 ms budget");
    expect(h.server.methods).not.toContain("textDocument/prepareCallHierarchy");
  });

  it("fails at the budget when the incoming calls never arrive, and says which step timed out", async () => {
    const h = harness();
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.hangIncomingCalls();
    await h.ready();

    // Held clock again: the 300 ms can only be spent by the request that never answers, not by an earlier
    // step, and the test no longer waits for real time to pass.
    const out = await runUntilBudgetExpires(() => h.run({ timeBudgetMs: 300 }), 300);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/did not return the incoming calls of "\(\*Store\)\.Get"/);
    expect(textOf(out)).toMatch(/do not read this as an empty answer/);
  }, 10_000);

  it("refuses an answer from a server that restarted while the hierarchy was being prepared", async () => {
    const h = harness();
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.failNextPrepare();
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/gopls restarted during the query/);
    expect(textOf(out)).toMatch(/initial workspace load has not been proven/);
    expect(countOf(h.server, "textDocument/prepareCallHierarchy")).toBe(2);
  }, 10_000);

  it("refuses a query gopls answered with no package metadata, naming the file and the constraint", async () => {
    const h = harness();
    const tagged = join(h.mod, "gpu.go");
    h.refuseCallHierarchy(`no package metadata for file ${tagged}`);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(`"${tagged}"`);
    expect(textOf(out)).toMatch(/Commonly a build constraint/);
  });

  it("propagates any other refusal from the call hierarchy to the caller's handler", async () => {
    const h = harness();
    h.refuseCallHierarchy("no identifier found");
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("no identifier found");
    expect(textOf(out)).not.toMatch(/build constraint/);
  });

  it("names the file it searched when the symbol is not declared there", async () => {
    const h = harness();
    await h.ready();

    const out = await h.run({ symbol: "Absent" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/no top-level declaration named "Absent"/);
    expect(h.server.methods).not.toContain("textDocument/prepareCallHierarchy");
  });

  it("fails rather than guessing a position when gopls reported no selection range", async () => {
    const h = harness();
    h.outline(h.file, [{ name: "Bare", kind: 6, range: { start: { line: 2 }, end: { line: 4 } } }]);
    await h.ready();

    const out = await h.run({ symbol: "Bare" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/no selection range/);
    expect(h.server.methods).not.toContain("textDocument/prepareCallHierarchy");
  });

  it("fails when the module governing the file sits outside the declared roots, naming both", async () => {
    const h = harness();
    const pkg = join(h.mod, "pkg");
    mkdirSync(pkg, { recursive: true });
    const inPkg = join(pkg, "a.go");
    writeFileSync(inPkg, "package pkg\n");

    const out = await h.run({ sourceRoots: [pkg], file: inPkg });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/outside every declared sourceRoots entry/);
    expect(textOf(out)).toContain(resolve(h.mod));
  });

  it("lists every candidate when the name matches more than one top-level declaration", async () => {
    const h = harness();
    h.outline(h.file, [STORE, GET, symbol("(*Store).Get", 6, 60, 62)]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/matches 2 top-level declarations/);
    expect(textOf(out)).toContain(`(*Store).Get (method) at ${h.file}:22`);
    expect(textOf(out)).toContain(`(*Store).Get (method) at ${h.file}:61`);
    expect(h.server.methods).not.toContain("textDocument/prepareCallHierarchy");
  });

  it("refuses a relative file that exists under two declared roots, naming both candidates", async () => {
    const h = harness();
    writeFileSync(join(h.tmp, "store.go"), "package mod\n");

    const out = await h.run({ sourceRoots: [h.tmp, h.mod], file: "store.go" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/exists under more than one declared root/);
    expect(textOf(out)).toContain(resolve(h.tmp));
    expect(textOf(out)).toContain(resolve(join(h.mod, "store.go")));
    expect(textOf(out)).toContain("pass an absolute path");
    // Deciding between roots is a boundary question, so it is settled before any child is started.
    expect(h.server.methods).toEqual([]);
  });

  it("fails with gopls's own unavailability text when no session can be obtained", async () => {
    const h = harness({ spawn: missingGoplsSpawn() });

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("Cannot start gopls");
    expect(textOf(out)).toContain("MCP_CODE_NAV_GOPLS");
    expect(textOf(out)).toContain("go install golang.org/x/tools/gopls@latest");
  });

  it("keeps the tried spellings of a relative file when the prelude throws on the way to an answer", async () => {
    const h = harness({
      spawn: () => {
        throw new Error("Cannot start gopls: \"gopls\" on PATH was not found");
      },
    });

    const out = await h.run({ sourceRoots: [h.tmp, h.mod], file: "store.go" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("Cannot start gopls");
    expect(textOf(out)).toMatch(/Resolved "store\.go" to "/);
    expect(textOf(out)).toMatch(/\(tried: "/);
  });

  it("roots gopls at the module and asks only methods its config allows", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 45)]);
    h.prepared([item(h.file, "(*Store).Get", 6, 21, 1)]);
    h.incoming([incoming(item(pg, "Serve", 12, 39), [{ line: 43, character: 11 }])]);
    await h.ready();
    await h.run();

    expect(h.server.requests[0]?.[1]).toMatchObject({ rootUri: uriOf(resolve(h.mod)) });
    expect(h.server.methods).toEqual([
      "initialize",
      "textDocument/documentSymbol",
      "textDocument/documentSymbol",
      "textDocument/prepareCallHierarchy",
      "callHierarchy/incomingCalls",
      "textDocument/documentSymbol",
    ]);
  });
});
