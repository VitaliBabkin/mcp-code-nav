import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import type { ClangQueryExecFn } from "../../src/clang-query/find-derived-classes.js";
import { CppFindDerivedClassesInput, runCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";
import { CppFindSymbolInput, runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { CppFileSymbolsInput, runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";
import { fakeProcessByFile, sessionsFor, sym } from "../helpers/fake-clangd.js";
import { cleanExec } from "../helpers/cpp-find-derived-classes.js";

/** The exact diagnostic, leading space included: it is appended to an existing sentence. */
function resolutionSentence(candidate: string, winner: string, tried: readonly string[]): string {
  return ` Resolved "${candidate}" to "${winner}" (tried: ${tried.map((p) => `"${p}"`).join(", ")}).`;
}

describe("relative file resolution at the tool layer", () => {
  let base: string;
  let buildRoot: string;
  let sourceRoot: string;

  beforeEach(() => {
    // Both roots under one unique base: an omitted `sourceRoots` derives that base, never the shared temp directory.
    base = mkdtempSync(join(tmpdir(), "mcp-code-nav-rel-"));
    buildRoot = join(base, "build");
    sourceRoot = join(base, "src");
    mkdirSync(buildRoot);
    mkdirSync(sourceRoot);
    writeFileSync(
      join(buildRoot, "compile_commands.json"),
      JSON.stringify([{ directory: sourceRoot, file: "widget.h" }]),
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("cpp_file_symbols reads a repository-relative file from the source root that holds it", async () => {
    const file = join(sourceRoot, "widget.h");
    writeFileSync(file, "class Widget {};\n");
    const sessions = sessionsFor(fakeProcessByFile((f) => (f === file ? [sym("Widget", 5)] : [])));
    const out = await runCppFileSymbols(sessions, {
      projectRoot: buildRoot,
      file: "widget.h",
      sourceRoots: [sourceRoot],
      depth: 1,
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toEqual({
      symbols: [{ name: "Widget", kind: "class", range: { startLine: 1, endLine: 2 } }],
    });
  });

  it("cpp_file_symbols names every spelling it tried when the relative file exists under none", async () => {
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const out = await runCppFileSymbols(sessions, {
      projectRoot: buildRoot,
      file: "gone.h",
      sourceRoots: [sourceRoot],
      depth: 1,
    });
    expect(out.isError).toBe(true);
    const underBuild = join(buildRoot, "gone.h");
    const tried = [underBuild, join(sourceRoot, "gone.h")];
    expect(out.content[0]?.text).toContain(resolutionSentence("gone.h", underBuild, tried));
    // The winner is still projectRoot's spelling, so a missing file surfaces as the plain ENOENT for it.
    expect(out.content[0]?.text).toContain(underBuild);
  });

  it("cpp_file_symbols says nothing about tried paths when there was only ever one candidate", async () => {
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    // A database whose only TU is under projectRoot derives no second root, so `sourceRoots` can be omitted.
    writeFileSync(
      join(buildRoot, "compile_commands.json"),
      JSON.stringify([{ directory: buildRoot, file: "gen.cpp" }]),
    );
    const out = await runCppFileSymbols(sessions, { projectRoot: buildRoot, file: "gone.h", depth: 1 } as never);
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).not.toContain("Resolved");
  });

  it("cpp_file_symbols asks for an absolute path when the relative file exists under both roots", async () => {
    writeFileSync(join(buildRoot, "both.h"), "#pragma once\n");
    writeFileSync(join(sourceRoot, "both.h"), "#pragma once\n");
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const out = await runCppFileSymbols(sessions, {
      projectRoot: buildRoot,
      file: "both.h",
      sourceRoots: [sourceRoot],
      depth: 1,
    });
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toContain(join(buildRoot, "both.h"));
    expect(text).toContain(join(sourceRoot, "both.h"));
    expect(text).toContain("pass an absolute path");
  });

  it("cpp_find_symbol appends the tried paths to its no-symbol text", async () => {
    const warmFile = join(sourceRoot, "warm.h");
    const widgetFile = join(sourceRoot, "widget.h");
    writeFileSync(warmFile, "class Warm {};\n");
    writeFileSync(widgetFile, "class Widget {};\n");
    const sessions = sessionsFor(fakeProcessByFile((f) => (f === warmFile ? [sym("Warm", 5)] : [])));
    await runCppFileSymbols(sessions, { projectRoot: buildRoot, file: "warm.h", sourceRoots: [sourceRoot], depth: 1 });
    const out = await runCppFindSymbol(sessions, {
      projectRoot: buildRoot,
      name: "Gone",
      file: "widget.h",
      sourceRoots: [sourceRoot],
    });
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toContain(`no symbol "Gone" found in "${widgetFile}".`);
    expect(text).toContain(resolutionSentence("widget.h", widgetFile, [join(buildRoot, "widget.h"), widgetFile]));
  });

  it("cpp_find_symbol asks for an absolute path when the relative file exists under both roots", async () => {
    writeFileSync(join(buildRoot, "both.h"), "#pragma once\n");
    writeFileSync(join(sourceRoot, "both.h"), "#pragma once\n");
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const out = await runCppFindSymbol(sessions, {
      projectRoot: buildRoot,
      name: "Widget",
      file: "both.h",
      sourceRoots: [sourceRoot],
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("pass an absolute path");
  });

  it("cpp_find_derived_classes sweeps the source root's TU for a relative `files` entry", async () => {
    const file = join(sourceRoot, "widget.cpp");
    writeFileSync(file, "class Widget : public Base {};\n");
    const seenTus: string[] = [];
    const exec: ClangQueryExecFn = async (args) => {
      seenTus.push(args[2] as string);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const out = await runCppFindDerivedClasses(
      { exec, cache: new SweepCache() },
      { projectRoot: buildRoot, qualifiedName: "Base", files: ["widget.cpp"], sourceRoots: [sourceRoot] },
    );
    expect(out.isError).toBeFalsy();
    expect(seenTus).toEqual([file]);
  });

  it("cpp_find_derived_classes asks for an absolute path when a relative `files` entry exists under both roots", async () => {
    writeFileSync(join(buildRoot, "widget.cpp"), "class InBuild : public Base {};\n");
    writeFileSync(join(sourceRoot, "widget.cpp"), "class InSource : public Base {};\n");
    const out = await runCppFindDerivedClasses(
      { exec: cleanExec, cache: new SweepCache() },
      { projectRoot: buildRoot, qualifiedName: "Base", files: ["widget.cpp"], sourceRoots: [sourceRoot] },
    );
    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).toContain(join(buildRoot, "widget.cpp"));
    expect(text).toContain(join(sourceRoot, "widget.cpp"));
    expect(text).toContain("pass an absolute path");
  });

  it("cpp_find_symbol returns the symbol from a relative file that exists only under a source root", async () => {
    const file = join(sourceRoot, "widget.h");
    writeFileSync(file, "class Widget {};\n");
    const sessions = sessionsFor(fakeProcessByFile((f) => (f === file ? [sym("Widget", 5)] : [])));
    const out = await runCppFindSymbol(sessions, {
      projectRoot: buildRoot,
      name: "Widget",
      file: "widget.h",
      sourceRoots: [sourceRoot],
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ name: "Widget", kind: "class", file });
  });

  it("matches ignoredPaths against the root that won the resolution, not against projectRoot", async () => {
    // The pattern is written relative to the source root the
    // candidate resolved under. Keyed off projectRoot the same relative path would start with ".." and
    // an ignored subtree of a source root could never be refused.
    writeFileSync(join(buildRoot, "mcp-code-nav.config.json"), JSON.stringify({ ignoredPaths: ["vendor/*"] }));
    mkdirSync(join(sourceRoot, "vendor"));
    const file = join(sourceRoot, "vendor", "widget.h");
    writeFileSync(file, "class Widget {};\n");
    const sessions = sessionsFor(fakeProcessByFile((f) => (f === file ? [sym("Widget", 5)] : [])));
    const out = await runCppFindSymbol(sessions, {
      projectRoot: buildRoot,
      name: "Widget",
      file: join("vendor", "widget.h"),
      sourceRoots: [sourceRoot],
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("ignoredPaths");
    expect(out.content[0]?.text).toContain(file);
  });
});

describe("file/files parameter descriptions name every declared root", () => {
  const fields: readonly [string, string | undefined][] = [
    ["cpp_file_symbols.file", CppFileSymbolsInput.shape.file.description],
    ["cpp_find_symbol.file", CppFindSymbolInput.shape.file.description],
    ["cpp_find_derived_classes.files", CppFindDerivedClassesInput.shape.files.description],
  ];

  it.each(fields)("%s states the multi-root rule instead of pointing only at projectRoot", (_name, described) => {
    expect(described).toContain("resolved against projectRoot and each sourceRoots entry");
    expect(described).toContain("must exist under exactly one of them");
    expect(described).not.toContain("relative to projectRoot");
  });

  it("sourceRoots still says these are absolute directories besides projectRoot, and what omitting it means", () => {
    const described = CppFileSymbolsInput.shape.sourceRoots.description;
    expect(described).toContain("Absolute directories");
    expect(described).toContain("besides projectRoot");
    expect(described).toContain("Omitted or empty: the source tree derived from compile_commands.json.");
  });
});
