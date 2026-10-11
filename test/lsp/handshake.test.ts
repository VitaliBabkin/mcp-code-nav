import { describe, expect, it, vi } from "vitest";
import { clangdConfig, goplsConfig, type LanguageServerConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { fakeServer, type FakeServer } from "../helpers/fake-lsp.js";
import { sym } from "../helpers/fake-clangd.js";

const SYMBOL = sym("Foo", 5);

/** A session whose children come from `spawn`, counted so a test can tell a reuse from a respawn. */
function sessionFor(spawn: (call: number) => FakeServer, config: LanguageServerConfig = clangdConfig) {
  let call = 0;
  const spawnFn = vi.fn(() => spawn(call++).process);
  const session = new LspSession({
    root: "/proj",
    config,
    spawn: spawnFn,
    readFile: () => "content",
    sleep: async () => {},
  });
  return { session, spawnFn };
}

describe("the handshake is not published until it is complete", () => {
  it("holds every concurrent cold caller until initialize is answered and initialized is sent", async () => {
    let settle: (() => void) | undefined;
    const initializePending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let server: FakeServer | undefined;
    const { session, spawnFn } = sessionFor(() => {
      server = fakeServer({
        respond: async (method) => {
          if (method !== "initialize") return [SYMBOL];
          await initializePending;
          return {};
        },
      });
      return server;
    });

    const both = Promise.all([session.documentSymbol("/proj/a.cpp"), session.documentSymbol("/proj/b.cpp")]);
    settle?.();
    expect(await both).toEqual([
      { state: "ok", symbols: [SYMBOL] },
      { state: "ok", symbols: [SYMBOL] },
    ]);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    const journal = server?.journal ?? [];
    // One spawn AND one handshake: everything after this point belongs after `initialized`, because a
    // server is not obliged to answer a request that overtook it. A second caller handed the child
    // mid-handshake shows up here as a didOpen or a documentSymbol before `note:initialized`.
    expect(journal.slice(0, journal.indexOf("note:initialized"))).toEqual(["req:initialize"]);
    expect(journal.filter((entry) => entry === "note:textDocument/didOpen")).toHaveLength(2);
    expect(journal.filter((entry) => entry === "req:textDocument/documentSymbol")).toHaveLength(2);
  }, 10_000);
});

describe("request() shares documentSymbol's crash recovery", () => {
  it("respawns once and answers, when the child died between calls", async () => {
    let firstDied = false;
    const first = fakeServer({ alive: () => !firstDied, respond: () => [SYMBOL] });
    const second = fakeServer({ respond: () => [SYMBOL] });
    const { session, spawnFn } = sessionFor((call) => (call === 0 ? first : second), goplsConfig);

    await session.documentSymbol("/proj/a.go");
    expect(spawnFn).toHaveBeenCalledTimes(1);

    firstDied = true;
    await expect(
      session.request("textDocument/implementation", {
        textDocument: { uri: "file:///proj/a.go" },
        position: { line: 1, character: 1 },
      }),
    ).resolves.toEqual([SYMBOL]);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    // The request went to the process that was started for it, not the one that died.
    expect(second.methods).toContain("textDocument/implementation");
    expect(first.methods).not.toContain("textDocument/implementation");
  });
});

describe("a child whose handshake failed", () => {
  it("is killed, not dropped, when it refused initialize while still alive", async () => {
    const kill = vi.fn();
    const server = fakeServer({
      kill,
      respond: (method) => {
        if (method === "initialize") throw new Error("clangd refused initialize");
        return [SYMBOL];
      },
    });
    const { session } = sessionFor(() => server);
    await expect(session.documentSymbol("/proj/a.cpp")).rejects.toThrow("clangd refused initialize");
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe("the capabilities the handshake declares", () => {
  it("declares window.workDoneProgress to gopls, because without it no initial-load token is ever created", () => {
    const { capabilities } = goplsConfig.initializeParams("/mod") as {
      capabilities: { window?: { workDoneProgress?: boolean }; textDocument?: Record<string, unknown> };
    };
    expect(capabilities.window?.workDoneProgress).toBe(true);
    // The capability the outline answer depends on is still beside it, not replaced by it.
    expect(capabilities.textDocument).toMatchObject({ documentSymbol: { hierarchicalDocumentSymbolSupport: true } });
  });
});
