import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { noteReadyWait, noteSession } from "../../src/call-log/annotations.js";
import { clangdConfig } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import type { CallRecord, RunRecord } from "../../src/call-log/record.js";
import { goplsConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { watchStdinClose, withCallLog } from "../../src/call-log/logging-transport.js";
import { fakeServer } from "../helpers/fake-lsp.js";
import type { CallLog } from "../../src/call-log/writer.js";

type Recorded = z.infer<typeof CallRecord>;
type Header = z.infer<typeof RunRecord>;
type Line = Header | Recorded;

const META = { build: "v1.2.3", cwd: "D:\\work" };

interface Harness {
  readonly transport: Transport;
  readonly inner: Transport;
  readonly lines: Line[];
  readonly sent: JSONRPCMessage[];
  readonly stderr: string[];
  readonly handler: ReturnType<typeof vi.fn>;
  readonly logClose: ReturnType<typeof vi.fn>;
  readonly receive: (message: JSONRPCMessage) => void;
  readonly send: (message: JSONRPCMessage) => Promise<void>;
  readonly fireClose: () => void;
  readonly releaseSends: () => void;
}

interface HarnessOptions {
  readonly failSendWith?: Error;
  readonly throwOnWrite?: boolean;
  readonly throwOnClose?: boolean;
  /** Holds each inner `send` until `releaseSends()`, which is how a slow stdout is simulated. */
  readonly holdSends?: boolean;
  readonly sentSink?: JSONRPCMessage[];
  readonly onWrite?: (line: Line) => void;
}

/**
 * A transport the test drives by hand, so a message sequence can be exactly what the SDK would have put on
 * the wire — including the shapes only the SDK produces. `process.stderr` is spied, never replaced.
 */
function harness(options: HarnessOptions = {}): Harness {
  const lines: Line[] = [];
  const sent = options.sentSink ?? [];
  const stderr: string[] = [];
  const held: (() => void)[] = [];
  let closed = 0;
  const handler = vi.fn((message: JSONRPCMessage) => void message);
  const logClose = vi.fn();

  const inner: Transport = {
    start: async () => {},
    close: async () => {
      if (options.failSendWith !== undefined) throw options.failSendWith;
      closed++;
    },
    async send(message) {
      if (options.failSendWith !== undefined) throw options.failSendWith;
      sent.push(message);
      if (options.holdSends) await new Promise<void>((release) => void held.push(release));
    },
  };
  const log: CallLog = {
    write: (line) => {
      if (options.throwOnWrite) throw new Error("a writer that should not throw");
      options.onWrite?.(line as Line);
      lines.push(line as Line);
    },
    close: () => {
      if (options.throwOnClose) throw new Error("a writer whose close threw");
      logClose();
    },
  };

  const transport = withCallLog(inner, log, META);
  transport.onmessage = handler;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });

  return {
    transport,
    inner,
    lines,
    sent,
    stderr,
    handler,
    logClose,
    receive: (message) => inner.onmessage?.(message),
    send: (message) => transport.send!(message),
    fireClose: () => inner.onclose?.(),
    releaseSends: () => void held.splice(0).forEach((release) => release()),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function toolCall(
  id: number,
  name = "cpp_file_symbols",
  args: unknown = { projectRoot: "D:\\b", file: "a.cpp" },
): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } as JSONRPCMessage;
}

function response(id: number, result: Record<string, unknown>): JSONRPCMessage {
  return { jsonrpc: "2.0", id, result } as JSONRPCMessage;
}

function answered(id: number, text: string, structured?: unknown): JSONRPCMessage {
  const result: Record<string, unknown> = { content: [{ type: "text", text }], isError: true };
  if (structured !== undefined) result.structuredContent = structured;
  return response(id, result);
}

function calls(lines: Line[]): Recorded[] {
  return lines.filter((line): line is Recorded => line.type === "call");
}

