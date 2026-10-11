import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LspDocumentSymbol, OutlineSymbol } from "../../src/clangd/outline.js";
import { LanguageServerUnavailableError, goplsConfig } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { GoFileSymbolsInput, runGoFileSymbols } from "../../src/tools/go-file-symbols.js";
import { fakeServer, type FakeServer } from "../helpers/fake-lsp.js";

const STORAGE: LspDocumentSymbol = {
  name: "Storage",
  kind: 11,
  range: { start: { line: 13 }, end: { line: 17 } },
  selectionRange: { start: { line: 13, character: 5 } },
  children: [{ name: "Get", kind: 6, range: { start: { line: 14 }, end: { line: 14 } } }],
};

const OUTLINE: OutlineSymbol = {
  name: "Storage",
  kind: "interface",
  range: { startLine: 14, endLine: 18 },
  children: [{ name: "Get", kind: "method", range: { startLine: 15, endLine: 15 } }],
};

type Input = { sourceRoots: string[]; file: string; depth: number; timeBudgetMs: number };

function input(partial: Pick<Input, "sourceRoots" | "file"> & Partial<Input>): Input {
  return { depth: 1, timeBudgetMs: 60_000, ...partial };
}

/** A session manager whose gopls answers `documentSymbol` with `symbols`, counting each child started. */
function sessionsAnswering(symbols: () => LspDocumentSymbol[]): { manager: LspSessionManager; servers: FakeServer[] } {
  const servers: FakeServer[] = [];
  const manager = new LspSessionManager({
    spawn: () => {
      const server = fakeServer({
        respond: (method) => (method === "textDocument/documentSymbol" ? symbols() : {}),
      });
      servers.push(server);
      return server.process;
    },
    sleep: async () => {},
  });
  return { manager, servers };
}

describe("go_file_symbols input schema", () => {
  it("requires at least one sourceRoots entry, because there is no projectRoot to fall back to", () => {
    expect(GoFileSymbolsInput.safeParse({ sourceRoots: [], file: "a.go" }).success).toBe(false);
    expect(GoFileSymbolsInput.safeParse({ file: "a.go" }).success).toBe(false);
    expect(GoFileSymbolsInput.safeParse({ sourceRoots: ["/repo"], file: "a.go" }).success).toBe(true);
  });

  it("defaults depth to 1 and timeBudgetMs to 60000, and refuses a budget past the ceiling", () => {
    const parsed = GoFileSymbolsInput.parse({ sourceRoots: ["/repo"], file: "a.go" });
    expect(parsed.depth).toBe(1);
    expect(parsed.timeBudgetMs).toBe(60_000);
    const overCeiling = GoFileSymbolsInput.safeParse({
      sourceRoots: ["/repo"],
      file: "a.go",
      timeBudgetMs: 600_001,
    });
    expect(overCeiling.success).toBe(false);
  });
});

