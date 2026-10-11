import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultClangQueryExec,
  findDerivedClasses,
  type ClangQueryExecFn,
} from "../../src/clang-query/find-derived-classes.js";
import { computeProjectFingerprint } from "../../src/clang-query/project-fingerprint.js";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { runCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";

// clang-cl.exe is the MSVC-compatible Windows driver, but this suite may also run on a
// machine/CI runner with only clang++ (e.g. Linux) — skip the clang-cl-specific test there rather
// than failing with the same zero-matches symptom the bug fix addresses, which would misleadingly
// read as a regression instead of an environment gap.
function isClangClAvailable(): boolean {
  try {
    execFileSync("clang-cl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const itIfClangClAvailable = isClangClAvailable() ? it : it.skip;

/**
 * Live-binary integration suite — spawns the REAL `clang-query` binary (excluded from `npm test`,
 * run via `npm run test:live`; see `vitest.live.config.ts` and CONTRIBUTING.md).
 *
 * Exists specifically because two bugs were structurally invisible to a mocked
 * `ClangQueryExecFn` — every mock in `cpp-find-derived-classes.test.ts` hand-writes its stdout, which can
 * never reproduce what a real compile database and a real compiler driver actually produce:
 * - A relative note-path fed straight to `readFile`, silently dropping every match —
 *   a mock never spells a relative path because its author already knows the "right" absolute one.
 * - `clang-cl.exe` (the MSVC-compatible Windows driver) emits MSVC-style
 *   `path(line,col):` notes, not GNU-style `path:line:col:` — a mock never varies the diagnostic
 *   format by driver, because nothing in the mocked test forces a real driver to be invoked at all.
 */
describe("findDerivedClasses against a real clang-query binary", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-live-"));
    writeFileSync(join(projectRoot, "base.h"), "class Base {\npublic:\n  virtual ~Base() = default;\n};\n");
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("finds a real match when compile_commands.json uses a RELATIVE source-file spelling", async () => {
    // This is the exact reproduction of the requirements: `-c widget.cpp`, not an absolute
    // path, is what makes clang-query echo back a relative note-path ("widget.cpp:3:1: note: ..."),
    // which a pre-fix `readFileSync` resolves against this process's own cwd instead of projectRoot.
    writeFileSync(join(projectRoot, "widget.cpp"), '#include "base.h"\n\nclass Derived : public Base {};\n');
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: "clang++ -std=c++17 -c widget.cpp -o widget.o", file: "widget.cpp" },
      ]),
    );

    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
    });

    expect(outcome.failedFiles).toEqual([]);
    expect(outcome.matches).toEqual([
      { className: "Derived", file: join(projectRoot, "widget.cpp"), line: 3, column: 1, direct: true },
    ]);
  });

  it("finds the same real match when compile_commands.json uses an ABSOLUTE source-file spelling", async () => {
    const cppFile = join(projectRoot, "widget.cpp");
    writeFileSync(cppFile, '#include "base.h"\n\nclass Derived : public Base {};\n');
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: `clang++ -std=c++17 -c "${cppFile}" -o widget.o`, file: cppFile },
      ]),
    );

    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
    });

    expect(outcome.failedFiles).toEqual([]);
    expect(outcome.matches).toEqual([{ className: "Derived", file: cppFile, line: 3, column: 1, direct: true }]);
  });

  itIfClangClAvailable("finds a real match when compile_commands.json is driven by clang-cl.exe (MSVC-style diagnostics)", async () => {
    // The requirements's exact reproduction: the driver alone flips clang-query's diagnostic
    // format from "widget.cpp:3:1: note: ..." to "widget.cpp(3,1): note: ...", independent of path
    // spelling or anything else on that path.
    const cppFile = join(projectRoot, "widget.cpp");
    writeFileSync(cppFile, '#include "base.h"\n\nclass Derived : public Base {};\n');
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: "clang-cl.exe -TP -c widget.cpp -o widget.o", file: "widget.cpp" },
      ]),
    );

    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
    });

    expect(outcome.failedFiles).toEqual([]);
    expect(outcome.matches).toEqual([{ className: "Derived", file: cppFile, line: 3, column: 1, direct: true }]);
  });
});

/**
 * clang-query binds every class-template form except the primary pattern at the `template` keyword that
 * opens the header . Only a real driver shows that; a mocked bind location cannot.
 */
