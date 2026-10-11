import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_WINDOW_EVENTS,
  RETRY_MAX_GAP_MS,
  RETRY_WINDOW_EVENTS,
  buildReport,
  detectFallbacks,
  detectRetries,
  parseTranscript,
  renderText,
  scanTranscripts,
  summarizeTranscripts,
  type StatsOptions,
  type TranscriptCall,
} from "../../scripts/call-stats.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "call-stats");
const transcripts = join(fixtures, "transcripts");
const windowedTranscripts = join(fixtures, "transcripts-windowed");
const coverageTranscripts = join(fixtures, "transcripts-coverage");
const logs = join(fixtures, "logs");
const missingLogs = join(fixtures, "no-such-directory");
const NO_WINDOW = { from: null, to: null };
const OURS = "mcp__mcp-code-nav__";

/* The proxies are always fed what the parser produces, so block order and result pairing come from a real file. */

type Block = Record<string, unknown>;

function use(id: string, tool: string, input: Record<string, unknown> = {}): Block {
  return { type: "tool_use", id, name: tool.startsWith(OURS) ? tool : `${OURS}${tool}`, input };
}

function foreignUse(id: string, tool: string, input: Record<string, unknown> = {}): Block {
  return { type: "tool_use", id, name: tool, input };
}

function okResult(id: string, text = "answered"): Block {
  return { type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] };
}

function failedResult(id: string, text: string): Block {
  return { type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text }] };
}

function assistant(timestamp: string, blocks: Block[]): string {
  return JSON.stringify({ type: "assistant", timestamp, message: { role: "assistant", content: blocks } });
}

function user(timestamp: string, blocks: Block[]): string {
  return JSON.stringify({ type: "user", timestamp, message: { role: "user", content: blocks } });
}

function parse(lines: string[]): TranscriptCall[] {
  return parseTranscript(lines.join("\n"), "mcp-code-nav");
}

/** A failed `cpp_find_symbol` of `name`, answered at `stamp`, with the text its producer really emits. */
function failingSymbolCall(id: string, name: string, stamp: string): string[] {
  return [
    assistant(stamp, [use(id, "cpp_find_symbol", { name })]),
    user(stamp, [failedResult(id, `no symbol "${name}" in the outline of src/a.cpp`)]),
  ];
}

function options(over: Partial<StatsOptions>): StatsOptions {
  return { logs, transcripts, serverName: "mcp-code-nav", window: NO_WINDOW, json: false, ...over };
}

describe("the proxy windows", () => {
  it("are the numbers, pinned here so a change is a decision", () => {
    expect(RETRY_WINDOW_EVENTS).toBe(3);
    expect(RETRY_MAX_GAP_MS).toBe(600_000);
    expect(FALLBACK_WINDOW_EVENTS).toBe(5);
  });
});

describe("parseTranscript", () => {
  it("pairs a tool_use with the tool_result that answers it and keeps the client's own span", () => {
    const [first] = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("t1", "cpp_file_symbols", { file: "a.cpp" })]),
      user("2026-09-30T10:00:01.500Z", [okResult("t1", "3 symbols")]),
    ]);
    expect(first).toMatchObject({
      ours: "cpp_file_symbols",
      input: { file: "a.cpp" },
      ok: true,
      endMs: Date.parse("2026-09-30T10:00:01.500Z"),
      resultPos: 1,
      usePos: 0,
    });
  });

  it("classifies this server's failure, marks the client-side class, and keeps no result text at all", () => {
    const calls = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("t1", "cpp_file_symbols"), foreignUse("t2", "Read")]),
      user("2026-09-30T10:00:00.100Z", [
        failedResult("t1", 'MCP error -32602: Input validation error: [InputValidationError] for "D:\\repo"'),
        failedResult("t2", "Read failed: EACCES denied on a 900 kilobyte file"),
      ]),
    ]);
    expect(calls[0]).toMatchObject({ clientSide: true, errorClass: "client-side-rejection", ok: false });
    expect(calls[1]).toMatchObject({ ours: null, ok: false, errorClass: null, errorHead: null, clientSide: false });
    expect(calls.map((call) => Object.hasOwn(call, "text"))).toEqual([false, false]);
  });

  it("classifies a real failure of ours with the writer's own classifier", () => {
    const [call] = parse(failingSymbolCall("t1", "Widget", "2026-09-30T10:00:00.000Z"));
    expect(call).toMatchObject({ ok: false, errorClass: "symbol-not-found" });
  });

  it("leaves a call nobody answered counted as a call, with no result position to measure from", () => {
    const [only] = parse([assistant("2026-09-30T10:00:00.000Z", [use("t1", "go_file_symbols")])]);
    expect(only).toMatchObject({ ok: null, endMs: null, resultPos: null, errorClass: null });
  });

  it("strips only the configured server's prefix and ignores records with no tool blocks", () => {
    const calls = parse([
      assistant("2026-09-30T10:00:00.000Z", [{ type: "tool_use", id: "t1", name: "mcp__other__cpp_file_symbols", input: {} }]),
      JSON.stringify({ type: "summary", timestamp: "2026-09-30T10:00:01.000Z", summary: "walked the outline" }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ours: null, tool: "mcp__other__cpp_file_symbols" });
  });
});

