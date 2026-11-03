import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionError, ConnectionErrors, ResponseError } from "vscode-jsonrpc/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defaultSpawnLsp, type LspProcess } from "../../src/lsp/process.js";
import {
  RequestAbortedError,
  RequestTimeoutError,
  sendWithControl,
} from "../../src/lsp/request-control.js";
import { clangdConfig, type LanguageServerConfig } from "../../src/lsp/server-config.js";

/**
 * The real `defaultSpawnLsp` and `sendWithControl` over the real vscode-jsonrpc, against a language server that
 * is a dozen lines of raw `Content-Length` framing written here and shares no code with that library. What the
 * server received is appended to a log file, so a test asserts the bytes that reached the wire (the
 * `$/cancelRequest` frame in particular) rather than the library's own account of having sent them.
 */
const FAKE_SERVER = `
const fs = require("node:fs");
const wireLog = process.argv[2];
let pending = Buffer.alloc(0);
function reply(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const headerEnd = pending.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(pending.subarray(0, headerEnd).toString())[1]);
    const bodyEnd = headerEnd + 4 + length;
    if (pending.length < bodyEnd) return;
    const message = JSON.parse(pending.subarray(headerEnd + 4, bodyEnd).toString());
    pending = pending.subarray(bodyEnd);
    fs.appendFileSync(wireLog, JSON.stringify(message) + "\\n");
    if (message.method === "echo") reply({ id: message.id, result: { echoed: message.params } });
    if (message.method === "refuse") {
      reply({ id: message.id, error: { code: -32803, message: "the server refused" } });
    }
  }
});
`;

const Frame = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});
type Frame = z.infer<typeof Frame>;

const SERVER_ID = "fake-lsp";
const TEST_TIMEOUT_MS = 30_000;
const FRAME_DEADLINE_MS = 10_000;
const NEVER_MS = 600_000;
const noOverride = "MCP_CODE_NAV_TEST_NO_SUCH_OVERRIDE";

describe("the real JSON-RPC connection behind defaultSpawnLsp, against a raw Content-Length server", () => {
  let dir: string;
  let wireLog: string;
  let proc: LspProcess;

  const framesOnWire = (): Frame[] => {
    if (!existsSync(wireLog)) return [];
    // The last element is "" after a complete line, or a line still being written: never parse it.
    return readFileSync(wireLog, "utf8")
      .split("\n")
      .slice(0, -1)
      .map((line) => Frame.parse(JSON.parse(line)));
  };

  const untilFrame = (matches: (frame: Frame) => boolean): Promise<Frame> =>
    vi.waitFor(
      () => {
        const found = framesOnWire().find(matches);
        if (found === undefined) throw new Error("that frame is not on the wire yet");
        return found;
      },
      { timeout: FRAME_DEADLINE_MS, interval: 10 },
    );

  const send = (method: string, params: unknown, signal?: AbortSignal, timeoutMs = NEVER_MS) =>
    sendWithControl<unknown>(proc.connection, method, params, {
      serverId: SERVER_ID,
      timeoutMs,
      signal,
    });

  const config = (script: string): LanguageServerConfig => ({
    ...clangdConfig,
    command: process.execPath,
    commandEnvOverride: noOverride,
    argv: () => [script, wireLog],
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-wire-"));
    wireLog = join(dir, "wire.jsonl");
    const script = join(dir, "fake-server.cjs");
    writeFileSync(script, FAKE_SERVER);
    proc = defaultSpawnLsp(dir, config(script));
  });

  afterEach(async () => {
    vi.useRealTimers();
    proc.kill();
    // The child's working directory is `dir`; Windows refuses to delete it until the child has gone.
    await vi.waitFor(() => expect(proc.isAlive()).toBe(false), { timeout: FRAME_DEADLINE_MS });
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it(
    "round-trips a request and its result, and writes no cancellation for a request that was answered",
    async () => {
      const result = await send("echo", { hello: "wire" });

      expect(result).toEqual({ echoed: { hello: "wire" } });
      expect(framesOnWire().map((frame) => frame.method)).toEqual(["echo"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "surfaces an error response as a ResponseError carrying the server's code",
    async () => {
      const failure = await send("refuse", {}).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ResponseError);
      expect(failure).toMatchObject({ code: -32803 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects an unanswered request with RequestTimeoutError and puts $/cancelRequest for its id on the wire",
    async () => {
      await send("echo", {});
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const outcome = send("hang", {}, undefined, 60_000).catch((e: unknown) => e);
      const request = await untilFrame((frame) => frame.method === "hang");
      vi.advanceTimersByTime(60_000);

      const timedOut = await outcome;
      expect(timedOut).toBeInstanceOf(RequestTimeoutError);
      expect(timedOut).toMatchObject({ serverId: SERVER_ID, method: "hang" });
      expect(String(timedOut)).toContain(`${SERVER_ID} did not answer hang`);
      const cancel = await untilFrame((frame) => frame.method === "$/cancelRequest");
      expect(request.id).toBeTypeOf("number");
      expect(cancel.params).toEqual({ id: request.id });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects an aborted request with RequestAbortedError and puts $/cancelRequest for its id on the wire",
    async () => {
      await send("echo", {});
      const controller = new AbortController();

      const outcome = send("hang", {}, controller.signal).catch((e: unknown) => e);
      const request = await untilFrame((frame) => frame.method === "hang");
      controller.abort();

      const aborted = await outcome;
      expect(aborted).toBeInstanceOf(RequestAbortedError);
      expect(aborted).toMatchObject({ serverId: SERVER_ID, method: "hang" });
      expect(String(aborted)).toContain(`${SERVER_ID} hang was cancelled`);
      const cancel = await untilFrame((frame) => frame.method === "$/cancelRequest");
      expect(request.id).toBeTypeOf("number");
      expect(cancel.params).toEqual({ id: request.id });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a new request once the server was killed, because the connection is disposed",
    async () => {
      await send("echo", {});

      proc.kill();
      await vi.waitFor(() => expect(proc.isAlive()).toBe(false), { timeout: FRAME_DEADLINE_MS });
      const failure = await send("echo", {}).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ConnectionError);
      expect(failure).toMatchObject({ code: ConnectionErrors.Disposed });
    },
    TEST_TIMEOUT_MS,
  );
});