describe("findDerivedClasses through class templates against a real clang-query binary", () => {
  let projectRoot: string;

  const TEMPLATE_FIXTURE = [
    '#include "base.h"',
    '',
    'template <class T> struct Primary : Base {};',
    'template <class T> struct Primary<T*> : Base {};',
    'template <> struct Primary<int> : Base {};',
    '',
    'template <const int& Ref,',
    '          class U = Primary<Primary<int>>>',
    'class Profiled : Base {};',
    'template <const int& Ref>',
    'class Profiled<Ref, char> : Base {};',
    '',
    'extern const int kRef;',
    'Primary<char> a;',
    'Primary<char*> b;',
    'Primary<int> c;',
    'Profiled<kRef> d;',
    'Profiled<kRef, char> e;',
    'template <class T> concept Any = true;',
    'template <class T> requires Any<T> && (sizeof(T) > 0) struct Constrained : Base {};',
    'Constrained<int> f;',
    '/* café € */ class Cafe : Base {};',
    '',
  ].join("\n");

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-live-template-"));
    writeFileSync(join(projectRoot, "base.h"), "class Base {\npublic:\n  virtual ~Base() = default;\n};\n");
    writeFileSync(join(projectRoot, "widget.cpp"), TEMPLATE_FIXTURE);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function sweepWith(driverCommand: string) {
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, command: driverCommand, file: "widget.cpp" }]),
    );
    return findDerivedClasses({ projectRoot, qualifiedName: "Base", exec: defaultClangQueryExec });
  }

  function expectRealNames(outcome: Awaited<ReturnType<typeof sweepWith>>): void {
    expect(outcome.failedFiles).toEqual([]);
    const names = new Set(outcome.matches.map((m) => m.className));
    expect(names).toEqual(new Set(["Primary", "Profiled", "Constrained", "Cafe"]));
    const rowAt = (line: number) => outcome.matches.filter((m) => m.line === line).map((m) => m.className);
    expect(rowAt(3)).toContain("Primary"); // primary pattern
    expect(rowAt(4)).toEqual(["Primary"]); // partial specialization
    expect(rowAt(5)).toEqual(["Primary"]); // explicit specialization
    expect(rowAt(7)).toEqual(["Profiled"]); // instantiation, bound at a multi-line header with a reference parameter
    expect(rowAt(9)).toEqual(["Profiled"]); // primary pattern, bound at the keyword after that header
    expect(rowAt(10)).toEqual(["Profiled"]); // partial specialization of it
    // primary pattern behind a requires clause, plus its instantiation bound at the header
    expect(rowAt(20).length).toBeGreaterThan(0);
    expect(new Set(rowAt(20))).toEqual(new Set(["Constrained"]));
    expect(rowAt(22)).toEqual(["Cafe"]); // byte column after a multi-byte comment on the same line
  }

  it("resolves the real name of every template form with clang++", async () => {
    expectRealNames(await sweepWith("clang++ -std=c++20 -c widget.cpp -o widget.o"));
  });

  itIfClangClAvailable("resolves the real name of every template form with clang-cl.exe", async () => {
    expectRealNames(await sweepWith("clang-cl.exe /std:c++20 -TP -c widget.cpp -o widget.o"));
  });
});

/**
 * The cache, wall-clock and interruption rules against the real binary — a mocked `exec` can assert the cache
 * bookkeeping logic, but only the real binary proves the wall-clock claim and that a
 * genuine `clang-query` process, not a stub, is what gets interrupted by the time budget.
 */
describe("findDerivedClasses caching against the real clang-query binary", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-live-cache-"));
    writeFileSync(join(projectRoot, "base.h"), "class Base {\npublic:\n  virtual ~Base() = default;\n};\n");
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeTwoTuFixture(): void {
    writeFileSync(join(projectRoot, "widget.cpp"), '#include "base.h"\n\nclass Derived : public Base {};\n');
    writeFileSync(join(projectRoot, "other.cpp"), '#include "base.h"\n\nclass DerivedTwo : public Base {};\n');
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: "clang++ -std=c++17 -c widget.cpp -o widget.o", file: "widget.cpp" },
        { directory: projectRoot, command: "clang++ -std=c++17 -c other.cpp -o other.o", file: "other.cpp" },
      ]),
    );
  }

  it("a repeat call after the first sweep is served from cache in well under a second", async () => {
    writeTwoTuFixture();
    const cache = new SweepCache();
    const fingerprint = computeProjectFingerprint([projectRoot]).fingerprint;
    expect(fingerprint).toBeDefined();

    const first = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
      cache,
      fingerprint,
    });
    expect(first.sweep.cache).toBe("miss");
    expect(first.matches).toHaveLength(2);

    const startedAt = Date.now();
    const second = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
      cache,
      fingerprint,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(second.sweep).toMatchObject({ cache: "hit", cachedTus: 2, totalTus: 2 });
    // The sweep runs its translation units concurrently, so which file's rows land first is a property of
    // process scheduling, not of the cache. The claim here is that the cached call answered with the same
    // rows, which is why both sides go through one order before comparing — the payload's own order stays
    // whatever the sweep produced, pinned nowhere.
    const rowKey = (row: (typeof first.matches)[number]) =>
      `${row.file}\u0000${row.line}\u0000${row.column}\u0000${row.className}\u0000${row.direct}`;
    const inOrder = (rows: typeof first.matches) =>
      [...rows].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0));
    expect(inOrder(second.matches)).toEqual(inOrder(first.matches));
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("touching one source file's mtime invalidates the cache and forces a full re-sweep", async () => {
    writeTwoTuFixture();
    const cache = new SweepCache();
    const fingerprint1 = computeProjectFingerprint([projectRoot]).fingerprint;
    await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
      cache,
      fingerprint: fingerprint1,
    });

    const future = new Date(Date.now() + 60_000);
    utimesSync(join(projectRoot, "widget.cpp"), future, future);
    const fingerprint2 = computeProjectFingerprint([projectRoot]).fingerprint;
    expect(fingerprint2).not.toBe(fingerprint1);

    const second = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
      cache,
      fingerprint: fingerprint2,
    });
    expect(second.sweep).toMatchObject({ cache: "miss", cachedTus: 0 });
    expect(second.matches).toHaveLength(2);
  });

  it("a sweep truncated by a small time budget returns a partial result, and an immediate follow-up call completes it", async () => {
    writeTwoTuFixture();
    const cache = new SweepCache();
    const fingerprint = computeProjectFingerprint([projectRoot]).fingerprint;

    const truncated = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
      cache,
      fingerprint,
      timeBudgetMs: 10,
      maxParallel: 1,
    });
    expect(truncated.incomplete).toBeDefined();
    expect(truncated.incomplete?.reason).toBe("time-budget");
    expect(truncated.incomplete?.sweptTus).toBeLessThan(2);
    expect(truncated.failedFiles).toEqual([]);

    const resumed = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
      cache,
      fingerprint,
    });
    expect(resumed.incomplete).toBeUndefined();
    expect(resumed.matches).toHaveLength(2);
  });
});

