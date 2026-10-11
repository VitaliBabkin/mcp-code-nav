import { describe, expect, it, vi } from "vitest";
import type { LspProcess, SpawnLsp } from "../../src/lsp/process.js";
import { clangdConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { noopServerHandlers } from "../helpers/fake-clangd.js";

const SAMPLE_SYMBOL: LspDocumentSymbol = {
  name: "Foo",
  kind: 5,
  range: { start: { line: 0 }, end: { line: 3 } },
};

interface FakeProcessOptions {
  onDocumentSymbol?: (callIndex: number) => LspDocumentSymbol[] | null;
  crashOnDocumentSymbol?: boolean;
}

function fakeProcess(
  options: FakeProcessOptions,
): { process: LspProcess; notifications: [string, unknown][]; requests: [string, unknown][] } {
  let callIndex = 0;
  let alive = true;
  const notifications: [string, unknown][] = [];
  const requests: [string, unknown][] = [];
  const sendRequest = vi.fn(async (method: string, params?: unknown) => {
    requests.push([method, params]);
    if (method === "initialize") return {};
    if (method === "textDocument/documentSymbol") {
      callIndex++;
      if (options.crashOnDocumentSymbol) {
        alive = false;
        throw new Error("clangd crashed");
      }
      return options.onDocumentSymbol ? options.onDocumentSymbol(callIndex) : [];
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const sendNotification = vi.fn(async (method: string, params?: unknown) => {
    notifications.push([method, params]);
  });
  const process = {
    connection: { sendRequest, sendNotification, ...noopServerHandlers() } as unknown as LspProcess["connection"],
    isAlive: () => alive,
    kill: () => {
      alive = false;
    },
    spawnFailure: () => undefined,
  };
  return { process, notifications, requests };
}

describe("LspSession initialize", () => {
  it("declares hierarchicalDocumentSymbolSupport, so clangd answers with nested DocumentSymbol[] not flat SymbolInformation[]", async () => {
    const { process, requests } = fakeProcess({ onDocumentSymbol: () => [SAMPLE_SYMBOL] });
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => process,
      sleep: async () => {},
      readFile: () => "content",
    });
    await session.documentSymbol("/proj/a.h");
    const initializeCall = requests.find(([method]) => method === "initialize");
    expect(initializeCall?.[1]).toMatchObject({
      capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    });
  });
});

describe("LspSession.documentSymbol", () => {
  it("retries once and reports cold-empty when a not-yet-warm process stays empty", async () => {
    const { process } = fakeProcess({ onDocumentSymbol: () => [] });
    const sleep = vi.fn(async () => {});
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => process,
      sleep,
      readFile: () => "content",
    });
    const result = await session.documentSymbol("/proj/a.h");
    expect(result).toEqual({ state: "cold-empty" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("marks the session warm and returns ok when the retry produces a non-empty result", async () => {
    const { process } = fakeProcess({ onDocumentSymbol: (n) => (n === 1 ? [] : [SAMPLE_SYMBOL]) });
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => process,
      sleep: async () => {},
      readFile: () => "content",
    });
    const result = await session.documentSymbol("/proj/a.h");
    expect(result).toEqual({ state: "ok", symbols: [SAMPLE_SYMBOL] });
  });

  it("returns a confident empty without retrying once the session is already warm", async () => {
    const responses: (LspDocumentSymbol[] | null)[] = [[SAMPLE_SYMBOL], []];
    let idx = 0;
    const { process } = fakeProcess({ onDocumentSymbol: () => responses[idx++] ?? [] });
    const sleep = vi.fn(async () => {});
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => process,
      sleep,
      readFile: () => "content",
    });
    await session.documentSymbol("/proj/a.h");
    const result = await session.documentSymbol("/proj/b.h");
    expect(result).toEqual({ state: "empty" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("opens a file at most once per process instance", async () => {
    const { process, notifications } = fakeProcess({ onDocumentSymbol: () => [SAMPLE_SYMBOL] });
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => process,
      sleep: async () => {},
      readFile: () => "content",
    });
    await session.documentSymbol("/proj/a.h");
    await session.documentSymbol("/proj/a.h");
    const didOpens = notifications.filter(([method]) => method === "textDocument/didOpen");
    expect(didOpens).toHaveLength(1);
  });

  it("tracks every file opened this session, across calls", async () => {
    const { process } = fakeProcess({ onDocumentSymbol: () => [SAMPLE_SYMBOL] });
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => process,
      sleep: async () => {},
      readFile: () => "content",
    });
    await session.documentSymbol("/proj/a.h");
    await session.documentSymbol("/proj/b.h");
    expect(session.getOpenedFiles().sort()).toEqual(["/proj/a.h", "/proj/b.h"]);
  });

  it("respawns and retries exactly once when the process has died mid-request", async () => {
    const crashed = fakeProcess({ crashOnDocumentSymbol: true });
    const healthy = fakeProcess({ onDocumentSymbol: () => [SAMPLE_SYMBOL] });
    let spawnCount = 0;
    const spawn: SpawnLsp = () => {
      spawnCount++;
      return spawnCount === 1 ? crashed.process : healthy.process;
    };
    const session = new LspSession({ root: "/proj", config: clangdConfig, spawn, sleep: async () => {}, readFile: () => "x" });
    const result = await session.documentSymbol("/proj/a.h");
    expect(result).toEqual({ state: "ok", symbols: [SAMPLE_SYMBOL] });
    expect(spawnCount).toBe(2);
  });

  it("resets warm to cold on respawn, even though the session was warm on the prior process", async () => {
    const warmThenDies = fakeProcess({ onDocumentSymbol: () => [SAMPLE_SYMBOL] });
    const coldReplacement = fakeProcess({ onDocumentSymbol: () => [] });
    let spawnCount = 0;
    const spawn: SpawnLsp = () => {
      spawnCount++;
      return spawnCount === 1 ? warmThenDies.process : coldReplacement.process;
    };
    const session = new LspSession({ root: "/proj", config: clangdConfig, spawn, sleep: async () => {}, readFile: () => "x" });

    const first = await session.documentSymbol("/proj/a.h");
    expect(first).toEqual({ state: "ok", symbols: [SAMPLE_SYMBOL] });

    // The first process dies between calls (detected proactively by ensureProcess, not mid-request).
    warmThenDies.process.kill();

    // The replacement process is genuinely cold — both the immediate and retried request come back
    // empty. Without resetting `warm`, this would incorrectly report a confident "empty".
    const result = await session.documentSymbol("/proj/b.h");
    expect(result).toEqual({ state: "cold-empty" });
    expect(spawnCount).toBe(2);
  });

  it("re-opens a file against the fresh process after a respawn", async () => {
    const crashed = fakeProcess({ crashOnDocumentSymbol: true });
    const healthy = fakeProcess({ onDocumentSymbol: () => [SAMPLE_SYMBOL] });
    const spawn: SpawnLsp = (() => {
      let n = 0;
      return () => (n++ === 0 ? crashed.process : healthy.process);
    })();
    const session = new LspSession({ root: "/proj", config: clangdConfig, spawn, sleep: async () => {}, readFile: () => "x" });
    await session.documentSymbol("/proj/a.h");
    const didOpens = healthy.notifications.filter(([method]) => method === "textDocument/didOpen");
    expect(didOpens).toHaveLength(1);
  });
});