describe("detectRetries", () => {
  it("counts a retry at three intervening tool events and lets it go at four", () => {
    const filler = (id: string, stamp: string) => [
      assistant(stamp, [foreignUse(id, "Read", { path: `${id}.md` })]),
      user(stamp, [okResult(id)]),
    ];
    const a = failingSymbolCall("A", "Widget", "2026-09-30T10:00:00.000Z");
    const three = parse([...a, ...filler("f1", "10:00:01"), ...filler("f2", "10:00:02"), ...filler("f3", "10:00:03"), ...a]);
    expect(detectRetries(three, NO_WINDOW)).toHaveLength(1);
    const four = parse([...a, ...filler("f1", "10:00:01"), ...filler("f2", "10:00:02"), ...filler("f3", "10:00:03"), ...filler("f4", "10:00:04"), ...a]);
    expect(detectRetries(four, NO_WINDOW)).toHaveLength(0);
  });

  it("takes 600 s after the failed call's result as inside the gap and 600 s 1 ms as outside it", () => {
    const inside = parse([
      ...failingSymbolCall("A", "Widget", "2026-09-30T10:00:00.000Z"),
      ...failingSymbolCall("B", "Widget", "2026-09-30T10:10:00.000Z"),
    ]);
    expect(detectRetries(inside, NO_WINDOW)).toHaveLength(1);
    const outside = parse([
      ...failingSymbolCall("A", "Widget", "2026-09-30T10:00:00.000Z"),
      ...failingSymbolCall("B", "Widget", "2026-09-30T10:10:00.001Z"),
    ]);
    expect(detectRetries(outside, NO_WINDOW)).toHaveLength(0);
  });

  it("names the keys whose values differ, and calls a reordered argument identical", () => {
    const changed = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("A", "cpp_file_symbols", { file: "a.cpp", projectRoot: "D:\\repo" })]),
      user("2026-09-30T10:00:00.000Z", [failedResult("A", 'compile_commands.json not found or unreadable at "D:\\repo"')]),
      assistant("2026-09-30T10:00:01.000Z", [use("B", "cpp_file_symbols", { file: "a.cpp", projectRoot: "D:\\build" })]),
      user("2026-09-30T10:00:01.000Z", [okResult("B")]),
    ]);
    expect(detectRetries(changed, NO_WINDOW)).toEqual([
      { tool: "cpp_file_symbols", changed: true, changedKeys: ["projectRoot"], recovered: true },
    ]);
    const reordered = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("A", "cpp_find_symbol", { name: "Widget", projectRoot: "D:\\a" })]),
      user("2026-09-30T10:00:00.000Z", [failedResult("A", 'no symbol "Widget"')]),
      assistant("2026-09-30T10:00:01.000Z", [use("B", "cpp_find_symbol", { projectRoot: "D:\\a", name: "Widget" })]),
      user("2026-09-30T10:00:01.000Z", [failedResult("B", 'no symbol "Widget"')]),
    ]);
    expect(detectRetries(reordered, NO_WINDOW)).toEqual([
      { tool: "cpp_find_symbol", changed: false, changedKeys: [], recovered: false },
    ]);
  });

  it("never treats a repeat of a successful call as a retry", () => {
    const success = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("A", "cpp_find_symbol", { name: "Widget" })]),
      user("2026-09-30T10:00:00.000Z", [okResult("A")]),
      assistant("2026-09-30T10:00:01.000Z", [use("B", "cpp_find_symbol", { name: "Other" })]),
      user("2026-09-30T10:00:01.000Z", [okResult("B")]),
    ]);
    expect(detectRetries(success, NO_WINDOW)).toHaveLength(0);
  });

  it("gives each failure its own next call, so one retry never belongs to two failures", () => {
    const chain = parse([
      ...failingSymbolCall("A", "Widget", "2026-09-30T10:00:00.000Z"),
      ...failingSymbolCall("B", "Widget", "2026-09-30T10:00:01.000Z"),
      assistant("2026-09-30T10:00:02.000Z", [use("C", "cpp_find_symbol", { name: "Widget" })]),
      user("2026-09-30T10:00:02.000Z", [okResult("C")]),
    ]);
    const retries = detectRetries(chain, NO_WINDOW);
    expect(retries).toHaveLength(2);
    expect(retries[1]?.recovered).toBe(true);
  });

  it("does not read a same-tool sibling issued before the result as the reaction to it", () => {
    const parallel = parse([
      assistant("2026-09-30T10:00:00.000Z", [
        use("A", "cpp_find_callers", { symbol: "Store.Open" }),
        use("B", "cpp_find_callers", { symbol: "Store.Close" }),
      ]),
      user("2026-09-30T10:00:00.500Z", [failedResult("A", 'no symbol "Store.Open"'), okResult("B")]),
    ]);
    expect(detectRetries(parallel, NO_WINDOW)).toHaveLength(0);
  });

  it("spends the event window only on events after the result, not on the batch that preceded it", () => {
    const sibling = foreignUse("S", "Read", { path: "notes.md" });
    const lines = [
      assistant("2026-09-30T10:00:00.000Z", [use("A", "cpp_find_symbol", { name: "Widget" }), sibling]),
      user("2026-09-30T10:00:00.000Z", [failedResult("A", 'no symbol "Widget"'), okResult("S")]),
      assistant("2026-09-30T10:00:01.000Z", [foreignUse("f1", "Read")]),
      user("2026-09-30T10:00:01.000Z", [okResult("f1")]),
      assistant("2026-09-30T10:00:02.000Z", [foreignUse("f2", "Read")]),
      user("2026-09-30T10:00:02.000Z", [okResult("f2")]),
      assistant("2026-09-30T10:00:03.000Z", [foreignUse("f3", "Read")]),
      user("2026-09-30T10:00:03.000Z", [okResult("f3")]),
      ...failingSymbolCall("B", "Widget", "2026-09-30T10:00:04.000Z"),
    ];
    expect(detectRetries(parse(lines), NO_WINDOW)).toHaveLength(1);
  });

  it("credits the parallel sibling's own retry, not the one that merely overwrote its slot", () => {
    const parallel = parse([
      assistant("2026-09-30T10:00:00.000Z", [
        use("A1", "cpp_find_symbol", { name: "Foo" }),
        use("A2", "cpp_find_symbol", { name: "Bar" }),
      ]),
      user("2026-09-30T10:00:00.100Z", [failedResult("A1", 'no symbol "Foo"'), failedResult("A2", 'no symbol "Bar"')]),
      assistant("2026-09-30T10:00:01.000Z", [use("C", "cpp_find_symbol", { name: "Foo" })]),
      user("2026-09-30T10:00:01.100Z", [okResult("C")]),
    ]);
    expect(detectRetries(parallel, NO_WINDOW)).toEqual([
      { tool: "cpp_find_symbol", changed: false, changedKeys: [], recovered: true },
    ]);
  });

  it("keeps a slot per waiting failure, so a batch of them is credited one per later call", () => {
    const batch = parse([
      assistant("2026-09-30T10:00:00.000Z", [
        use("A1", "cpp_find_symbol", { name: "Foo" }),
        use("A2", "cpp_find_symbol", { name: "Bar" }),
      ]),
      user("2026-09-30T10:00:00.100Z", [failedResult("A1", 'no symbol "Foo"'), failedResult("A2", 'no symbol "Bar"')]),
      assistant("2026-09-30T10:00:01.000Z", [use("C", "cpp_find_symbol", { name: "Foo" })]),
      user("2026-09-30T10:00:01.100Z", [failedResult("C", 'no symbol "Foo"')]),
      assistant("2026-09-30T10:00:02.000Z", [use("D", "cpp_find_symbol", { name: "Bar" })]),
      user("2026-09-30T10:00:02.100Z", [okResult("D")]),
    ]);
    const retries = detectRetries(batch, NO_WINDOW);
    expect(retries).toHaveLength(2);
    expect(retries.map((retry) => retry.changedKeys)).toEqual([[], []]);
    expect(retries.map((retry) => retry.recovered)).toEqual([false, true]);
  });

  it("claims nothing for a failure whose result never arrived, nor for a tool the server is not", () => {
    const unanswered = parse([
      ...failingSymbolCall("A", "Widget", "2026-09-30T10:00:00.000Z").slice(0, 1),
      assistant("2026-09-30T10:00:01.000Z", [use("B", "cpp_find_symbol", { name: "Widget" })]),
      user("2026-09-30T10:00:01.000Z", [okResult("B")]),
    ]);
    expect(detectRetries(unanswered, NO_WINDOW)).toHaveLength(0);
    const foreignPair = parse([
      assistant("2026-09-30T10:00:00.000Z", [foreignUse("A", "Grep", { pattern: "Widget" })]),
      user("2026-09-30T10:00:00.000Z", [failedResult("A", "no match")]),
      assistant("2026-09-30T10:00:01.000Z", [foreignUse("B", "Grep", { pattern: "Frame" })]),
      user("2026-09-30T10:00:01.000Z", [okResult("B")]),
    ]);
    expect(detectRetries(foreignPair, NO_WINDOW)).toHaveLength(0);
  });
});

