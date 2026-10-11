import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDerivedClasses, type ClangQueryExecFn } from "../../src/clang-query/find-derived-classes.js";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";

const readFile = (map: Record<string, string>) => (path: string) => {
  const content = map[path];
  if (content === undefined) throw new Error(`unexpected read: ${path}`);
  return content;
};

describe("findDerivedClasses", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("parses a bind-note match and extracts the class name from the source at that location", async () => {
    const tu = join(projectRoot, "a.cpp");
    const header = join(projectRoot, "derived.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${header}:3:7: note: "derived" binds here\n  class Derived : public Base {\n  ^\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFile({ [header]: "line1\nline2\nclass Derived : public Base {\n};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Derived", file: header, line: 3, column: 7, direct: false }]);
    expect(outcome.failedFiles).toEqual([]);
  });

  it("dedupes the same location reported by multiple translation units", async () => {
    const header = join(projectRoot, "derived.h");
    const tu1 = join(projectRoot, "a.cpp");
    const tu2 = join(projectRoot, "b.cpp");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${header}:3:7: note: "derived" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu1, tu2],
      exec,
      readFile: readFile({ [header]: "\n\nclass Derived : public Base {\n};\n" }),
    });
    expect(outcome.matches).toHaveLength(1);
  });

  it("returns an empty matches array when a TU compiles cleanly with no matches", async () => {
    const tu = join(projectRoot, "a.cpp");
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const outcome = await findDerivedClasses({ projectRoot, qualifiedName: "Base", translationUnits: [tu], exec });
    expect(outcome.matches).toEqual([]);
    expect(outcome.failedFiles).toEqual([]);
  });

  it("records a per-TU clang-query failure in failedFiles and keeps sweeping the rest, instead of throwing", async () => {
    const badTu = join(projectRoot, "bad.cpp");
    const goodTu = join(projectRoot, "good.cpp");
    const header = join(projectRoot, "derived.h");
    const exec: ClangQueryExecFn = async (args) => {
      const tu = args[2];
      if (tu === badTu) return { exitCode: 1, stdout: "", stderr: "fatal error: x.h not found" };
      return { exitCode: 0, stdout: `${header}:1:7: note: "derived" binds here\n`, stderr: "" };
    };
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [badTu, goodTu],
      exec,
      readFile: readFile({ [header]: "class Derived : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Derived", file: header, line: 1, column: 7, direct: false }]);
    expect(outcome.failedFiles).toEqual([{ file: badTu, error: "fatal error: x.h not found" }]);
  });

  it("builds the failure text from clang-query's stdout diagnostics when stderr is empty", async () => {
    // Measured against clang-query 22.1.3 with only the second `-c` command unparseable: exit 1, EMPTY
    // stderr, and stdout beginning with the first command's `Match #1:` output before the diagnostics.
    const pairTu = join(projectRoot, "pair.cpp");
    const plainTu = join(projectRoot, "plain.cpp");
    const emptyTu = join(projectRoot, "empty.cpp");
    const stderrTu = join(projectRoot, "stderr.cpp");
    const stdoutByTu: Record<string, string> = {
      [pairTu]:
        "Match #1:\n1:1: derived: Base\nMatch #2:\n<3 lines omitted>\n" +
        "1:1: Error parsing argument 1 for matcher cxxRecordDecl.\n1:15: Matcher not found: isNoSuchMatcher\n",
      [plainTu]: "Match #1:\nnothing here says why\n",
      [emptyTu]: "",
      [stderrTu]: "ignored because stderr has the cause\n",
    };
    const exec: ClangQueryExecFn = async (args) => ({
      exitCode: 1,
      stdout: stdoutByTu[args[2] as string] ?? "",
      stderr: args[2] === stderrTu ? "  fatal error: x.h not found  " : "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [pairTu, plainTu, emptyTu, stderrTu],
      exec,
    });
    const errorFor = (tu: string) => outcome.failedFiles.find((entry) => entry.file === tu)?.error ?? "";

    expect(errorFor(pairTu)).toBe(
      "1:1: Error parsing argument 1 for matcher cxxRecordDecl. 1:15: Matcher not found: isNoSuchMatcher",
    );
    expect(errorFor(plainTu)).toBe("nothing here says why");
    expect(errorFor(emptyTu)).toBe("non-zero exit, no stderr captured");
    expect(errorFor(stderrTu)).toBe("fatal error: x.h not found");
    expect(outcome.uniformFailure).toBeUndefined();
  });

  it("returns empty matches with every TU listed in failedFiles when all TUs fail", async () => {
    const tu1 = join(projectRoot, "a.cpp");
    const tu2 = join(projectRoot, "b.cpp");
    const exec: ClangQueryExecFn = async () => ({ exitCode: 1, stdout: "", stderr: "compile error" });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu1, tu2],
      exec,
    });
    expect(outcome.matches).toEqual([]);
    expect(outcome.failedFiles).toEqual([
      { file: tu1, error: "compile error" },
      { file: tu2, error: "compile error" },
    ]);
  });

  it("falls back to compile_commands.json when translationUnits is omitted", async () => {
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }]),
    );
    const seenArgs: string[][] = [];
    const exec: ClangQueryExecFn = async (args) => {
      seenArgs.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await findDerivedClasses({ projectRoot, qualifiedName: "Base", exec });
    expect(seenArgs).toHaveLength(1);
    expect(seenArgs[0]).toContain(join(projectRoot, "a.cpp"));
  });

  it("records a match whose source location can't be read in failedFiles, instead of silently dropping it", async () => {
    const tu = join(projectRoot, "a.cpp");
    const missingHeader = join(projectRoot, "missing.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${missingHeader}:1:1: note: "derived" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(outcome.matches).toEqual([]);
    expect(outcome.failedFiles).toHaveLength(1);
    expect(outcome.failedFiles[0]).toMatchObject({ file: missingHeader });
    expect(outcome.failedFiles[0]?.error).toContain("1:1");
  });

  it("resolves a relative note-path (as clang-query echoes back a relative compile-command spelling) against projectRoot before reading it", async () => {
    const tu = join(projectRoot, "a.cpp");
    const header = join(projectRoot, "derived.h");
    writeFileSync(header, "class Derived : public Base {};\n");
    // The note names ONLY "derived.h" — no directory component — exactly what clang-query echoes
    // back when the compile command used a relative source-file spelling.
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: 'derived.h:1:7: note: "derived" binds here\n',
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFile({ [header]: "class Derived : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Derived", file: header, line: 1, column: 7, direct: false }]);
    expect(outcome.failedFiles).toEqual([]);
  });

  it("extracts the class name when the bind location is the START OF THE FULL DECLARATION (the `class` keyword), not the identifier", async () => {
    // Checked with clang-query 22.1.3: a cxxRecordDecl bind's note location is
    // column 1 of "class Derived : public Base {};" — pointing at "class", not "Derived".
    const tu = join(projectRoot, "a.cpp");
    const header = join(projectRoot, "derived.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${header}:1:1: note: "derived" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFile({ [header]: "class Derived : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Derived", file: header, line: 1, column: 1, direct: false }]);
  });

  it("extracts the class name for a struct declaration the same way", async () => {
    const tu = join(projectRoot, "a.cpp");
    const header = join(projectRoot, "derived.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${header}:1:1: note: "derived" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFile({ [header]: "struct Derived : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Derived", file: header, line: 1, column: 1, direct: false }]);
  });

  it("recognizes an MSVC-style bind note (clang-cl.exe's `path(line,col):` format), not only GNU-style", async () => {
    // clang-cl.exe (the MSVC-compatible Windows driver) emits
    // "path(line,col): note: ..." instead of "path:line:col: note: ...". Without recognizing this
    // form, the per-line loop silently skips every bind line: zero matches AND zero failedFiles.
    const tu = join(projectRoot, "a.cpp");
    const header = join(projectRoot, "derived.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${header}(3,1): note: "derived" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFile({ [header]: "line1\nline2\nclass Derived : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Derived", file: header, line: 3, column: 1, direct: false }]);
    expect(outcome.failedFiles).toEqual([]);
  });

  it("a mixed TU (one readable match, one unreadable identifier) reports both — the readable one is not swallowed", async () => {
    const tu = join(projectRoot, "a.cpp");
    const goodHeader = join(projectRoot, "good.h");
    const badHeader = join(projectRoot, "bad.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout:
        `${goodHeader}:1:1: note: "derived" binds here\n` + `${badHeader}:1:1: note: "derived" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFile({ [goodHeader]: "class Derived : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Derived", file: goodHeader, line: 1, column: 1, direct: false }]);
    expect(outcome.failedFiles).toHaveLength(1);
    expect(outcome.failedFiles[0]?.file).toBe(badHeader);
  });
});

describe("findDerivedClasses — the two bind names", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-binds-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const BIND_NOTE = {
    GNU: (file: string, line: number, column: number, bind: string) =>
      `${file}:${line}:${column}: note: "${bind}" binds here\n`,
    MSVC: (file: string, line: number, column: number, bind: string) =>
      `${file}(${line},${column}): note: "${bind}" binds here\n`,
  };

  it.each(["GNU", "MSVC"] as const)(
    "reads both bind names from one stdout and joins directness by location (%s note format)",
    async (format) => {
      const note = BIND_NOTE[format];
      const tu = join(projectRoot, "a.cpp");
      const directHeader = join(projectRoot, "direct.h");
      const deepHeader = join(projectRoot, "deep.h");
      const exec: ClangQueryExecFn = async () => ({
        exitCode: 0,
        stdout:
          note(directHeader, 2, 1, "derived") + note(deepHeader, 1, 3, "derived") + note(directHeader, 2, 1, "direct"),
        stderr: "",
      });
      const outcome = await findDerivedClasses({
        projectRoot,
        qualifiedName: "Base",
        translationUnits: [tu],
        exec,
        readFile: readFile({
          [directHeader]: "int x;\nclass Direct : public Base {};\n",
          [deepHeader]: "  struct Deep : Middle {};\n",
        }),
      });
      expect(outcome.matches).toEqual([
        { className: "Direct", file: directHeader, line: 2, column: 1, direct: true },
        { className: "Deep", file: deepHeader, line: 1, column: 3, direct: false },
      ]);
      expect(outcome.failedFiles).toEqual([]);
    },
  );

  it("keeps a location that only the direct command reported", async () => {
    const tu = join(projectRoot, "a.cpp");
    const file = join(projectRoot, "direct.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${file}:1:1: note: "direct" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFile({ [file]: "class Direct : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Direct", file, line: 1, column: 1, direct: true }]);
    expect(outcome.failedFiles).toEqual([]);
  });

  it("collapses repeated notes at one location into a single row that keeps its directness", async () => {
    const tu = join(projectRoot, "a.cpp");
    const file = join(projectRoot, "direct.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout:
        `${file}:1:1: note: "direct" binds here\n` +
        `${file}:1:1: note: "derived" binds here\n` +
        `${file}:1:1: note: "direct" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFile({ [file]: "class Direct : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Direct", file, line: 1, column: 1, direct: true }]);
    expect(outcome.failedFiles).toEqual([]);
  });

  it("reports one failedFiles entry for an unreadable location that both commands noted", async () => {
    const tu = join(projectRoot, "a.cpp");
    const file = join(projectRoot, "gone.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${file}:4:9: note: "derived" binds here\n${file}:4:9: note: "direct" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(outcome.matches).toEqual([]);
    expect(outcome.failedFiles).toHaveLength(1);
    expect(outcome.failedFiles[0]?.error).toContain("4:9");
  });

  it("OR-s directness across translation units regardless of which one is swept first", async () => {
    const derivedTu = join(projectRoot, "derived.cpp");
    const directTu = join(projectRoot, "direct.cpp");
    const file = join(projectRoot, "direct.h");
    const sweepWith = (translationUnits: string[]) =>
      findDerivedClasses({
        projectRoot,
        qualifiedName: "Base",
        translationUnits,
        maxParallel: 1,
        exec: async (args) => ({
          exitCode: 0,
          stdout: `${file}:1:1: note: "${args[2] === derivedTu ? "derived" : "direct"}" binds here\n`,
          stderr: "",
        }),
        readFile: readFile({ [file]: "class Direct : public Base {};\n" }),
      });

    const row = { className: "Direct", file, line: 1, column: 1, direct: true };
    expect((await sweepWith([derivedTu, directTu])).matches).toEqual([row]);
    expect((await sweepWith([directTu, derivedTu])).matches).toEqual([row]);
  });

  it("ignores a note whose bind name is neither of the two commands this sweep issues", async () => {
    const tu = join(projectRoot, "a.cpp");
    const file = join(projectRoot, "direct.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${file}:1:1: note: "matched" binds here\n`,
      stderr: "",
    });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFile({ [file]: "class Direct : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([]);
    expect(outcome.failedFiles).toEqual([]);
  });

  it("issues both matchers in one clang-query invocation, transitive first", async () => {
    const tu = join(projectRoot, "a.cpp");
    const seenArgs: string[][] = [];
    const exec: ClangQueryExecFn = async (args) => {
      seenArgs.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await findDerivedClasses({ projectRoot, qualifiedName: "ns::Base", translationUnits: [tu], exec });
    expect(seenArgs).toEqual([
      [
        "-p",
        projectRoot,
        tu,
        "-c",
        'match cxxRecordDecl(isDerivedFrom(hasName("ns::Base"))).bind("derived")',
        "-c",
        'match cxxRecordDecl(isDirectlyDerivedFrom(hasName("ns::Base"))).bind("direct")',
      ],
    ]);
  });
});

describe("findDerivedClasses — sweep stats (uncached)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-sweep-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("reports sweep.cache as 'disabled' with totalTus/cachedTus when no cache/fingerprint is supplied", async () => {
    const tu = join(projectRoot, "a.cpp");
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const outcome = await findDerivedClasses({ projectRoot, qualifiedName: "Base", translationUnits: [tu], exec });
    expect(outcome.sweep).toMatchObject({ cache: "disabled", cachedTus: 0, totalTus: 1 });
    expect(outcome.sweep.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(outcome.incomplete).toBeUndefined();
  });
});

describe("findDerivedClasses — bounded-parallel sweep", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-pool-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("never runs more than maxParallel clang-query children concurrently, but does parallelize", async () => {
    const tus = Array.from({ length: 6 }, (_, i) => join(projectRoot, `f${i}.cpp`));
    let inFlight = 0;
    let maxInFlight = 0;
    const exec: ClangQueryExecFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: tus,
      exec,
      maxParallel: 2,
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(outcome.sweep.totalTus).toBe(6);
    expect(outcome.incomplete).toBeUndefined();
  });
});

describe("findDerivedClasses — time budget and cancellation", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-budget-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("a TU truncated by the time budget is absent from failedFiles and not counted as swept, while a TU that finished in time still counts", async () => {
    const fastTu = join(projectRoot, "fast.cpp");
    const slowTu = join(projectRoot, "slow.cpp");
    const header = join(projectRoot, "derived.h");
    const exec: ClangQueryExecFn = async (args, _cwd, signal) => {
      const tu = args[2];
      if (tu === fastTu) {
        return { exitCode: 0, stdout: `${header}:1:1: note: "derived" binds here\n`, stderr: "" };
      }
      // Never resolves on its own — only reacts to the abort signal, exactly like execFile with `signal`.
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [fastTu, slowTu],
      exec,
      maxParallel: 2,
      timeBudgetMs: 30,
      readFile: readFile({ [header]: "class Derived : public Base {};\n" }),
    });
    expect(outcome.matches).toEqual([{ className: "Derived", file: header, line: 1, column: 1, direct: false }]);
    expect(outcome.failedFiles).toEqual([]);
    expect(outcome.incomplete).toEqual({ sweptTus: 1, totalTus: 2, reason: "time-budget" });
  });

  it("an externally cancelled sweep reports the incomplete reason as 'cancelled', not 'time-budget'", async () => {
    const tu = join(projectRoot, "a.cpp");
    const controller = new AbortController();
    const exec: ClangQueryExecFn = async (_args, _cwd, signal) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const pending = findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      timeBudgetMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.incomplete).toEqual({ sweptTus: 0, totalTus: 1, reason: "cancelled" });
    expect(result.failedFiles).toEqual([]);
    expect(result.matches).toEqual([]);
  });
});

