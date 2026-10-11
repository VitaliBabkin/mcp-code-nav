import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LspProcess } from "../../src/lsp/process.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { noopServerHandlers } from "../helpers/fake-clangd.js";
import { runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";

function fakeProcess(onDocumentSymbol: () => LspDocumentSymbol[] | null): LspProcess {
  return {
    connection: {
      sendRequest: vi.fn(async (method: string) => {
        if (method === "initialize") return {};
        if (method === "textDocument/documentSymbol") return onDocumentSymbol();
        throw new Error(`unexpected request: ${method}`);
      }),
      sendNotification: vi.fn(async () => {}),
      ...noopServerHandlers(),
    } as unknown as LspProcess["connection"],
    isAlive: () => true,
    kill: () => {},
    spawnFailure: () => undefined,
  };
}

describe("runCppFileSymbols", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-gfs-"));
    writeFileSync(join(projectRoot, "a.cpp"), "class Foo {};\n");
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }]),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns isError when projectRoot does not exist, and starts no clangd", async () => {
    const spawn = vi.fn();
    const sessions = new LspSessionManager({ spawn, sleep: async () => {} });
    const gone = join(projectRoot, "gone");
    const out = await runCppFileSymbols(sessions, { projectRoot: gone, file: "a.cpp", depth: 1 });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("That directory does not exist.");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("outlines without a compile database, naming the build directory that holds one when given a repository root", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-repo-"));
    try {
      mkdirSync(join(repoRoot, "build"), { recursive: true });
      writeFileSync(join(repoRoot, "a.cpp"), "class Foo {};\n");
      writeFileSync(
        join(repoRoot, "build", "compile_commands.json"),
        JSON.stringify([{ directory: repoRoot, file: "a.cpp" }]),
      );
      const process = fakeProcess(() => [{ name: "Foo", kind: 5, range: { start: { line: 0 }, end: { line: 0 } } }]);
      const sessions = new LspSessionManager({ spawn: () => process, sleep: async () => {} });

      const out = await runCppFileSymbols(sessions, { projectRoot: repoRoot, file: "a.cpp", depth: 1 });

      expect(out.isError).toBeUndefined();
      // The text, unchanged, is what the degraded summary carries after its own first sentence.
      expect(out.content[0]?.text).toBe(
        "Parsed without a compile database: clangd used default flags, with no include paths or defines from a build, " +
          "so a declaration hidden behind a macro or a missing header may be absent or misnamed. " +
          `compile_commands.json not found or unreadable at "${repoRoot}". Directories under it that hold a ` +
          `compile_commands.json, nearest first: "${join(repoRoot, "build")}". Pass one of them as projectRoot.`,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns isError when file escapes projectRoot", async () => {
    const sessions = new LspSessionManager({ sleep: async () => {} });
    const out = await runCppFileSymbols(sessions, { projectRoot, file: "../outside.cpp", depth: 1 });
    expect(out.isError).toBe(true);
  });

  it("returns isError when the file matches ignoredPaths", async () => {
    writeFileSync(join(projectRoot, "mcp-code-nav.config.json"), JSON.stringify({ ignoredPaths: ["a.cpp"] }));
    const sessions = new LspSessionManager({ sleep: async () => {} });
    const out = await runCppFileSymbols(sessions, { projectRoot, file: "a.cpp", depth: 1 });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("ignoredPaths");
  });

  it("returns the outline, 1-based lines, on a successful symbol response", async () => {
    const process = fakeProcess(() => [{ name: "Foo", kind: 5, range: { start: { line: 0 }, end: { line: 0 } } }]);
    const sessions = new LspSessionManager({ spawn: () => process, sleep: async () => {} });
    const out = await runCppFileSymbols(sessions, { projectRoot, file: "a.cpp", depth: 1 });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toEqual({
      symbols: [{ name: "Foo", kind: "class", range: { startLine: 1, endLine: 1 } }],
    });
  });

  it("returns isError, naming the cold-index state, instead of a confident empty on first use", async () => {
    const process = fakeProcess(() => []);
    const sessions = new LspSessionManager({ spawn: () => process, sleep: async () => {} });
    const out = await runCppFileSymbols(sessions, { projectRoot, file: "a.cpp", depth: 1 });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("not yet confirmed warm");
  });

  it("returns isError instead of throwing when mcp-code-nav.config.json is malformed", async () => {
    writeFileSync(join(projectRoot, "mcp-code-nav.config.json"), "{ not json");
    const sessions = new LspSessionManager({ sleep: async () => {} });
    await expect(runCppFileSymbols(sessions, { projectRoot, file: "a.cpp", depth: 1 })).resolves.toMatchObject({
      isError: true,
    });
  });
});

describe("runCppFileSymbols with sourceRoots (out-of-tree build layout)", () => {
  let buildRoot: string;
  let sourceRoot: string;

  beforeEach(() => {
    // Mirrors the standard CMake out-of-tree layout: compile_commands.json in a build directory,
    // the actual source tree as a SIBLING, not nested under it.
    buildRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-build-"));
    sourceRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-src-"));
    writeFileSync(join(sourceRoot, "widget.cpp"), "class Widget {};\n");
    writeFileSync(
      join(buildRoot, "compile_commands.json"),
      JSON.stringify([{ directory: sourceRoot, file: "widget.cpp" }]),
    );
  });

  afterEach(() => {
    rmSync(buildRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("resolves a file inside a declared sourceRoots entry, outside projectRoot", async () => {
    const process = fakeProcess(() => [{ name: "Widget", kind: 5, range: { start: { line: 0 }, end: { line: 0 } } }]);
    const sessions = new LspSessionManager({ spawn: () => process, sleep: async () => {} });
    const out = await runCppFileSymbols(sessions, {
      projectRoot: buildRoot,
      file: join(sourceRoot, "widget.cpp"),
      sourceRoots: [sourceRoot],
      depth: 1,
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toEqual({
      symbols: [{ name: "Widget", kind: "class", range: { startLine: 1, endLine: 1 } }],
    });
  });

  it("still rejects a file outside every declared root, naming all of them", async () => {
    const sessions = new LspSessionManager({ sleep: async () => {} });
    const elsewhere = mkdtempSync(join(tmpdir(), "mcp-code-nav-elsewhere-"));
    try {
      const out = await runCppFileSymbols(sessions, {
        projectRoot: buildRoot,
        file: join(elsewhere, "x.cpp"),
        sourceRoots: [sourceRoot],
        depth: 1,
      });
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain(buildRoot);
      expect(out.content[0]?.text).toContain(sourceRoot);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("matches an ignoredPaths pattern computed relative to the sourceRoots entry that actually contained the file", async () => {
    // Pattern is written relative to sourceRoot (the vendor dir lives under the SOURCE tree, not the
    // build tree) — this only matches if isIgnoredPath keys off sourceRoot, not always projectRoot.
    writeFileSync(join(buildRoot, "mcp-code-nav.config.json"), JSON.stringify({ ignoredPaths: ["widget.cpp"] }));
    const sessions = new LspSessionManager({ sleep: async () => {} });
    const out = await runCppFileSymbols(sessions, {
      projectRoot: buildRoot,
      file: join(sourceRoot, "widget.cpp"),
      sourceRoots: [sourceRoot],
      depth: 1,
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("ignoredPaths");
  });
});
