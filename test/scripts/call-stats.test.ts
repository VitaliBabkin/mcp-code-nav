import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  clientFamily,
  defaultLogDir,
  defaultTranscriptsDir,
  jsonReport,
  parseArgs,
  percentile,
  renderText,
  scanCallLog,
  summarizeLog,
  type StatsOptions,
} from "../../scripts/call-stats.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "call-stats");
const logs = join(fixtures, "logs");
const missing = join(fixtures, "no-such-directory");
// Absolute on every platform (a bare "D:" prefix is only a drive on Windows).
const ABS_ROOT = resolve(tmpdir(), "mcp-code-nav-abs-fixture");
const HOME = join(ABS_ROOT, "home");

function options(over: Partial<StatsOptions> = {}): StatsOptions {
  return {
    logs,
    transcripts: undefined,
    serverName: "mcp-code-nav",
    window: { from: null, to: null },
    json: false,
    ...over,
  };
}

/** The data rows of one titled table, cells split on the column gap; the header row is dropped. */
function section(text: string, title: string): string[][] {
  const lines = text.split("\n");
  const start = lines.indexOf(title);
  if (start === -1) throw new Error(`no "${title}" section in:\n${text}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (line === "") break;
    rows.push(line.split(/\s{2,}/));
  }
  return rows;
}

async function logText(over: Partial<StatsOptions> = {}): Promise<string> {
  return renderText(await buildReport(options(over)));
}

describe("parseArgs", () => {
  it("defaults the log directory to what the server itself would resolve", () => {
    const parsed = parseArgs([], {}, HOME);
    expect(parsed.logs).toBe(resolve(join(HOME, ".mcp-code-nav", "calls")));
    expect(parsed.transcripts).toBeUndefined();
    expect(parsed.serverName).toBe("mcp-code-nav");
    expect(parsed.window).toEqual({ from: null, to: null });
    expect(parsed.json).toBe(false);
  });

  it("reads every flag the contract names", () => {
    const parsed = parseArgs(
      ["--logs", logs, "--since", "2026-09-18", "--until", "2026-09-30", "--transcripts", transcriptsDir(), "--server-name", "other", "--json"],
      {},
      HOME,
    );
    expect(parsed.logs).toBe(resolve(logs));
    expect(parsed.window.from).toBe(Date.parse("2026-09-18T00:00:00.000Z"));
    expect(parsed.serverName).toBe("other");
    expect(parsed.json).toBe(true);
  });

  it("bounds a bare day whole, so --until 2026-09-30 still covers 2026-09-30T23:59:59.999Z", () => {
    const parsed = parseArgs(["--until", "2026-09-30"], {}, HOME);
    expect(parsed.window.to).toBe(Date.parse("2026-09-30T00:00:00.000Z") + 86_399_999);
    expect(new Date(parsed.window.to ?? 0).toISOString()).toBe("2026-09-30T23:59:59.999Z");
  });

  it("takes a timestamp with a zone verbatim, since and until alike", () => {
    const parsed = parseArgs(["--since", "2026-09-30T10:05:03Z", "--until", "2026-09-30T10:05:04.000Z"], {}, HOME);
    expect(parsed.window.from).toBe(Date.parse("2026-09-30T10:05:03.000Z"));
    expect(parsed.window.to).toBe(Date.parse("2026-09-30T10:05:04.000Z"));
  });

  it("turns a bare --transcripts into the default directory, at the end and before another flag", () => {
    const bare = join(HOME, ".claude", "projects");
    expect(parseArgs(["--transcripts"], {}, HOME).transcripts).toBe(resolve(bare));
    expect(parseArgs(["--transcripts", "--json"], {}, HOME).transcripts).toBe(resolve(bare));
    expect(parseArgs(["--transcripts", logs], {}, HOME).transcripts).toBe(resolve(logs));
  });

  it("refuses an unknown flag and a flag with no value, naming the usage", () => {
    expect(() => parseArgs(["--nope", "x"], {}, HOME)).toThrow(/--nope/);
    expect(() => parseArgs(["--nope", "x"], {}, HOME)).toThrow(/usage: npm run stats/);
    expect(() => parseArgs(["--logs"], {}, HOME)).toThrow(/--logs needs a value/);
    expect(() => parseArgs(["a.cpp"], {}, HOME)).toThrow(/unexpected argument "a.cpp"/);
  });

  it("refuses a date the report could not compare against the log's UTC stamps", () => {
    expect(() => parseArgs(["--since", "2026-09-30T10:00:00"], {}, HOME)).toThrow(/--since/);
    expect(() => parseArgs(["--until", "last tuesday"], {}, HOME)).toThrow(/--until/);
    expect(() => parseArgs(["--server-name", "two names"], {}, HOME)).toThrow(/serverName/);
  });
});

function transcriptsDir(): string {
  return join(fixtures, "transcripts");
}

describe("defaultLogDir", () => {
  it("follows the switch the server follows, and falls back to the default when the log is off", () => {
    const scratch = join(ABS_ROOT, "scratch");
    expect(defaultLogDir({ MCP_CODE_NAV_CALL_LOG: scratch }, HOME)).toBe(scratch);
    expect(defaultLogDir({}, HOME)).toBe(join(HOME, ".mcp-code-nav", "calls"));
    expect(defaultLogDir({ MCP_CODE_NAV_CALL_LOG: "off" }, HOME)).toBe(join(HOME, ".mcp-code-nav", "calls"));
    expect(defaultLogDir({ MCP_CODE_NAV_CALL_LOG: "relative" }, HOME)).toBe(join(HOME, ".mcp-code-nav", "calls"));
    expect(defaultTranscriptsDir(HOME)).toBe(join(HOME, ".claude", "projects"));
  });
});

describe("clientFamily", () => {
  function run(name: string | undefined, version = "1.0.0") {
    return {
      v: 1,
      type: "run" as const,
      run: "r",
      ts: "2026-09-30T10:00:00.000Z",
      pid: 1,
      build: "b",
      node: "v",
      cwd: "c",
      protocol: null,
      client: name === undefined ? null : { name, version },
    };
  }

  it("maps the three known prefixes and keeps anything else raw", () => {
    expect(clientFamily(run("claude-code"))).toBe("claude-code");
    expect(clientFamily(run("claude-code-2"))).toBe("claude-code");
    expect(clientFamily(run("qwen-cli-mcp-client-mcp-code-nav"))).toBe("qwen-code");
    expect(clientFamily(run("codex-mcp-client"))).toBe("codex");
    expect(clientFamily(run("some-other-client"))).toBe("some-other-client");
  });

  it("says the client is unknown when the run header carries none", () => {
    expect(clientFamily(run(undefined))).toBe("(unknown client)");
    expect(clientFamily(undefined)).toBe("(unknown client)");
  });
});

describe("percentile", () => {
  it("is nearest rank, so it only ever answers a value it observed", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});

describe("scanCallLog", () => {
  it("counts every line kind it is handed and never fails on one it cannot read", async () => {
    const scan = await scanCallLog(logs, { from: null, to: null });
    expect(scan.files).toBe(2);
    expect(scan.calls).toHaveLength(10);
    expect(scan.runs.size).toBe(2);
    expect(scan.malformed).toBe(1);
    expect(scan.unsupportedVersion).toBe(1);
  });

  it("skips a blank line silently and counts a part-written one as malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "call-stats-"));
    try {
      const good = JSON.stringify({ v: 1, type: "close", run: "r9", ts: "2026-09-30T10:00:00.000Z", dropped: 1 });
      await writeFile(join(dir, "calls-20260930T100000-1.jsonl"), `{"v":1,"type":"ca\n\n${good}\n\n`);
      const scan = await scanCallLog(dir, { from: null, to: null });
      expect(scan.malformed).toBe(1);
      expect(scan.closeLines).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads the run's closing `close` record as a record, summing what its queue refused", async () => {
    const scan = await scanCallLog(logs, { from: null, to: null });
    expect(scan.closeLines).toBe(1);
    expect(scan.dropped).toBe(2);
    expect(scan.malformed).toBe(1);
  });

  it("counts one call once, by run and sequence rather than by line position", async () => {
    const scan = await scanCallLog(logs, { from: null, to: null });
    expect(scan.duplicates).toBe(1);
    expect(scan.calls.filter((call) => call.run === "r1" && call.seq === 3)).toHaveLength(1);
  });

  it("touches only the log's own files in the directory", async () => {
    const scan = await scanCallLog(logs, { from: null, to: null });
    expect(scan.calls.some((call) => call.tool === "not_a_real_tool")).toBe(false);
  });

  it("bounds calls by the window, keeping the ones whose stamp it cannot read only when unbounded", async () => {
    const bounded = await scanCallLog(logs, { from: Date.parse("2026-09-30T10:05:03.000Z"), to: null });
    expect(bounded.calls.map((call) => `${call.run}:${call.seq}`)).toEqual(["r2:3", "r2:4", "r2:5"]);
    const oneDay = await scanCallLog(logs, {
      from: Date.parse("2026-09-30T00:00:00.000Z"),
      to: Date.parse("2026-09-30T00:00:00.000Z") + 86_399_999,
    });
    expect(oneDay.calls).toHaveLength(10);
  });

  it("states an unreadable log directory as a note, not as a crash", async () => {
    const scan = await scanCallLog(missing, { from: null, to: null });
    expect(scan.files).toBe(0);
    expect(scan.calls).toHaveLength(0);
    expect(scan.readError).toMatch(/ENOENT/);
  });
});

