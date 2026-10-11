import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { CallLogLine } from "../../src/call-log/record.js";
import { openCallLog, type CallLogFs } from "../../src/call-log/writer.js";

const DIR = "D:\\scratch\\calls";
const FILE_PATTERN = /^calls-[0-9]{8}T[0-9]{6}-[0-9]+\.jsonl$/;
const DAY = 24 * 60 * 60 * 1000;

type Line = z.infer<typeof CallLogLine>;

function header(): Line {
  return {
    v: 1,
    type: "run",
    run: "run-1",
    ts: "2026-09-30T10:00:00.000Z",
    pid: 4242,
    build: "v1.2.3",
    node: "v22.9.0",
    cwd: "D:\\work",
    protocol: "2025-06-18",
    client: { name: "claude-code", version: "1.2.3" },
  };
}

function call(seq: number, overrides: Record<string, unknown> = {}): Line {
  return {
    v: 1,
    type: "call",
    run: "run-1",
    seq,
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
    limits: [],
    results: 3,
    capped: false,
    cache: null,
    indexState: null,
    spawned: null,
    readyWaitMs: null,
    textBytes: 8,
    ...overrides,
  };
}

interface Entry {
  size: number;
  ageMs: number;
}

interface FakeFs {
  readonly fs: CallLogFs;
  readonly appended: string[];
  readonly appendedSync: string[];
  readonly removed: string[];
  readonly statNames: string[];
  readonly madeDirs: string[];
  readonly paths: string[];
}

/**
 * The filesystem the writer sees. `entries` is what the calls directory already holds, `hang` keeps an
 * append unresolved so a queued write can be observed before it lands, and `rejectWith` fails every append
 * the way an unwritable directory does.
 */
function fakeFs(
  options: {
    entries?: Record<string, Entry>;
    hang?: boolean;
    slow?: boolean;
    rejectWith?: unknown;
    rejectSyncWith?: unknown;
  } = {},
): FakeFs {
  const appended: string[] = [];
  const appendedSync: string[] = [];
  const removed: string[] = [];
  const statNames: string[] = [];
  const madeDirs: string[] = [];
  const paths: string[] = [];
  const seen = (path: string) => {
    if (!paths.includes(path)) paths.push(path);
  };

  return {
    appended,
    appendedSync,
    removed,
    statNames,
    madeDirs,
    paths,
    fs: {
      appendFile: async (path, data) => {
        if (options.rejectWith !== undefined) throw options.rejectWith;
        if (options.hang) return new Promise<void>(() => {});
        if (options.slow) await new Promise((done) => setTimeout(done, 0));
        seen(path);
        appended.push(data);
      },
      appendFileSync: (path, data) => {
        if (options.rejectWith !== undefined) throw options.rejectWith;
        if (options.rejectSyncWith !== undefined) throw options.rejectSyncWith;
        seen(path);
        appendedSync.push(data);
      },
      mkdirSync: (path) => void madeDirs.push(path),
      readdir: async (path) => {
        if (options.entries === undefined) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: "ENOENT" });
        }
        return Object.keys(options.entries);
      },
      stat: async (path) => {
        const name = path.slice(DIR.length + 1);
        statNames.push(name);
        const entry = options.entries?.[name];
        if (entry === undefined) throw new Error(`no such file: ${name}`);
        return { size: entry.size, mtimeMs: Date.now() - entry.ageMs };
      },
      remove: async (path) => void removed.push(path.slice(DIR.length + 1)),
    },
  };
}

/** Let the queued appends run: the writer drains on its promise chain, never on a timer. */
async function settled(times = 4): Promise<void> {
  for (let step = 0; step < times; step++) {
    await new Promise((done) => setTimeout(done, 0));
  }
}

function callsFile(written: string[]): string | undefined {
  return written.at(0)?.slice(DIR.length + 1);
}

