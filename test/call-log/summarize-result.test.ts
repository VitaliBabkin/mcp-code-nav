import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { RESULT_COUNT_SELECTORS, type CallRecord } from "../../src/call-log/record.js";
import { pickArgs, summarizeCall, withinRecordCap } from "../../src/call-log/summarize-result.js";
import { cleanExec } from "../helpers/cpp-find-derived-classes.js";
import { runCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A C++ `scope` block, as `cpp-navigation-shared.ts` builds it. */
const cppScope = {
  projectRoot: "D:\\build",
  index: { state: "quiescent", staleFiles: { count: 0, files: [] } },
  uncoveredSources: { count: 0, files: [] },
  limits: ["compile-database-only"],
};

/** A Go `scope` block, as `go-navigation-shared.ts` builds it. */
const goScope = {
  moduleRoot: "D:\\mod",
  freshness: { kind: "unchanged" },
  visibility: "exported",
  environment: { goos: "windows", goarch: "amd64", cgoEnabled: true, buildTags: [], goWork: null },
  osArchExcluded: { count: 0, files: [], namedFileExcluded: false },
  limits: ["one-module", "one-port", "listing-capped"],
};

/** A TS `scope` block, as `ts-navigation-shared.ts` builds it. */
const tsScope = {
  workspaceRoot: "D:\\ws",
  enclosingWorkspace: null,
  freshness: { kind: "unchanged" },
  server: { version: "7.0.2" },
  workspaceTypescript: null,
  projects: { count: 1, configs: ["D:\\ws\\tsconfig.json"], failed: [], subsumed: [] },
  uncoveredSources: { count: 0, files: [], namedFileUncovered: false },
  limits: ["one-workspace"],
};

/** One realistic answer per tool, keyed by the tool the selector belongs to. */
const REAL_ANSWERS: Record<string, { payload: unknown; results: number }> = {
  cpp_file_symbols: {
    payload: { symbols: [{ name: "Foo", kind: "class", range: { startLine: 1, endLine: 3 } }, {}, {}] },
    results: 3,
  },
  go_file_symbols: { payload: { symbols: [] }, results: 0 },
  cpp_find_symbol: {
    payload: { name: "Foo", kind: "class", file: "D:\\src\\a.cpp", range: { startLine: 1, endLine: 3 }, scope: cppScope },
    results: 1,
  },
  go_find_symbol: {
    payload: { declarations: [{ name: "Store" }, { name: "Open" }, { name: "Close" }], scope: { ...goScope, lookup: "workspace-symbol" } },
    results: 3,
  },
  cpp_find_references: {
    payload: {
      resolved: { name: "Foo", kind: "class", file: "D:\\src\\a.cpp", line: 3 },
      totalReferences: 12,
      files: [{ file: "D:\\src\\a.cpp", external: false, count: 12, sitesTruncated: 0, sites: [] }],
      filesTruncated: 0,
      scope: cppScope,
    },
    results: 12,
  },
  go_find_references: {
    payload: {
      resolved: { name: "Store", kind: "interface", file: "D:\\mod\\s.go", line: 4 },
      totalReferences: 7,
      files: [],
      filesTruncated: 0,
      scope: goScope,
    },
    results: 7,
  },
  cpp_find_callers: {
    payload: {
      resolved: { name: "Run", kind: "function", file: "D:\\src\\a.cpp", line: 8 },
      totalCallers: 2,
      callers: [{ name: "Main", kind: "function", file: "D:\\src\\b.cpp", line: 3, external: false, callSites: [], callSitesTruncated: 0 }, {}],
      callersTruncated: 0,
      scope: { ...cppScope, limits: ["compile-database-only", "indirect-dispatch-not-resolved", "listing-capped"] },
    },
    results: 2,
  },
  go_find_callers: {
    payload: {
      resolved: { name: "Open", kind: "method", file: "D:\\mod\\s.go", line: 11 },
      totalCallers: 4,
      callers: [],
      callersTruncated: 0,
      scope: goScope,
    },
    results: 4,
  },
  cpp_find_derived_classes: {
    payload: {
      derivation: "transitive",
      matches: [{ className: "Widget", file: "D:\\src\\w.cpp", line: 4, column: 7, direct: false }],
      counts: { transitive: 1, direct: 1 },
      sweep: { totalTus: 9, cachedTus: 4, elapsedMs: 320, cache: "partial", uncoveredSources: { count: 0, files: [] } },
    },
    results: 1,
  },
  go_find_implementations: {
    payload: {
      resolved: { name: "Store", kind: "interface", file: "D:\\mod\\s.go", line: 4 },
      direction: "implementers-of-interface",
      implementations: [{ name: "PgStore", kind: "struct", file: "D:\\mod\\pg.go", line: 9, external: false }],
      truncated: 0,
      scope: { moduleRoot: "D:\\mod", freshness: { kind: "unchanged" }, environment: goScope.environment, osArchExcluded: goScope.osArchExcluded },
    },
    results: 1,
  },
  ts_file_symbols: { payload: { symbols: [{ name: "Driver" }, { name: "run" }] }, results: 2 },
  ts_find_symbol: {
    payload: { declarations: [{ name: "Driver" }, { name: "Driver" }, { name: "Driver" }], scope: { ...tsScope, lookup: "workspace-symbol" } },
    results: 3,
  },
  ts_find_references: {
    payload: {
      resolved: { name: "Driver", kind: "class", file: "D:\\ws\\a.ts", line: 3 },
      totalReferences: 9,
      files: [],
      filesTruncated: 0,
      scope: tsScope,
    },
    results: 9,
  },
  ts_find_callers: {
    payload: {
      resolved: { name: "run", kind: "function", file: "D:\\ws\\a.ts", line: 8 },
      totalCallers: 5,
      callers: [],
      callersTruncated: 0,
      scope: tsScope,
    },
    results: 5,
  },
  ts_find_implementations: {
    payload: {
      resolved: { name: "Storage", kind: "interface", file: "D:\\ws\\a.ts", line: 1 },
      implementations: [{ name: "Driver", kind: "class", file: "D:\\ws\\d.ts", line: 2, external: false }],
      truncated: 0,
      scope: tsScope,
    },
    results: 1,
  },
};

describe("each result-count selector against the payload its own tool answers with", () => {
  for (const [tool, answer] of Object.entries(REAL_ANSWERS)) {
    it(`${tool} counts what its payload actually carries`, () => {
      expect(RESULT_COUNT_SELECTORS[tool]?.(answer.payload)).toBe(answer.results);
    });
  }

  it("reads the same key out of a payload the real sweep tool produced", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-code-nav-sel-"));
    tempDirs.push(root);
    writeFileSync(join(root, "a.cpp"), "class Base {};\n");
    writeFileSync(join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "a.cpp" }]));

    const out = await runCppFindDerivedClasses(
      { exec: cleanExec, cache: new SweepCache() },
      { projectRoot: root, qualifiedName: "Base" },
    );
    const payload = out.structuredContent as { matches: unknown[] };

    expect(RESULT_COUNT_SELECTORS.cpp_find_derived_classes?.(payload)).toBe(0);
    const withRows = { ...payload, matches: [{}, {}, {}] };
    expect(RESULT_COUNT_SELECTORS.cpp_find_derived_classes?.(withRows)).toBe(3);
  });
});

