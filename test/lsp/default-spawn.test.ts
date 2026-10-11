import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSpawnLsp } from "../../src/lsp/process.js";
import { clangdConfig, LanguageServerUnavailableError } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";

/**
 * These run the REAL `defaultSpawnLsp` against a binary that does not exist, so nothing here is
 * mocked at the process boundary: the defect this pins is vscode-jsonrpc's own write failing on a
 * stdin that was never opened, which no fake can reproduce.
 */
const originalOverride = process.env.MCP_CODE_NAV_CLANGD;
const rejections: unknown[] = [];
const collect = (reason: unknown): void => {
  rejections.push(reason);
};

let root: string;
let missing: string;

beforeEach(() => {
  process.on("unhandledRejection", collect);
  root = mkdtempSync(join(tmpdir(), "mcp-code-nav-spawn-"));
  writeFileSync(join(root, "a.cpp"), "class Foo {};\n");
  missing = join(root, process.platform === "win32" ? "no-such-clangd.exe" : "no-such-clangd");
  process.env.MCP_CODE_NAV_CLANGD = missing;
});

afterEach(() => {
  process.off("unhandledRejection", collect);
  if (originalOverride === undefined) delete process.env.MCP_CODE_NAV_CLANGD;
  else process.env.MCP_CODE_NAV_CLANGD = originalOverride;
  rmSync(root, { recursive: true, force: true });
});

/** The failed write is reported by Node on a later turn of the loop, so a rejection needs room to land. */
const drain = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("defaultSpawnLsp against a binary that is not there", () => {
  it("rejects the first write with LanguageServerUnavailableError and leaves no unhandled rejection", async () => {
    const proc = defaultSpawnLsp(root, clangdConfig);
    await expect(proc.connection.sendRequest("initialize", {})).rejects.toBeInstanceOf(
      LanguageServerUnavailableError,
    );
    await drain();
    expect(rejections).toEqual([]);
    expect(proc.isAlive()).toBe(false);
    expect(proc.spawnFailure()).toBeInstanceOf(LanguageServerUnavailableError);
    proc.kill();
  });

  it("keeps a tool call failing as that error across the session's respawn-and-retry path", async () => {
    const session = new LspSession({ root, config: clangdConfig });
    await expect(session.documentSymbol(join(root, "a.cpp"))).rejects.toBeInstanceOf(
      LanguageServerUnavailableError,
    );
    await drain();
    expect(rejections).toEqual([]);
    session.dispose();
  });

  it("refuses a repeated call the same way, without accumulating crashes", async () => {
    const session = new LspSession({ root, config: clangdConfig });
    const first = await session.documentSymbol(join(root, "a.cpp")).catch((e: unknown) => e);
    const second = await session.documentSymbol(join(root, "a.cpp")).catch((e: unknown) => e);
    await drain();
    expect(first).toBeInstanceOf(LanguageServerUnavailableError);
    expect(second).toBeInstanceOf(LanguageServerUnavailableError);
    if (first instanceof LanguageServerUnavailableError && second instanceof LanguageServerUnavailableError) {
      expect(first.message).toBe(second.message);
      expect(first.attempted).toBe(missing);
    }
    expect(rejections).toEqual([]);
    session.dispose();
  });
});