describe("the tap forwards", () => {
  it("every message it is handed, unchanged and in order", async () => {
    const h = harness();
    const messages: JSONRPCMessage[] = [
      response(1, { content: [] }),
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1 } } as JSONRPCMessage,
      response(2, { tools: [] }),
      response(3, { content: [{ type: "text", text: "done" }] }),
    ];
    for (const message of messages) await h.send(message);

    expect(h.sent).toHaveLength(messages.length);
    messages.forEach((message, index) => expect(h.sent[index]).toBe(message));
  });

  it("every incoming message to the handler it was given, unchanged", () => {
    const h = harness();
    const messages: JSONRPCMessage[] = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "1.2.3" } },
      } as JSONRPCMessage,
      toolCall(2),
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} } as JSONRPCMessage,
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } } as JSONRPCMessage,
    ];
    for (const message of messages) h.receive(message);

    expect(h.handler.mock.calls).toHaveLength(messages.length);
    messages.forEach((message, index) => expect(h.handler.mock.calls[index]?.[0]).toBe(message));
  });

  it("keeps forwarding after a fault, and never touches the log again", async () => {
    const h = harness({ throwOnWrite: true });
    h.receive(toolCall(1));
    await h.send(response(1, { content: [{ type: "text", text: "x" }] }));

    expect(h.stderr).toHaveLength(1);
    expect(h.stderr[0]).toContain("call log tap disabled");
    expect(h.lines).toEqual([]);

    h.receive(toolCall(2));
    await h.send(response(2, { content: [] }));
    h.fireClose();

    expect(h.sent).toHaveLength(2);
    expect(h.stderr).toHaveLength(1);
    expect(h.lines).toEqual([]);
    expect(h.logClose).toHaveBeenCalledTimes(1);
  });

  it("hands an inner send rejection back to the caller untouched, recording nothing", async () => {
    const broken = new Error("EPIPE: broken pipe");
    const h = harness({ failSendWith: broken });
    h.receive(toolCall(1));
    await expect(h.send(response(1, { content: [] }))).rejects.toBe(broken);
    expect(h.lines).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  it("records nothing while the response is still on its way out", async () => {
    const h = harness();
    h.receive(toolCall(1));
    const sending = h.send(response(1, { content: [{ type: "text", text: "the answer" }] }));

    expect(h.sent).toHaveLength(1);
    expect(h.lines).toEqual([]);
    await sending;
    expect(h.lines.length).toBeGreaterThan(0);
  });

  it("writes every line with its response already on the wire", async () => {
    const sent: JSONRPCMessage[] = [];
    const widthAtWrite: number[] = [];
    const h = harness({ sentSink: sent, onWrite: () => widthAtWrite.push(sent.length) });
    h.receive(toolCall(1));
    await h.send(response(1, { content: [] }));

    expect(sent).toHaveLength(1);
    expect(widthAtWrite).toEqual([1, 1]);
  });

  it("does not make the next message wait for the log of the one before it", async () => {
    const h = harness({ holdSends: true });
    h.receive(toolCall(1));
    h.receive(toolCall(2));
    const first = h.send(response(1, { content: [] }));
    const second = h.send(response(2, { content: [] }));

    expect(h.sent).toHaveLength(2);
    expect(h.lines).toEqual([]);
    h.releaseSends();
    await Promise.all([first, second]);
    expect(calls(h.lines).map((line) => line.seq)).toEqual([1, 2]);
  });

  it("still hands the message to the handler when reading it faults", async () => {
    const poisoned = {
      get name(): string {
        throw new Error("a params object that throws when read");
      },
    };
    const h = harness();

    h.receive({ jsonrpc: "2.0", id: 1, method: "tools/call", params: poisoned } as unknown as JSONRPCMessage);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.stderr).toHaveLength(1);
    expect(h.stderr[0]).toContain("call log tap disabled");

    await h.send(response(1, { content: [] }));
    h.receive(toolCall(2));
    await h.send(response(2, { content: [] }));
    expect(h.handler).toHaveBeenCalledTimes(2);
    expect(h.sent).toHaveLength(2);
    expect(h.lines).toEqual([]);
    expect(h.stderr).toHaveLength(1);
  });
});

