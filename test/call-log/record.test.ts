import { describe, expect, it } from "vitest";
import { CallLogLine, LOGGED_ARG_KEYS, RESULT_COUNT_SELECTORS, RunRecord } from "../../src/call-log/record.js";

const REGISTERED_TOOLS = [
  "cpp_file_symbols",
  "cpp_find_symbol",
  "cpp_find_references",
  "cpp_find_callers",
  "cpp_find_derived_classes",
  "go_file_symbols",
  "go_find_symbol",
  "go_find_references",
  "go_find_callers",
  "go_find_implementations",
  "ts_file_symbols",
  "ts_find_symbol",
  "ts_find_references",
  "ts_find_callers",
  "ts_find_implementations",
];

function callLine(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: "call",
    run: "run-1",
    seq: 1,
    ts: "2026-09-30T10:00:00.000Z",
    tool: "cpp_file_symbols",
    lang: "cpp",
    project: "D:\\build",
    args: { file: "a.cpp" },
    argKeys: [],
    ms: 12,
    inflight: 0,
    outcome: "ok",
    errorClass: null,
    errorHead: null,
    limits: ["compile-database-only"],
    results: 3,
    capped: false,
    cache: null,
    indexState: null,
    spawned: true,
    readyWaitMs: null,
    textBytes: 128,
    ...overrides,
  };
}

describe("LOGGED_ARG_KEYS", () => {
  it("is exactly the argument names allowed in plaintext", () => {
    expect([...LOGGED_ARG_KEYS].sort()).toEqual(
      [
        "anchor",
        "derivation",
        "depth",
        "file",
        "files",
        "includeDeclaration",
        "kind",
        "name",
        "projectRoot",
        "qualifiedName",
        "sourceRoots",
        "symbol",
        "timeBudgetMs",
      ].sort(),
    );
  });
});

describe("RESULT_COUNT_SELECTORS", () => {
  it("covers every registered tool, so an answer count is never silently absent", () => {
    expect(Object.keys(RESULT_COUNT_SELECTORS).sort()).toEqual([...REGISTERED_TOOLS].sort());
  });

  for (const tool of REGISTERED_TOOLS.filter((name) => name !== "cpp_find_symbol")) {
    it(`answers null rather than throwing for ${tool} without a payload`, () => {
      const select = RESULT_COUNT_SELECTORS[tool];
      expect(select).toBeDefined();
      for (const payload of [undefined, null, "text", 7, [], {}, { symbols: null, totalReferences: -1 }]) {
        expect(select?.(payload)).toBeNull();
      }
    });
  }

  it("counts a list rather than a same-named scalar", () => {
    expect(RESULT_COUNT_SELECTORS.cpp_file_symbols?.({ symbols: 3 })).toBeNull();
    expect(RESULT_COUNT_SELECTORS.go_find_references?.({ totalReferences: "4" })).toBeNull();
  });

  it("counts an empty answer as zero, not as absent", () => {
    expect(RESULT_COUNT_SELECTORS.cpp_find_derived_classes?.({ matches: [] })).toBe(0);
    expect(RESULT_COUNT_SELECTORS.go_find_symbol?.({ declarations: [] })).toBe(0);
  });

  it("reports the one declaration cpp_find_symbol answers with even though it lists nothing", () => {
    expect(RESULT_COUNT_SELECTORS.cpp_find_symbol?.({ name: "Foo", kind: "class" })).toBe(1);
  });
});

describe("CallLogLine", () => {
  const header = {
    v: 1,
    type: "run",
    run: "run-1",
    ts: "2026-09-30T10:00:00.000Z",
    pid: 4242,
    build: "v1.2.3",
    node: "v22.9.0",
    cwd: "D:\\work",
    protocol: "2025-06-18",
    client: { name: "claude-code", version: "1.2.3", title: "Claude Code" },
  };

  it("accepts the run header, which is the first line of every file", () => {
    expect(RunRecord.safeParse(header).success).toBe(true);
    expect(CallLogLine.safeParse(header).data?.type).toBe("run");
  });

  it("accepts a call record with only the allow-listed argument shapes", () => {
    const parsed = CallLogLine.safeParse(
      callLine({ args: { s: "x", n: 2, b: true, list: ["a"] } }),
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses an object argument value, which is why the tap names such a key instead", () => {
    expect(CallLogLine.safeParse(callLine({ args: { nested: { a: 1 } } })).success).toBe(false);
  });

  it("refuses another writer's version rather than guessing its fields", () => {
    expect(CallLogLine.safeParse(callLine({ v: 2 })).success).toBe(false);
    expect(CallLogLine.safeParse({ ...header, v: 2 }).success).toBe(false);
  });

  it("accepts the run's closing line, which is what says how much the queue refused", () => {
    const closing = { v: 1, type: "close", run: "run-1", ts: "2026-09-30T10:00:00.000Z", dropped: 3 };

    expect(CallLogLine.safeParse(closing).success).toBe(true);
    expect(CallLogLine.safeParse({ ...closing, dropped: -1 }).success).toBe(false);
    expect(CallLogLine.safeParse({ ...closing, dropped: 1.5 }).success).toBe(false);
  });

  it("refuses a line that is none of the three kinds", () => {
    expect(CallLogLine.safeParse({ v: 1, type: "delta", run: "run-1" }).success).toBe(false);
  });

  it("refuses a tool name longer than the cap the tap enforces", () => {
    expect(CallLogLine.safeParse(callLine({ tool: "x".repeat(81) })).success).toBe(false);
    expect(CallLogLine.safeParse(callLine({ tool: "x".repeat(80) })).success).toBe(true);
  });

  it("refuses a non-positive sequence or a negative duration", () => {
    expect(CallLogLine.safeParse(callLine({ seq: 0 })).success).toBe(false);
    expect(CallLogLine.safeParse(callLine({ ms: -1 })).success).toBe(false);
    expect(CallLogLine.safeParse(callLine({ inflight: -1 })).success).toBe(false);
  });

  it("keeps the enums closed where a response could only name a known state", () => {
    expect(CallLogLine.safeParse(callLine({ outcome: "timeout" })).success).toBe(false);
    expect(CallLogLine.safeParse(callLine({ cache: "stale" })).success).toBe(false);
    expect(CallLogLine.safeParse(callLine({ indexState: "warm" })).success).toBe(false);
    // A newer writer's error class must still read, which is why `errorClass` is a plain string.
    expect(CallLogLine.safeParse(callLine({ errorClass: "some-new-class" })).success).toBe(true);
  });
});
