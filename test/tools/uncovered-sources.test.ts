import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import type { ClangQueryExecFn, FailedFile } from "../../src/clang-query/find-derived-classes.js";
import { inferredFlagsCaveat } from "../../src/clang-query/uncovered-sources.js";
import { runCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";
import { cleanExec, registeredDescription } from "../helpers/cpp-find-derived-classes.js";

/** Every TU fails, all of them the same way — the whole-sweep failure text. */
const brokenExec: ClangQueryExecFn = async () => ({ exitCode: 1, stdout: "", stderr: "error: unknown matcher" });

/** Every TU fails, each differently, so no uniform failure short-circuits the response and `failedFiles` is read. */
const failsEachWay: ClangQueryExecFn = async (args) => ({
  exitCode: 1,
  stdout: "",
  stderr: `fatal error: cannot compile ${(args[2] as string).split(/[\\/]/).at(-1)}`,
});

let buildRoot: string;
let sourceRoot: string;
let cache: SweepCache;

const source = (name: string): string => join(sourceRoot, name);
const rowFor = (rows: FailedFile[] | undefined, file: string): string | undefined =>
  rows?.find((row) => row.file === file)?.error;

function writeDb(files: string[]): void {
  writeFileSync(
    join(buildRoot, "compile_commands.json"),
    JSON.stringify(files.map((file) => ({ directory: sourceRoot, file }))),
  );
}

/**
 * A database whose only TU sits under projectRoot, so an omitted `sourceRoots` derives nothing
 * (`sources-under-project-root`) and the call has no source tree to make a claim about.
 */
function writeDbUnderProjectRoot(): void {
  writeFileSync(join(buildRoot, "compile_commands.json"), JSON.stringify([{ directory: buildRoot, file: "gen.cpp" }]));
}

function writeConfig(raw: string): void {
  writeFileSync(join(buildRoot, "mcp-code-nav.config.json"), raw);
}

async function run(
  overrides: { files?: string[]; sourceRoots?: string[]; exec?: ClangQueryExecFn; timeBudgetMs?: number } = {},
) {
  return runCppFindDerivedClasses(
    { exec: overrides.exec ?? cleanExec, cache },
    {
      projectRoot: buildRoot,
      qualifiedName: "IProviderAdapter",
      sourceRoots: overrides.sourceRoots ?? [sourceRoot],
      ...(overrides.files ? { files: overrides.files } : {}),
      ...(overrides.timeBudgetMs ? { timeBudgetMs: overrides.timeBudgetMs } : {}),
    },
  );
}

beforeEach(() => {
  buildRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-uncov-build-"));
  sourceRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-uncov-src-"));
  cache = new SweepCache();
  writeFileSync(source("adapter.cpp"), "class Adapter : public IProviderAdapter {};\n");
  writeFileSync(source("factset_md_adapter.cpp"), "class FactSetMdAdapter : public IProviderAdapter {};\n");
  writeDb(["adapter.cpp"]);
});

afterEach(() => {
  rmSync(buildRoot, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe("sweep.uncoveredSources", () => {
  it("names the source under sourceRoots that no compile-database entry compiles", async () => {
    const out = await run();
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.sweep).toMatchObject({
      uncoveredSources: { count: 1, files: [source("factset_md_adapter.cpp")] },
    });
    expect(out.structuredContent.sweep).not.toHaveProperty("uncoveredSourcesUnavailable");
  });

  it("counts the real source once, not its `.claude` worktree copy", async () => {
    mkdirSync(source("src"));
    writeFileSync(source(join("src", "real.cpp")), "class Real : public IProviderAdapter {};\n");
    const copyDir = source(join(".claude", "worktrees", "x", "src"));
    mkdirSync(copyDir, { recursive: true });
    writeFileSync(join(copyDir, "real.cpp"), "class Real : public IProviderAdapter {};\n");
    rmSync(source("factset_md_adapter.cpp"));
    const out = await run();
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.sweep).toMatchObject({
      uncoveredSources: { count: 1, files: [source(join("src", "real.cpp"))] },
    });
  });

  it("walks nested directories and claims nothing about which TUs the call swept", async () => {
    mkdirSync(source("core"));
    writeFileSync(source(join("core", "deep.cpp")), "class Deep : public IProviderAdapter {};\n");
    writeDb(["adapter.cpp", "core/deep.cpp"]);
    const out = await run({ files: ["adapter.cpp"] });
    expect(out.structuredContent.sweep).toMatchObject({
      uncoveredSources: { count: 1, files: [source("factset_md_adapter.cpp")] },
      totalTus: 1,
    });
  });

  it("says count zero, with the field present rather than absent, when every visited source has an entry", async () => {
    rmSync(source("factset_md_adapter.cpp"));
    const out = await run();
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSources: { count: 0, files: [] } });
    expect(out.structuredContent.sweep).not.toHaveProperty("uncoveredSourcesUnavailable");
  });

  it("makes no claim about sources under projectRoot alone, which is the build directory", async () => {
    writeFileSync(join(buildRoot, "generated.cpp"), "class Generated : public IProviderAdapter {};\n");
    rmSync(source("factset_md_adapter.cpp"));
    const out = await run();
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSources: { count: 0, files: [] } });
  });

  it("is information only: the rows, counts and isError do not depend on whether the signal could be computed", async () => {
    // Real rows, so the comparison cannot be satisfied by two empty results: the TU the database compiles
    // reports two declarations, one of them a direct implementer of the queried base.
    const rowsExec: ClangQueryExecFn = async () => ({
      exitCode: 0,
      stdout:
        `${source("adapter.cpp")}:1:1: note: "derived" binds here\n` +
        `${source("adapter.cpp")}:1:1: note: "direct" binds here\n` +
        `${source("factset_md_adapter.cpp")}:1:1: note: "derived" binds here\n`,
      stderr: "",
    });
    const withSignal = await run({ exec: rowsExec });
    writeDbUnderProjectRoot();
    const withoutSignal = await run({ exec: rowsExec, sourceRoots: [] });
    expect(withSignal.isError).toBeFalsy();
    expect(withSignal.structuredContent.matches).toHaveLength(2);
    expect(withSignal.structuredContent.counts).toEqual({ transitive: 2, direct: 1 });
    expect(withSignal.structuredContent.sweep).toMatchObject({ uncoveredSources: { count: 1 } });
    expect(withoutSignal.structuredContent.sweep).toMatchObject({
      uncoveredSourcesUnavailable: "no-source-roots",
    });
    expect(withSignal.structuredContent.matches).toEqual(withoutSignal.structuredContent.matches);
    expect(withSignal.structuredContent.counts).toEqual(withoutSignal.structuredContent.counts);
    expect(withSignal.isError).toBe(withoutSignal.isError);
  });

  it("is carried by a cache-hit call too, derived from that call's own walk", async () => {
    // The stronger claim cannot be built on a real filesystem: a source added under any walked root changes
    // the fingerprint, so it invalidates the cache by design. What this does pin is that a
    // hit carries a live signal rather than whatever the stored outcome happened to see.
    expect((await run()).structuredContent.sweep.cache).toBe("miss");
    const second = await run();
    expect(second.structuredContent.sweep).toMatchObject({
      cache: "hit",
      uncoveredSources: { count: 1, files: [source("factset_md_adapter.cpp")] },
    });
  });

  it("rides the partial payload of a call that reached its ceiling, beside the incomplete block", async () => {
    const hanging: ClangQueryExecFn = (_args, _cwd, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const out = await run({ exec: hanging, timeBudgetMs: 20 });
    expect(out.isError).toBe(true);
    expect(out.structuredContent.incomplete).toEqual({ sweptTus: 0, totalTus: 1, reason: "time-budget" });
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSources: { count: 1 } });
    expect(out.structuredContent.sweep).not.toHaveProperty("uncoveredSourcesUnavailable");
  });
});