describe("one record per outcome", () => {
  it("records an answer without `isError` as ok, with what it answered", async () => {
    const h = harness();
    h.receive(toolCall(7));
    await h.send(
      response(7, {
        content: [{ type: "text", text: "3 symbols" }, { type: "image", data: "x" }],
        structuredContent: { symbols: [{}, {}, {}], scope: { limits: ["compile-database-only"] } },
      }),
    );

    expect(calls(h.lines)).toHaveLength(1);
    expect(h.lines.at(-1)).toMatchObject({
      type: "call",
      seq: 1,
      tool: "cpp_file_symbols",
      lang: "cpp",
      outcome: "ok",
      results: 3,
      limits: ["compile-database-only"],
      capped: false,
      project: "D:\\b",
      args: { projectRoot: "D:\\b", file: "a.cpp" },
      argKeys: [],
      errorClass: null,
      errorHead: null,
      textBytes: 9,
      cache: null,
      indexState: null,
    });
    expect(h.lines.at(-1)?.ms).toBeGreaterThanOrEqual(0);
    expect(h.lines.at(-1)?.inflight).toBe(0);
  });

  it("records `isError` without a payload as error, classified from the tool's own text", async () => {
    const failure = 'cpp_file_symbols failed: compile_commands.json not found or unreadable at "D:\\repo"';
    const h = harness();
    h.receive(toolCall(1, "cpp_file_symbols", { projectRoot: "D:\\repo", file: "a.cpp" }));
    await h.send(answered(1, failure));

    expect(h.lines.at(-1)).toMatchObject({
      outcome: "error",
      errorClass: "compile-db-missing",
      errorHead: 'cpp_file_symbols failed: compile_commands.json not found or unreadable at "…"',
      results: null,
      limits: [],
      capped: false,
      textBytes: Buffer.byteLength(failure, "utf8"),
    });
  });

  it("records `isError` with a payload as partial, which is the sweep ceiling's answer", async () => {
    const h = harness();
    h.receive(toolCall(1, "cpp_find_derived_classes", { projectRoot: "D:\\b", qualifiedName: "Base" }));
    await h.send(
      answered(1, "cpp_find_derived_classes swept 3/9 translation units within its 5000 ms ceiling", {
        matches: [{}, {}, {}],
        sweep: { cache: "partial" },
      }),
    );

    expect(h.lines.at(-1)).toMatchObject({
      outcome: "partial",
      errorClass: "budget-exceeded",
      results: 3,
      cache: "partial",
      project: "D:\\b",
    });
  });

  it("records a JSON-RPC error response as protocol-error, deriving nothing from a payload it never had", async () => {
    const h = harness();
    h.receive(toolCall(1));
    await h.send({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } } as JSONRPCMessage);

    expect(h.lines.at(-1)).toMatchObject({
      outcome: "protocol-error",
      errorClass: "other",
      errorHead: "Method not found",
      results: null,
      limits: [],
      textBytes: 0,
    });
  });

  it("records a cancelled call once, from the notification, and ignores the answer that arrives after it", async () => {
    const h = harness();
    h.receive(toolCall(4));
    h.receive({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } } as JSONRPCMessage);
    await h.send(response(4, { content: [{ type: "text", text: "late" }] }));

    expect(calls(h.lines)).toHaveLength(1);
    expect(h.lines.at(-1)).toMatchObject({ outcome: "cancelled", errorClass: null, results: null });
  });

  it("records an abandoned call for each one still in flight when the transport closes", () => {
    const h = harness();
    h.receive(toolCall(5));
    h.receive(toolCall(6));
    h.fireClose();

    expect(calls(h.lines).map((line) => line.outcome)).toEqual(["abandoned", "abandoned"]);
    expect(h.logClose).toHaveBeenCalledTimes(1);
  });

  it("never records one call twice, whatever arrives after its answer", async () => {
    const h = harness();
    h.receive(toolCall(1));
    await h.send(response(1, { content: [] }));
    await h.send(response(1, { content: [] }));
    h.receive({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } } as JSONRPCMessage);

    expect(calls(h.lines)).toHaveLength(1);
  });

  it("records nothing for the requests that are not tool calls", async () => {
    const h = harness();
    h.receive({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } as JSONRPCMessage);
    await h.send(response(1, { tools: [] }));
    h.receive({ jsonrpc: "2.0", id: 2, method: "ping", params: {} } as JSONRPCMessage);
    await h.send(response(2, {}));

    expect(h.lines).toEqual([]);
  });

  it("records a request whose parameters do not read as a tool call, rather than faulting on it", async () => {
    const h = harness();
    h.receive({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 7 } } as unknown as JSONRPCMessage);
    await h.send(response(1, { content: [] }));

    expect(h.lines.at(-1)).toMatchObject({ tool: "", lang: null, args: {}, argKeys: [] });
    expect(h.stderr).toEqual([]);
  });

  it("counts the calls that were already in flight when a call arrived, and numbers every record", async () => {
    const h = harness();
    h.receive(toolCall(1));
    h.receive(toolCall(2));
    h.receive(toolCall(3));
    for (const id of [1, 2, 3]) await h.send(response(id, { content: [] }));

    expect(calls(h.lines).map((line) => line.inflight)).toEqual([0, 1, 2]);
    expect(calls(h.lines).map((line) => line.seq)).toEqual([1, 2, 3]);
  });
});