describe("findDerivedClasses with a SweepCache", () => {
  let projectRoot: string;
  let cache: SweepCache;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-cache-"));
    cache = new SweepCache();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("serves a repeat call for the same fingerprint entirely from cache, without invoking exec again", async () => {
    const tu = join(projectRoot, "a.cpp");
    const header = join(projectRoot, "derived.h");
    let execCalls = 0;
    const exec: ClangQueryExecFn = async () => {
      execCalls++;
      return { exitCode: 0, stdout: `${header}:1:1: note: "derived" binds here\n`, stderr: "" };
    };
    const readFileFn = readFile({ [header]: "class Derived : public Base {};\n" });

    const first = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFileFn,
      cache,
      fingerprint: "fp1",
    });
    expect(first.sweep.cache).toBe("miss");
    expect(execCalls).toBe(1);

    const second = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFileFn,
      cache,
      fingerprint: "fp1",
    });
    expect(second.sweep).toMatchObject({ cache: "hit", cachedTus: 1, totalTus: 1 });
    expect(execCalls).toBe(1);
    expect(second.matches).toEqual(first.matches);
  });

  it("drops the whole projectRoot's cache (every query) when the fingerprint changes", async () => {
    const tu = join(projectRoot, "a.cpp");
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    await findDerivedClasses({ projectRoot, qualifiedName: "Base", translationUnits: [tu], exec, cache, fingerprint: "fp1" });
    await findDerivedClasses({ projectRoot, qualifiedName: "Other", translationUnits: [tu], exec, cache, fingerprint: "fp1" });

    expect(cache.lookup(projectRoot, "Other", "fp1").size).toBe(1);
    const changed = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      cache,
      fingerprint: "fp2",
    });
    expect(changed.sweep.cachedTus).toBe(0);
    // The mismatch fires on the FIRST lookup against the new fingerprint (qualifiedName "Base" here) and
    // drops the whole projectRoot entry — "Other"'s fp1 data is gone too, not just "Base"'s.
    expect(cache.lookup(projectRoot, "Other", "fp1").size).toBe(0);
  });

  it("a TU whose clang-query run failed is not cached, so the next call re-runs it while a clean TU is served from cache", async () => {
    const badTu = join(projectRoot, "bad.cpp");
    const goodTu = join(projectRoot, "good.cpp");
    const header = join(projectRoot, "derived.h");
    let badCalls = 0;
    const exec: ClangQueryExecFn = async (args) => {
      if (args[2] === badTu) {
        badCalls++;
        return { exitCode: 1, stdout: "", stderr: "compile error" };
      }
      return { exitCode: 0, stdout: `${header}:1:1: note: "derived" binds here\n`, stderr: "" };
    };
    const args = {
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [badTu, goodTu],
      exec,
      readFile: readFile({ [header]: "class Derived : public Base {};\n" }),
      cache,
      fingerprint: "fp1",
    };

    const first = await findDerivedClasses(args);
    expect(first.failedFiles).toEqual([{ file: badTu, error: "compile error" }]);
    expect(first.sweep.cachedTus).toBe(0);
    // Only the clean outcome is stored: a failure may be the environment, not the source.
    expect(Array.from(cache.lookup(projectRoot, "Base", "fp1").keys())).toEqual([goodTu]);

    const second = await findDerivedClasses(args);
    expect(badCalls).toBe(2);
    expect(second.sweep).toMatchObject({ cache: "partial", cachedTus: 1, totalTus: 2 });
    expect(second.failedFiles).toEqual([{ file: badTu, error: "compile error" }]);
    expect(second.matches).toEqual(first.matches);
  });

  it("does not cache a TU interrupted by the time budget — a later call re-sweeps it fresh", async () => {
    const tu = join(projectRoot, "a.cpp");
    let attempt = 0;
    const exec: ClangQueryExecFn = async (_args, _cwd, signal) => {
      attempt++;
      if (attempt === 1) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const truncated = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      cache,
      fingerprint: "fp1",
      timeBudgetMs: 20,
    });
    expect(truncated.incomplete).toEqual({ sweptTus: 0, totalTus: 1, reason: "time-budget" });
    expect(cache.lookup(projectRoot, "Base", "fp1").size).toBe(0);

    const resumed = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      cache,
      fingerprint: "fp1",
    });
    expect(resumed.incomplete).toBeUndefined();
    expect(resumed.sweep.cachedTus).toBe(0);
    expect(attempt).toBe(2);
  });

  it("mixing cached and pending TUs reports sweep.cache as 'partial'", async () => {
    const tu1 = join(projectRoot, "a.cpp");
    const tu2 = join(projectRoot, "b.cpp");
    const exec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    await findDerivedClasses({ projectRoot, qualifiedName: "Base", translationUnits: [tu1], exec, cache, fingerprint: "fp1" });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu1, tu2],
      exec,
      cache,
      fingerprint: "fp1",
    });
    expect(outcome.sweep).toMatchObject({ cache: "partial", cachedTus: 1, totalTus: 2 });
  });

  it("a cache hit for a mixed TU replays only the cached good matches — the extraction failure is not re-derived from cache", async () => {
    const tu = join(projectRoot, "a.cpp");
    const goodHeader = join(projectRoot, "good.h");
    const badHeader = join(projectRoot, "bad.h");
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout:
        `${goodHeader}:1:1: note: "derived" binds here\n` + `${badHeader}:1:1: note: "derived" binds here\n`,
      stderr: "",
    });
    const readFileFn = readFile({ [goodHeader]: "class Derived : public Base {};\n" });

    const first = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec,
      readFile: readFileFn,
      cache,
      fingerprint: "fp1",
    });
    expect(first.failedFiles).toHaveLength(1);

    const second = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu],
      exec: async () => {
        throw new Error("should not run on a cache hit");
      },
      readFile: readFileFn,
      cache,
      fingerprint: "fp1",
    });
    expect(second.sweep.cache).toBe("hit");
    expect(second.matches).toEqual(first.matches);
    expect(second.failedFiles).toEqual([]);
  });
});

