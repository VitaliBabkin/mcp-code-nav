import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { classifyError } from "../../src/call-log/error-class.js";
import { describeMissingCompileDb } from "../../src/clang-query/compile-db-hint.js";
import type { LspProcess } from "../../src/lsp/process.js";
import { clangdConfig, clangdNoDatabaseConfig, type LanguageServerConfig } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";
import { runCppFindCallers } from "../../src/tools/cpp-find-callers.js";
import { runCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";
import { runCppFindReferences } from "../../src/tools/cpp-find-references.js";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { noopServerHandlers } from "../helpers/fake-clangd.js";

// `cpp_file_symbols` outlines from a default-flags parse when projectRoot holds no database,
// and says so; an empty parse proves nothing; the other four C++ tools keep refusing.

const SUMMARY_HEAD =
  "Parsed without a compile database: clangd used default flags, with no include paths or defines from a build, " +
  "so a declaration hidden behind a macro or a missing header may be absent or misnamed. ";

const widget: LspDocumentSymbol[] = [{ name: "Widget", kind: 5, range: { start: { line: 0 }, end: { line: 0 } } }];

interface Result {
  readonly isError?: boolean;
  readonly content: readonly { readonly text?: string }[];
  readonly structuredContent?: unknown;
}
const textOf = (result: Result): string => result.content[0]?.text ?? "";

describe("cpp_file_symbols without a compile database", () => {
  let base: string;
  let projectRoot: string;
  let spawned: { root: string; config: LanguageServerConfig }[];
  let answer: () => LspDocumentSymbol[] | null;
  let sessions: LspSessionManager;
  let requests: string[];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mcp-code-nav-degraded-"));
    projectRoot = join(base, "proj");
    mkdirSync(projectRoot);
    mkdirSync(join(base, "src"));
    writeFileSync(join(projectRoot, "a.cpp"), "class Widget {};\n");
    writeFileSync(join(projectRoot, "a.h"), "class Widget {};\n");
    writeFileSync(join(base, "src", "b.cpp"), "class Widget {};\n");
    spawned = [];
    requests = [];
    answer = () => widget;
    const process: LspProcess = {
      connection: {
        sendRequest: vi.fn(async (method: string) => {
          requests.push(method);
          if (method === "initialize") return {};
          if (method === "textDocument/documentSymbol") return answer();
          throw new Error(`unexpected request: ${method}`);
        }),
        sendNotification: vi.fn(async () => {}),
        ...noopServerHandlers(),
      } as unknown as LspProcess["connection"],
      isAlive: () => true,
      kill: () => {},
      spawnFailure: () => undefined,
    };
    sessions = new LspSessionManager({
      spawn: (root, config) => {
        spawned.push({ root, config });
        return process;
      },
      sleep: async () => {},
    });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const outline = (file: string, extra: Record<string, unknown> = {}) =>
    runCppFileSymbols(sessions, { projectRoot, file, depth: 1, ...extra } as never);

  it("answers a non-empty outline as a success, summary first, with the limit code", async () => {
    const missing = await describeMissingCompileDb(projectRoot);

    const result = await outline("a.cpp");

    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.structuredContent).startsWith('{"summary":"Parsed without a compile database:')).toBe(
      true,
    );
    expect(result.structuredContent).toEqual({
      summary: SUMMARY_HEAD + missing,
      symbols: [{ name: "Widget", kind: "class", range: { startLine: 1, endLine: 1 } }],
      scope: { projectRoot, limits: ["parsed-without-compile-database"] },
    });
    expect(Object.keys(result.structuredContent as object)).toEqual(["summary", "symbols", "scope"]);
    expect(textOf(result)).toBe(SUMMARY_HEAD + missing);
  });

  it("answers a depth-0 outline, whose empty check and truncation agree", async () => {
    answer = () => [{ ...widget[0]!, children: [{ name: "value", kind: 6, range: widget[0]!.range }] }];

    const top = await outline("a.cpp", { depth: 0 });
    const nested = await outline("a.h", { depth: 1 });

    const symbolsOf = (result: Result): { name: string; children?: unknown[] }[] =>
      (result.structuredContent as { symbols: { name: string; children?: unknown[] }[] }).symbols;
    expect(top.isError).toBeUndefined();
    expect(symbolsOf(top)).toEqual([{ name: "Widget", kind: "class", range: { startLine: 1, endLine: 1 } }]);
    expect(symbolsOf(nested)[0]?.children).toHaveLength(1);
  });

  it("outlines a header the same way", async () => {
    const result = await outline("a.h");

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { scope: { limits: string[] } }).scope.limits).toEqual([
      "parsed-without-compile-database",
    ]);
  });

  it("asks only the no-database session, and only for the outline", async () => {
    await outline("a.cpp");

    expect(spawned).toEqual([{ root: projectRoot, config: clangdNoDatabaseConfig }]);
    expect(requests).toEqual(["initialize", "textDocument/documentSymbol"]);
  });

  it("starts the database-backed session on the next call once a database exists", async () => {
    await outline("a.cpp");
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }]),
    );

    const result = await outline("a.cpp");

    expect(spawned.map((one) => one.config)).toEqual([clangdNoDatabaseConfig, clangdConfig]);
    expect(result.structuredContent).toEqual({
      symbols: [{ name: "Widget", kind: "class", range: { startLine: 1, endLine: 1 } }],
    });
  });

  it("leaves the database-backed answer with no summary and no scope", async () => {
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "a.cpp" }]),
    );

    const result = await outline("a.cpp");

    expect(Object.keys(result.structuredContent as object)).toEqual(["symbols"]);
  });

  it("is an error, classed compile-db-missing, when the parse found nothing (cold-empty)", async () => {
    answer = () => [];
    const missing = await describeMissingCompileDb(projectRoot);

    const result = await outline("a.cpp");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `${missing} Without it, a default-flags parse of "${join(projectRoot, "a.cpp")}" found no symbols, which ` +
        "does not show the file is empty.",
    );
    expect(classifyError(textOf(result)).errorClass).toBe("compile-db-missing");
  });

  it("is the same error when the process is already warm and the parse is empty", async () => {
    await outline("a.cpp");
    answer = () => [];

    const result = await outline("a.h");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `${await describeMissingCompileDb(projectRoot)} Without it, a default-flags parse of ` +
        `"${join(projectRoot, "a.h")}" found no symbols, which does not show the file is empty.`,
    );
    expect(result.structuredContent).toBeUndefined();
  });

  it("keeps variant 3's error for a projectRoot that does not exist, and starts nothing", async () => {
    const gone = join(base, "gone");

    const result = await runCppFileSymbols(sessions, { projectRoot: gone, file: "a.cpp", depth: 1 } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(await describeMissingCompileDb(gone));
    expect(textOf(result)).toContain("That directory does not exist.");
    expect(spawned).toEqual([]);
  });

  it("keeps the error for a projectRoot that is a file", async () => {
    const result = await runCppFileSymbols(sessions, { projectRoot: join(projectRoot, "a.cpp"), file: "a.cpp", depth: 1 } as never);

    expect(result.isError).toBe(true);
    expect(spawned).toEqual([]);
  });

  it("also outlines when the database is present but unreadable (a directory wearing its name)", async () => {
    mkdirSync(join(projectRoot, "compile_commands.json"));

    const result = await outline("a.cpp");

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { summary: string }).summary).toContain("The file is present but could not be read.");
  });

  it("resolves the file against projectRoot and the declared roots only, deriving nothing", async () => {
    const outside = join(base, "src", "b.cpp");

    const refused = await outline(outside);
    const declared = await outline(outside, { sourceRoots: [join(base, "src")] });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("escapes every declared root");
    expect(textOf(refused).endsWith(`sourceRoots: [${JSON.stringify(base)}].`)).toBe(true);
    expect(declared.isError).toBeUndefined();
  });

  it("names the search boundary for a file that does not exist", async () => {
    const result = await outline("missing.cpp");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Only projectRoot was searched");
  });

  it("does not outline an ignored path", async () => {
    writeFileSync(join(projectRoot, "mcp-code-nav.config.json"), JSON.stringify({ ignoredPaths: ["a.cpp"] }));

    const result = await outline("a.cpp");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ignoredPaths");
    expect(spawned).toEqual([]);
  });
});

describe("the other four C++ tools without a compile database", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-code-nav-degraded-refuse-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keep the missing-database error and start no clangd", async () => {
    const spawn = vi.fn();
    const sessions = new LspSessionManager({ spawn, sleep: async () => {} });
    const head = await describeMissingCompileDb(root);

    const results = [
      await runCppFindSymbol(sessions, { projectRoot: root, name: "Widget", file: "a.cpp" } as never),
      await runCppFindReferences(sessions, { projectRoot: root, name: "Widget" } as never),
      await runCppFindCallers(sessions, { projectRoot: root, name: "Widget" } as never),
      await runCppFindDerivedClasses(
        { cache: new SweepCache() },
        { projectRoot: root, qualifiedName: "Widget" } as never,
      ),
    ];

    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(head);
      expect("structuredContent" in result).toBe(false);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
