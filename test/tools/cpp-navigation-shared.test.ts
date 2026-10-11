import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CppSourceRootsBlock } from "../../src/clang-query/derived-source-roots.js";
import { computeProjectFingerprint } from "../../src/clang-query/project-fingerprint.js";
import { listTranslationUnits } from "../../src/clang-query/compile-db.js";
import { readIgnoredPatterns } from "../../src/config/ignored-paths.js";
import { uncoveredSourcesBlock } from "../../src/clang-query/uncovered-sources.js";
import { takeIndexSnapshot } from "../../src/paths/index-drift.js";
import {
  cppNavigationLimits,
  indexBlock,
  uncoveredBlock,
  type CppIndexBlock,
  type CppScopeFacts,
} from "../../src/tools/cpp-navigation-shared.js";

/**
 * `scope.uncoveredSources` beside a C++ listing answer is computed from the walk the drift signal already
 * took, not from the sweep's
 * fingerprint walk. Two walks over one project must not disagree about what a compile database leaves
 * uncovered, or `cpp_find_references` and `cpp_find_derived_classes` would name different blind spots for the same
 * tree. Each case therefore compares the two functions over one fixture, so any drift in either walk's
 * file set surfaces as a difference between them rather than as a green suite.
 */
describe("the two C++ walks agree about what a compile database leaves uncovered", () => {
  let tmp: string;
  let buildDir: string;
  let sourceDir: string;

  /** Roots as one call states them: declared when there are any, projectRoot alone when there are none. */
  const blockOf = (roots: readonly string[]): CppSourceRootsBlock =>
    roots.length > 0
      ? { origin: "declared", roots }
      : { origin: "project-root-only", roots: [], reason: "sources-under-project-root" };

  const quietIndex: CppIndexBlock = { state: "quiescent", staleFiles: { count: 0, files: [] } };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-cpp-uncovered-"));
    buildDir = join(tmp, "out", "build");
    sourceDir = join(tmp, "src");
    mkdirSync(buildDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "widget.cpp"), '#include "widget.h"\n\nint Widget::value() {\n  return 1;\n}\n');
    writeFileSync(join(sourceDir, "widget.h"), "#pragma once\n\nclass Widget {\npublic:\n  int value();\n};\n");
    // The blind spot: a source the build never named. It is the only thing the pair may list.
    writeFileSync(join(sourceDir, "orphan.cpp"), "int orphan() { return 0; }\n");
    writeFileSync(join(sourceDir, "notes.md"), "# not a source\n");
    mkdirSync(join(sourceDir, "sub"), { recursive: true });
    writeFileSync(join(sourceDir, "sub", "nested.cpp"), "int nested() { return 0; }\n");
    mkdirSync(join(sourceDir, ".cache", "clangd", "index"), { recursive: true });
    writeFileSync(join(sourceDir, ".cache", "clangd", "index", "widget.cpp.AAAAAAAA.idx"), "shards");
    writeFileSync(
      join(buildDir, "compile_commands.json"),
      JSON.stringify([
        {
          directory: sourceDir,
          command: `clang++ -std=c++17 -c "${join(sourceDir, "widget.cpp")}" -o widget.o`,
          file: join(sourceDir, "widget.cpp"),
        },
        {
          directory: sourceDir,
          command: `clang++ -std=c++17 -c "${join(sourceDir, "sub", "nested.cpp")}" -o nested.o`,
          file: join(sourceDir, "sub", "nested.cpp"),
        },
      ]),
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** What a `cpp_find_references` answer publishes, from the drift walk's own account. */
  function fromDriftWalk(roots: readonly string[]) {
    const facts: CppScopeFacts = {
      projectRoot: buildDir,
      sourceRootsBlock: blockOf(roots),
      index: quietIndex,
      account: takeIndexSnapshot(roots).account,
      compileDbTus: listTranslationUnits(buildDir),
      capped: false,
      indirectDispatch: false,
    };
    return uncoveredBlock(facts);
  }

  /** What `cpp_find_derived_classes` publishes for the same roots, from the fingerprint walk. */
  function fromFingerprintWalk(roots: readonly string[]) {
    return uncoveredSourcesBlock({
      roots: [buildDir, ...roots],
      walk: computeProjectFingerprint([buildDir, ...roots]),
      compileDbTus: listTranslationUnits(buildDir),
      readIgnoredPaths: () => readIgnoredPatterns(buildDir),
    });
  }

  it("names the same uncovered source through either walk", () => {
    const drift = fromDriftWalk([sourceDir]);

    expect(drift).toEqual(fromFingerprintWalk([sourceDir]));
    expect(drift).toEqual({ uncoveredSources: { count: 1, files: [join(sourceDir, "orphan.cpp")] } });
  });

  it("keeps a header out of both, because a header is essentially never a database entry", () => {
    const drift = fromDriftWalk([sourceDir]);
    const listed = (drift as { uncoveredSources: { files: readonly string[] } }).uncoveredSources;

    expect(listed.files).not.toContain(join(sourceDir, "widget.h"));
    expect(drift).toEqual(fromFingerprintWalk([sourceDir]));
  });

  it("skips clangd's own shard tree in both, so the index is never reported against itself", () => {
    expect(JSON.stringify(fromDriftWalk([sourceDir]))).not.toContain(".cache");
    expect(fromDriftWalk([sourceDir])).toEqual(fromFingerprintWalk([sourceDir]));
  });

  it("treats a nested declared root as one tree in both", () => {
    const roots = [sourceDir, join(sourceDir, "sub")];

    expect(fromDriftWalk(roots)).toEqual(fromFingerprintWalk(roots));
    expect(fromDriftWalk(roots)).toEqual({
      uncoveredSources: { count: 1, files: [join(sourceDir, "orphan.cpp")] },
    });
  });

  it("claims nothing when no source root is declared, in both", () => {
    expect(fromDriftWalk([])).toEqual(fromFingerprintWalk([]));
    expect(fromDriftWalk([])).toEqual({ uncoveredSourcesUnavailable: "no-source-roots" });
  });

  it("reports a bounded walk as no claim at all, the way the sweep does", () => {
    const starved = takeIndexSnapshot([sourceDir], { maxEntries: 2 });
    const facts: CppScopeFacts = {
      projectRoot: buildDir,
      sourceRootsBlock: blockOf([sourceDir]),
      index: quietIndex,
      account: starved.account,
      compileDbTus: listTranslationUnits(buildDir),
      capped: false,
      indirectDispatch: false,
    };

    expect(starved.account?.bounded).toBe(true);
    expect(uncoveredBlock(facts)).toEqual({ uncoveredSourcesUnavailable: "walk-bounded" });
    expect(uncoveredBlock({ ...facts, account: undefined })).toEqual(uncoveredBlock(facts));
  });

  it("carries `compile-database-only` on every C++ answer and the blind-spot code beside a non-empty pair", () => {
    const facts = (capped: boolean): CppScopeFacts => ({
      projectRoot: buildDir,
      sourceRootsBlock: blockOf([sourceDir]),
      index: quietIndex,
      account: takeIndexSnapshot([sourceDir]).account,
      compileDbTus: listTranslationUnits(buildDir),
      capped,
      indirectDispatch: false,
    });

    expect(cppNavigationLimits(facts(false))).toEqual(["compile-database-only", "uncovered-sources-present"]);
    expect(cppNavigationLimits(facts(true))).toEqual([
      "compile-database-only",
      "uncovered-sources-present",
      "listing-capped",
    ]);
  });

  it("states drift as exactly one of `staleFiles` and `driftUnknown`, capping the listing only", () => {
    const many = Array.from({ length: 25 }, (_, index) => join(sourceDir, `changed${index}.cpp`));

    const stale = indexBlock("quiescent", { kind: "stale", files: many });
    const unknown = indexBlock("building", {
      kind: "unknown",
      cause: "no-baseline",
      reason: "this is the first index-backed answer",
    });

    if (!("staleFiles" in stale)) throw new Error("a stale verdict must carry staleFiles");
    expect(stale.staleFiles.count).toBe(25);
    expect(stale.staleFiles.files).toHaveLength(20);
    expect(unknown).toEqual({ state: "building", driftUnknown: "this is the first index-backed answer" });
  });
});