describe("sweep.uncoveredSourcesUnavailable", () => {
  it("says no-source-roots, not a confident zero, when the caller declared no source tree", async () => {
    writeDbUnderProjectRoot();
    const out = await run({ sourceRoots: [] });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSourcesUnavailable: "no-source-roots" });
    expect(out.structuredContent.sweep).not.toHaveProperty("uncoveredSources");
  });

  it("says walk-incomplete when a declared source root cannot be read", async () => {
    const missing = join(tmpdir(), "mcp-code-nav-uncov-no-such-root");
    rmSync(missing, { recursive: true, force: true });
    const out = await run({ sourceRoots: [sourceRoot, missing] });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSourcesUnavailable: "walk-incomplete" });
  });

  it("says root-under-skipped-dir when dedupe drops a root behind a skipped directory name", async () => {
    // Everything the walk does reach is compiled, so the difference alone would have said "count: 0"
    // about sources it never saw. Dedupe can change the answer, so the answer is refused instead.
    const hidden = source(join("build_tools", "src"));
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "gated.cpp"), "class Gated : public IProviderAdapter {};\n");
    rmSync(source("factset_md_adapter.cpp"));
    const out = await run({ sourceRoots: [sourceRoot, hidden] });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSourcesUnavailable: "root-under-skipped-dir" });
    expect(out.structuredContent.sweep).not.toHaveProperty("uncoveredSources");
  });

  it("says root-under-skipped-dir when the dropped root is reached through `.claude`", async () => {
    const hidden = source(join(".claude", "worktrees", "x", "src"));
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "gated.cpp"), "class Gated : public IProviderAdapter {};\n");
    rmSync(source("factset_md_adapter.cpp"));
    const out = await run({ sourceRoots: [sourceRoot, hidden] });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSourcesUnavailable: "root-under-skipped-dir" });
    expect(out.structuredContent.sweep).not.toHaveProperty("uncoveredSources");
  });

  it("says ignored-paths-unreadable, and still answers, when the project config is malformed", async () => {
    writeConfig("{ not json");
    const out = await run();
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.matches).toEqual([]);
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSourcesUnavailable: "ignored-paths-unreadable" });
    expect(out.structuredContent.sweep).not.toHaveProperty("uncoveredSources");
  });

  it("says compile-db-unlistable on a files-scoped call whose database cannot be read, failing open", async () => {
    rmSync(join(buildRoot, "compile_commands.json"));
    const out = await run({ files: ["untouched.cpp"] });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSourcesUnavailable: "compile-db-unlistable" });
  });

  it("keeps the walk's own failure ahead of an unreadable config when both are true", async () => {
    // The config is read last (see the counting reader in test/clang-query/uncovered-sources.test.ts), and
    // wiring it ahead of the walk checks would bury which fact actually refused the signal.
    writeConfig("{ not json");
    const missing = join(tmpdir(), "mcp-code-nav-uncov-no-such-root-again");
    rmSync(missing, { recursive: true, force: true });
    const out = await run({ sourceRoots: [sourceRoot, missing] });
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSourcesUnavailable: "walk-incomplete" });
  });

  it("applies ignoredPaths keyed to the source root that contains the file, not to projectRoot", async () => {
    mkdirSync(source("third_party"));
    writeFileSync(source(join("third_party", "vendored.cpp")), "class Vendored {};\n");
    rmSync(source("factset_md_adapter.cpp"));
    writeConfig(JSON.stringify({ ignoredPaths: ["third_party/*"] }));
    const out = await run();
    // Keyed to the build directory the relative path would start with ".." and the pattern could never
    // have matched, leaving this file reported as a blind spot forever.
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSources: { count: 0, files: [] } });
  });

  it("keeps a source under a skipped directory inside a declared root out of both the count and the reasons", async () => {
    // The narrowed claim, pinned so widening it has to change this test: a real source tree named
    // `builder/` is invisible to the field in both directions.
    mkdirSync(source("builder"));
    writeFileSync(source(join("builder", "omitted.cpp")), "class Omitted : public IProviderAdapter {};\n");
    rmSync(source("factset_md_adapter.cpp"));
    const out = await run();
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSources: { count: 0, files: [] } });
    expect(out.structuredContent.sweep).not.toHaveProperty("uncoveredSourcesUnavailable");
  });
});