describe("runGoFileSymbols", () => {
  let tmp: string;
  let mod: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-gofsyn-"));
    mod = join(tmp, "mod");
    mkdirSync(mod, { recursive: true });
    writeFileSync(join(mod, "go.mod"), "module example.com/mod\n");
    writeFileSync(join(mod, "storage.go"), "package mod\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the outline with 1-based lines, in the same shape cpp_file_symbols emits", async () => {
    const { manager } = sessionsAnswering(() => [STORAGE]);
    const out = await runGoFileSymbols(manager, input({ sourceRoots: [mod], file: join(mod, "storage.go") }));
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toEqual({ symbols: [OUTLINE] });
  });

  it("roots gopls at the module containing the file, and opens the file with go's languageId", async () => {
    const nested = join(mod, "internal", "pkg");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "b.go"), "package pkg\n");
    const { manager, servers } = sessionsAnswering(() => [STORAGE]);
    const out = await runGoFileSymbols(manager, input({ sourceRoots: [mod], file: join(nested, "b.go") }));
    expect(out.isError).toBeFalsy();
    expect(servers[0]?.requests[0]?.[1]).toMatchObject({ rootUri: pathToFileURL(resolve(mod)).toString() });
    const didOpen = servers[0]?.notifications.find(([method]) => method === "textDocument/didOpen");
    expect(didOpen?.[1]).toMatchObject({ textDocument: { languageId: "go" } });
  });

  it("counts depth plainly: 0 returns top-level declarations without their children", async () => {
    const { manager } = sessionsAnswering(() => [STORAGE]);
    const out = await runGoFileSymbols(manager, input({ sourceRoots: [mod], file: "storage.go", depth: 0 }));
    expect(out.structuredContent).toEqual({
      symbols: [{ name: "Storage", kind: "interface", range: { startLine: 14, endLine: 18 } }],
    });
  });

  it("reports a confident empty for an empty outline, because gopls answers it correctly from the first call", async () => {
    const { manager } = sessionsAnswering(() => []);
    const out = await runGoFileSymbols(manager, input({ sourceRoots: [mod], file: join(mod, "storage.go") }));
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toEqual({ symbols: [] });
  });

  it("fails with gopls's own unavailability text, naming the override variable and the install command", async () => {
    const failure = new LanguageServerUnavailableError(
      { config: goplsConfig, attempted: "gopls", fromOverride: false },
      { code: "ENOENT" },
    );
    const server = fakeServer({
      respond: () => {
        throw new Error("connection got disposed");
      },
      failure: () => failure,
    });
    const manager = new LspSessionManager({ spawn: () => server.process, sleep: async () => {} });
    const out = await runGoFileSymbols(manager, input({ sourceRoots: [mod], file: join(mod, "storage.go") }));
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain(failure.message);
    expect(out.content[0]?.text).toContain("was not found (ENOENT)");
    expect(out.content[0]?.text).toContain("MCP_CODE_NAV_GOPLS");
    expect(out.content[0]?.text).toContain("go install golang.org/x/tools/gopls@latest");
  });

  it("fails rather than answering when no go.mod exists above the file, without starting a child", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "a.go"), "package a\n");
    const { manager, servers } = sessionsAnswering(() => [STORAGE]);
    const out = await runGoFileSymbols(manager, input({ sourceRoots: [plain], file: join(plain, "a.go") }));
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toMatch(/not inside a Go module/);
    expect(out.content[0]?.text).toContain(plain);
    expect(servers).toHaveLength(0);
  });

  it("fails when the module sits outside every declared root, naming the go.mod and the roots", async () => {
    // `mod` holds the go.mod; the caller declared only its subdirectory, so the file is inside the
    // boundary while the module that governs it is not.
    const pkg = join(mod, "pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "a.go"), "package pkg\n");
    const { manager } = sessionsAnswering(() => [STORAGE]);
    const out = await runGoFileSymbols(manager, input({ sourceRoots: [pkg], file: join(pkg, "a.go") }));
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toMatch(/outside every declared sourceRoots entry/);
    expect(out.content[0]?.text).toContain(resolve(mod));
    expect(out.content[0]?.text).toContain(resolve(pkg));
  });

  it("fails within the caller's budget when gopls is still loading the module", async () => {
    const manager = new LspSessionManager({
      spawn: () =>
        fakeServer({
          respond: (method) =>
            method === "textDocument/documentSymbol" ? new Promise<LspDocumentSymbol[]>(() => {}) : {},
        }).process,
      sleep: async () => {},
    });
    const out = await runGoFileSymbols(
      manager,
      input({ sourceRoots: [mod], file: join(mod, "storage.go"), timeBudgetMs: 30 }),
    );
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toMatch(/did not answer[\s\S]*30 ms budget/);
    expect(out.content[0]?.text).toMatch(/do not read this as an empty file/);
  });

  it("rejects a file outside every declared root before any disk access, as the C++ tools do", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "mcp-code-nav-gofsyn-out-"));
    try {
      writeFileSync(join(elsewhere, "a.go"), "package a\n");
      writeFileSync(join(elsewhere, "go.mod"), "module example.com/outside\n");
      const { manager } = sessionsAnswering(() => [STORAGE]);
      const out = await runGoFileSymbols(manager, input({ sourceRoots: [mod], file: join(elsewhere, "a.go") }));
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toMatch(/escapes every declared root/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("resolves a relative file against the declared roots", async () => {
    const { manager } = sessionsAnswering(() => [STORAGE]);
    const out = await runGoFileSymbols(manager, input({ sourceRoots: [mod], file: "storage.go" }));
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toEqual({ symbols: [OUTLINE] });
  });

  it("keeps a missing file the loud failure it is", async () => {
    const { manager } = sessionsAnswering(() => [STORAGE]);
    const out = await runGoFileSymbols(manager, input({ sourceRoots: [mod], file: join(mod, "gone.go") }));
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toMatch(/ENOENT/);
  });
});