describe("the run header", () => {
  it("is the line before the first call and carries what is constant for the process", async () => {
    const h = harness();
    h.receive({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "qwen-cli-mcp-client-mcp-code-nav", version: "0.0.1" },
      },
    } as JSONRPCMessage);
    await h.send(response(0, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "v" } }));
    expect(h.lines).toEqual([]);

    h.receive(toolCall(1));
    await h.send(response(1, { content: [] }));
    h.receive(toolCall(2));
    await h.send(response(2, { content: [] }));

    expect(h.lines.map((line) => line.type)).toEqual(["run", "call", "call"]);
    expect(h.lines.at(0)).toMatchObject({
      type: "run",
      build: "v1.2.3",
      cwd: "D:\\work",
      protocol: "2025-06-18",
      node: process.version,
      pid: process.pid,
      client: { name: "qwen-cli-mcp-client-mcp-code-nav", version: "0.0.1" },
    });
    expect(calls(h.lines).every((line) => line.run === h.lines.at(0)?.run)).toBe(true);
  });

  it("bounds what the client names itself, so an unbounded name cannot push a record past its cap", async () => {
    const h = harness();
    h.receive({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "n".repeat(5000), version: "v".repeat(5000), title: "t".repeat(5000) },
      },
    } as JSONRPCMessage);
    h.receive(toolCall(1));
    await h.send(response(1, { content: [] }));

    expect(h.lines.at(0)).toMatchObject({
      type: "run",
      client: { name: "n".repeat(200), version: "v".repeat(200), title: "t".repeat(200) },
    });
  });

  it("says the client was unnamed rather than inventing one", async () => {
    const h = harness();
    h.receive({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    } as JSONRPCMessage);
    h.receive(toolCall(1));
    await h.send(response(1, { content: [] }));

    expect(h.lines.at(0)).toMatchObject({ type: "run", client: null, protocol: "2025-06-18" });
  });
});

describe("what the language-server layer notes", () => {
  it("lands in the record of the call that noted it, and nowhere else", async () => {
    const h = harness();
    h.handler.mockImplementation((message: JSONRPCMessage) => {
      const id = "id" in message ? message.id : undefined;
      if (id === 1) {
        noteSession(true);
        noteReadyWait(42);
      }
      if (id === 2) noteSession(false);
    });

    h.receive(toolCall(1));
    await h.send(response(1, { content: [] }));
    h.receive(toolCall(2));
    await h.send(response(2, { content: [] }));
    noteSession(true);
    noteReadyWait(999);

    expect(calls(h.lines).at(0)).toMatchObject({ spawned: true, readyWaitMs: 42 });
    expect(calls(h.lines).at(1)).toMatchObject({ spawned: false, readyWaitMs: null });
  });

  it("picks up the session a real tool call created, through the real session manager", async () => {
    const h = harness();
    const sessions = new LspSessionManager();
    h.handler.mockImplementation((message: JSONRPCMessage) => {
      if ("method" in message && message.method === "tools/call") sessions.get("D:\\b", clangdConfig);
    });

    h.receive(toolCall(1));
    await h.send(response(1, { content: [] }));
    expect(calls(h.lines).at(-1)).toMatchObject({ spawned: true });

    h.receive(toolCall(2));
    await h.send(response(2, { content: [] }));
    expect(calls(h.lines).at(-1)).toMatchObject({ spawned: false });
  });
});