describe("detectFallbacks", () => {
  it("reads a Grep of the same whole word as a fallback, and not a longer identifier that contains it", () => {
    const hit = parse([
      assistant("2026-09-30T10:00:00.100Z", [use("A", "cpp_find_symbol", { name: "Widget" })]),
      user("2026-09-30T10:00:00.200Z", [okResult("A", "1 declaration")]),
      assistant("2026-09-30T10:00:00.300Z", [foreignUse("G", "Grep", { pattern: "class Widget" })]),
      user("2026-09-30T10:00:00.400Z", [okResult("G")]),
    ]);
    expect(detectFallbacks(hit, NO_WINDOW).fallbacks).toEqual([
      { tool: "cpp_find_symbol", identifier: "Widget", kind: "grep", afterOk: true },
    ]);
    const longer = parse([
      assistant("2026-09-30T10:00:00.100Z", [use("A", "cpp_find_symbol", { name: "Widget" })]),
      user("2026-09-30T10:00:00.200Z", [okResult("A")]),
      assistant("2026-09-30T10:00:00.300Z", [foreignUse("G", "Grep", { pattern: "WidgetFactory" })]),
      user("2026-09-30T10:00:00.400Z", [okResult("G")]),
    ]);
    expect(detectFallbacks(longer, NO_WINDOW).fallbacks).toHaveLength(0);
  });

  it("does not claim a search issued in the same batch as the call it is said to follow", () => {
    const parallel = parse([
      assistant("2026-09-30T10:00:00.000Z", [
        use("A", "cpp_find_symbol", { name: "Widget" }),
        foreignUse("G", "Grep", { pattern: "Widget" }),
      ]),
      user("2026-09-30T10:00:01.000Z", [okResult("A"), okResult("G")]),
    ]);
    expect(detectFallbacks(parallel, NO_WINDOW).fallbacks).toHaveLength(0);
    const later = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("A", "cpp_find_symbol", { name: "Widget" })]),
      user("2026-09-30T10:00:01.000Z", [okResult("A")]),
      assistant("2026-09-30T10:00:02.000Z", [foreignUse("G", "Grep", { pattern: "Widget" })]),
      user("2026-09-30T10:00:03.000Z", [okResult("G")]),
    ]);
    expect(detectFallbacks(later, NO_WINDOW).fallbacks).toHaveLength(1);
  });

  it("attributes nothing to a call whose result never arrived", () => {
    const abandoned = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("A", "cpp_find_symbol", { name: "Widget" })]),
      assistant("2026-09-30T10:00:01.000Z", [foreignUse("G", "Grep", { pattern: "Widget" })]),
      user("2026-09-30T10:00:02.000Z", [okResult("G")]),
    ]);
    const found = detectFallbacks(abandoned, NO_WINDOW);
    expect(found.fallbacks).toHaveLength(0);
    expect(found.nav).toHaveLength(0);
  });

  it("needs a search program in the command, not merely the name in any text", () => {
    const withProgram = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("A", "go_find_callers", { symbol: "Store.Open" })]),
      user("2026-09-30T10:00:00.100Z", [okResult("A")]),
      assistant("2026-09-30T10:00:00.200Z", [foreignUse("B", "Bash", { command: "rg Open internal" })]),
      user("2026-09-30T10:00:00.300Z", [okResult("B")]),
    ]);
    expect(detectFallbacks(withProgram, NO_WINDOW).fallbacks[0]?.kind).toBe("shell");
    const withoutProgram = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("A", "go_find_callers", { symbol: "Store.Open" })]),
      user("2026-09-30T10:00:00.100Z", [okResult("A")]),
      assistant("2026-09-30T10:00:00.200Z", [foreignUse("B", "PowerShell", { command: "Get-Content Open" })]),
      user("2026-09-30T10:00:00.300Z", [okResult("B")]),
    ]);
    expect(detectFallbacks(withoutProgram, NO_WINDOW).fallbacks).toHaveLength(0);
  });

  it("counts a workspaceSymbol query as a fallback and a positioned navigation as lspNav instead", () => {
    const symbol = parse([
      ...failingSymbolCall("A", "Widget", "2026-09-30T10:00:00.000Z"),
      assistant("2026-09-30T10:00:01.000Z", [foreignUse("L", "LSP", { operation: "workspaceSymbol", query: "Widget" })]),
      user("2026-09-30T10:00:01.100Z", [okResult("L")]),
    ]);
    expect(detectFallbacks(symbol, NO_WINDOW).fallbacks[0]?.kind).toBe("lsp-symbol");
    const nav = parse([
      ...failingSymbolCall("A", "Widget", "2026-09-30T10:00:00.000Z"),
      assistant("2026-09-30T10:00:01.000Z", [foreignUse("L", "LSP", { operation: "goToDefinition", line: 12 })]),
      user("2026-09-30T10:00:01.100Z", [okResult("L")]),
    ]);
    expect(detectFallbacks(nav, NO_WINDOW).fallbacks).toHaveLength(0);
    expect(detectFallbacks(nav, NO_WINDOW).nav).toEqual([{ tool: "cpp_find_symbol", afterOk: false }]);
  });

  it("looks as far as the fifth tool event after the result and no further", () => {
    const filler = (id: string) => [
      assistant(`2026-09-30T10:00:0${id}.000Z`, [foreignUse(id, "Read")]),
      user(`2026-09-30T10:00:0${id}.000Z`, [okResult(id)]),
    ];
    const base = [
      ...failingSymbolCall("A", "Widget", "2026-09-30T10:00:00.000Z"),
      ...filler("1"),
      ...filler("2"),
      ...filler("3"),
      ...filler("4"),
    ];
    const atFive = parse([...base, assistant("2026-09-30T10:00:05.000Z", [foreignUse("G", "Grep", { pattern: "Widget" })]), user("2026-09-30T10:00:05.100Z", [okResult("G")])]);
    expect(detectFallbacks(atFive, NO_WINDOW).fallbacks).toHaveLength(1);
    const atSix = parse([...base, ...filler("5"), assistant("2026-09-30T10:00:06.000Z", [foreignUse("G", "Grep", { pattern: "Widget" })]), user("2026-09-30T10:00:06.100Z", [okResult("G")])]);
    expect(detectFallbacks(atSix, NO_WINDOW).fallbacks).toHaveLength(0);
  });

  it("takes the identifier from the last segment, usable only as a whole word of three or more characters", () => {
    function named(tool: string, key: string, value: string, searched: string) {
      return parse([
        assistant("2026-09-30T10:00:00.000Z", [use("A", tool, { [key]: value })]),
        user("2026-09-30T10:00:00.100Z", [okResult("A")]),
        assistant("2026-09-30T10:00:00.200Z", [foreignUse("G", "Grep", { pattern: `class ${searched}` })]),
        user("2026-09-30T10:00:00.300Z", [okResult("G")]),
      ]);
    }
    expect(detectFallbacks(named("cpp_find_symbol", "name", "ns::Foo::Bar", "Bar"), NO_WINDOW).fallbacks[0]?.identifier).toBe("Bar");
    expect(detectFallbacks(named("go_find_references", "symbol", "pkg.Type", "Type"), NO_WINDOW).fallbacks[0]?.identifier).toBe("Type");
    expect(detectFallbacks(named("cpp_find_symbol", "name", "Foo::bar(int)", "bar"), NO_WINDOW).fallbacks[0]?.identifier).toBe("bar");
    expect(detectFallbacks(named("cpp_find_derived_classes", "qualifiedName", "ns::Foo*", "Foo"), NO_WINDOW).fallbacks[0]?.identifier).toBe("Foo");
    expect(detectFallbacks(named("cpp_find_symbol", "name", "ns::ab", "ab"), NO_WINDOW).fallbacks).toHaveLength(0);
    expect(detectFallbacks(named("cpp_find_symbol", "name", "ns::1Bad", "1Bad"), NO_WINDOW).fallbacks).toHaveLength(0);
  });

  it("names no identifier for the tools that do not take one", () => {
    const outline = parse([
      assistant("2026-09-30T10:00:00.000Z", [use("A", "cpp_file_symbols", { file: "a.cpp" })]),
      user("2026-09-30T10:00:00.100Z", [okResult("A")]),
      assistant("2026-09-30T10:00:00.200Z", [use("B", "go_file_symbols", { file: "main.go" })]),
      user("2026-09-30T10:00:00.300Z", [okResult("B")]),
      assistant("2026-09-30T10:00:00.400Z", [foreignUse("G", "Grep", { pattern: "main.go" })]),
      user("2026-09-30T10:00:00.500Z", [okResult("G")]),
    ]);
    expect(detectFallbacks(outline, NO_WINDOW).fallbacks).toHaveLength(0);
  });

  it("keeps the window on the calls it attributes, never on the events it counts", () => {
    const calls = parse([
      ...failingSymbolCall("P1", "Old", "2026-09-17T10:00:00.000Z"),
      ...failingSymbolCall("P2", "Old", "2026-09-17T10:00:01.000Z"),
      ...failingSymbolCall("A", "Qux", "2026-09-20T10:00:00.000Z"),
      assistant("2026-09-20T10:00:01.000Z", [foreignUse("G", "Grep", { pattern: "Qux" })]),
      user("2026-09-20T10:00:01.100Z", [okResult("G")]),
    ]);
    const since = { from: Date.parse("2026-09-20T00:00:00.000Z"), to: null };
    expect(detectFallbacks(calls, since).fallbacks).toEqual([
      { tool: "cpp_find_symbol", identifier: "Qux", kind: "grep", afterOk: false },
    ]);
    const after = { from: null, to: Date.parse("2026-09-19T00:00:00.000Z") };
    expect(detectFallbacks(calls, after).fallbacks).toHaveLength(0);
  });
});