describe("findDerivedClasses — uniform sweep failure", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-uniform-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("names the shared error and the TU count when a complete sweep failed every TU the same way", async () => {
    const tu1 = join(projectRoot, "a.cpp");
    const tu2 = join(projectRoot, "b.cpp");
    const exec: ClangQueryExecFn = async () => ({ exitCode: 1, stdout: "", stderr: "error: unknown matcher" });
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu1, tu2],
      exec,
    });
    expect(outcome.uniformFailure).toEqual({ error: "error: unknown matcher", failedTus: 2 });
    expect(outcome.matches).toEqual([]);
    expect(outcome.incomplete).toBeUndefined();
    // The verdict is additive — the TUs stay listed in failedFiles exactly as before.
    expect(outcome.failedFiles).toEqual([
      { file: tu1, error: "error: unknown matcher" },
      { file: tu2, error: "error: unknown matcher" },
    ]);
  });

  it("is not set when one TU succeeded beside the identically failing ones", async () => {
    const badTu1 = join(projectRoot, "a.cpp");
    const badTu2 = join(projectRoot, "b.cpp");
    const goodTu = join(projectRoot, "c.cpp");
    const exec: ClangQueryExecFn = async (args) =>
      args[2] === goodTu
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "error: unknown matcher" };
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [badTu1, badTu2, goodTu],
      exec,
    });
    expect(outcome.uniformFailure).toBeUndefined();
    expect(outcome.failedFiles).toHaveLength(2);
  });

  it("is not set when the failures carry different errors", async () => {
    const tu1 = join(projectRoot, "a.cpp");
    const tu2 = join(projectRoot, "b.cpp");
    const exec: ClangQueryExecFn = async (args) => ({
      exitCode: 1,
      stdout: "",
      stderr: args[2] === tu1 ? "error: unknown matcher" : "fatal error: base.h not found",
    });
    const outcome = await findDerivedClasses({ projectRoot, qualifiedName: "Base", translationUnits: [tu1, tu2], exec });
    expect(outcome.uniformFailure).toBeUndefined();
    expect(outcome.failedFiles).toHaveLength(2);
  });

  it("is not set when the budget cut the sweep short, though every TU that ran failed identically", async () => {
    const failingTu = join(projectRoot, "a.cpp");
    const hangingTu = join(projectRoot, "b.cpp");
    const exec: ClangQueryExecFn = async (args, _cwd, signal) => {
      if (args[2] === failingTu) return { exitCode: 1, stdout: "", stderr: "error: unknown matcher" };
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [failingTu, hangingTu],
      exec,
      maxParallel: 2,
      timeBudgetMs: 30,
    });
    expect(outcome.incomplete).toEqual({ sweptTus: 1, totalTus: 2, reason: "time-budget" });
    expect(outcome.uniformFailure).toBeUndefined();
  });

  it("is not set for a sweep with no translation units at all", async () => {
    const exec: ClangQueryExecFn = async () => {
      throw new Error("no translation unit to run");
    };
    const outcome = await findDerivedClasses({ projectRoot, qualifiedName: "Base", translationUnits: [], exec });
    expect(outcome.uniformFailure).toBeUndefined();
    expect(outcome.failedFiles).toEqual([]);
  });

  it("is never replayed from cache — a failed TU is re-run, so a fixed environment clears the verdict", async () => {
    const cache = new SweepCache();
    const tu1 = join(projectRoot, "a.cpp");
    const tu2 = join(projectRoot, "b.cpp");
    const header = join(projectRoot, "derived.h");
    let execCalls = 0;
    let brokenQuery = true;
    const exec: ClangQueryExecFn = async () => {
      execCalls++;
      return brokenQuery
        ? { exitCode: 1, stdout: "", stderr: "error: unknown matcher" }
        : { exitCode: 0, stdout: `${header}:1:1: note: "derived" binds here\n`, stderr: "" };
    };
    const args = {
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [tu1, tu2],
      exec,
      readFile: readFile({ [header]: "class Derived : public Base {};\n" }),
      cache,
      fingerprint: "fp1",
    };

    const failed = await findDerivedClasses(args);
    expect(failed.uniformFailure).toEqual({ error: "error: unknown matcher", failedTus: 2 });
    expect(cache.lookup(projectRoot, "Base", "fp1").size).toBe(0);

    brokenQuery = false;
    const recovered = await findDerivedClasses(args);
    expect(execCalls).toBe(4);
    expect(recovered.uniformFailure).toBeUndefined();
    expect(recovered.failedFiles).toEqual([]);
    expect(recovered.matches).toEqual([{ className: "Derived", file: header, line: 1, column: 1, direct: false }]);
    expect(recovered.sweep.cachedTus).toBe(0);
  });
});

