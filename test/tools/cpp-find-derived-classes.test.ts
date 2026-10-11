import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SWEEP_CEILING_MS,
  type ClangQueryExecFn,
} from "../../src/clang-query/find-derived-classes.js";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { CppFindDerivedClassesInput, runCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";
import { registeredDescription } from "../helpers/cpp-find-derived-classes.js";

type ProgressParams = { progressToken: string | number; progress: number; total: number; message: string };

function progressParamsOf(notifications: unknown[]): ProgressParams[] {
  return notifications.map((n) => (n as { params: ProgressParams }).params);
}

/** MCP 2025-11-25 §Progress: the `progress` value MUST increase with each notification. */
function expectMonotonicProgress(params: ProgressParams[]): void {
  expect(params.length).toBeGreaterThan(0);
  for (let i = 1; i < params.length; i++) {
    expect(params[i]!.progress).toBeGreaterThan(params[i - 1]!.progress);
  }
}

/** An exec that never resolves on its own — it only reacts to the abort signal, like a wedged clang-query parse. */
const hangingExec: ClangQueryExecFn = (_args, _cwd, signal) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

describe("runCppFindDerivedClasses", () => {
  let projectRoot: string;
  let cache: SweepCache;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-"));
    cache = new SweepCache();
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }]),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns the union of matches, wrapped under `matches`, plus a `sweep` block", async () => {
    const header = join(projectRoot, "derived.h");
    writeFileSync(header, "class Derived : public Base {};\n");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${header}:1:7: note: "derived" binds here\n`,
      stderr: "",
    });
    const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.matches).toEqual([{ className: "Derived", file: header, line: 1, column: 7, direct: false }]);
    expect(out.structuredContent).not.toHaveProperty("failedFiles");
    expect(out.structuredContent.sweep).toMatchObject({ totalTus: 1, cachedTus: 0 });
  });

  it("returns isError when compile_commands.json is missing", async () => {
    rmSync(join(projectRoot, "compile_commands.json"));
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(out.isError).toBe(true);
  });

  it("names the build directory that holds the database, and sweeps nothing under a root that has none", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-repo-"));
    try {
      mkdirSync(join(repoRoot, "build"), { recursive: true });
      writeFileSync(
        join(repoRoot, "build", "compile_commands.json"),
        JSON.stringify([{ directory: repoRoot, file: "a.cpp" }]),
      );
      const exec: ClangQueryExecFn = () => {
        throw new Error("clang-query must not run for a root that holds no database");
      };

      const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot: repoRoot, qualifiedName: "Base" });

      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toBe(
        `cpp_find_derived_classes failed: compile_commands.json not found or unreadable at "${repoRoot}". ` +
          `Directories under it that hold a compile_commands.json, nearest first: "${join(repoRoot, "build")}". ` +
          "Pass one of them as projectRoot.",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns isError:false with the failure recorded in failedFiles when a TU fails beside a clean one", async () => {
    // A TU that ran and failed to compile is still not the call failing; only a sweep whose EVERY TU
    // failed the same way is (see the uniform-sweep-failure suite).
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, file: "a.cpp" },
        { directory: projectRoot, file: "b.cpp" },
      ]),
    );
    const exec: ClangQueryExecFn = async (args) =>
      args[2] === join(projectRoot, "a.cpp")
        ? { exitCode: 1, stdout: "", stderr: "compile error" }
        : { exitCode: 0, stdout: "", stderr: "" };
    const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.matches).toEqual([]);
    expect(out.structuredContent.failedFiles).toEqual([{ file: join(projectRoot, "a.cpp"), error: "compile error" }]);
  });

  it("rejects a `files` entry that escapes projectRoot", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const out = await runCppFindDerivedClasses(
      { exec, cache },
      { projectRoot, qualifiedName: "Base", files: ["../outside.cpp"] },
    );
    expect(out.isError).toBe(true);
  });

  it("restricts the sweep to the given files, resolved within projectRoot", async () => {
    const seenTus: string[] = [];
    const exec: ClangQueryExecFn = async (args) => {
      seenTus.push(args[2] as string);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base", files: ["a.cpp"] });
    expect(seenTus).toEqual([join(projectRoot, "a.cpp")]);
  });

  it("returns an empty matches array, not an error, when there are genuinely no derived classes", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.matches).toEqual([]);
  });

  it("omits failedFiles entirely when every TU swept cleanly", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(out.structuredContent).not.toHaveProperty("failedFiles");
  });

  it("serves a repeat call from the injected SweepCache without re-invoking exec", async () => {
    let execCalls = 0;
    const exec: ClangQueryExecFn = async () => {
      execCalls++;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const first = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(first.structuredContent.sweep.cache).toBe("miss");
    const second = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(second.structuredContent.sweep).toMatchObject({ cache: "hit", cachedTus: 1, totalTus: 1 });
    expect(execCalls).toBe(1);
  });

  it("re-sweeps after a tracked source file changes, invalidating the cache", async () => {
    let execCalls = 0;
    const exec: ClangQueryExecFn = async () => {
      execCalls++;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    writeFileSync(join(projectRoot, "a.cpp"), "class Touched {};\n");
    const second = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(second.structuredContent.sweep).toMatchObject({ cache: "miss", cachedTus: 0 });
    expect(execCalls).toBe(2);
  });

  it("returns a truncated (isError:true) partial result naming the remedy when the sweep hits its time budget", async () => {
    const exec: ClangQueryExecFn = async (_args, _cwd, signal) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base", timeBudgetMs: 20 });
    expect(out.isError).toBe(true);
    expect(out.structuredContent?.incomplete).toEqual({ sweptTus: 0, totalTus: 1, reason: "time-budget" });
    expect(out.content[0]?.text).toContain("files");
    expect(out.content[0]?.text).toContain("call again");
  });
});

describe("runCppFindDerivedClasses — derivation views", () => {
  let projectRoot: string;
  let cache: SweepCache;
  let execCalls: number;

  const header = (name: string) => join(projectRoot, name);
  const note = (name: string, bind: "derived" | "direct") => `${header(name)}:1:1: note: "${bind}" binds here\n`;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-derivation-"));
    cache = new SweepCache();
    execCalls = 0;
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }]),
    );
    writeFileSync(header("MarketData.h"), "class MarketData : public IEngineCallback {};\n");
    writeFileSync(header("Trading.h"), "class Trading : public IEngineCallback {};\n");
    writeFileSync(header("Session.h"), "class Session : public Trading {};\n");
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** One TU in which two of the three declarations name the queried base in their own base list. */
  const sweepExec: ClangQueryExecFn = async () => {
    execCalls++;
    return {
      exitCode: 0,
      stdout:
        note("MarketData.h", "derived") +
        note("Session.h", "derived") +
        note("Trading.h", "derived") +
        note("MarketData.h", "direct") +
        note("Trading.h", "direct"),
      stderr: "",
    };
  };

  const row = (file: string, direct: boolean) => ({
    className: file.replace(/\.h$/, ""),
    file: header(file),
    line: 1,
    column: 1,
    direct,
  });
  const allRows = () => [row("MarketData.h", true), row("Session.h", false), row("Trading.h", true)];
  const directRows = () => allRows().filter((r) => r.direct);

  it("answers the transitive view when `derivation` is omitted, echoing it as the first key", async () => {
    const out = await runCppFindDerivedClasses({ exec: sweepExec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(out.isError).toBeFalsy();
    expect(Object.keys(out.structuredContent)[0]).toBe("derivation");
    expect(out.structuredContent.derivation).toBe("transitive");
    expect(out.structuredContent.matches).toEqual(allRows());
    expect(out.structuredContent.counts).toEqual({ transitive: 3, direct: 2 });
  });

  it("resolves the default both when the key is absent and when it arrives explicitly undefined", async () => {
    const absent = await runCppFindDerivedClasses({ exec: sweepExec, cache }, { projectRoot, qualifiedName: "Base" });
    const explicit = await runCppFindDerivedClasses(
      { exec: sweepExec, cache },
      { projectRoot, qualifiedName: "Base", derivation: undefined },
    );
    expect(absent.structuredContent.derivation).toBe("transitive");
    expect(absent.structuredContent.matches).toEqual(allRows());
    expect(explicit.structuredContent.sweep.cache).toBe("hit");
    expect(explicit.structuredContent.derivation).toBe("transitive");
    expect(explicit.structuredContent.matches).toEqual(allRows());
  });

  it("`direct` returns only the rows that name the base themselves", async () => {
    const out = await runCppFindDerivedClasses(
      { exec: sweepExec, cache },
      { projectRoot, qualifiedName: "Base", derivation: "direct" },
    );
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.derivation).toBe("direct");
    expect(out.structuredContent.matches).toEqual(directRows());
    expect(out.structuredContent.matches).toHaveLength(2);
  });

  it("counts over the unfiltered rows under both views", async () => {
    const transitive = await runCppFindDerivedClasses({ exec: sweepExec, cache }, { projectRoot, qualifiedName: "Base" });
    cache.clear();
    const direct = await runCppFindDerivedClasses(
      { exec: sweepExec, cache },
      { projectRoot, qualifiedName: "Base", derivation: "direct" },
    );
    expect(transitive.structuredContent.counts).toEqual({ transitive: 3, direct: 2 });
    expect(direct.structuredContent.counts).toEqual({ transitive: 3, direct: 2 });
    expect(direct.structuredContent.matches).toHaveLength(2);
  });

  it("serves a `direct` call that follows a transitive one entirely from the injected cache", async () => {
    const first = await runCppFindDerivedClasses({ exec: sweepExec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(first.structuredContent.sweep.cache).toBe("miss");
    const second = await runCppFindDerivedClasses(
      { exec: sweepExec, cache },
      { projectRoot, qualifiedName: "Base", derivation: "direct" },
    );
    expect(execCalls).toBe(1);
    expect(second.structuredContent.sweep).toMatchObject({ cache: "hit", cachedTus: 1, totalTus: 1 });
    expect(second.structuredContent.matches).toEqual(first.structuredContent.matches.filter((m) => m.direct));
  });

  it("echoes the derivation on a payload that carries only failedFiles", async () => {
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, file: "a.cpp" },
        { directory: projectRoot, file: "b.cpp" },
      ]),
    );
    const failing: ClangQueryExecFn = async (args) =>
      args[2] === join(projectRoot, "a.cpp")
        ? { exitCode: 1, stdout: "", stderr: "compile error" }
        : { exitCode: 0, stdout: "", stderr: "" };
    const out = await runCppFindDerivedClasses(
      { exec: failing, cache },
      { projectRoot, qualifiedName: "Base", derivation: "direct" },
    );
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.derivation).toBe("direct");
    expect(out.structuredContent.counts).toEqual({ transitive: 0, direct: 0 });
    expect(out.structuredContent.failedFiles).toEqual([{ file: join(projectRoot, "a.cpp"), error: "compile error" }]);
  });

  it("echoes the derivation on the partial payload and names it, with all three remedies, in the ceiling text", async () => {
    const out = await runCppFindDerivedClasses(
      { exec: hangingExec, cache },
      { projectRoot, qualifiedName: "Base", derivation: "direct", timeBudgetMs: 20 },
    );
    expect(out.isError).toBe(true);
    expect(out.structuredContent.derivation).toBe("direct");
    expect(out.structuredContent.counts).toEqual({ transitive: 0, direct: 0 });
    expect(out.structuredContent.incomplete).toEqual({ sweptTus: 0, totalTus: 1, reason: "time-budget" });
    const text = out.content[0]?.text ?? "";
    expect(text).toContain('derivation: "direct"');
    expect(text).toContain("`files`");
    expect(text).toContain("`timeBudgetMs`");
    expect(text).toContain("call again");
  });
});

describe("runCppFindDerivedClasses — uniform sweep failure", () => {
  let projectRoot: string;
  let cache: SweepCache;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-uniform-"));
    cache = new SweepCache();
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }, { directory: projectRoot, file: "b.cpp" }]),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("turns an identical failure on every TU into an error naming the shared error once, with no payload", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 1, stdout: "", stderr: "error: unknown matcher" });
    const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(out.isError).toBe(true);
    expect(out).not.toHaveProperty("structuredContent");
    expect(out.content[0]?.text).toBe(
      "cpp_find_derived_classes failed on all 2 translation units with the same error, so the empty result is a " +
        "sweep failure, not an empty hierarchy - check that the clang-query on PATH supports this query. " +
        "Shared error: error: unknown matcher",
    );
    expect(out.content[0]?.text?.match(/error: unknown matcher/g)).toHaveLength(1);
  });

  it("is an error on a one-TU scope too, and names the file that failed", async () => {
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }]),
    );
    const exec: ClangQueryExecFn = async () => ({ exitCode: 1, stdout: "", stderr: "error: unknown matcher" });
    const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toBe(
      "cpp_find_derived_classes failed on all 1 translation units with the same error, so the empty result is a " +
        "sweep failure, not an empty hierarchy - check that the clang-query on PATH supports this query. " +
        "Shared error: error: unknown matcher Failed file: " + join(projectRoot, "a.cpp"),
    );
  });

  it("keeps isError:false with failedFiles when one TU fails beside one that succeeds", async () => {
    const exec: ClangQueryExecFn = async (args) =>
      args[2] === join(projectRoot, "a.cpp")
        ? { exitCode: 1, stdout: "", stderr: "fatal error: x.h not found" }
        : { exitCode: 0, stdout: "", stderr: "" };
    const out = await runCppFindDerivedClasses({ exec, cache }, { projectRoot, qualifiedName: "Base" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.failedFiles).toEqual([
      { file: join(projectRoot, "a.cpp"), error: "fatal error: x.h not found" },
    ]);
    expect(out.structuredContent.counts).toEqual({ transitive: 0, direct: 0 });
  });
});

describe("runCppFindDerivedClasses with sourceRoots (out-of-tree build layout)", () => {
  let buildRoot: string;
  let sourceRoot: string;
  let cache: SweepCache;

  beforeEach(() => {
    buildRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-build-"));
    sourceRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-src-"));
    cache = new SweepCache();
    writeFileSync(
      join(buildRoot, "compile_commands.json"),
      JSON.stringify([{ directory: sourceRoot, file: "a.cpp" }]),
    );
  });

  afterEach(() => {
    rmSync(buildRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("restricts the sweep to a `files` entry resolved under a declared sourceRoots entry", async () => {
    const seenTus: string[] = [];
    const exec: ClangQueryExecFn = async (args) => {
      seenTus.push(args[2] as string);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runCppFindDerivedClasses(
      { exec, cache },
      { projectRoot: buildRoot, qualifiedName: "Base", files: [join(sourceRoot, "a.cpp")], sourceRoots: [sourceRoot] },
    );
    expect(seenTus).toEqual([join(sourceRoot, "a.cpp")]);
  });

  it("still rejects a `files` entry outside every declared root, naming all of them", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const elsewhere = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-elsewhere-"));
    try {
      const out = await runCppFindDerivedClasses(
        { exec, cache },
        {
          projectRoot: buildRoot,
          qualifiedName: "Base",
          files: [join(elsewhere, "x.cpp")],
          sourceRoots: [sourceRoot],
        },
      );
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain(buildRoot);
      expect(out.content[0]?.text).toContain(sourceRoot);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("stays a containment failure rather than an empty `direct` answer, naming every root", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const elsewhere = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-elsewhere-"));
    try {
      const out = await runCppFindDerivedClasses(
        { exec, cache },
        {
          projectRoot: buildRoot,
          qualifiedName: "Base",
          derivation: "direct",
          files: [join(elsewhere, "x.cpp")],
          sourceRoots: [sourceRoot],
        },
      );
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain(buildRoot);
      expect(out.content[0]?.text).toContain(sourceRoot);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("runCppFindDerivedClasses — progress reporting", () => {
  let projectRoot: string;
  let cache: SweepCache;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-progress-"));
    cache = new SweepCache();
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }, { directory: projectRoot, file: "b.cpp" }]),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("sends a final notifications/progress update whose message carries the full TU count, with monotonic elapsed-ms progress", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const notifications: unknown[] = [];
    await runCppFindDerivedClasses(
      { exec, cache },
      { projectRoot, qualifiedName: "Base" },
      {
        progressToken: "tok-1",
        sendNotification: async (n) => {
          notifications.push(n);
        },
      },
    );
    const params = progressParamsOf(notifications);
    expect(params.at(-1)!.message).toContain("2/2");
    expectMonotonicProgress(params);
    // `total` is now the ceiling this call runs under, not a TU total.
    for (const p of params) expect(p.total).toBe(DEFAULT_SWEEP_CEILING_MS);
    expect(DEFAULT_SWEEP_CEILING_MS).toBe(300_000);
  });

  it("sends no notification when no progressToken is supplied", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const notifications: unknown[] = [];
    await runCppFindDerivedClasses(
      { exec, cache },
      { projectRoot, qualifiedName: "Base" },
      { sendNotification: async (n) => void notifications.push(n) },
    );
    expect(notifications).toEqual([]);
  });
});

describe("runCppFindDerivedClasses — progress heartbeat and reporter lifetime", () => {
  let projectRoot: string;
  let cache: SweepCache;
  let notifications: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    notifications = [];
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fdc-heartbeat-"));
    cache = new SweepCache();
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }, { directory: projectRoot, file: "b.cpp" }]),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("keeps emitting on the heartbeat while no translation unit has completed", async () => {
    const pending = runCppFindDerivedClasses(
      { exec: hangingExec, cache },
      { projectRoot, qualifiedName: "Base", timeBudgetMs: 12_000 },
      {
        progressToken: "tok-hb",
        sendNotification: async (n) => {
          notifications.push(n);
        },
      },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    const afterFirstHeartbeat = progressParamsOf(notifications);
    expect(afterFirstHeartbeat).toHaveLength(1);
    expect(afterFirstHeartbeat[0]!.message).toContain("0/0 translation units");
    expect(afterFirstHeartbeat[0]!.message).toContain("5000 ms elapsed");
    expect(afterFirstHeartbeat[0]!.total).toBe(12_000);

    await vi.advanceTimersByTimeAsync(7_000);
    const out = await pending;
    expect(out.isError).toBe(true);

    const params = progressParamsOf(notifications);
    expect(params).toHaveLength(3);
    expectMonotonicProgress(params);
    for (const p of params) expect(p.message).toContain("0/0 translation units");
  });

  it("keeps `progress` strictly increasing when two emissions collide in the same millisecond", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    await runCppFindDerivedClasses(
      { exec, cache },
      { projectRoot, qualifiedName: "Base" },
      {
        progressToken: "tok-collide",
        sendNotification: async (n) => {
          notifications.push(n);
        },
      },
    );

    const params = progressParamsOf(notifications);
    expect(params.length).toBeGreaterThan(1);
    // The fake clock never advances, so every elapsed value here is identical: the increase can only
    // come from the guard, not from time passing.
    for (const p of params) expect(p.message).toMatch(/, 0 ms elapsed$/);
    expectMonotonicProgress(params);
  });

  it("sends nothing after the result has returned", async () => {
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    await runCppFindDerivedClasses(
      { exec, cache },
      { projectRoot, qualifiedName: "Base" },
      {
        progressToken: "tok-dispose",
        sendNotification: async (n) => {
          notifications.push(n);
        },
      },
    );
    const sentDuringCall = notifications.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifications).toHaveLength(sentDuringCall);
  });
});

describe("CppFindDerivedClassesInput", () => {
  it("accepts a bare name, a qualified name, and a leading-:: global-qualified name", () => {
    expect(CppFindDerivedClassesInput.shape.qualifiedName.safeParse("IFoo").success).toBe(true);
    expect(CppFindDerivedClassesInput.shape.qualifiedName.safeParse("ns::IFoo").success).toBe(true);
    expect(CppFindDerivedClassesInput.shape.qualifiedName.safeParse("::ns::IFoo").success).toBe(true);
  });

  it("rejects a qualifiedName containing a quote, before it ever reaches the clang-query matcher string", () => {
    const parsed = CppFindDerivedClassesInput.shape.qualifiedName.safeParse('IFoo")); match cxxRecordDecl((');
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty segment (:: with nothing on one side)", () => {
    expect(CppFindDerivedClassesInput.shape.qualifiedName.safeParse("ns::").success).toBe(false);
    expect(CppFindDerivedClassesInput.shape.qualifiedName.safeParse("ns::::IFoo").success).toBe(false);
  });

  it("accepts an omitted timeBudgetMs and rejects one above the 600000 ms ceiling", () => {
    expect(CppFindDerivedClassesInput.shape.timeBudgetMs.safeParse(undefined).success).toBe(true);
    expect(CppFindDerivedClassesInput.shape.timeBudgetMs.safeParse(600_000).success).toBe(true);
    expect(CppFindDerivedClassesInput.shape.timeBudgetMs.safeParse(600_001).success).toBe(false);
    expect(CppFindDerivedClassesInput.shape.timeBudgetMs.safeParse(0).success).toBe(false);
  });

  it("keeps `derivation` a closed enum of the two views", () => {
    expect(CppFindDerivedClassesInput.shape.derivation.safeParse("transitive").success).toBe(true);
    expect(CppFindDerivedClassesInput.shape.derivation.safeParse("direct").success).toBe(true);
    expect(CppFindDerivedClassesInput.shape.derivation.safeParse(undefined).success).toBe(true);
    expect(CppFindDerivedClassesInput.shape.derivation.safeParse(undefined).data).toBe("transitive");
    for (const rejected of ["Direct", "direct-only", "both", 1, true, null]) {
      expect(CppFindDerivedClassesInput.shape.derivation.safeParse(rejected).success).toBe(false);
    }
  });
});

describe("cpp_find_derived_classes description text", () => {
  it("says what the counts count and how to read them as classes", () => {
    const description = registeredDescription();
    expect(description).toContain("`counts` are matched source locations");
    expect(description).toContain("one per template form, test fixtures included");
    expect(description).toContain("count distinct `className` values in `matches`");
  });

  it("refuses the retry a long call invites", () => {
    const description = registeredDescription();
    expect(description).toContain(
      "do not retry a timed-out or truncated call expecting a different result",
    );
  });
});
