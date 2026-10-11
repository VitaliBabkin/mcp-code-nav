import { describe, expect, it, vi } from "vitest";
import { clangdConfig, goplsConfig, type LanguageServerConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { fakeServer } from "../helpers/fake-lsp.js";

/**
 * A session with its server already running: the session only spawns on the first request, and the
 * server-to-client handlers are registered as part of starting it.
 */
async function running(config: LanguageServerConfig = goplsConfig) {
  // A non-empty outline, so a clangd session answers on its first request and never takes the
  // cold-empty retry path that would add a second documentSymbol to the record.
  const server = fakeServer({
    respond: () => [{ name: "Foo", kind: 5, range: { start: { line: 0 }, end: { line: 1 } } }],
  });
  const session = new LspSession({
    root: "/mod",
    config,
    spawn: () => server.process,
    readFile: () => "package main\n",
    sleep: async () => {},
  });
  await session.documentSymbol("/mod/a.go");
  return { server, session };
}

describe("awaitWorkspaceReady", () => {
  it("answers the server's window/workDoneProgress/create and resolves ready on that token's end", async () => {
    const { server, session } = await running();
    expect(server.registeredRequestHandlers).toContain("window/workDoneProgress/create");

    const ready = session.awaitWorkspaceReady(1000);
    expect(await server.createProgress("tok-1")).toBeNull();
    expect(server.progressTokens).toEqual(["tok-1"]);
    expect(server.sendProgress("tok-1", { kind: "begin", title: "Setting up workspace" })).toBe(true);
    expect(server.sendProgress("tok-1", { kind: "end", message: "Finished loading packages." })).toBe(true);
    expect(await ready).toBe("ready");
  });

  it("resolves timed-out when the end never arrives inside the budget", async () => {
    const { server, session } = await running();
    await server.createProgress("tok-1");
    expect(await session.awaitWorkspaceReady(10)).toBe("timed-out");
  });

  it("distinguishes the budget running out from the process being taken away", async () => {
    const { server, session } = await running();
    await server.createProgress("tok-1");
    // The clock first, on its own: a caller that waited and waited is told the budget ran out.
    expect(await session.awaitWorkspaceReady(10)).toBe("timed-out");

    // Then a wait cut short: the only process that could answer it is gone, and a caller told
    // "timed-out" here would be sent to raise a budget that was never the problem.
    const pending = session.awaitWorkspaceReady(60_000);
    session.dispose();
    expect(await pending).toBe("restarted");
  });

  it("counts only the first token as the load proof, so a later end proves nothing", async () => {
    const { server, session } = await running();
    await server.createProgress("tok-1");
    await server.createProgress("tok-2");
    // Every token a process creates is watched, because the index state an index-backed C++ answer carries
    // is counted from all of them — watching is not what proves the load.
    expect(server.progressTokens).toEqual(["tok-1", "tok-2"]);

    // The second token's end is delivered, and still proves nothing about the initial load.
    expect(server.sendProgress("tok-2", { kind: "end" })).toBe(true);
    expect(await session.awaitWorkspaceReady(10)).toBe("timed-out");

    expect(server.sendProgress("tok-1", { kind: "end" })).toBe(true);
    expect(await session.awaitWorkspaceReady(10)).toBe("ready");
  });

  it("tolerates a repeated create for the token it already tracks", async () => {
    const { server, session } = await running();
    await server.createProgress("tok-1");
    // vscode-jsonrpc throws on a second subscription for one token, which a repeated create must not do.
    await expect(server.createProgress("tok-1")).resolves.toBeNull();
    expect(server.sendProgress("tok-1", { kind: "end" })).toBe(true);
    expect(await session.awaitWorkspaceReady(10)).toBe("ready");
  });

  it("still answers a create that names no token, and subscribes to nothing", async () => {
    const { server, session } = await running();
    await expect(server.createProgress(undefined)).resolves.toBeNull();
    expect(server.progressTokens).toEqual([]);
    expect(await session.awaitWorkspaceReady(10)).toBe("timed-out");
  });

  it("is harmless for a clangd session, whose outline answer does not depend on it", async () => {
    const { server, session } = await running(clangdConfig);
    expect(server.methods).toEqual(["initialize", "textDocument/documentSymbol"]);
    await server.createProgress("tok-1");
    expect(await session.awaitWorkspaceReady(10)).toBe("timed-out");
    expect(server.sendProgress("tok-1", { kind: "end" })).toBe(true);
    expect(await session.awaitWorkspaceReady(10)).toBe("ready");
  });

  it("resolves a pending wait as restarted when the session is disposed, leaving no timer running", async () => {
    const { server, session } = await running();
    await server.createProgress("tok-1");
    vi.useFakeTimers();
    try {
      const pending = session.awaitWorkspaceReady(600_000);
      expect(vi.getTimerCount()).toBe(1);
      session.dispose();
      await expect(pending).resolves.toBe("restarted");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a pending wait when the process it was waiting on is replaced", async () => {
    let firstDied = false;
    const first = fakeServer({ alive: () => !firstDied });
    const second = fakeServer();
    let call = 0;
    const session = new LspSession({
      root: "/mod",
      config: goplsConfig,
      spawn: () => (call++ === 0 ? first.process : second.process),
      readFile: () => "package main\n",
      sleep: async () => {},
    });
    await session.documentSymbol("/mod/a.go");
    await first.createProgress("tok-1");
    const pending = session.awaitWorkspaceReady(60_000);

    firstDied = true;
    await session.documentSymbol("/mod/b.go");
    await expect(pending).resolves.toBe("restarted");

    // The replacement proves its own load; the old token's proof died with the old process.
    await second.createProgress("tok-1");
    expect(second.progressTokens).toEqual(["tok-1"]);
  });

  it("reports the current process only, so a respawn is never read as still-loaded", async () => {
    const { server, session } = await running();
    await server.createProgress("tok-1");
    server.sendProgress("tok-1", { kind: "end" });
    expect(session.isWorkspaceLoaded()).toBe(true);

    session.dispose();
    expect(session.isWorkspaceLoaded()).toBe(false);
  });
});
