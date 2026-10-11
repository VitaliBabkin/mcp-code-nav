import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LspProcess } from "../../src/lsp/process.js";
import { clangdNoDatabaseConfig } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";
import { runCppFindCallers } from "../../src/tools/cpp-find-callers.js";
import { runCppFindReferences } from "../../src/tools/cpp-find-references.js";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import type { CppAddress } from "../../src/tools/cpp-navigation-shared.js";
import { fakeProcessByFile, symAt } from "../helpers/fake-clangd.js";

const DB = "compile_commands.json";
const headAt = (projectRoot: string): string => `compile_commands.json not found or unreadable at "${projectRoot}"`;

interface Answer {
  isError?: boolean;
  content: readonly { text?: string }[];
}

const textOf = (answer: Answer): string => answer.content[0]?.text ?? "";

const prefixFor = (tool: string): string => `${tool} failed: `;

/**
 * The rule for every clangd-backed tool: the compile database is proven readable before a
 * session exists. `cpp_find_symbol`, `cpp_find_references` and `cpp_find_callers` answer the same refusal and none
 * of them spawns first; `cpp_file_symbols` outlines from a default-flags parse instead.
 */
describe("the C++ tools' compile-database pre-check", () => {
  let repoRoot: string;
  let buildDir: string;
  let srcDir: string;
  let widget: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-precheck-"));
    buildDir = join(repoRoot, "build");
    srcDir = join(repoRoot, "src");
    widget = join(srcDir, "widget.cpp");
    mkdirSync(buildDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(widget, "class Widget {};\n");
    writeFileSync(join(buildDir, DB), JSON.stringify([{ directory: srcDir, file: widget }]));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A clangd whose spawn is recorded, so a case can prove the refusal happened before any child started. */
  function watchedSessions(): { sessions: LspSessionManager; spawn: ReturnType<typeof vi.fn> } {
    const clangd: LspProcess = fakeProcessByFile(() => [symAt("Widget", 5, 0, 6)]);
    const spawn = vi.fn(() => clangd);
    return { sessions: new LspSessionManager({ spawn, sleep: async () => {} }), spawn };
  }

  const address = (projectRoot: string): CppAddress => ({ projectRoot, name: "Widget", sourceRoots: [srcDir] });

  const tools: readonly { readonly tool: string; readonly ask: (sessions: LspSessionManager, root: string) => Promise<Answer> }[] = [
    {
      tool: "cpp_file_symbols",
      ask: (sessions, root) => runCppFileSymbols(sessions, { projectRoot: root, file: widget, sourceRoots: [srcDir], depth: 1 }),
    },
    { tool: "cpp_find_symbol", ask: (sessions, root) => runCppFindSymbol(sessions, address(root)) },
    { tool: "cpp_find_references", ask: (sessions, root) => runCppFindReferences(sessions, address(root) as never) },
    { tool: "cpp_find_callers", ask: (sessions, root) => runCppFindCallers(sessions, address(root) as never) },
  ];

  const refusing = tools.filter(({ tool }) => tool !== "cpp_file_symbols");

  for (const { tool, ask } of refusing) {
    it(`${tool} names the nearest build directory and starts no clangd`, async () => {
      const { sessions, spawn } = watchedSessions();

      const out = await ask(sessions, repoRoot);

      expect(out.isError).toBe(true);
      expect(textOf(out)).toBe(
        `${prefixFor(tool)}${headAt(repoRoot)}. Directories under it that hold a compile_commands.json, ` +
          `nearest first: "${buildDir}". Pass one of them as projectRoot.`,
      );
      expect(spawn).not.toHaveBeenCalled();
    });

    it(`${tool} states a database that is present but unreadable, and starts no clangd`, async () => {
      // A directory wearing the database's name is the portable way to make a present file unreadable. The
      // build directory stays where it is: this text must be variant 4, not the candidate list.
      mkdirSync(join(repoRoot, DB));
      const { sessions, spawn } = watchedSessions();

      const out = await ask(sessions, repoRoot);

      expect(out.isError).toBe(true);
      expect(textOf(out)).toBe(`${prefixFor(tool)}${headAt(repoRoot)}. The file is present but could not be read.`);
      expect(spawn).not.toHaveBeenCalled();
    });
  }

  for (const { tool, ask } of tools) {
    it(`${tool} still asks clangd when the database is there to be read`, async () => {
      const { sessions, spawn } = watchedSessions();

      const out = await ask(sessions, buildDir);

      expect(textOf(out)).not.toContain("compile_commands.json not found or unreadable");
      expect(spawn).toHaveBeenCalled();
    });
  }

  it("cpp_file_symbols outlines the repository root's file from a default-flags parse, naming the build directory", async () => {
    const { sessions, spawn } = watchedSessions();

    const out = await runCppFileSymbols(sessions, { projectRoot: repoRoot, file: widget, sourceRoots: [srcDir], depth: 1 });

    expect(out.isError).toBeUndefined();
    const summary = (out as unknown as { structuredContent: { summary: string } }).structuredContent.summary;
    expect(summary).toContain(
      `${headAt(repoRoot)}. Directories under it that hold a compile_commands.json, nearest first: "${buildDir}".`,
    );
    expect(spawn).toHaveBeenCalledWith(repoRoot, clangdNoDatabaseConfig);
  });

  it("cpp_file_symbols states a database that is present but unreadable in the same summary", async () => {
    mkdirSync(join(repoRoot, DB));
    const { sessions } = watchedSessions();

    const out = await runCppFileSymbols(sessions, { projectRoot: repoRoot, file: widget, sourceRoots: [srcDir], depth: 1 });

    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toContain(`${headAt(repoRoot)}. The file is present but could not be read.`);
  });

  it("refuses the root before it resolves the file, so a wrong root reads as a wrong root", async () => {
    const { sessions, spawn } = watchedSessions();

    const out = await runCppFindSymbol(sessions, {
      projectRoot: repoRoot,
      name: "Widget",
      file: "../outside.cpp",
      sourceRoots: [srcDir],
    });

    expect(textOf(out)).toContain("Pass one of them as projectRoot");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("answers the hinted directory instead, which is the way out the text exists to give", async () => {
    const { sessions } = watchedSessions();
    const refused = await runCppFindSymbol(sessions, address(repoRoot));
    const named = /nearest first: "([^"]+)"/.exec(textOf(refused))?.[1];
    expect(named).toBe(buildDir);

    const { sessions: next, spawn } = watchedSessions();
    const out = await runCppFindSymbol(next, { ...address(named ?? buildDir), file: widget });

    expect(out.isError, textOf(out)).toBeFalsy();
    expect(spawn).toHaveBeenCalled();
  });

  it("refuses a projectRoot that is not a directory at all, instead of spawning on it", async () => {
    const notADirectory = join(repoRoot, "a-file");
    writeFileSync(notADirectory, "class NotADirectory {};\n");
    const { sessions, spawn } = watchedSessions();

    const out = await runCppFindSymbol(sessions, address(notADirectory));

    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("compile_commands.json not found or unreadable");
    expect(textOf(out)).toContain("so nothing below it was searched");
    expect(spawn).not.toHaveBeenCalled();
  });
});