/**
 * A fresh unscoped sweep answers in ONE call. Under the 60 s per-call chunk,
 * a partial `incomplete` result was the routine outcome of every first-touch query on a real project;
 * this is the assertion that would have caught that.
 */
describe("findDerivedClasses completes a fresh unscoped sweep in one call (real binary, default inputs)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-live-single-call-"));
    writeFileSync(join(projectRoot, "base.h"), "class Base {\npublic:\n  virtual ~Base() = default;\n};\n");
    writeFileSync(join(projectRoot, "widget.cpp"), '#include "base.h"\n\nclass Derived : public Base {};\n');
    writeFileSync(join(projectRoot, "other.cpp"), '#include "base.h"\n\nclass DerivedTwo : public Base {};\n');
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: "clang++ -std=c++17 -c widget.cpp -o widget.o", file: "widget.cpp" },
        { directory: projectRoot, command: "clang++ -std=c++17 -c other.cpp -o other.o", file: "other.cpp" },
      ]),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns every match with no `incomplete` block, without a caller-supplied budget", async () => {
    const outcome = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
    });
    expect(outcome.incomplete).toBeUndefined();
    expect(outcome.failedFiles).toEqual([]);
    expect(outcome.sweep).toMatchObject({ totalTus: 2, cachedTus: 0, cache: "disabled" });
    expect(outcome.matches).toHaveLength(2);
  });
});

/**
 * Against the real binary: a signal/budget-triggered abort must not
 * leave a `clang-query.exe` child running. `tasklist` is Windows-only,
 * so the check is skipped elsewhere rather than failing there.
 */
describe("findDerivedClasses cancellation leaves no orphan clang-query process (real binary)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-live-orphan-"));
    writeFileSync(join(projectRoot, "base.h"), "class Base {\npublic:\n  virtual ~Base() = default;\n};\n");
    writeFileSync(join(projectRoot, "widget.cpp"), '#include "base.h"\n\nclass Derived : public Base {};\n');
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: "clang++ -std=c++17 -c widget.cpp -o widget.o", file: "widget.cpp" },
      ]),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function countClangQueryProcesses(): number {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq clang-query.exe", "/NH"], { encoding: "utf-8" });
    return /No tasks/i.test(out) ? 0 : out.trim().split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  }

  const itIfWindows = process.platform === "win32" ? it : it.skip;

  itIfWindows("a time-budget abort of a real clang-query child leaves no orphan process behind", async () => {
    const before = countClangQueryProcesses();

    // A budget far shorter than clang-query's own process-spawn-plus-parse time (tens of ms at least)
    // reliably interrupts a real, already-spawned child rather than racing spawn itself.
    const result = await findDerivedClasses({
      projectRoot,
      qualifiedName: "Base",
      exec: defaultClangQueryExec,
      timeBudgetMs: 10,
    });
    expect(result.incomplete?.reason).toBe("time-budget");

    // execFile's kill on abort is not instantaneous — give the OS a short grace period to reap it.
    await new Promise((r) => setTimeout(r, 500));
    expect(countClangQueryProcesses()).toBe(before);
  });
});

/**
 * The live cases: one sweep answers both derivation questions, against a real `clang-query` under each
 * compiler driver. Rows are compared as `className@line:direct`, because a note path follows the compile
 * command's own spelling — and path resolution is view-independent, already covered by the relative-spelling
 * case above, so no case below repeats it.
 */
