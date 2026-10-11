import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CancellationToken } from "vscode-jsonrpc/node";
import type { LspConnection } from "../../src/lsp/process.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  RequestAbortedError,
  RequestTimeoutError,
  resolveRequestTimeoutMs,
  sendWithControl,
} from "../../src/lsp/request-control.js";
import { withRequestSignal } from "../../src/lsp/request-scope.js";
import { goplsConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { fakeServer } from "../helpers/fake-lsp.js";

/** A connection whose requests the test settles by hand, remembering the token each one was sent with. */
function manualConnection() {
  const tokens: CancellationToken[] = [];
  const settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  const connection: LspConnection = {
    sendRequest: <R>(_method: string, _params?: unknown, token?: CancellationToken) => {
      if (token !== undefined) tokens.push(token);
      return new Promise<R>((resolve, reject) => {
        settle.push({ resolve: resolve as (value: unknown) => void, reject });
      });
    },
    sendNotification: async () => {},
    onRequest: () => ({ dispose: () => {} }),
    onProgress: () => ({ dispose: () => {} }),
  };
  return { connection, tokens, settle };
}

describe("sendWithControl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers with the server's result and leaves no timer behind", async () => {
    const { connection, settle, tokens } = manualConnection();
    const pending = sendWithControl<string>(connection, "textDocument/references", {}, { serverId: "gopls", timeoutMs: 1000 });
    settle[0]?.resolve("answer");
    await expect(pending).resolves.toBe("answer");
    expect(vi.getTimerCount()).toBe(0);
    expect(tokens[0]?.isCancellationRequested).toBe(false);
  });

  it("passes the server's own rejection through unchanged", async () => {
    const { connection, settle } = manualConnection();
    const pending = sendWithControl(connection, "textDocument/hover", {}, { serverId: "gopls", timeoutMs: 1000 });
    const failure = new Error("server said no");
    settle[0]?.reject(failure);
    await expect(pending).rejects.toBe(failure);
  });

  it("rejects with RequestTimeoutError at the deadline and cancels the request on the server", async () => {
    const { connection, tokens } = manualConnection();
    const pending = sendWithControl(connection, "textDocument/references", {}, { serverId: "gopls", timeoutMs: 500 });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "RequestTimeoutError",
      serverId: "gopls",
      method: "textDocument/references",
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(tokens[0]?.isCancellationRequested).toBe(true);
  });

  it("rejects with RequestAbortedError when the signal fires, and cancels the request on the server", async () => {
    const { connection, tokens } = manualConnection();
    const controller = new AbortController();
    const pending = sendWithControl(connection, "textDocument/hover", {}, { serverId: "clangd", timeoutMs: 60_000, signal: controller.signal });
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestAbortedError);
    controller.abort();
    await assertion;
    expect(tokens[0]?.isCancellationRequested).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing when the signal had already fired", async () => {
    const sendRequest = vi.fn();
    const connection: LspConnection = {
      sendRequest,
      sendNotification: async () => {},
      onRequest: () => ({ dispose: () => {} }),
      onProgress: () => ({ dispose: () => {} }),
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      sendWithControl(connection, "textDocument/hover", {}, { serverId: "clangd", timeoutMs: 1000, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RequestAbortedError);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("rejects, and keeps no timer, when the connection throws while sending", async () => {
    const connection: LspConnection = {
      sendRequest: () => {
        throw new Error("connection is closed");
      },
      sendNotification: async () => {},
      onRequest: () => ({ dispose: () => {} }),
      onProgress: () => ({ dispose: () => {} }),
    };
    await expect(sendWithControl(connection, "initialize", {}, { serverId: "gopls", timeoutMs: 1000 })).rejects.toThrow(
      "connection is closed",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("resolveRequestTimeoutMs", () => {
  it("uses the default when the variable is unset or empty", () => {
    const warn = vi.fn();
    expect(resolveRequestTimeoutMs({}, warn)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(resolveRequestTimeoutMs({ MCP_CODE_NAV_REQUEST_TIMEOUT_MS: "" }, warn)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads a positive integer", () => {
    expect(resolveRequestTimeoutMs({ MCP_CODE_NAV_REQUEST_TIMEOUT_MS: "45000" }, vi.fn())).toBe(45_000);
  });

  it.each(["0", "-5", "1.5", "soon", "99999999"])("reports %s and falls back to the default", (value) => {
    const warn = vi.fn();
    expect(resolveRequestTimeoutMs({ MCP_CODE_NAV_REQUEST_TIMEOUT_MS: value }, warn)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("MCP_CODE_NAV_REQUEST_TIMEOUT_MS");
  });
});

/** A server that completes the handshake and then never answers anything else. */
function silentServer() {
  return fakeServer({
    respond: (method) => (method === "initialize" ? { capabilities: {} } : new Promise(() => {})),
  });
}

function sessionOver(server: ReturnType<typeof silentServer>, requestTimeoutMs: number): LspSession {
  return new LspSession({
    root: "/mod",
    config: goplsConfig,
    spawn: () => server.process,
    readFile: () => "package main\n",
    sleep: async () => {},
    requestTimeoutMs,
  });
}

describe("LspSession requests against a server that stops answering", () => {
  it("fails a request with RequestTimeoutError once the per-request timeout passes", async () => {
    const server = silentServer();
    const session = sessionOver(server, 40);

    const failure = await session.request("textDocument/references", {}).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RequestTimeoutError);
    expect((failure as Error).message).toContain("textDocument/references");
    const sent = vi.mocked(server.process.connection.sendRequest).mock.calls.at(-1);
    expect((sent?.[2] as CancellationToken | undefined)?.isCancellationRequested).toBe(true);
    session.dispose();
  });

  it("fails an in-flight request when the call's signal fires, long before the timeout", async () => {
    const server = silentServer();
    const session = sessionOver(server, 600_000);
    const controller = new AbortController();

    const pending = withRequestSignal(controller.signal, () => session.request("textDocument/references", {}));
    const failure = pending.catch((e: unknown) => e);
    await vi.waitFor(() => expect(server.methods).toContain("textDocument/references"));
    controller.abort();

    expect(await failure).toBeInstanceOf(RequestAbortedError);
    session.dispose();
  });

  it("refuses to start a request for a call that is already cancelled", async () => {
    const server = silentServer();
    const session = sessionOver(server, 600_000);
    const controller = new AbortController();
    controller.abort();

    const failure = await withRequestSignal(controller.signal, () => session.request("textDocument/references", {})).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(RequestAbortedError);
    expect(server.methods).not.toContain("textDocument/references");
    session.dispose();
  });

  /** Two children: the first hangs on every request after the handshake, the second answers. */
  function hangThenHealthy(requestTimeoutMs = 40) {
    const first = fakeServer({
      respond: (method) => (method === "initialize" ? { capabilities: {} } : new Promise(() => {})),
      kill: vi.fn(),
    });
    const second = fakeServer({ respond: (method) => (method === "initialize" ? { capabilities: {} } : ["ok"]), kill: vi.fn() });
    const servers = [first, second];
    const spawn = vi.fn(() => {
      const next = servers[spawn.mock.calls.length - 1];
      if (next === undefined) throw new Error("spawned a third child");
      return next.process;
    });
    const session = new LspSession({
      root: "/mod",
      config: goplsConfig,
      spawn,
      readFile: () => "package main\n",
      sleep: async () => {},
      requestTimeoutMs,
    });
    return { first, second, spawn, session };
  }

  it("kills the child that timed out and serves the next call from a new one, without retrying the timed-out call", async () => {
    const { first, second, spawn, session } = hangThenHealthy();

    const failure = await session.request("textDocument/references", {}).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RequestTimeoutError);
    expect(first.process.kill).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(first.methods.filter((m) => m === "textDocument/references")).toHaveLength(1);

    await expect(session.request("textDocument/references", {})).resolves.toEqual(["ok"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(second.methods.filter((m) => m === "textDocument/references")).toHaveLength(1);
    session.dispose();
  });

  it("discards the timed-out child before it waits for the child's stderr", async () => {
    const hung = fakeServer({
      respond: (method) => (method === "initialize" ? { capabilities: {} } : new Promise(() => {})),
      kill: vi.fn(),
    });
    const healthy = fakeServer({ respond: (method) => (method === "initialize" ? { capabilities: {} } : ["ok"]) });
    const servers = [hung, healthy];
    const spawn = vi.fn(() => (servers[spawn.mock.calls.length - 1] ?? hung).process);
    // The stderr wait and the settle sleep never finish: the failure stays pending while the test looks.
    const stuckStderr = { ...hung.process, stderrSettled: () => new Promise<void>(() => {}), stderrTail: () => "" };
    servers[0] = { ...hung, process: stuckStderr } as typeof hung;
    const session = new LspSession({
      root: "/mod",
      config: goplsConfig,
      spawn,
      readFile: () => "package main\n",
      sleep: () => new Promise<void>(() => {}),
      requestTimeoutMs: 40,
    });

    const failure = session.request("textDocument/references", {}).catch((e: unknown) => e);
    await vi.waitFor(() => expect(hung.process.kill).toHaveBeenCalledOnce());

    // A caller arriving in that window gets the new child, not the hung one.
    await expect(session.request("textDocument/references", {})).resolves.toEqual(["ok"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(hung.methods.filter((m) => m === "textDocument/references")).toHaveLength(1);
    void failure;
    session.dispose();
  });

  it("does not respawn and retry a timed-out documentSymbol", async () => {
    const { first, spawn, session } = hangThenHealthy();

    const failure = await session.documentSymbol("/mod/a.go").catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RequestTimeoutError);
    expect(first.process.kill).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("leaves the child alone when the call is cancelled rather than timed out", async () => {
    const { first, spawn, session } = hangThenHealthy(600_000);
    const controller = new AbortController();

    const pending = withRequestSignal(controller.signal, () => session.request("textDocument/references", {}));
    const failure = pending.catch((e: unknown) => e);
    await vi.waitFor(() => expect(first.methods).toContain("textDocument/references"));
    controller.abort();

    expect(await failure).toBeInstanceOf(RequestAbortedError);
    expect(first.process.kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("ends a readiness wait when the call's signal fires", async () => {
    const server = silentServer();
    const session = sessionOver(server, 600_000);
    const controller = new AbortController();

    const outcome = withRequestSignal(controller.signal, () => session.awaitWorkspaceReady(600_000));
    controller.abort();

    await expect(outcome).resolves.toBe("timed-out");
    session.dispose();
  });
});