function parsed(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("openCallLog", () => {
  it("creates nothing until the first record, and then one file for this process", async () => {
    const disk = fakeFs();
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    await settled();
    expect(disk.madeDirs).toEqual([]);

    log.write(header());
    await settled();
    expect(disk.madeDirs).toEqual([DIR]);
    expect(disk.paths).toHaveLength(1);
    expect(callsFile(disk.paths)).toMatch(FILE_PATTERN);
  });

  it("appends one newline-terminated line per record, in the order written", async () => {
    const disk = fakeFs();
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    log.write(header());
    log.write(call(1));
    log.write(call(2));
    await settled();

    expect(disk.appended.every((line) => line.endsWith("\n"))).toBe(true);
    expect(parsed(disk.appended).map((line) => line.type)).toEqual(["run", "call", "call"]);
    expect(parsed(disk.appended).slice(1).map((line) => line.seq)).toEqual([1, 2]);
  });

  it("writes nothing at all when the switch is off", async () => {
    const disk = fakeFs({ entries: {} });
    const stderr = vi.fn();
    const log = openCallLog({ kind: "off" }, { fs: disk.fs, stderr });
    log.write(header());
    log.write(call(1));
    log.close();

    expect([...disk.appended, ...disk.appendedSync, ...disk.madeDirs, ...disk.removed]).toEqual([]);
    expect(disk.statNames).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("says nothing and writes nothing when the value is not a directory", () => {
    const disk = fakeFs({ entries: {} });
    const stderr = vi.fn();
    const log = openCallLog({ kind: "invalid", value: "scratch/calls" }, { fs: disk.fs, stderr });
    log.write(call(1));
    log.close();

    expect(stderr).not.toHaveBeenCalled();
    expect([...disk.appended, ...disk.appendedSync, ...disk.madeDirs]).toEqual([]);
  });

  it("survives a calls directory that does not exist yet", async () => {
    const disk = fakeFs();
    openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    await settled();
    expect(disk.removed).toEqual([]);
  });

  it("costs a write failure one line of stderr naming the path and the code", async () => {
    const failure = Object.assign(new Error("EACCES: permission denied, open 'x'"), { code: "EACCES" });
    const disk = fakeFs({ rejectWith: failure });
    const stderr = vi.fn();
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs, stderr });

    expect(() => log.write(call(1))).not.toThrow();
    await settled();
    expect(stderr.mock.calls).toHaveLength(1);
    const line = String(stderr.mock.calls[0]?.[0]);
    expect(line).toContain("EACCES");
    expect(line).toMatch(/calls-[0-9]{8}T[0-9]{6}-[0-9]+\.jsonl/);

    expect(() => log.write(call(2))).not.toThrow();
    log.close();
    expect(stderr.mock.calls).toHaveLength(1);
    expect(disk.appendedSync).toEqual([]);
  });

  it("drains what the queue still holds synchronously on close, because a forced kill would lose it", () => {
    const disk = fakeFs({ hang: true });
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    log.write(header());
    log.write(call(1));
    log.write(call(2));
    log.close();

    expect(disk.appended).toEqual([]);
    expect(parsed(disk.appendedSync).map((line) => line.type)).toEqual(["run", "call", "call"]);
    expect(disk.paths).toHaveLength(1);
  });

  it("writes an append still outstanding at close, ahead of what is queued behind it", () => {
    const disk = fakeFs({ hang: true });
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    log.write(call(1));
    log.write(call(2));
    return settled(1).then(() => {
      log.write(call(3));
      log.close();

      expect(parsed(disk.appendedSync).map((line) => line.seq)).toEqual([1, 2, 3]);
    });
  });

  it("replays an outstanding record on a line of its own, so a part-written prefix stays a separate line", () => {
    const disk = fakeFs();
    const whole = `${JSON.stringify(call(1))}\n`;
    disk.fs.appendFile = async (_path, data) => {
      disk.appended.push(data.slice(0, 40));
      return new Promise<void>(() => {});
    };
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    log.write(call(1));
    return settled(1).then(() => {
      log.close();

      const onDisk = (disk.appended.join("") + disk.appendedSync.join("")).split("\n").filter((row) => row !== "");
      expect(onDisk).toHaveLength(2);
      expect(() => JSON.parse(onDisk[0] ?? "")).toThrow();
      expect(onDisk[1]).toBe(whole.trimEnd());
    });
  });

  it("does not write twice an append the filesystem already has", async () => {
    const disk = fakeFs({ slow: true });
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    log.write(call(1));
    await settled();
    log.write(call(2));
    log.close();

    expect(parsed(disk.appended).map((line) => line.seq)).toEqual([1]);
    expect(parsed(disk.appendedSync).map((line) => line.seq)).toEqual([2]);
  });

  it("stays silent when an append outstanding at close fails after its line was flushed", async () => {
    const disk = fakeFs();
    const stderr = vi.fn();
    let fail: (cause: Error) => void = () => {};
    disk.fs.appendFile = () => new Promise<void>((_done, reject) => void (fail = reject));
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs, stderr });
    log.write(call(1));
    await settled(1);
    log.close();
    fail(new Error("EPIPE"));
    await settled();

    expect(parsed(disk.appendedSync)).toHaveLength(1);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("reports the first failure of the flush at close, once", () => {
    const failure = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const disk = fakeFs({ hang: true, rejectSyncWith: failure });
    const stderr = vi.fn();
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs, stderr });
    log.write(header());
    log.write(call(1));
    log.close();
    log.close();

    expect(stderr.mock.calls).toHaveLength(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("ENOSPC");
  });

  it("keeps the 8 MiB ceiling in the flush at close and counts what it could not keep", () => {
    const disk = fakeFs({ hang: true });
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    const fat = (seq: number) => call(seq, { argKeys: ["k".repeat(4_600_000)] });
    log.write(header());
    for (const seq of [1, 2, 3]) log.write(fat(seq));
    log.close();

    const lines = parsed(disk.appendedSync);
    expect(lines.map((line) => line.type)).toEqual(["run", "call", "call", "close"]);
    expect(lines.at(-1)).toMatchObject({ type: "close", run: "run-1", dropped: 1 });
  });

  it("drops the newest record when the queue is full and counts them in the run's closing line", () => {
    const disk = fakeFs({ hang: true });
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    log.write(header());
    for (let seq = 1; seq <= 1001; seq++) log.write(call(seq));
    log.close();

    const lines = parsed(disk.appendedSync);
    expect(lines).toHaveLength(1001);
    expect(lines.at(0)?.type).toBe("run");
    expect(lines.slice(1, 1000).map((line) => line.seq)).toEqual(
      Array.from({ length: 999 }, (_unused, index) => index + 1),
    );
    expect(lines.at(-1)).toEqual({
      v: 1,
      type: "close",
      run: "run-1",
      ts: expect.any(String),
      dropped: 2,
    });
    expect(CallLogLine.safeParse(lines.at(-1)).success).toBe(true);
  });

  it("stops logging at 8 MiB with one line naming the file", async () => {
    const disk = fakeFs();
    const stderr = vi.fn();
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs, stderr });
    const fat = () => call(1, { argKeys: ["k".repeat(1_000_000)] });
    for (let seq = 1; seq <= 10; seq++) log.write(fat());
    await settled(12);

    expect(disk.appended).toHaveLength(9);
    expect(stderr.mock.calls.map(([line]) => line)).toEqual([expect.stringContaining("8388608 bytes")]);
    expect(String(stderr.mock.calls[0]?.[0])).toContain(callsFile(disk.paths));
  });

  it("states what it left behind when the size ceiling stops the log itself", async () => {
    const disk = fakeFs({ slow: true });
    const stderr = vi.fn();
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs, stderr });
    const fat = (seq: number) => call(seq, { argKeys: ["k".repeat(4_600_000)] });
    log.write(header());
    for (const seq of [1, 2, 3]) log.write(fat(seq));
    await settled(12);

    const closing = parsed(disk.appendedSync);
    expect(closing).toHaveLength(1);
    expect(closing[0]).toEqual({
      v: 1,
      type: "close",
      run: "run-1",
      ts: expect.any(String),
      dropped: 1,
    });
    expect(disk.appended).toHaveLength(3);
    expect(stderr.mock.calls.map(([line]) => line)).toEqual([expect.stringContaining("8388608 bytes")]);
  });

  it("refuses a record outside the schema with one line and never writes it", async () => {
    const disk = fakeFs();
    const stderr = vi.fn();
    const log = openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs, stderr });
    log.write(call(1, { v: 2 }));
    await settled();

    expect([...disk.appended, ...disk.appendedSync]).toEqual([]);
    expect(stderr.mock.calls).toHaveLength(1);
    log.write(call(2));
    await settled();
    expect(disk.appended).toEqual([]);
  });
});