describe("the transcript section over the fixtures", () => {
  async function text(logsDir: string, transcriptDir: string | undefined = transcripts): Promise<string> {
    return renderText(await buildReport(options({ logs: logsDir, transcripts: transcriptDir })));
  }

  it("keeps one agent's context in one file, splitting main from subagent", async () => {
    const stats = await summarizeTranscripts(await scanTranscripts(transcripts), "mcp-code-nav", NO_WINDOW);
    expect(stats.mainFiles).toBe(1);
    expect(stats.subagentFiles).toBe(1);
    expect(stats.groups.map((group) => `${group.kind}/${group.tool}`)).toEqual([
      "main/cpp_file_symbols",
      "main/cpp_find_derived_classes",
      "main/cpp_find_references",
      "main/cpp_find_symbol",
      "main/go_find_callers",
      "main/go_find_implementations",
      "subagent/go_file_symbols",
    ]);
  });

  it("carries file references through the scan, and only what the coverage line divides by through the tally", async () => {
    const scan = await scanTranscripts(transcripts);
    expect(scan.files.map((file) => file.kind)).toEqual(["main", "subagent"]);
    expect(scan.files[0]).not.toHaveProperty("calls");
    const stats = await summarizeTranscripts(scan, "mcp-code-nav", NO_WINDOW);
    expect(stats.ours).toHaveLength(15);
    expect(Object.keys(stats.ours[0] ?? {}).sort()).toEqual(["clientSide", "startMs", "tool"]);
    expect(stats.ours[0]).toEqual({
      tool: "cpp_file_symbols",
      startMs: Date.parse("2026-09-30T10:00:00.000Z"),
      clientSide: false,
    });
  });

  it("drops a transcript that holds no call of this server the moment it has been parsed", async () => {
    const scan = await scanTranscripts(windowedTranscripts);
    expect(scan.files).toHaveLength(2);
    const stats = await summarizeTranscripts(scan, "mcp-code-nav", NO_WINDOW);
    expect(stats.mainFiles).toBe(1);
    expect(stats.groups.map((group) => group.tool)).toEqual(["cpp_find_symbol"]);
    expect(stats.ours).toHaveLength(3);
  });

  it("counts calls, failures, the client-side class and the client-observed latency per tool and kind", async () => {
    const scan = await scanTranscripts(transcripts);
    expect(scan.files.map((file) => file.kind)).toEqual(["main", "subagent"]);
    const stats = await summarizeTranscripts(scan, "mcp-code-nav", NO_WINDOW);
    const group = (kind: string, tool: string) => stats.groups.find((item) => item.kind === kind && item.tool === tool)!;
    expect(group("main", "cpp_file_symbols")).toMatchObject({ calls: 3, failures: 2, clientSide: 1 });
    expect(group("main", "cpp_file_symbols").latency).toEqual([500, 200, 0]);
    expect(group("main", "go_find_callers")).toMatchObject({ calls: 2, failures: 0, failedCalls: 0 });
    expect(group("subagent", "go_file_symbols")).toMatchObject({ calls: 2, failures: 1, retries: 1, changed: 1, recovered: 1 });
    expect(group("main", "cpp_find_symbol").classes).toEqual(new Map([["symbol-not-found", 2]]));
  });

  it("renders the window-edge fixtures into rows a reader can check by hand", async () => {
    const report = await text(logs);
    expect(rowsAfter(report, "transcripts ")).toEqual([
      ["main", "cpp_file_symbols", "3", "2", "1", "200", "500", "1/2 50.0%", "1/1", "1/1", "0", "0", "0"],
      ["main", "cpp_find_derived_classes", "2", "1", "0", "0", "500", "1/1 100.0%", "1/1", "1/1", "0", "1", "1"],
      ["main", "cpp_find_references", "2", "2", "0", "100", "100", "0/2 0.0%", "0/0", "0/0", "0", "0", "0"],
      ["main", "cpp_find_symbol", "2", "2", "0", "0", "500", "1/2 50.0%", "0/1", "0/1", "0", "1", "0"],
      ["main", "go_find_callers", "2", "0", "0", "100", "100", "—", "0/0", "0/0", "0", "0", "2"],
      ["main", "go_find_implementations", "2", "2", "0", "0", "99", "0/2 0.0%", "0/0", "0/0", "0", "0", "0"],
      ["subagent", "go_file_symbols", "2", "1", "0", "200", "400", "1/1 100.0%", "1/1", "1/1", "0", "0", "0"],
    ]);
    expect(rowsAfter(report, "retry changedKeys")).toEqual([
      ["projectRoot", "1"],
      ["qualifiedName", "1"],
      ["sourceRoots", "1"],
    ]);
    expect(rowsAfter(report, "failure classes per tool (transcript)")).toEqual([
      ["main", "cpp_file_symbols", "client-side-rejection", "1"],
      ["main", "cpp_file_symbols", "compile-db-missing", "1"],
      ["main", "cpp_find_derived_classes", "compile-db-missing", "1"],
      ["main", "cpp_find_references", "symbol-not-found", "2"],
      ["main", "cpp_find_symbol", "symbol-not-found", "2"],
      ["main", "go_find_implementations", "symbol-not-found", "2"],
      ["subagent", "go_file_symbols", "no-module", "1"],
    ]);
  });

  it("counts a fallback whose earlier events the window cut away, while tallying only the calls inside it", async () => {
    const scan = await scanTranscripts(windowedTranscripts);
    const since = { from: Date.parse("2026-09-20T00:00:00.000Z"), to: null };
    const stats = await summarizeTranscripts(scan, "mcp-code-nav", since);
    const group = stats.groups.find((item) => item.tool === "cpp_find_symbol")!;
    expect(group.calls).toBe(1);
    expect(group.fallbackAfterError).toBe(1);
    expect(group.fallbackAfterOk).toBe(0);
  });

  it("applies the window to transcript calls as well as log calls", async () => {
    const scan = await scanTranscripts(transcripts);
    const since = { from: Date.parse("2026-09-30T11:00:00.000Z"), to: null };
    const stats = await summarizeTranscripts(scan, "mcp-code-nav", since);
    expect(stats.mainFiles).toBe(0);
    expect(stats.subagentFiles).toBe(1);
    expect(stats.groups.map((group) => `${group.kind}/${group.tool}`)).toEqual(["subagent/go_file_symbols"]);
    expect(stats.groups[0]?.calls).toBe(2);
  });

  it("compares the two sources per tool over the window they share, and says so when they share none", async () => {
    const report = await text(logs);
    const heading = lineStartingWith(report, "coverage,");
    expect(heading).toContain("2026-09-30T10:00:01.000Z .. 2026-09-30T10:00:05.000Z");
    expect(heading).toContain("client-side");
    expect(rowsAfter(report, "coverage,")).toEqual([
      ["cpp_file_symbols", "3", "1"],
      ["cpp_find_symbol", "2", "1"],
    ]);
    const empty = await text(missingLogs);
    expect(lineStartingWith(empty, "coverage,")).toContain("none — one side holds no call in it");
    expect(empty).toContain("The transcript section counts the client-side class");
  });

  it("keeps the client-side rejections out of the transcript side of the coverage line", async () => {
    const report = await text(logs, coverageTranscripts);
    expect(rowsAfter(report, "coverage,")).toEqual([
      ["cpp_file_symbols", "1", "0"],
      ["cpp_find_symbol", "0", "1"],
    ]);
  });
});

/** The data rows after the line starting with `prefix`, skipping that line and the table header under it. */
function rowsAfter(text: string, prefix: string): string[][] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(prefix));
  if (start === -1) throw new Error(`no line starting "${prefix}" in:\n${text}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (line === "") break;
    rows.push(line.split(/\s{2,}/));
  }
  return rows;
}

function lineStartingWith(text: string, prefix: string): string {
  const found = text.split("\n").find((line) => line.startsWith(prefix));
  if (found === undefined) throw new Error(`no line starting "${prefix}" in:\n${text}`);
  return found;
}
