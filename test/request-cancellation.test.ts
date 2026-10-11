import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { makeGoExec } from "../src/gopls/go-env.js";
import { currentRequestSignal, withRequestSignal } from "../src/lsp/request-scope.js";
import { withRequestCancellation } from "../src/request-cancellation.js";
import { defaultTsExec } from "../src/tsgo/binary.js";

/** A transport the test drives by hand: `deliver` plays the client, `sent` is what the server wrote back. */
function manualTransport() {
  const sent: JSONRPCMessage[] = [];
  const inner: Transport = {
    start: async () => {},
    send: async (message) => {
      sent.push(message);
    },
    close: async () => {
      inner.onclose?.();
    },
  };
  return {
    inner,
    sent,
    deliver: (message: JSONRPCMessage) => inner.onmessage?.(message),
  };
}

const toolCall = (id: number): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "ts_find_symbol", arguments: {} },
});

const cancelled = (requestId: number): JSONRPCMessage => ({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId },
});

/** The signal each delivered request saw in its handler, keyed by request id. */
function observe(transport: Transport): Map<number, AbortSignal | undefined> {
  const seen = new Map<number, AbortSignal | undefined>();
  transport.onmessage = (message) => {
    if ("id" in message && "method" in message && typeof message.id === "number") {
      seen.set(message.id, currentRequestSignal());
    }
  };
  return seen;
}

describe("withRequestCancellation", () => {
  it("gives each tools/call its own signal inside the handler", () => {
    const { inner, deliver } = manualTransport();
    const transport = withRequestCancellation(inner);
    const seen = observe(transport);

    deliver(toolCall(1));
    deliver(toolCall(2));

    expect(seen.get(1)).toBeDefined();
    expect(seen.get(2)).toBeDefined();
    expect(seen.get(1)).not.toBe(seen.get(2));
    expect(seen.get(1)?.aborted).toBe(false);
  });

  it("aborts exactly the cancelled call's signal", () => {
    const { inner, deliver } = manualTransport();
    const transport = withRequestCancellation(inner);
    const seen = observe(transport);
    deliver(toolCall(1));
    deliver(toolCall(2));

    deliver(cancelled(1));

    expect(seen.get(1)?.aborted).toBe(true);
    expect(seen.get(2)?.aborted).toBe(false);
  });

  it("carries the signal through awaits inside the handler", async () => {
    const { inner, deliver } = manualTransport();
    const transport = withRequestCancellation(inner);
    let later: AbortSignal | undefined;
    transport.onmessage = () => {
      void Promise.resolve()
        .then(() => new Promise((resolve) => setTimeout(resolve, 5)))
        .then(() => {
          later = currentRequestSignal();
        });
    };

    deliver(toolCall(7));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(later).toBeDefined();
  });

  it("leaves other requests outside any scope", () => {
    const { inner, deliver } = manualTransport();
    const transport = withRequestCancellation(inner);
    const seen = observe(transport);

    deliver({ jsonrpc: "2.0", id: 3, method: "tools/list" });

    expect(seen.get(3)).toBeUndefined();
  });

  it("does not abort a call whose response has gone out", async () => {
    const { inner, deliver } = manualTransport();
    const transport = withRequestCancellation(inner);
    const seen = observe(transport);
    deliver(toolCall(1));

    await transport.send({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    deliver(cancelled(1));

    expect(seen.get(1)?.aborted).toBe(false);
  });

  it("aborts every call still in flight when the transport closes", async () => {
    const { inner, deliver } = manualTransport();
    const transport = withRequestCancellation(inner);
    const seen = observe(transport);
    deliver(toolCall(1));
    deliver(toolCall(2));

    await transport.close();

    expect(seen.get(1)?.aborted).toBe(true);
    expect(seen.get(2)?.aborted).toBe(true);
  });
});

const SLEEP_FOR_A_MINUTE = ["-e", "setTimeout(() => {}, 60000)"];

describe("helper processes started for a call", () => {
  it("stop when the call is cancelled: the go toolchain pass", async () => {
    const controller = new AbortController();
    const began = Date.now();

    const run = withRequestSignal(controller.signal, () => makeGoExec(process.execPath)(SLEEP_FOR_A_MINUTE, process.cwd(), {}));
    setTimeout(() => controller.abort(), 100);
    const result = await run;

    expect(Date.now() - began).toBeLessThan(20_000);
    expect(result.exitCode).toBeUndefined();
  }, 30_000);

  it("stop when the call is cancelled: the TypeScript tool lookup", async () => {
    const controller = new AbortController();
    const began = Date.now();

    const run = withRequestSignal(controller.signal, () => defaultTsExec(process.execPath, SLEEP_FOR_A_MINUTE, process.cwd(), undefined));
    setTimeout(() => controller.abort(), 100);
    const result = await run;

    expect(Date.now() - began).toBeLessThan(20_000);
    expect(result.exitCode).toBeUndefined();
  }, 30_000);
});
