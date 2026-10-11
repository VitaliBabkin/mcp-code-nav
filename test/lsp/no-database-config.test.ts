import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clangdConfig, clangdNoDatabaseConfig } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { fakeServer } from "../helpers/fake-lsp.js";

// the session that outlines a file when projectRoot holds no compile database.

describe("clangdNoDatabaseConfig", () => {
  it("is clangd under its own session kind, so start errors and the server-unavailable anchor are unchanged", () => {
    expect(clangdNoDatabaseConfig.id).toBe("clangd");
    expect(clangdNoDatabaseConfig.sessionKind).toBe("clangd-no-db");
    expect(clangdConfig.sessionKind).toBeUndefined();
    expect(clangdNoDatabaseConfig.command).toBe(clangdConfig.command);
    expect(clangdNoDatabaseConfig.commandEnvOverride).toBe(clangdConfig.commandEnvOverride);
    expect(clangdNoDatabaseConfig.installHint).toBe(clangdConfig.installHint);
  });

  it("starts clangd with background indexing off, so nothing is written under projectRoot", () => {
    expect(clangdNoDatabaseConfig.argv("/p")).toEqual([
      "--compile-commands-dir=/p",
      "--background-index=false",
      "--log=error",
    ]);
  });

  it("admits only the lifecycle and the outline", () => {
    expect([...clangdNoDatabaseConfig.allowedRequests].sort()).toEqual([
      "initialize",
      "shutdown",
      "textDocument/documentSymbol",
    ]);
  });

  it("keeps the cold-empty proof, and has no index to diff", () => {
    expect(clangdNoDatabaseConfig.documentSymbolNeedsWarmth).toBe(true);
    expect(clangdNoDatabaseConfig.indexSnapshot).toBeUndefined();
  });

  it("leaves the database-backed config as it was", () => {
    expect(clangdConfig.argv("/p")).toEqual(["--compile-commands-dir=/p", "--background-index=true", "--log=error"]);
    expect(clangdConfig.allowedRequests.has("workspace/symbol")).toBe(true);
    expect(clangdConfig.indexSnapshot).toBeDefined();
  });
});

describe("the session key", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-code-nav-nodb-key-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the two clangd sessions of one root apart, and each one stable", async () => {
    const spawn = vi.fn(() => fakeServer().process);
    const manager = new LspSessionManager({ spawn, sleep: async () => {}, readFile: () => "x" });

    const normal = manager.get(root, clangdConfig);
    const degraded = manager.get(root, clangdNoDatabaseConfig);

    expect(degraded).not.toBe(normal);
    expect(manager.get(root, clangdNoDatabaseConfig)).toBe(degraded);
    expect(manager.get(root, clangdConfig)).toBe(normal);
    await normal.documentSymbol(join(root, "a.cpp"));
    await degraded.documentSymbol(join(root, "a.cpp"));
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