describe("startup pruning", () => {
  const callsName = (stamp: string, pid: number) => `calls-${stamp}-${pid}.jsonl`;

  it("deletes a month of its own files and touches nothing else", async () => {
    const old = callsName("20260801T101010", 11);
    const fresh = callsName("20260929T101010", 12);
    const disk = fakeFs({
      entries: {
        [old]: { size: 1024, ageMs: 31 * DAY },
        [fresh]: { size: 1024, ageMs: DAY },
        "notes.txt": { size: 1024, ageMs: 400 * DAY },
        "calls-not-mine.jsonl": { size: 1024, ageMs: 400 * DAY },
      },
    });
    openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    await settled();

    expect(disk.removed).toEqual([old]);
    expect(disk.statNames).toEqual(expect.arrayContaining([old, fresh]));
    expect(disk.statNames).not.toContain("notes.txt");
    expect(disk.statNames).not.toContain("calls-not-mine.jsonl");
  });

  it("trims oldest-first only as far as the directory budget needs", async () => {
    const megabyte = 1024 * 1024;
    const oldest = callsName("20260901T000000", 1);
    const middle = callsName("20260902T000000", 2);
    const newest = callsName("20260929T000000", 3);
    const disk = fakeFs({
      entries: {
        [oldest]: { size: 30 * megabyte, ageMs: 3 * DAY },
        [middle]: { size: 30 * megabyte, ageMs: 2 * DAY },
        [newest]: { size: 30 * megabyte, ageMs: DAY },
      },
    });
    openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    await settled();

    expect(disk.removed).toEqual([oldest]);
  });

  it("leaves the directory alone when it is already under budget", async () => {
    const disk = fakeFs({ entries: { [callsName("20260901T000000", 1)]: { size: 1024, ageMs: DAY } } });
    openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    await settled();
    expect(disk.removed).toEqual([]);
  });

  it("keeps pruning quietly when a file vanishes between the listing and the stat", async () => {
    const entries = { [callsName("20260801T000000", 1)]: { size: 1024, ageMs: 40 * DAY } };
    const disk = fakeFs({ entries });
    disk.fs.stat = () => Promise.reject(new Error("ENOENT while statting"));
    openCallLog({ kind: "on", dir: DIR }, { fs: disk.fs });
    await settled();

    expect(disk.removed).toEqual([]);
  });
});