describe("summarizeLog", () => {
  it("splits outcomes, counts failures apart from aborted, and reads the cold and empty shares off their own denominators", async () => {
    const log = summarizeLog(await scanCallLog(logs, { from: null, to: null }));
    const tools = Object.fromEntries(log.byTool.map((group) => [group.key, group]));
    const symbols = tools["cpp_file_symbols"]!;
    expect(symbols.calls).toBe(3);
    expect(symbols.outcomes.get("ok")).toBe(2);
    expect(symbols.failures).toBe(1);
    expect(symbols.aborted).toBe(0);
    expect(symbols.cold).toBe(1);
    expect(symbols.coldBase).toBe(3);
    expect(symbols.empty).toBe(1);
    expect(symbols.emptyBase).toBe(2);
    expect(tools["cpp_find_symbol"]!.aborted).toBe(1);
    expect(tools["go_find_callers"]!.cold).toBe(1);
    expect(tools["go_find_callers"]!.coldBase).toBe(1);
    expect(tools["go_find_implementations"]!.failures).toBe(1);
  });

  it("groups the same calls by client family and by project, keeping a missing project named", async () => {
    const log = summarizeLog(await scanCallLog(logs, { from: null, to: null }));
    expect(log.byClient.map((group) => group.key)).toEqual(["claude-code", "qwen-code"]);
    expect(log.byProject.map((group) => group.key)).toEqual([
      "D:\\build",
      "D:\\repo\\backend",
      "(no project)",
      "D:\\repo",
    ]);
    const qwen = log.byClient.find((group) => group.key === "qwen-code")!;
    expect(qwen.calls).toBe(5);
    expect([...qwen.clients.values()]).toEqual([{ name: "qwen-cli-mcp-client-mcp-code-nav", version: "0.0.1", calls: 5 }]);
  });

  it("counts the `limits` codes, the builds, and lists the class it could not place by its head", async () => {
    const log = summarizeLog(await scanCallLog(logs, { from: null, to: null }));
    expect([...log.limits]).toEqual([
      ["compile-database-only", 1],
      ["index-building", 1],
      ["listing-capped", 1],
    ]);
    expect(log.builds).toEqual([
      { build: "0.1.0+2.g35469a6", calls: 5 },
      { build: "0.1.0+3.gabcdef0", calls: 5 },
    ]);
    expect(log.heads).toEqual([{ tool: "cpp_find_symbol", head: "nothing here matches 42", count: 1 }]);
  });
});