/** What the annotation may claim: the absence, and that clang-query ran the file on inferred flags. It does
 *  not claim the file was never parsed — measured against clang-query 22.1.3 it is not rejected at all. */
const DB_ENTRY_REASON = `no compile-database entry; ${inferredFlagsCaveat(false)}`;

describe("a files-scoped call diagnoses its own entries against the database", () => {
  // Read per test: the temp roots only exist once `beforeEach` has run.
  const mistyped = (): string => join(buildRoot, "typo.cpp");
  const compiled = (): string => source("adapter.cpp");

  it("adds the real reason beside clang-query's error on a named file no entry compiles", async () => {
    const out = await run({ files: ["typo.cpp", "adapter.cpp"], exec: failsEachWay });
    expect(out.isError).toBeFalsy();
    expect(rowFor(out.structuredContent.failedFiles, mistyped())).toBe(
      `fatal error: cannot compile typo.cpp - ${DB_ENTRY_REASON}`,
    );
    expect(rowFor(out.structuredContent.failedFiles, compiled())).toBe("fatal error: cannot compile adapter.cpp");
  });

  it("needs no sourceRoots and no completed walk to make the diagnosis", async () => {
    writeDbUnderProjectRoot();
    const out = await run({ sourceRoots: [], files: ["typo.cpp", "adapter.cpp"], exec: failsEachWay });
    expect(rowFor(out.structuredContent.failedFiles, join(buildRoot, "typo.cpp"))).toBe(
      `fatal error: cannot compile typo.cpp - ${DB_ENTRY_REASON}`,
    );
    expect(rowFor(out.structuredContent.failedFiles, join(buildRoot, "adapter.cpp"))).toBe(
      `fatal error: cannot compile adapter.cpp - ${DB_ENTRY_REASON}`,
    );
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSourcesUnavailable: "no-source-roots" });
  });

  it("names the blind-spot files in the uniform-failure text instead of only blaming the binary", async () => {
    const out = await run({ files: ["typo.cpp"], exec: brokenExec });
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toBe(
      "cpp_find_derived_classes failed on all 1 translation units with the same error, so the empty result is a " +
        "sweep failure, not an empty hierarchy - check that the clang-query on PATH supports this query. " +
        "Shared error: error: unknown matcher" +
        ` These files are named in \`files\` but have no compile-database entry; ${inferredFlagsCaveat(true)}: ` +
        `"${mistyped()}".` +
        ` Failed file: ${mistyped()}`,
    );
    // The sentence goes first so the path stays at the end: a caller matching the tail captures the path,
    // not the explanation.
    expect(text.endsWith(`Failed file: ${mistyped()}`)).toBe(true);
  });

  it("leaves the uniform-failure text byte-identical when every named file is compiled", async () => {
    const out = await run({ files: ["adapter.cpp"], exec: brokenExec });
    expect(out.content[0]?.text).toBe(
      "cpp_find_derived_classes failed on all 1 translation units with the same error, so the empty result is a " +
        "sweep failure, not an empty hierarchy - check that the clang-query on PATH supports this query. " +
        `Shared error: error: unknown matcher Failed file: ${compiled()}`,
    );
  });

  it("fails open on a malformed compile_commands.json, and still answers", async () => {
    writeFileSync(join(buildRoot, "compile_commands.json"), "{ not an array");
    const out = await run({ files: ["adapter.cpp"] });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.matches).toEqual([]);
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSourcesUnavailable: "compile-db-unlistable" });
    expect(out.structuredContent.sweep).not.toHaveProperty("uncoveredSources");
  });

  it("creates no row for a file the caller did not name", async () => {
    const out = await run();
    expect(out.structuredContent).not.toHaveProperty("failedFiles");
    expect(out.structuredContent.sweep).toMatchObject({ uncoveredSources: { count: 1 } });
  });
});

describe("cpp_find_derived_classes description text", () => {
  it("names the blind spot, what a class there cannot do, and what count zero does not mean", () => {
    const description = registeredDescription();
    expect(description).toContain(
      "`sweep.uncoveredSources` names sources under `sourceRoots` that no compile-database entry compiles",
    );
    expect(description).toContain("a class defined only there cannot appear");
    expect(description).toContain(
      "not build, vendored, VCS or `.claude` directories, `ignoredPaths` matches or symlinks",
    );
    expect(description).toContain("says nothing about which TUs were swept");
  });
});