describe("pickArgs", () => {
  it("records the allow-listed keys and names every other one without its value", () => {
    const picked = pickArgs({
      projectRoot: "D:\\build",
      files: ["a.cpp", "b.cpp"],
      depth: 1,
      includeDeclaration: false,
      auditToken: { user: "me" },
      blob: null,
    });

    expect(picked.args).toEqual({
      projectRoot: "D:\\build",
      files: ["a.cpp", "b.cpp"],
      depth: 1,
      includeDeclaration: false,
    });
    expect(picked.argKeys).toEqual(["auditToken", "blob"]);
  });

  it("caps a string at 300 characters and an array at 20 entries", () => {
    const picked = pickArgs({ file: "x".repeat(400), sourceRoots: Array.from({ length: 40 }, (_u, i) => `r${i}`) });

    expect(picked.args.file).toHaveLength(300);
    expect(picked.args.sourceRoots).toHaveLength(20);
    expect((picked.args.sourceRoots as string[]).at(-1)).toBe("r19");
  });

  it("keeps an array of non-strings out of the record entirely, naming it instead", () => {
    const picked = pickArgs({ files: [{ path: "a.cpp" }], mixed: [1, "a"], sourceRoots: ["a", "b"] });

    expect(picked.argKeys).toEqual(["files", "mixed"]);
    expect(picked.args.sourceRoots).toEqual(["a", "b"]);
  });

  it("bounds the names it is left with, so a caller's key list cannot outgrow the record", () => {
    const many = Object.fromEntries(
      Array.from({ length: 400 }, (_unused, index) => [`audit${"k".repeat(120)}${index}`, {}]),
    );
    const picked = pickArgs(many);

    expect(picked.argKeys.length).toBeLessThanOrEqual(100);
    expect(picked.argKeys.every((key) => key.length <= 80)).toBe(true);
  });

  it("reads nothing from arguments that are absent or not an object", () => {
    for (const raw of [undefined, null, "a string", 42, ["projectRoot"]]) {
      expect(pickArgs(raw)).toEqual({ args: {}, argKeys: [] });
    }
  });

  it("drops a number that could not be stored, rather than recording NaN", () => {
    expect(pickArgs({ timeBudgetMs: Number.NaN }).argKeys).toEqual(["timeBudgetMs"]);
  });
});