describe("renderText, the log section golden", () => {
  it("renders the fixture log into the report", async () => {
    const text = await logText();
    expect(text.split("\n").slice(0, 5)).toEqual([
      "window    open .. open",
      "",
      `logs       ${resolve(logs)}`,
      "files 2, calls 10, run headers 2, close lines 1 (2 dropped)",
      "skipped   1 malformed, 1 unsupported version, 1 duplicate run+seq, 0 unreadable files",
    ]);
    expect(section(text, "by tool")).toEqual([
      ["cpp_file_symbols", "3", "2", "1", "0", "0", "0", "0", "1", "10", "20", "1/3 33.3%", "1/2 50.0%", "0/3 0.0%", "100"],
      ["cpp_find_symbol", "2", "0", "1", "0", "0", "1", "0", "1", "0", "30", "—", "—", "0/2 0.0%", "0"],
      ["go_file_symbols", "2", "2", "0", "0", "0", "0", "0", "0", "80", "120", "1/2 50.0%", "0/2 0.0%", "1/2 50.0%", "200"],
      ["go_find_callers", "2", "0", "0", "1", "0", "0", "1", "1", "2", "9", "1/1 100.0%", "—", "0/2 0.0%", "0"],
      ["go_find_implementations", "1", "0", "0", "0", "1", "0", "0", "1", "1", "1", "—", "—", "0/1 0.0%", "0"],
    ]);
    expect(section(text, "by client family")).toEqual([
      ["claude-code", "5", "2", "2", "0", "0", "1", "0", "2", "10", "30", "1/3 33.3%", "1/2 50.0%", "0/5 0.0%", "96"],
      ["qwen-code", "5", "2", "0", "1", "1", "0", "1", "2", "9", "120", "2/3 66.7%", "0/2 0.0%", "1/5 20.0%", "60"],
    ]);
    expect(section(text, "by project")).toEqual([
      ["D:\\build", "4", "2", "1", "0", "0", "1", "0", "1", "10", "30", "1/2 50.0%", "1/2 50.0%", "0/4 0.0%", "70"],
      ["D:\\repo\\backend", "4", "1", "0", "1", "1", "0", "1", "2", "2", "120", "2/2 100.0%", "0/1 0.0%", "0/4 0.0%", "0"],
      ["(no project)", "1", "1", "0", "0", "0", "0", "0", "0", "80", "80", "0/1 0.0%", "0/1 0.0%", "1/1 100.0%", "300"],
      ["D:\\repo", "1", "0", "1", "0", "0", "0", "0", "1", "4", "4", "0/1 0.0%", "—", "0/1 0.0%", "96"],
    ]);
    expect(section(text, "limits by code")).toEqual([
      ["compile-database-only", "1"],
      ["index-building", "1"],
      ["listing-capped", "1"],
    ]);
    expect(section(text, "failures by error class (failure = error + partial + protocol-error; cancelled and abandoned sit in the aborted column, apart)")).toEqual([
      ["tool", "cpp_file_symbols", "compile-db-missing", "1"],
      ["tool", "cpp_find_symbol", "other", "1"],
      ["tool", "go_find_callers", "not-ready", "1"],
      ["tool", "go_find_implementations", "tool-unknown", "1"],
      ["client", "claude-code", "compile-db-missing", "1"],
      ["client", "claude-code", "other", "1"],
      ["client", "qwen-code", "not-ready", "1"],
      ["client", "qwen-code", "tool-unknown", "1"],
      ["project", "D:\\build", "other", "1"],
      ["project", "D:\\repo\\backend", "not-ready", "1"],
      ["project", "D:\\repo\\backend", "tool-unknown", "1"],
      ["project", "D:\\repo", "compile-db-missing", "1"],
    ]);
    expect(section(text, 'unclassified heads, class "other" (top 20 — grow the anchor table from these)')).toEqual([
      ["1", "cpp_find_symbol", "nothing here matches 42"],
    ]);
    expect(text).toContain("a call killed with no transport close");
    expect(text).toContain("pass --transcripts");
  });

  it("keeps the section off entirely when the transcript flag was not passed", async () => {
    const text = await logText();
    expect(text).not.toMatch(/^transcripts /m);
    expect(text).not.toMatch(/^coverage,/m);
  });
});

describe("jsonReport", () => {
  it("carries the raw client name and version the text form leaves out, and the never-counted list", async () => {
    const report = await buildReport(options());
    const shape = JSON.parse(jsonReport(report)) as Record<string, never>;
    const logsShape = (shape["logs"] ?? {}) as Record<string, unknown>;
    const byClient = logsShape["byClient"] as { key: string; clients: { name: string; version: string }[] }[];
    expect(byClient.map((group) => group.clients[0]?.name)).toContain("qwen-cli-mcp-client-mcp-code-nav");
    expect(shape["notCounted"]).toBeInstanceOf(Array);
    expect(shape["transcripts"]).toBeNull();
    const lines = logsShape["lines"] as Record<string, number>;
    expect(lines).toMatchObject({ calls: 10, closeLines: 1, dropped: 2, malformed: 1, unsupportedVersion: 1, duplicates: 1 });
  });
});