describe("findDerivedClasses — direct and transitive views against a real clang-query binary", () => {
  let projectRoot: string;

  const CLANGXX = "clang++ -std=c++20 -c widget.cpp -o widget.o";
  const CLANG_CL = "clang-cl.exe /std:c++20 -TP -c widget.cpp -o widget.o";

  /** Every case spawns a real `clang-query`, and several sweep more than once per case. */
  const LIVE_TIMEOUT_MS = 30_000;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-live-derivation-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  type SweepResult = Awaited<ReturnType<typeof findDerivedClasses>>;

  function writeFixture(source: string[], driverCommand: string): void {
    writeFileSync(join(projectRoot, "widget.cpp"), source.join("\n"));
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, command: driverCommand, file: "widget.cpp" }]),
    );
  }

  async function sweep(
    source: string[],
    qualifiedName: string,
    driverCommand: string,
    extra: { exec?: ClangQueryExecFn; cache?: SweepCache; fingerprint?: string } = {},
  ): Promise<SweepResult> {
    writeFixture(source, driverCommand);
    return findDerivedClasses({
      projectRoot,
      qualifiedName,
      exec: extra.exec ?? defaultClangQueryExec,
      cache: extra.cache,
      fingerprint: extra.fingerprint,
    });
  }

  const flags = (outcome: SweepResult) =>
    outcome.matches.map((m) => `${m.className}@${m.line}:${m.direct}`).sort();

  /** Rows sharing one line (a template's primary pattern and its implicit instantiation) collapse here. */
  const flagsAt = (outcome: SweepResult, line: number) =>
    Array.from(new Set(outcome.matches.filter((m) => m.line === line).map((m) => `${m.className}:${m.direct}`))).sort();

  const classNames = (outcome: SweepResult) =>
    Array.from(new Set(outcome.matches.map((m) => m.className))).sort();

  const DEPTH = [
    "struct Base {",
    "  virtual ~Base() = default;",
    "};",
    "struct Mid : Base {};",
    "struct Leaf : Mid {};",
    "struct Other : Base {};",
    "",
  ];

  async function checkBothDepths(driverCommand: string): Promise<void> {
    const outcome = await sweep(DEPTH, "Base", driverCommand);
    expect(outcome.failedFiles).toEqual([]);
    expect(outcome.incomplete).toBeUndefined();
    expect(classNames(outcome)).toEqual(["Leaf", "Mid", "Other"]);
    expect(flags(outcome)).toEqual(["Mid@4:true", "Leaf@5:false", "Other@6:true"].sort());
  }

  async function checkALeafHasNothingBelowIt(driverCommand: string): Promise<void> {
    const outcome = await sweep(DEPTH, "Leaf", driverCommand);
    expect(outcome.matches).toEqual([]);
    expect(outcome.incomplete).toBeUndefined();
    expect(outcome.failedFiles).toEqual([]);
  }

  async function checkNotItsOwnRow(driverCommand: string): Promise<void> {
    // Both matchers are irreflexive, so the queried record never appears among its own rows — which also
    // means no row ever carries the base's own declaration with `direct` set.
    const outcome = await sweep(DEPTH, "Base", driverCommand);
    expect(classNames(outcome)).toEqual(["Leaf", "Mid", "Other"]);
  }

  async function checkOneInvocationAnswersBothBindNames(driverCommand: string): Promise<void> {
    const invocations: string[][] = [];
    const recording: ClangQueryExecFn = async (args, cwd, signal) => {
      invocations.push(args);
      return defaultClangQueryExec(args, cwd, signal);
    };
    const outcome = await sweep(DEPTH, "Base", driverCommand, { exec: recording });
    expect(invocations).toHaveLength(1);
    const argv = invocations[0] ?? [];
    const commands = argv
      .map((arg, i) => (arg === "-c" ? argv[i + 1] : undefined))
      .filter((arg): arg is string => arg !== undefined);
    expect(commands).toEqual([
      'match cxxRecordDecl(isDerivedFrom(hasName("Base"))).bind("derived")',
      'match cxxRecordDecl(isDirectlyDerivedFrom(hasName("Base"))).bind("direct")',
    ]);
    // Both kinds of row came from that ONE process — one command alone cannot produce both.
    expect(outcome.matches.filter((m) => m.direct).map((m) => m.className).sort()).toEqual(["Mid", "Other"]);
    expect(outcome.matches.filter((m) => !m.direct).map((m) => m.className)).toEqual(["Leaf"]);
  }

  const INTERFACE = [
    "class IEngineCallback {",
    "public:",
    "  virtual ~IEngineCallback() = default;",
    "  virtual void onEvent(int event) = 0;",
    "};",
    "class ChannelA : public IEngineCallback {",
    "public:",
    "  void onEvent(int event) override {}",
    "};",
    "class ChannelB : public IEngineCallback {",
    "public:",
    "  void onEvent(int event) override {}",
    "};",
    "class ChannelC : public IEngineCallback {",
    "public:",
    "  void onEvent(int event) override {}",
    "};",
    "class ChannelD : public ChannelA {",
    "public:",
    "  void onEvent(int event) override {}",
    "};",
    "class ChannelE : public ChannelB {",
    "public:",
    "  void onEvent(int event) override {}",
    "};",
    "",
  ];

  async function checkTheInterfaceGap(driverCommand: string): Promise<void> {
    const outcome = await sweep(INTERFACE, "IEngineCallback", driverCommand);
    expect(outcome.failedFiles).toEqual([]);
    expect(classNames(outcome)).toEqual(
      ["ChannelA", "ChannelB", "ChannelC", "ChannelD", "ChannelE"].sort(),
    );
    expect(flags(outcome)).toEqual(
      [
        "ChannelA@6:true",
        "ChannelB@10:true",
        "ChannelC@14:true",
        "ChannelD@18:false",
        "ChannelE@22:false",
      ].sort(),
    );
  }

  const DIAMOND = [
    "struct Base {",
    "  virtual ~Base() = default;",
    "};",
    "struct Mid1 : Base {};",
    "struct Mid2 : Base {};",
    "struct Joiner : Mid1, Mid2 {};",
    "",
  ];

  async function checkDiamond(driverCommand: string): Promise<void> {
    const fromBase = await sweep(DIAMOND, "Base", driverCommand);
    expect(fromBase.failedFiles).toEqual([]);
    expect(flags(fromBase)).toEqual(["Mid1@4:true", "Mid2@5:true", "Joiner@6:false"].sort());
    const fromMid1 = await sweep(DIAMOND, "Mid1", driverCommand);
    expect(flags(fromMid1)).toEqual(["Joiner@6:true"]);
  }

  const TEMPLATES = [
    "struct Base {",
    "  virtual ~Base() = default;",
    "};",
    "struct Mid : Base {};",
    "template <class T> struct Direct : Base {};",
    "template <class T> struct Indirect : Mid {};",
    "Direct<char> directUse;",
    "Indirect<char> indirectUse;",
    "template <class T> struct Partial : Base {};",
    "template <class T> struct Partial<T*> : Base {};",
    "Partial<int*> partialUse;",
    "template <class T> struct Spec : Base {};",
    "template <> struct Spec<int> : Base {};",
    "template <> struct Spec<char> : Mid {};",
    "template <class T> struct IndPart : Mid {};",
    "template <class T> struct IndPart<T*> : Mid {};",
    "Spec<int> specInt;",
    "Spec<char> specChar;",
    "IndPart<int*> indPartUse;",
    "",
  ];

  async function checkTemplateDirectness(driverCommand: string): Promise<void> {
    const outcome = await sweep(TEMPLATES, "Base", driverCommand);
    expect(outcome.failedFiles).toEqual([]);
    expect(classNames(outcome)).toEqual(["Direct", "IndPart", "Indirect", "Mid", "Partial", "Spec"]);
    expect(flagsAt(outcome, 4)).toEqual(["Mid:true"]);
    // Lines 5 and 6 each hold a primary pattern bound at its `struct` keyword and an implicit instantiation
    // bound at its `template` keyword; both rows must carry the declaration's own directness.
    expect(flagsAt(outcome, 5)).toEqual(["Direct:true"]);
    expect(flagsAt(outcome, 6)).toEqual(["Indirect:false"]);
    // A partial specialization binds only at its `template` keyword, so the join happens after a header read.
    expect(flagsAt(outcome, 9)).toEqual(["Partial:true"]);
    expect(flagsAt(outcome, 10)).toEqual(["Partial:true"]);
    expect(flagsAt(outcome, 12)).toEqual(["Spec:true"]);
    // Each explicit specialization binds at its own `template` keyword and carries its OWN base list, so one
    // template name yields a direct row (13) and an indirect one (14) in the same sweep.
    expect(flagsAt(outcome, 13)).toEqual(["Spec:true"]);
    expect(flagsAt(outcome, 14)).toEqual(["Spec:false"]);
    expect(flagsAt(outcome, 15)).toEqual(["IndPart:false"]);
    expect(flagsAt(outcome, 16)).toEqual(["IndPart:false"]);
  }

  const ACCESS = [
    "struct A {};",
    "struct B {};",
    "struct C {};",
    "class D : public A, private B, public virtual C {};",
    "",
  ];

  async function checkAccessAndVirtualDoNotRemoveAnEdge(driverCommand: string): Promise<void> {
    for (const base of ["A", "B", "C"]) {
      const outcome = await sweep(ACCESS, base, driverCommand);
      expect(outcome.failedFiles).toEqual([]);
      expect(flags(outcome)).toEqual(["D@4:true"]);
    }
  }

  async function checkBothViewsComeFromOneCachedEntry(driverCommand: string): Promise<void> {
    writeFixture(DEPTH, driverCommand);
    const fingerprint = computeProjectFingerprint([projectRoot]).fingerprint;
    const cache = new SweepCache();
    const first = await sweep(DEPTH, "Base", driverCommand, { cache, fingerprint });
    expect(first.sweep.cache).toBe("miss");
    const again = await sweep(DEPTH, "Base", driverCommand, { cache, fingerprint });
    expect(again.sweep).toMatchObject({ cache: "hit", cachedTus: 1, totalTus: 1 });
    // The stored entry carries both views, so the narrow answer is a filter over these same cached rows.
    expect(again.matches.filter((m) => m.direct).map((m) => m.className).sort()).toEqual(["Mid", "Other"]);
    expect(flags(again)).toEqual(flags(first));
  }

  async function checkARealUnsupportedMatcherIsNamed(driverCommand: string): Promise<void> {
    // The motivating failure: a clang-query build without isDirectlyDerivedFrom answers every TU
    // with `Matcher not found: …` on stdout and an EMPTY stderr, so that line is the whole diagnostic.
    const unsupported: ClangQueryExecFn = async (args, cwd, signal) =>
      defaultClangQueryExec(
        args.map((arg) => arg.replace("isDirectlyDerivedFrom", "isNoSuchMatcher")),
        cwd,
        signal,
      );
    const outcome = await sweep(DEPTH, "Base", driverCommand, { exec: unsupported });
    expect(outcome.matches).toEqual([]);
    expect(outcome.uniformFailure?.failedTus).toBe(1);
    expect(outcome.uniformFailure?.error).toContain("Matcher not found");
  }

  it("L1 sweeps the whole tree and flags the rows that name the base themselves (clang++)", async () =>
    checkBothDepths(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L1 sweeps the whole tree and flags the rows that name the base themselves (clang-cl)",
    async () => checkBothDepths(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );

  it("L1 a leaf answers empty from a complete sweep, with no error row (clang++)", async () =>
    checkALeafHasNothingBelowIt(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L1 a leaf answers empty from a complete sweep, with no error row (clang-cl)",
    async () => checkALeafHasNothingBelowIt(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );

  it("L2 names every descendant and marks exactly the three implementers direct (clang++)", async () =>
    checkTheInterfaceGap(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L2 names every descendant and marks exactly the three implementers direct (clang-cl)",
    async () => checkTheInterfaceGap(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );

  it("L3 the queried base is never a row of its own hierarchy (clang++)", async () =>
    checkNotItsOwnRow(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L3 the queried base is never a row of its own hierarchy (clang-cl)",
    async () => checkNotItsOwnRow(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );

  it("L4 directness survives the join at a template-keyword bind (clang++)", async () =>
    checkTemplateDirectness(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L4 directness survives the join at a template-keyword bind (clang-cl)",
    async () => checkTemplateDirectness(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );

  it("L5 one clang-query invocation answers both bind names (clang++)", async () =>
    checkOneInvocationAnswersBothBindNames(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L5 one clang-query invocation answers both bind names (clang-cl)",
    async () => checkOneInvocationAnswersBothBindNames(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );

  it("L6 a private and a virtual base each yield D exactly once, directly (clang++)", async () =>
    checkAccessAndVirtualDoNotRemoveAnEdge(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L6 a private and a virtual base each yield D exactly once, directly (clang-cl)",
    async () => checkAccessAndVirtualDoNotRemoveAnEdge(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );

  it("L7 a diamond reaches the base in two hops, so the joiner is not direct (clang++)", async () =>
    checkDiamond(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L7 a diamond reaches the base in two hops, so the joiner is not direct (clang-cl)",
    async () => checkDiamond(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );

  it("L8 one cached entry still carries both views of the same rows (clang++)", async () =>
    checkBothViewsComeFromOneCachedEntry(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L8 one cached entry still carries both views of the same rows (clang-cl)",
    async () => checkBothViewsComeFromOneCachedEntry(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );

  it("L9 an unsupported matcher is named from stdout, not the empty-stderr fallback (clang++)", async () =>
    checkARealUnsupportedMatcherIsNamed(CLANGXX), LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "L9 an unsupported matcher is named from stdout, not the empty-stderr fallback (clang-cl)",
    async () => checkARealUnsupportedMatcherIsNamed(CLANG_CL),
    LIVE_TIMEOUT_MS,
  );
});

/**
 * The live cases: the compile-database blind spot, named by the real tool handler against a real
 * `clang-query`. A mocked sweep can only show that the handler subtracts two lists it was handed; only the
 * real binary shows that a class defined solely in a TU no entry compiles is genuinely missing from
 * `matches` while the new field names its file,
 * and that a forced `files` entry is run on `clang-query`'s inferred flags rather than rejected.
 *
 * The fixture is the out-of-tree layout the field exists for: `projectRoot` is a build directory holding
 * only `compile_commands.json`, and the sources live in a sibling directory, declared as the one
 * `sourceRoots` entry.
 */
describe("cpp_find_derived_classes blind-spot signal through the tool handler against a real clang-query", () => {
  /** Each case spawns a real `clang-query`; B4 sweeps twice. */
  const BLIND_LIVE_TIMEOUT_MS = 30_000;

  /** The phrase both user-visible texts must carry. Its full sentences are pinned
   *  byte-exact in `test/tools/uncovered-sources.test.ts`; this suite is about the real binary producing
   *  a row and a text at all. */
  const DB_ENTRY_REASON = "no compile-database entry";

  type CompileCommandFor = (sourceFile: string) => string;

  const gnuCommand: CompileCommandFor = (file) => `clang++ -std=c++17 -c "${file}" -o ${basename(file, ".cpp")}.o`;
  const msvcCommand: CompileCommandFor = (file) =>
    `clang-cl.exe /std:c++17 -TP -c "${file}" -o ${basename(file, ".cpp")}.obj`;

  let repoRoot: string;
  let buildRoot: string;
  let srcRoot: string;

  const inSrc = (name: string): string => join(srcRoot, name);
  /** The TU the compile database does list, and the build-gated one it omits. */
  const compiledFile = (): string => inSrc("adapter.cpp");
  const uncoveredFile = (): string => inSrc("factset_md_adapter.cpp");

  const classNames = (rows: readonly { className: string }[]): string[] =>
    Array.from(new Set(rows.map((row) => row.className))).sort();

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-live-blind-spot-"));
    buildRoot = join(repoRoot, "build");
    srcRoot = join(repoRoot, "src");
    mkdirSync(buildRoot);
    mkdirSync(srcRoot);
    writeFileSync(
      inSrc("base.h"),
      "class IProviderAdapter {\npublic:\n  virtual ~IProviderAdapter() = default;\n};\n",
    );
    // Both files are parseable and both define a direct implementer: only the database tells them apart,
    // which is the whole point. A file that could not compile would prove nothing about the sweep's scope.
    const deriving = (className: string): string =>
      `#include "base.h"\n\nclass ${className} : public IProviderAdapter {};\n`;
    writeFileSync(compiledFile(), deriving("CoreAdapter"));
    writeFileSync(uncoveredFile(), deriving("FactSetMdAdapter"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  type HandlerResult = Awaited<ReturnType<typeof callTool>>;

  function writeDb(commandFor: CompileCommandFor, entries: string[]): void {
    writeFileSync(
      join(buildRoot, "compile_commands.json"),
      JSON.stringify(entries.map((file) => ({ directory: buildRoot, command: commandFor(file), file }))),
    );
  }

  /** One real call through the MCP tool handler: no injected `exec`, no injected `readFile`. */
  async function callTool(
    commandFor: CompileCommandFor,
    entries: string[],
    input: { files?: string[]; sourceRoots?: string[] } = {},
  ) {
    writeDb(commandFor, entries);
    return runCppFindDerivedClasses(
      { cache: new SweepCache() },
      {
        projectRoot: buildRoot,
        qualifiedName: "IProviderAdapter",
        sourceRoots: input.sourceRoots ?? [srcRoot],
        ...(input.files ? { files: input.files } : {}),
      },
    );
  }

  function payloadOf(out: HandlerResult): {
    matches: readonly { className: string }[];
    failedFiles?: { file: string; error: string }[];
    incomplete?: unknown;
    sweep: { totalTus: number };
  } {
    if ("structuredContent" in out) return out.structuredContent;
    // Failing here with the whole error text beats a payload-shape assertion that cannot read.
    throw new Error(`expected a payload, got isError: ${out.content[0]?.text ?? "no text"}`);
  }

  /** The whole-sweep-failure text, when the call produced one instead of a payload. */
  function failureText(out: HandlerResult): string | undefined {
    return "isError" in out ? out.content[0]?.text : undefined;
  }

  async function checkTheBlindSpotIsNamed(commandFor: CompileCommandFor): Promise<void> {
    const out = await callTool(commandFor, [compiledFile()]);
    expect(out.isError).toBeFalsy();
    const payload = payloadOf(out);
    // The scope the answer covers is `totalTus`; `uncoveredSources` says nothing about it, and the sweep ran
    // clean, so nothing but the new field hints that a second source file exists at all.
    expect(payload.sweep.totalTus).toBe(1);
    expect(payload.failedFiles).toBeUndefined();
    expect(payload.incomplete).toBeUndefined();
    expect(payload.sweep).toMatchObject({ uncoveredSources: { count: 1, files: [uncoveredFile()] } });
    expect(payload.sweep).not.toHaveProperty("uncoveredSourcesUnavailable");
    // The class defined only in that file is not in the answer, and the payload now names the reason.
    expect(classNames(payload.matches)).toEqual(["CoreAdapter"]);
  }

  async function checkACompleteDatabaseSaysZero(commandFor: CompileCommandFor): Promise<void> {
    const out = await callTool(commandFor, [compiledFile(), uncoveredFile()]);
    expect(out.isError).toBeFalsy();
    const payload = payloadOf(out);
    expect(payload.sweep.totalTus).toBe(2);
    expect(payload.failedFiles).toBeUndefined();
    expect(payload.sweep).toMatchObject({ uncoveredSources: { count: 0, files: [] } });
    expect(payload.sweep).not.toHaveProperty("uncoveredSourcesUnavailable");
    // The class that vanished in B1 is here once an entry compiles its TU: B1's answer was short because of
    // the database, not the matcher, and `count: 0` is the claim that nothing is left outside.
    expect(classNames(payload.matches)).toEqual(["CoreAdapter", "FactSetMdAdapter"]);
  }

  async function checkAnOmittedSourceRootsDerivesTheTree(commandFor: CompileCommandFor): Promise<void> {
    const out = await callTool(commandFor, [compiledFile()], { sourceRoots: [] });
    expect(out.isError).toBeFalsy();
    const payload = payloadOf(out);
    // with nothing declared the source tree is derived from the database, so the same blind spot B1
    // names is named here, and the root it came from is stated.
    expect(payload.sweep).toMatchObject({
      sourceRoots: { origin: "derived", roots: [repoRoot], tusOutsideRoots: 0 },
      uncoveredSources: { count: 1, files: [uncoveredFile()] },
    });
    expect(payload.sweep).not.toHaveProperty("uncoveredSourcesUnavailable");
    expect(classNames(payload.matches)).toEqual(["CoreAdapter"]);
    expect(payload.failedFiles).toBeUndefined();
  }

  async function checkAForcedUncoveredFileIsNeverReportedAsCovered(commandFor: CompileCommandFor): Promise<void> {
    // Named beside the TU the database lists, so one failing forced TU cannot collapse the sweep into a
    // uniform failure and cost the payload: which way `clang-query`'s inferred flags land is the fixture's
    // business, and both ways have to hold.
    const together = payloadOf(
      await callTool(commandFor, [compiledFile()], { files: [compiledFile(), uncoveredFile()] }),
    );
    // Passing a file does not create an entry for it: the field still names it at this scope.
    expect(together.sweep).toMatchObject({ uncoveredSources: { count: 1, files: [uncoveredFile()] } });
    expect(together.sweep).not.toHaveProperty("uncoveredSourcesUnavailable");
    for (const row of together.failedFiles ?? []) {
      // The TU with an entry is never annotated, and the one without carries the real reason.
      expect(row.file).toBe(uncoveredFile());
      expect(row.error).toContain(DB_ENTRY_REASON);
    }

    // Forced alone, the same file is either a clean parse on inferred flags or the whole sweep's failure,
    // and that failure text names the missing entry instead of only blaming the binary.
    const alone = await callTool(commandFor, [compiledFile()], { files: [uncoveredFile()] });
    const text = failureText(alone);
    if (text === undefined) {
      const payload = payloadOf(alone);
      expect(payload.failedFiles).toBeUndefined();
      expect(payload.sweep).toMatchObject({ uncoveredSources: { count: 1, files: [uncoveredFile()] } });
      expect(classNames(payload.matches)).toEqual(["FactSetMdAdapter"]);
    } else {
      expect(text).toContain(DB_ENTRY_REASON);
      expect(text).toContain(`"${uncoveredFile()}"`);
      // The path stays the last thing in the text, so a caller can read it off the end.
      expect(text.endsWith(`Failed file: ${uncoveredFile()}`)).toBe(true);
    }
  }

  it("B1 names the source no entry compiles, and its class is absent from the answer (clang++)", async () =>
    checkTheBlindSpotIsNamed(gnuCommand), BLIND_LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "B1 names the source no entry compiles, and its class is absent from the answer (clang-cl)",
    async () => checkTheBlindSpotIsNamed(msvcCommand),
    BLIND_LIVE_TIMEOUT_MS,
  );

  it("B2 a database listing every source reports count zero and loses no class (clang++)", async () =>
    checkACompleteDatabaseSaysZero(gnuCommand), BLIND_LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "B2 a database listing every source reports count zero and loses no class (clang-cl)",
    async () => checkACompleteDatabaseSaysZero(msvcCommand),
    BLIND_LIVE_TIMEOUT_MS,
  );

  it("B3 an omitted sourceRoots derives the source tree and names the same blind spot (clang++)", async () =>
    checkAnOmittedSourceRootsDerivesTheTree(gnuCommand), BLIND_LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "B3 an omitted sourceRoots derives the source tree and names the same blind spot (clang-cl)",
    async () => checkAnOmittedSourceRootsDerivesTheTree(msvcCommand),
    BLIND_LIVE_TIMEOUT_MS,
  );

  it("B4 a forced uncovered file is never reported as covered, either outcome (clang++)", async () =>
    checkAForcedUncoveredFileIsNeverReportedAsCovered(gnuCommand), BLIND_LIVE_TIMEOUT_MS);
  itIfClangClAvailable(
    "B4 a forced uncovered file is never reported as covered, either outcome (clang-cl)",
    async () => checkAForcedUncoveredFileIsNeverReportedAsCovered(msvcCommand),
    BLIND_LIVE_TIMEOUT_MS,
  );
});

/**
 * The live case for the sweep: the repository root a caller passes by mistake is refused
 * with the build directory under it that does hold a `compile_commands.json` named, and that directory is
 * the one the sweep then answers from. Pinned through the real handler because the head a caller matches on
 * is the one this server actually emits.
 */
describe("cpp_find_derived_classes names the nearest compile database, against a real clang-query", () => {
  /** The refusal spawns no `clang-query`; the sweep that follows it does, twice over. */
  const HINT_LIVE_TIMEOUT_MS = 60_000;

  let repoRoot: string;
  let buildRoot: string;
  let srcRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cq-live-hint-"));
    buildRoot = join(repoRoot, "build");
    srcRoot = join(repoRoot, "src");
    mkdirSync(buildRoot);
    mkdirSync(srcRoot);
    writeFileSync(join(srcRoot, "base.h"), "class Base {\npublic:\n  virtual ~Base() = default;\n};\n");
    writeFileSync(join(srcRoot, "widget.cpp"), '#include "base.h"\n\nclass Widget : public Base {};\n');
    writeFileSync(
      join(buildRoot, "compile_commands.json"),
      JSON.stringify([
        {
          directory: srcRoot,
          command: `clang++ -std=c++17 -c "${join(srcRoot, "widget.cpp")}" -o widget.o`,
          file: join(srcRoot, "widget.cpp"),
        },
      ]),
    );
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const sweptClasses = (out: Awaited<ReturnType<typeof ask>>) =>
    ((out.structuredContent as { matches?: { className: string }[] } | undefined)?.matches ?? []).map(
      (row) => row.className,
    );

  function ask(projectRoot: string) {
    return runCppFindDerivedClasses(
      { cache: new SweepCache() },
      { projectRoot, qualifiedName: "Base", sourceRoots: [srcRoot] },
    );
  }

  it("refuses a repository root, naming the build directory that holds its database", async () => {
    const out = await ask(repoRoot);

    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toBe(
      `cpp_find_derived_classes failed: compile_commands.json not found or unreadable at "${repoRoot}". ` +
        `Directories under it that hold a compile_commands.json, nearest first: "${buildRoot}". ` +
        "Pass one of them as projectRoot.",
    );
  }, HINT_LIVE_TIMEOUT_MS);

  it("sweeps the directory that refusal named, and finds the class in it", async () => {
    const refused = await ask(repoRoot);
    const named = /nearest first: "([^"]+)"/.exec(refused.content[0]?.text ?? "")?.[1];

    expect(named).toBe(buildRoot);
    const swept = await ask(named ?? buildRoot);

    expect(swept.isError, swept.content[0]?.text).toBeFalsy();
    expect(sweptClasses(swept)).toEqual(["Widget"]);
  }, HINT_LIVE_TIMEOUT_MS);
});