describe("withinRecordCap", () => {
  const record = (over: Partial<CallRecord> = {}): CallRecord => ({
    v: 1,
    type: "call",
    run: "run-1",
    seq: 1,
    ts: "2026-09-30T10:00:00.000Z",
    tool: "cpp_find_derived_classes",
    lang: "cpp",
    project: "D:\\build",
    args: { qualifiedName: "Base" },
    argKeys: [],
    ms: 5,
    inflight: 0,
    outcome: "ok",
    errorClass: null,
    errorHead: null,
    limits: [],
    results: 0,
    capped: false,
    cache: null,
    indexState: null,
    spawned: null,
    readyWaitMs: null,
    textBytes: 0,
    ...over,
  });

  it("leaves a record the size allows untouched", () => {
    const capped = withinRecordCap(record());

    expect(capped).toEqual(record());
    expect(capped.argsDropped).toBeUndefined();
  });

  it("drops the arguments whole when the record would pass 4 KiB", () => {
    const fat = record({ args: { projectRoot: "p".repeat(300), files: Array.from({ length: 20 }, () => "f".repeat(300)) } });
    const capped = withinRecordCap(fat);

    expect(capped.args).toEqual({});
    expect(capped.argsDropped).toBe(true);
    expect(capped.argKeys).toEqual([]);
    expect(JSON.stringify(capped).length).toBeLessThan(JSON.stringify(fat).length);
  });

  it("goes on to the argument names when dropping the values did not make it fit", () => {
    const fat = record({
      args: { projectRoot: "p".repeat(300) },
      argKeys: Array.from({ length: 100 }, (_unused, index) => `a${index}${"k".repeat(78)}`),
    });
    const capped = withinRecordCap(fat);

    expect(capped.args).toEqual({});
    expect(capped.argKeys).toEqual([]);
    expect(capped.argsDropped).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(capped), "utf8")).toBeLessThan(4096);
  });
});

