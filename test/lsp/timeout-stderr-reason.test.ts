import { describe, expect, it } from "vitest";
import { RequestTimeoutError, ServerExitedError } from "../../src/lsp/request-control.js";
import { withRequestSignal } from "../../src/lsp/request-scope.js";
import { goplsConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { reasonOfError } from "../../src/tools/reason-of-error.js";
import { fakeServer } from "../helpers/fake-lsp.js";

/** A child that completes the handshake, never answers anything else, and left `tail` on its stderr. */
function silentChildWithStderr(tail: string) {
  const server = fakeServer({
    respond: (method) => (method === "initialize" ? { capabilities: {} } : new Promise(() => {})),
  });
  return {
    ...server.process,
    stderrTail: () => tail,
    stderrSettled: async () => {},
  };
}

function sessionOver(child: ReturnType<typeof silentChildWithStderr>, requestTimeoutMs: number) {
  return new LspSession({
    root: "/mod",
    config: goplsConfig,
    spawn: () => child,
    readFile: () => "package main\n",
    sleep: async () => {},
    requestTimeoutMs,
  });
}

describe("a request failure that carries the server's stderr keeps its reason", () => {
  it("keeps the timeout as the cause, so the failure still reads as request-timeout", async () => {
    const session = sessionOver(silentChildWithStderr("fatal: index corrupted"), 40);

    const failure = await session.request("textDocument/references", {}).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("fatal: index corrupted");
    expect((failure as Error).cause).toBeInstanceOf(RequestTimeoutError);
    expect(reasonOfError(failure)).toBe("request-timeout");
    session.dispose();
  });

  it("reads the failure of a child that died mid-request as session-lost, with the stderr tail in its text", async () => {
    let alive = true;
    const server = fakeServer({
      alive: () => alive,
      respond: (method) => {
        if (method === "initialize") return { capabilities: {} };
        alive = false;
        throw new Error("Pending response rejected since connection got disposed");
      },
    });
    const child = {
      ...server.process,
      stderrTail: () => "panic: out of memory",
      stderrSettled: async () => {},
    };
    const session = sessionOver(child, 600_000);

    const failure = await session.request("textDocument/references", {}).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ServerExitedError);
    expect((failure as Error).message).toContain("Pending response rejected");
    expect((failure as Error).message).toContain("panic: out of memory");
    expect(reasonOfError(failure)).toBe("session-lost");
    session.dispose();
  });

  it("leaves a cancelled call cancelled, whatever the child's stderr says", async () => {
    const session = sessionOver(silentChildWithStderr("panic: late"), 600_000);
    const controller = new AbortController();
    controller.abort();

    const failure = await withRequestSignal(controller.signal, () =>
      session.request("textDocument/references", {}),
    ).catch((e: unknown) => e);

    expect(reasonOfError(failure)).toBe("cancelled");
    expect((failure as Error).message).not.toContain("panic: late");
    session.dispose();
  });
});
