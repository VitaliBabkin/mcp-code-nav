import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { attachLifecycleHandlers } from "../../src/lsp/process.js";
import {
  clangdConfig,
  goplsConfig,
  LanguageServerUnavailableError,
  type LanguageServerConfig,
} from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { fakeServer } from "../helpers/fake-lsp.js";

function unavailable(
  config: LanguageServerConfig,
  attempted: string,
  fromOverride: boolean,
  code: string | undefined,
): LanguageServerUnavailableError {
  return new LanguageServerUnavailableError({ config, attempted, fromOverride }, { code });
}

describe("LanguageServerUnavailableError text", () => {
  it("names the override variable and the install hint for an ENOENT through the override", () => {
    const err = unavailable(goplsConfig, "C:\\tools\\go\\bin\\gopls.exe", true, "ENOENT");
    expect(err.message).toContain("MCP_CODE_NAV_GOPLS");
    expect(err.message).toContain("C:\\tools\\go\\bin\\gopls.exe");
    expect(err.message).toContain("go install golang.org/x/tools/gopls@latest");
    expect(err.message).toContain("ENOENT");
    expect(err.message).toContain("was not found");
    expect(err.attempted).toBe("C:\\tools\\go\\bin\\gopls.exe");
    expect(err.code).toBe("ENOENT");
    expect(err.name).toBe("LanguageServerUnavailableError");
  });

  it("names the PATH lookup and the override variable it could have used when there is no override", () => {
    const err = unavailable(clangdConfig, "clangd", false, "ENOENT");
    expect(err.message).toContain('"clangd" on PATH');
    expect(err.message).toContain("MCP_CODE_NAV_CLANGD");
    expect(err.message).toContain("install LLVM/clangd and put it on PATH");
  });

  it("does not claim a missing binary for a spawn failure that is not ENOENT", () => {
    const err = unavailable(goplsConfig, "gopls", false, "EACCES");
    expect(err.message).toContain("could not be started");
    expect(err.message).toContain("EACCES");
    expect(err.message).not.toContain("was not found");
  });

  it("keeps the spawn error as its cause", () => {
    const cause = Object.assign(new Error("spawn clangd ENOENT"), { code: "ENOENT" });
    const err = new LanguageServerUnavailableError(
      { config: clangdConfig, attempted: "clangd", fromOverride: false },
      { code: "ENOENT", cause },
    );
    expect(err.cause).toBe(cause);
  });
});

describe("attachLifecycleHandlers", () => {
  it("records the spawn error's argument instead of discarding it", () => {
    const child = new EventEmitter();
    const { isAlive, spawnFailure } = attachLifecycleHandlers(child, { dispose: () => {} }, {
      config: clangdConfig,
      attempted: "/nope/clangd.exe",
      fromOverride: true,
    });
    expect(spawnFailure()).toBeUndefined();

    child.emit("error", Object.assign(new Error("spawn /nope/clangd.exe ENOENT"), { code: "ENOENT" }));
    child.emit("error", Object.assign(new Error("spawn /nope/clangd.exe EACCES"), { code: "EACCES" }));

    const failure = spawnFailure();
    expect(failure).toBeInstanceOf(LanguageServerUnavailableError);
    expect(failure?.code).toBe("ENOENT");
    expect(failure?.message).toContain("MCP_CODE_NAV_CLANGD");
    expect(isAlive()).toBe(false);
  });

  it("keeps an 'exit' a plain death, with no spawn failure to report", () => {
    const child = new EventEmitter();
    const { spawnFailure } = attachLifecycleHandlers(child, { dispose: () => {} }, {
      config: goplsConfig,
      attempted: "gopls",
      fromOverride: false,
    });
    child.emit("exit", 1, null);
    expect(spawnFailure()).toBeUndefined();
  });
});

describe("a session whose child never started", () => {
  const DISPOSED = "Pending response rejected since connection got disposed";

  it("surfaces the spawn failure in place of the connection's opaque rejection", async () => {
    const failure = unavailable(clangdConfig, "clangd", false, "ENOENT");
    const server = fakeServer({
      respond: () => {
        throw new Error(DISPOSED);
      },
      failure: () => failure,
    });
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => server.process,
      readFile: () => "x",
      sleep: async () => {},
    });
    await expect(session.documentSymbol("/proj/a.cpp")).rejects.toBe(failure);
  });

  it("keeps the connection's own error when the child died for some other reason", async () => {
    const server = fakeServer({
      respond: () => {
        throw new Error(DISPOSED);
      },
    });
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => server.process,
      readFile: () => "x",
      sleep: async () => {},
    });
    await expect(session.documentSymbol("/proj/a.cpp")).rejects.toThrow(DISPOSED);
  });
});