describe("findDerivedClasses — class name at a bind location", () => {
  const projectRoot = join(tmpdir(), "mcp-code-nav-cq-bind");
  const header = join(projectRoot, "derived.h");

  async function namesFor(source: string, line: number, column: number) {
    const exec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout: `${header}:${line}:${column}: note: "derived" binds here\n`,
      stderr: "",
    });
    return findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      translationUnits: [join(projectRoot, "a.cpp")],
      exec,
      readFile: readFile({ [header]: source }),
    });
  }

  it("reads the name after a plain class keyword", async () => {
    const outcome = await namesFor("class Derived : public Base {};\n", 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Derived"]);
  });

  it("skips a single-line template header", async () => {
    const outcome = await namesFor("template <class T> struct Primary<T*> : Base {};\n", 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Primary"]);
  });

  it("skips a header that spans several lines and starts mid-file", async () => {
    const source = "int x;\ntemplate <class T,\n          int N = 3>\nstruct Multi<T, N> : Base {};\n";
    const outcome = await namesFor(source, 2, 1);
    expect(outcome.matches).toEqual([expect.objectContaining({ className: "Multi", line: 2, column: 1 })]);
  });

  it("skips nested angle brackets and a reference non-type parameter", async () => {
    const source = "template <const VenueProfile& Profile, class U = Vec<Vec<int>>>\nclass Profiled : Base {};\n";
    const outcome = await namesFor(source, 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Profiled"]);
  });

  it("skips an empty header of an explicit specialization", async () => {
    const outcome = await namesFor("template <> struct Primary<int> : Base {};\n", 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Primary"]);
  });

  it("skips an attribute between the keyword and the name", async () => {
    const source = "template <> struct alignas(16) [[deprecated]] Aligned<int> : Base {};\n";
    const outcome = await namesFor(source, 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Aligned"]);
  });

  it("reads the name when the bind location is the keyword after the header", async () => {
    const outcome = await namesFor("template <class T> struct Primary : Base {};\n", 1, 20);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Primary"]);
  });

  it("reports an extraction failure, never a keyword, when no name can be recovered", async () => {
    const outcome = await namesFor("template <class T> requires Ok<T> P<T> : Base {};\n", 1, 1);
    expect(outcome.matches).toEqual([]);
    expect(outcome.failedFiles).toHaveLength(1);
    expect(outcome.failedFiles[0]?.error).toContain("could not be read");
  });

  describe("a requires clause between the template header and the class key", () => {
    async function nameFor(source: string) {
      const outcome = await namesFor(source, 1, 1);
      return outcome.matches.map((m) => m.className);
    }

    it("skips a simple concept constraint", async () => {
      expect(await nameFor("template <class T> requires Ok<T> struct P<T> : Base {};\n")).toEqual(["P"]);
    });

    it("skips a qualified concept with template arguments", async () => {
      const source = "template <typename T> requires std::convertible_to<T, int> class Widget : Base {};\n";
      expect(await nameFor(source)).toEqual(["Widget"]);
    });

    it("does not close the constraint at a `>` inside parentheses", async () => {
      expect(await nameFor("template <int N> requires (N > 0) && Big<N> struct Sized<N> : Base {};\n")).toEqual([
        "Sized",
      ]);
    });

    it("skips a nested requires-expression with a parameter list and a body", async () => {
      const source = "template <class T> requires requires (T t) { t.f(); } class Probe : Base {};\n";
      expect(await nameFor(source)).toEqual(["Probe"]);
    });

    it("skips a compound requirement with a `>` and a return-type constraint", async () => {
      const source = "template <class T> requires requires { { T{} > T{} } -> std::same_as<bool>; } struct Cmp : Base {};\n";
      expect(await nameFor(source)).toEqual(["Cmp"]);
    });

    it("skips a `||`/`!` combination of concepts", async () => {
      expect(await nameFor("template <class T> requires (!A<T> || B<T>) && C<T> struct Mix : Base {};\n")).toEqual([
        "Mix",
      ]);
    });

    it("skips an attribute between the constraint and the class key", async () => {
      expect(await nameFor("template <class T> requires Ok<T> [[deprecated]] class Old : Base {};\n")).toEqual([
        "Old",
      ]);
    });

    it("reads the name past an alignas after the class key", async () => {
      expect(await nameFor("template <class T> requires Ok<T> struct alignas(8) Aligned : Base {};\n")).toEqual([
        "Aligned",
      ]);
    });

    it("skips a constraint that spans several lines, with comments", async () => {
      const source = [
        "template <class T>",
        "  requires Ok<T> // > not a closer",
        "        && /* struct */ Fine<T>",
        "        && (sizeof(T) > 4)",
        "struct Lines<T> : Base {};",
        "",
      ].join("\n");
      expect(await nameFor(source)).toEqual(["Lines"]);
    });

    it("skips string and character literals in the constraint", async () => {
      const source = "template <class T> requires Named<T, \"x>y struct\"> && Ch<'>'> struct Lit<T> : Base {};\n";
      expect(await nameFor(source)).toEqual(["Lit"]);
    });

    it("is not stopped by a dependent `::template` in the constraint", async () => {
      expect(await nameFor("template <class T> requires T::template value<int> struct Dep<T> : Base {};\n")).toEqual([
        "Dep",
      ]);
    });

    it("skips a requires clause after each of two nested template headers", async () => {
      const source = "template <class T> requires A<T> template <class U> requires B<U> struct Inner<T, U> : Base {};\n";
      expect(await nameFor(source)).toEqual(["Inner"]);
    });

    it("reads the name when the bind location is the keyword after the clause", async () => {
      const source = "template <class T> requires Ok<T> struct Primary : Base {};\n";
      const outcome = await namesFor(source, 1, source.indexOf("struct") + 1);
      expect(outcome.matches.map((m) => m.className)).toEqual(["Primary"]);
    });

    it("reports an extraction failure when no class key follows the constraint", async () => {
      const outcome = await namesFor("template <class T> requires Ok<T> && Fine<T>\nint x;\n", 1, 1);
      expect(outcome.matches).toEqual([]);
      expect(outcome.failedFiles).toHaveLength(1);
    });

    it("reports an extraction failure when a bracket in the constraint never closes", async () => {
      const outcome = await namesFor("template <class T> requires Ok<T struct P : Base {};\n", 1, 1);
      expect(outcome.matches).toEqual([]);
      expect(outcome.failedFiles).toHaveLength(1);
    });
  });

  describe("a byte column against UTF-16 source", () => {
    const byteColumnOf = (source: string, needle: string) =>
      Buffer.byteLength(source.slice(0, source.indexOf(needle))) + 1;

    it.each([
      ["a 2-byte character", "/* café */"],
      ["a 3-byte character", "/* € */"],
      ["a 4-byte character", "/* \u{1F600} */"],
      ["several multi-byte characters", "/* é€\u{1F600}é */"],
    ])("finds the name after %s earlier on the bind line", async (_label, comment) => {
      const source = `${comment} template <class T> struct Primary<T*> : Base {};\n`;
      const outcome = await namesFor(source, 1, byteColumnOf(source, "template"));
      expect(outcome.failedFiles).toEqual([]);
      expect(outcome.matches.map((m) => m.className)).toEqual(["Primary"]);
    });

    it("finds the name when the bind location is the keyword after the header", async () => {
      const source = "/* café */ template <class T> struct Primary : Base {};\n";
      const outcome = await namesFor(source, 1, byteColumnOf(source, "struct"));
      expect(outcome.matches.map((m) => m.className)).toEqual(["Primary"]);
    });

    it("finds the name on a later line when the bind line has a multi-byte character", async () => {
      const source = "// €\nint x;\n/* é */ template <class T> struct Later<T*> : Base {};\n";
      const outcome = await namesFor(source, 3, byteColumnOf("/* é */ template", "template"));
      expect(outcome.matches.map((m) => m.className)).toEqual(["Later"]);
    });

    it("finds the name in a CRLF file with a non-ASCII line above", async () => {
      const line = "/* café */ template <class T> struct Crlf<T*> : Base {};";
      const source = ["// € \u{1F600}", line, ""].join("\r\n");
      const outcome = await namesFor(source, 2, byteColumnOf(line, "template"));
      expect(outcome.matches.map((m) => m.className)).toEqual(["Crlf"]);
    });

    it("reports an extraction failure, without throwing, for a column inside a multi-byte sequence", async () => {
      const source = "/* é */ template <class T> struct P<T*> : Base {};\n";
      const inside = Buffer.byteLength("/* ") + 2;
      const outcome = await namesFor(source, 1, inside);
      expect(outcome.matches).toEqual([]);
      expect(outcome.failedFiles).toHaveLength(1);
    });

    it("reports an extraction failure for a column past the end of a non-ASCII line", async () => {
      const outcome = await namesFor("/* é */\ntemplate <class T> struct P<T*> : Base {};\n", 1, 40);
      expect(outcome.matches).toEqual([]);
      expect(outcome.failedFiles).toHaveLength(1);
    });
  });

  it("does not close the header at a `>` inside parentheses", async () => {
    const source = "template <class T = std::enable_if_t<(N > 0)>>\nstruct Guarded<T> : Base {};\n";
    const outcome = await namesFor(source, 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Guarded"]);
  });

  it("does not close the header at a `>` inside a nested call expression", async () => {
    const source = "template <int N = (sizeof(T) > 4 ? 1 : 0)>\nstruct Sized<N> : Base {};\n";
    const outcome = await namesFor(source, 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Sized"]);
  });

  it("does not close the header at a `>` inside braces", async () => {
    const source = "template <auto V = Wrap{1 > 0}>\nstruct Braced<V> : Base {};\n";
    const outcome = await namesFor(source, 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Braced"]);
  });

  it("does not close the header at a `>` inside a string literal", async () => {
    const source = 'template <const char* S = "x>y">\nstruct Named<S> : Base {};\n';
    const outcome = await namesFor(source, 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Named"]);
  });

  it("does not close the header at a `>` inside a character literal or an escaped quote", async () => {
    const source = "template <char C = '>', const char* S = \"\\\">\">\nstruct Chars<C, S> : Base {};\n";
    const outcome = await namesFor(source, 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Chars"]);
  });

  it("treats a digit separator as part of the number, not a character literal", async () => {
    const outcome = await namesFor("template <int N = 1'000>\nstruct Sep<N> : Base {};\n", 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Sep"]);
  });

  it("does not close the header at a `>` inside a comment", async () => {
    const source = "template <class T /* > */, // >\n          class U>\nstruct Commented<T, U> : Base {};\n";
    const outcome = await namesFor(source, 1, 1);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Commented"]);
  });

  it("reports an extraction failure, not a row, when a literal in the header never closes", async () => {
    const outcome = await namesFor('template <const char* S = "x>y\nstruct Broken<S> : Base {};\n', 1, 1);
    expect(outcome.matches).toEqual([]);
    expect(outcome.failedFiles).toHaveLength(1);
  });

  it("finds the name in a CRLF file whose bind is several lines down", async () => {
    const source = ["int a;", "int b;", "int c;", "int d;", "template <class T,", "          int N>", "struct Crlf<T, N> : Base {};", ""].join("\r\n");
    const outcome = await namesFor(source, 5, 1);
    expect(outcome.matches).toEqual([expect.objectContaining({ className: "Crlf", line: 5, column: 1 })]);
  });

  it("finds the name at a non-zero column in a CRLF file", async () => {
    const source = ["int a;", "int b;", "int c;", "int d;", "template <class T> struct Primary : Base {};", ""].join("\r\n");
    const outcome = await namesFor(source, 5, 20);
    expect(outcome.matches.map((m) => m.className)).toEqual(["Primary"]);
  });

  it("reports an extraction failure for an unterminated template header", async () => {
    const outcome = await namesFor("template <class T\n", 1, 1);
    expect(outcome.matches).toEqual([]);
    expect(outcome.failedFiles).toHaveLength(1);
  });
});
