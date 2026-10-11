import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clangdConfig, goplsConfig } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { fakeServer } from "../helpers/fake-lsp.js";

/** The same directory spelled the way a caller, a config file, and Windows' case-folding each would. */
function otherSpellings(root: string): string[] {
  const nested = join(root, "sub", "..");
  const trailing = join(root, "");
  return process.platform === "win32" ? [nested, trailing, root.toUpperCase()] : [nested, trailing];
}

describe("LspSessionManager", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-code-nav-key-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("gives every spelling of one root the same session, so one root costs one child", async () => {
    const server = fakeServer();
    const spawn = vi.fn(() => server.process);
    const manager = new LspSessionManager({ spawn, sleep: async () => {}, readFile: () => "x" });

    const session = manager.get(root, clangdConfig);
    for (const spelling of otherSpellings(root)) {
      expect(manager.get(spelling, clangdConfig)).toBe(session);
    }
    await session.documentSymbol(join(root, "a.cpp"));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("keys on the server as well as the root, so one directory can hold one session per language", () => {
    const server = fakeServer();
    const manager = new LspSessionManager({ spawn: () => server.process, sleep: async () => {}, readFile: () => "x" });
    expect(manager.get(root, goplsConfig)).not.toBe(manager.get(root, clangdConfig));
  });

  it("hands the session the resolved root, whatever spelling opened it", async () => {
    const server = fakeServer();
    const manager = new LspSessionManager({ spawn: () => server.process, sleep: async () => {}, readFile: () => "x" });
    manager.get(join(root, "sub", ".."), clangdConfig);
    await manager.get(root, clangdConfig).documentSymbol(join(root, "a.cpp"));
    const initialize = server.requests.find(([method]) => method === "initialize");
    expect(initialize?.[1]).toMatchObject({ rootUri: expect.stringContaining(resolve(root).replace(/\\/g, "/")) });
  });

  it("disposeAll kills every child and forgets every session", async () => {
    const kill = vi.fn();
    const server = fakeServer({ kill });
    const manager = new LspSessionManager({ spawn: () => server.process, sleep: async () => {}, readFile: () => "x" });
    const cpp = manager.get(root, clangdConfig);
    const go = manager.get(root, goplsConfig);
    await cpp.documentSymbol(join(root, "a.cpp"));
    await go.documentSymbol(join(root, "a.go"));

    manager.disposeAll();
    expect(kill).toHaveBeenCalledTimes(2);
    expect(manager.get(root, clangdConfig)).not.toBe(cpp);
  });
});
