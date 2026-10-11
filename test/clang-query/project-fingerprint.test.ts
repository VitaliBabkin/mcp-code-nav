import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeProjectFingerprint } from "../../src/clang-query/project-fingerprint.js";

describe("computeProjectFingerprint", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fp-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("is deterministic across two consecutive calls with no filesystem change", () => {
    writeFileSync(join(projectRoot, "compile_commands.json"), "[]");
    writeFileSync(join(projectRoot, "a.cpp"), "class A {};\n");
    const first = computeProjectFingerprint([projectRoot]);
    const second = computeProjectFingerprint([projectRoot]);
    expect(first.fingerprint).toBeDefined();
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("changes when a tracked source file's mtime changes", () => {
    const file = join(projectRoot, "a.cpp");
    writeFileSync(file, "class A {};\n");
    const before = computeProjectFingerprint([projectRoot]);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, past, future);
    const after = computeProjectFingerprint([projectRoot]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("ignores a file whose extension is not a recognized C/C++ extension", () => {
    writeFileSync(join(projectRoot, "readme.txt"), "hello");
    const before = computeProjectFingerprint([projectRoot]);
    writeFileSync(join(projectRoot, "readme.txt"), "hello, changed");
    const after = computeProjectFingerprint([projectRoot]);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("skips files under a skip-listed directory name (node_modules, .git, build*, cmake-build*)", () => {
    const skippedDirs = [
      "node_modules",
      ".git",
      ".claude",
      "build-x64",
      "cmake-build-debug",
      ".vs",
      ".idea",
      "vcpkg_installed",
      "out",
    ];
    for (const dirName of skippedDirs) {
      const dir = join(projectRoot, dirName);
      mkdirSync(dir);
      writeFileSync(join(dir, "ignored.cpp"), "class Ignored {};\n");
    }
    const before = computeProjectFingerprint([projectRoot]);
    for (const dirName of skippedDirs) {
      writeFileSync(join(projectRoot, dirName, "ignored.cpp"), "class IgnoredChanged {};\n");
    }
    const after = computeProjectFingerprint([projectRoot]);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("does NOT skip a walk root itself even when its own directory name matches the skip list", () => {
    const buildNamedRoot = join(projectRoot, "build-nested");
    mkdirSync(buildNamedRoot);
    writeFileSync(join(buildNamedRoot, "a.cpp"), "class A {};\n");
    const before = computeProjectFingerprint([buildNamedRoot]);
    writeFileSync(join(buildNamedRoot, "a.cpp"), "class A { int x; };\n");
    const after = computeProjectFingerprint([buildNamedRoot]);
    expect(before.fingerprint).toBeDefined();
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("does NOT skip a walk root that is itself named .claude, so a worktree checkout still walks", () => {
    const claudeRoot = join(projectRoot, ".claude");
    mkdirSync(claudeRoot);
    writeFileSync(join(claudeRoot, "a.cpp"), "class A {};\n");
    const before = computeProjectFingerprint([claudeRoot]);
    writeFileSync(join(claudeRoot, "a.cpp"), "class A { int x; };\n");
    const after = computeProjectFingerprint([claudeRoot]);
    expect(before.fingerprint).toBeDefined();
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("walks `.Claude` — the skip match is exact name equality, case-sensitive on every platform", () => {
    const dir = join(projectRoot, ".Claude");
    mkdirSync(dir);
    const file = join(dir, "a.cpp");
    writeFileSync(file, "class A {};\n");
    const before = computeProjectFingerprint([projectRoot]);
    writeFileSync(file, "class A { int x; };\n");
    const after = computeProjectFingerprint([projectRoot]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("walks a root nested inside another root only once (no double count, same fingerprint as the outer root alone)", () => {
    const nested = join(projectRoot, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "a.cpp"), "class A {};\n");
    const outerAlone = computeProjectFingerprint([projectRoot]);
    const outerPlusNested = computeProjectFingerprint([projectRoot, nested]);
    expect(outerPlusNested.fingerprint).toBe(outerAlone.fingerprint);
    expect(outerPlusNested.entriesScanned).toBe(outerAlone.entriesScanned);
  });

  it("nests a root whose name only starts with two dots (`..hidden`), so it is still walked once", () => {
    // `relative(projectRoot, nested)` answers "..hidden"; only a `..` segment is an escape, so the inner
    // root is nested and the same file is not walked, or hashed, twice.
    const nested = join(projectRoot, "..hidden");
    mkdirSync(nested);
    writeFileSync(join(nested, "a.cpp"), "class A {};\n");
    const outerAlone = computeProjectFingerprint([projectRoot]);
    const outerPlusNested = computeProjectFingerprint([projectRoot, nested]);
    expect(outerPlusNested.fingerprint).toBe(outerAlone.fingerprint);
    expect(outerPlusNested.entriesScanned).toBe(outerAlone.entriesScanned);
  });

  it("keeps a root that really is outside another (a .. step) as its own walk root", () => {
    const sibling = mkdtempSync(join(tmpdir(), "mcp-code-nav-fp-sibling-"));
    try {
      writeFileSync(join(sibling, "b.cpp"), "class B {};\n");
      const outerAlone = computeProjectFingerprint([projectRoot]);
      const bothRoots = computeProjectFingerprint([projectRoot, sibling]);
      expect(bothRoots.entriesScanned).toBeGreaterThan(outerAlone.entriesScanned);
      expect(bothRoots.fingerprint).not.toBe(outerAlone.fingerprint);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("always includes projectRoot/compile_commands.json even when it does not exist (as an ERR line)", () => {
    const withoutDb = computeProjectFingerprint([projectRoot]);
    writeFileSync(join(projectRoot, "compile_commands.json"), "[]");
    const withDb = computeProjectFingerprint([projectRoot]);
    expect(withoutDb.fingerprint).not.toBe(withDb.fingerprint);
  });

  it("disables the fingerprint (no fingerprint, a reason) when the walk enumerates more than maxEntries", () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(projectRoot, `f${i}.cpp`), "class A {};\n");
    }
    const result = computeProjectFingerprint([projectRoot], { maxEntries: 2 });
    expect(result.fingerprint).toBeUndefined();
    expect(result.reason).toBeDefined();
    expect(result.entriesScanned).toBeGreaterThan(2);
  });

  it("returns a correct fingerprint when the walk stays within maxEntries", () => {
    writeFileSync(join(projectRoot, "a.cpp"), "class A {};\n");
    const result = computeProjectFingerprint([projectRoot], { maxEntries: 20_000 });
    expect(result.fingerprint).toBeDefined();
    expect(result.reason).toBeUndefined();
  });
});

describe("computeProjectFingerprint — the uncovered-source by-products", () => {
  let buildRoot: string;
  let sourceRoot: string;

  const inSource = (name: string): string => join(sourceRoot, name);
  const sorted = (paths: readonly string[] | undefined): string[] => [...(paths ?? [])].sort();

  beforeEach(() => {
    buildRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fp-by-build-"));
    sourceRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fp-by-src-"));
    writeFileSync(join(buildRoot, "compile_commands.json"), "[]");
  });

  afterEach(() => {
    rmSync(buildRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("collects the TU-extension sources under a declared source root, and only those", () => {
    for (const name of [
      "a.c",
      "b.cc",
      "c.cpp",
      "d.cxx",
      "e.ixx",
      "f.mm",
      "g.hpp",
      "h.cppm",
      "i.cpp",
      "notes.txt",
    ]) {
      writeFileSync(inSource(name), "x\n");
    }
    // A source under projectRoot alone is outside the claim: projectRoot is the build directory, and its
    // generated .cpp files are not a blind spot worth naming.
    writeFileSync(join(buildRoot, "generated.cpp"), "x\n");
    const result = computeProjectFingerprint([buildRoot, sourceRoot]);
    expect(sorted(result.sourceTus)).toEqual(
      [
        inSource("a.c"),
        inSource("b.cc"),
        inSource("c.cpp"),
        inSource("d.cxx"),
        inSource("e.ixx"),
        inSource("f.mm"),
        inSource("i.cpp"),
      ].sort(),
    );
  });

  it("leaves sourceTus undefined when no source root was declared", () => {
    writeFileSync(join(buildRoot, "a.cpp"), "class A {};\n");
    const result = computeProjectFingerprint([buildRoot]);
    expect(result.sourceTus).toBeUndefined();
  });

  it("reports an empty sourceTus, not an undefined one, when a declared root holds no source", () => {
    const result = computeProjectFingerprint([buildRoot, sourceRoot]);
    expect(result.sourceTus).toEqual([]);
  });

  it("flags the walk as incomplete when a readdir fails, instead of an honest, empty, wrong zero", () => {
    const missing = join(tmpdir(), "mcp-code-nav-fp-by-nope-not-here");
    rmSync(missing, { recursive: true, force: true });
    const result = computeProjectFingerprint([buildRoot, missing]);
    expect(result.walkIncomplete).toBe(true);
    expect(result.fingerprint).toBeDefined();
    const clean = computeProjectFingerprint([buildRoot, sourceRoot]);
    expect(clean.walkIncomplete).toBe(false);
  });

  it("flags the walk incomplete for a readdir failure outside every source root", () => {
    // projectRoot is not a source root, so this failure has no source-root cause to name — which is exactly
    // why the flag is global and conservative: one unreadable directory anywhere refuses the claim.
    writeFileSync(inSource("a.cpp"), "class A {};\n");
    const unreadable = join(tmpdir(), "mcp-code-nav-fp-by-no-such-build-dir");
    rmSync(unreadable, { recursive: true, force: true });
    const result = computeProjectFingerprint([unreadable, sourceRoot]);
    expect(result.walkIncomplete).toBe(true);
    expect(result.unreachableSourceRoots).toEqual([]);
    expect(result.sourceTus).toEqual([inSource("a.cpp")]);
  });

  it("names a dedupe-dropped source root the walk could never reach", () => {
    const hidden = join(sourceRoot, "build_tools", "src");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "adapter.cpp"), "class Adapter : public IProviderAdapter {};\n");
    const result = computeProjectFingerprint([buildRoot, sourceRoot, hidden]);
    expect(result.unreachableSourceRoots).toEqual([hidden]);
    // The source behind the skipped name is neither collected nor claimed: it is outside the field.
    expect(result.sourceTus).toEqual([]);
  });

  it("keeps a nested source root the walk did reach out of unreachableSourceRoots", () => {
    const nested = join(sourceRoot, "core");
    mkdirSync(nested);
    writeFileSync(join(nested, "a.cpp"), "class A {};\n");
    const result = computeProjectFingerprint([buildRoot, sourceRoot, nested]);
    expect(result.unreachableSourceRoots).toEqual([]);
    expect(result.sourceTus).toEqual([join(nested, "a.cpp")]);
  });

  it("collects a source under a nested declared root that dedupe dropped from the walk list", () => {
    // The in-source layout: projectRoot is the source tree and `src` a declared root inside it. Dedupe walks
    // only the outer root, so `src/a.cpp` is reached through it — and it still qualifies, because membership
    // is tested against the pre-dedupe roots. `other.cpp` sits in projectRoot alone, outside the claim. That
    // `sourceTus` is defined at all is what stops the tool layer answering "no-source-roots" for this caller.
    mkdirSync(join(buildRoot, "src"));
    writeFileSync(join(buildRoot, "src", "a.cpp"), "class A : public Base {};\n");
    writeFileSync(join(buildRoot, "other.cpp"), "class Other : public Base {};\n");
    const result = computeProjectFingerprint([buildRoot, join(buildRoot, "src")]);
    expect(result.sourceTus).toEqual([join(buildRoot, "src", "a.cpp")]);
    expect(result.unreachableSourceRoots).toEqual([]);
  });

  it("leaves a skipped directory inside a declared root out of both sourceTus and the reason evidence", () => {
    // A genuine source tree named `builder/` is outside `count: 0`'s claim and produces no reason code:
    // pinned deliberately, so widening the claim later is an edit to this test, not a silent drift.
    const vendored = join(sourceRoot, "builder");
    mkdirSync(vendored);
    writeFileSync(join(vendored, "hidden.cpp"), "class Hidden {};\n");
    writeFileSync(inSource("a.cpp"), "class A {};\n");
    const result = computeProjectFingerprint([buildRoot, sourceRoot]);
    expect(result.sourceTus).toEqual([inSource("a.cpp")]);
    expect(result.unreachableSourceRoots).toEqual([]);
    expect(result.walkIncomplete).toBe(false);
  });

  it("leaves a source under a `.claude` worktree copy out of both sourceTus and the fingerprint", () => {
    writeFileSync(inSource("a.cpp"), "class A {};\n");
    const nestedDir = inSource(join("sub", ".claude"));
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "n.cpp"), "class N {};\n");
    const before = computeProjectFingerprint([buildRoot, sourceRoot]);
    const copyDir = join(sourceRoot, ".claude", "worktrees", "x");
    mkdirSync(copyDir, { recursive: true });
    const copy = join(copyDir, "a.cpp");
    writeFileSync(copy, "class A {};\n");
    const added = computeProjectFingerprint([buildRoot, sourceRoot]);
    expect(added.fingerprint).toBe(before.fingerprint);
    expect(added.sourceTus).toEqual([inSource("a.cpp")]);
    writeFileSync(copy, "class A { int x; };\n");
    const changed = computeProjectFingerprint([buildRoot, sourceRoot]);
    expect(changed.fingerprint).toBe(before.fingerprint);
    expect(changed.sourceTus).toEqual([inSource("a.cpp")]);
  });

  it("sets every by-product on the bounded early return too, because the fields are required", () => {
    // Every directory here holds exactly one entry, so the bound trips at a known point whatever order
    // `readdir` returns them in: `a.cpp` is collected, `extraRoot/x.cpp` is never reached. `gone` is nested
    // (so dedupe drops it) and does not exist (so the walk cannot reach it) — unreachable by outcome.
    writeFileSync(inSource("a.cpp"), "class A {};\n");
    const gone = inSource("gone");
    const extraRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fp-by-extra-"));
    writeFileSync(join(extraRoot, "x.cpp"), "class X {};\n");
    try {
      const bounded = computeProjectFingerprint([buildRoot, sourceRoot, gone, extraRoot], { maxEntries: 2 });
      expect(bounded.fingerprint).toBeUndefined();
      expect(bounded.reason).toContain("caching disabled");
      expect(bounded.entriesScanned).toBe(3);
      expect(bounded.sourceTus).toEqual([inSource("a.cpp")]);
      expect(bounded.walkIncomplete).toBe(false);
      expect(bounded.unreachableSourceRoots).toEqual([gone]);
    } finally {
      rmSync(extraRoot, { recursive: true, force: true });
    }
  });
});