describe("the caps, end to end", () => {
  it("trims an over-long argument to 300 characters", async () => {
    const h = harness();
    h.receive(toolCall(1, "cpp_file_symbols", { projectRoot: "D:\\b", file: "x".repeat(400) }));
    await h.send(response(1, { content: [] }));

    const args = calls(h.lines).at(-1)?.args as Record<string, string>;
    expect(args.file).toHaveLength(300);
    expect(calls(h.lines).at(-1)?.argsDropped).toBeUndefined();
  });

  it("drops the arguments whole when the record would pass 4 KiB, naming what it dropped", async () => {
    const h = harness();
    h.receive(
      toolCall(1, "cpp_find_derived_classes", {
        projectRoot: "p".repeat(300),
        qualifiedName: "Base",
        files: Array.from({ length: 40 }, () => "f".repeat(300)),
      }),
    );
    await h.send(response(1, { content: [] }));

    const [line] = calls(h.lines);
    expect(line?.args).toEqual({});
    expect(line?.argsDropped).toBe(true);
    expect(line?.argKeys).toEqual([]);
  });

  it("names a parameter it is not allowed to record instead of storing its contents", async () => {
    const h = harness();
    h.receive(toolCall(1, "cpp_file_symbols", { projectRoot: "D:\\b", file: "a.cpp", auditToken: { user: "me" } }));
    await h.send(response(1, { content: [] }));

    expect(calls(h.lines).at(-1)).toMatchObject({
      args: { projectRoot: "D:\\b", file: "a.cpp" },
      argKeys: ["auditToken"],
    });
  });
});

describe("close", () => {
  it("flushes in-flight calls in its synchronous prefix, before a signal handler could exit", () => {
    const h = harness();
    h.receive(toolCall(1));
    const closing = h.transport.close();

    expect(calls(h.lines).map((line) => line.outcome)).toEqual(["abandoned"]);
    expect(h.logClose).toHaveBeenCalledTimes(1);
    return expect(closing).resolves.toBeUndefined();
  });

  it("still runs the handlers the server assigned, which is how the SDK learns the transport went away", () => {
    const h = harness();
    const seen: string[] = [];
    h.transport.onclose = () => void seen.push("assigned");
    h.transport.onerror = (error) => void seen.push(error.message);

    h.receive({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } } as JSONRPCMessage);
    h.fireClose();
    h.inner.onerror?.(new Error("the child died"));

    expect(seen).toEqual(["assigned", "the child died"]);
    expect(h.logClose).toHaveBeenCalledTimes(1);
  });

  it("runs the assigned close handler even when the log's own close throws", () => {
    const h = harness({ throwOnClose: true });
    const seen: string[] = [];
    h.transport.onclose = () => void seen.push("assigned");
    h.receive(toolCall(1));

    h.fireClose();

    expect(calls(h.lines).map((line) => line.outcome)).toEqual(["abandoned"]);
    expect(seen).toEqual(["assigned"]);
    expect(h.stderr).toHaveLength(1);
  });

  it("abandons every remaining call even when one of them faults on the way out", () => {
    const h = harness({ throwOnWrite: true });
    const seen: string[] = [];
    h.transport.onclose = () => void seen.push("assigned");
    h.receive(toolCall(1));
    h.receive(toolCall(2));

    h.fireClose();

    expect(h.stderr).toHaveLength(1);
    expect(seen).toEqual(["assigned"]);
  });
});

describe("watchStdinClose", () => {
  /** Wired as `src/index.ts` wires it: the shutdown closes the tap and exits in the same tick. */
  function watched() {
    const h = harness();
    const stdin = new EventEmitter();
    const exits: { calls: number; logClosed: number }[] = [];
    let shutdowns = 0;
    watchStdinClose(stdin, () => {
      shutdowns++;
      void h.transport.close();
      exits.push({ calls: calls(h.lines).length, logClosed: h.logClose.mock.calls.length });
    });
    return { h, stdin, exits, shutdowns: () => shutdowns };
  }

  it.each(["end", "close"])("runs the close path when stdin emits `%s`, with its records already written", (event) => {
    const { h, stdin, exits, shutdowns } = watched();
    h.receive(toolCall(1));
    h.receive(toolCall(2));

    stdin.emit(event);

    expect(shutdowns()).toBe(1);
    expect(exits).toEqual([{ calls: 2, logClosed: 1 }]);
    expect(calls(h.lines).map((line) => line.outcome)).toEqual(["abandoned", "abandoned"]);
  });

  it("is a no-op for the second event, as stdin emits `end` and then `close`", () => {
    const { h, stdin, shutdowns } = watched();
    h.receive(toolCall(1));

    stdin.emit("end");
    stdin.emit("close");

    expect(shutdowns()).toBe(1);
    expect(calls(h.lines)).toHaveLength(1);
    expect(h.logClose).toHaveBeenCalledTimes(1);
  });

  it("listens for nothing else", () => {
    const { stdin, shutdowns } = watched();

    stdin.emit("data", Buffer.from("x"));
    stdin.emit("readable");

    expect(shutdowns()).toBe(0);
  });
});