describe("summarizeCall", () => {
  const message = (result: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, result });

  it("calls an answer without `isError` ok and reads nothing as an error", () => {
    const summary = summarizeCall("cpp_find_symbol", message({ content: [{ type: "text", text: "found" }], structuredContent: { name: "Foo", scope: cppScope } }), {});

    expect(summary).toMatchObject({
      outcome: "ok",
      errorClass: null,
      errorHead: null,
      results: 1,
      limits: ["compile-database-only"],
      capped: false,
      indexState: "quiescent",
      cache: null,
      project: "D:\\build",
      textBytes: 5,
    });
  });

  it("calls `isError` with a payload partial, which is what a stopped sweep answers with", () => {
    const summary = summarizeCall(
      "cpp_find_derived_classes",
      message({ content: [{ type: "text", text: "stopped" }], structuredContent: REAL_ANSWERS.cpp_find_derived_classes?.payload, isError: true }),
      { projectRoot: "D:\\build" },
    );

    expect(summary).toMatchObject({
      outcome: "partial",
      errorClass: "other",
      results: 1,
      cache: "partial",
      project: "D:\\build",
    });
  });

  it("classifies an `isError` answer from the first text block only", () => {
    const first = '"D:\\src\\gen\\a.cpp" is pre-excluded by this project\'s ignoredPaths config';
    const summary = summarizeCall(
      "cpp_file_symbols",
      message({
        isError: true,
        content: [
          { type: "text", text: first },
          { type: "text", text: "ignoredPaths" },
        ],
      }),
      {},
    );

    expect(summary.errorClass).toBe("path-ignored");
    expect(summary.textBytes).toBe(Buffer.byteLength(first, "utf8") + "ignoredPaths".length);
  });

  it("counts the bytes a caller read, in UTF-8 rather than in code units", () => {
    const summary = summarizeCall("cpp_file_symbols", message({ content: [{ type: "text", text: "Ω Ω" }] }), {});

    expect(summary.textBytes).toBe(5);
  });

  it("ignores content blocks that are not text", () => {
    const summary = summarizeCall("cpp_file_symbols", message({ content: [{ type: "image", data: "AAA" }, { type: "text", text: "x" }] }), {});

    expect(summary.textBytes).toBe(1);
  });

  it("reads a JSON-RPC error response as protocol-error and derives nothing from a payload", () => {
    const summary = summarizeCall("cpp_file_symbols", { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Input validation error: nope" } }, {});

    expect(summary).toMatchObject({
      outcome: "protocol-error",
      errorClass: "input-invalid",
      results: null,
      limits: [],
      capped: false,
      textBytes: 0,
      cache: null,
      indexState: null,
    });
  });

  it("answers nothing at all, and never throws, for a message that is neither", () => {
    for (const response of [undefined, null, "text", [], { jsonrpc: "2.0", method: "notifications/progress" }]) {
      expect(() => summarizeCall("cpp_file_symbols", response, {})).not.toThrow();
    }
    expect(summarizeCall("cpp_file_symbols", undefined, {}).outcome).toBe("ok");
  });

  it("keeps a state a newer payload invented out of an enum field", () => {
    const summary = summarizeCall(
      "cpp_find_derived_classes",
      message({ structuredContent: { matches: [], sweep: { cache: "rebuild" }, scope: { index: { state: "warming" }, limits: ["listing-capped", 7] } } }),
      {},
    );

    expect(summary.cache).toBeNull();
    expect(summary.indexState).toBeNull();
    expect(summary.limits).toEqual(["listing-capped"]);
    expect(summary.capped).toBe(true);
  });

  it("takes a TS answer's project from its workspace root, else the first declared root", () => {
    const answer = message({ structuredContent: { declarations: [], scope: tsScope } });

    expect(summarizeCall("ts_find_symbol", answer, { sourceRoots: ["D:\\ws\\packages"] }).project).toBe("D:\\ws");
    expect(
      summarizeCall("ts_find_symbol", message({ structuredContent: { declarations: [] } }), { sourceRoots: ["D:\\ws\\packages"] }).project,
    ).toBe("D:\\ws\\packages");
  });

  it("takes the project from the C++ argument, then the Go module, then the first declared root", () => {
    const goAnswer = message({ structuredContent: { declarations: [], scope: goScope } });

    expect(summarizeCall("cpp_find_symbol", message({ structuredContent: { name: "F" } }), { projectRoot: "D:\\b" }).project).toBe("D:\\b");
    expect(summarizeCall("go_find_symbol", goAnswer, { sourceRoots: ["D:\\mod"] }).project).toBe("D:\\mod");
    expect(summarizeCall("go_find_symbol", message({ structuredContent: { declarations: [] } }), { sourceRoots: ["D:\\mod", "D:\\other"] }).project).toBe("D:\\mod");
    expect(summarizeCall("go_find_symbol", message({ structuredContent: { declarations: [] } }), {}).project).toBeNull();
    expect(summarizeCall("go_find_symbol", goAnswer, { sourceRoots: [3] as never }).project).toBe("D:\\mod");
  });

  it("caps the root a payload names, so a record cannot be filled by one path", () => {
    const long = "p".repeat(900);

    expect(
      summarizeCall("cpp_find_symbol", message({ structuredContent: { name: "F", scope: { ...cppScope, projectRoot: long } } }), {}).project,
    ).toHaveLength(300);
    expect(
      summarizeCall("go_find_symbol", message({ structuredContent: { declarations: [], scope: { ...goScope, moduleRoot: long } } }), {}).project,
    ).toHaveLength(300);
  });

  it("has no selector entry for a tool the server does not have, and answers null", () => {
    expect(summarizeCall("no_such_tool", message({ content: [], structuredContent: { symbols: [{}] } }), {}).results).toBeNull();
  });
});
