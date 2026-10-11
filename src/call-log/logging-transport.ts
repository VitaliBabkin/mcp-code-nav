/** The transport decorator that records one line per `tools/call`, beside the SDK rather than around its callbacks. */
import { randomUUID } from "node:crypto";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { newCallAnnotations, withCallAnnotations, type CallAnnotations } from "./annotations.js";
import { CallRecord } from "./record.js";
import { pickArgs, summarizeCall, withinRecordCap, type CallSummary, type LoggedArgValue } from "./summarize-result.js";
import type { CallLog } from "./writer.js";

/** What is constant for the process and cannot be read off a message. */
export type CallLogMeta = {
  readonly build: string;
  readonly cwd: string;
};

const ToolCallParams = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});

const CancelledParams = z.object({ requestId: z.union([z.string(), z.number()]) });

const InitializeParams = z.object({
  protocolVersion: z.string().optional(),
  clientInfo: z.object({ name: z.string(), version: z.string(), title: z.string().optional() }).optional(),
});

type PendingCall = {
  readonly id: string | number;
  readonly tool: string;
  readonly args: Record<string, LoggedArgValue>;
  readonly argKeys: readonly string[];
  readonly receivedAt: number;
  /** A monotonic start for `ms`; `receivedAt` is the wall clock the record's `ts` is stamped from. */
  readonly beganAt: number;
  readonly inflight: number;
  readonly annotations: CallAnnotations;
};

type Client = { readonly name: string; readonly version: string; readonly title?: string };

const TOOL_CALL = "tools/call";
const CANCELLED = "notifications/cancelled";
const INITIALIZE = "initialize";
const TOOL_MAX_CHARS = 80;
const CLIENT_FIELD_MAX_CHARS = 200;

/**
 * Wraps the transport the server connects to. Every message is forwarded untouched and in order, and the
 * record for a call is built only after its response has gone out, so the log can never delay or change an
 * answer (the project rules). A fault inside the tap costs one line of stderr and disables the tap —
 * it never costs the caller its call.
 */
export function withCallLog(inner: Transport, log: CallLog, meta: CallLogMeta): Transport {
  return new CallLogTransport(inner, log, meta);
}

/**
 * Runs `onClose` the once a client hanging up can be seen as. SDK 1.29's stdio transport registers only
 * `data` and `error` on stdin, so an EOF never reaches `onclose` and the run would end with its in-flight
 * calls unrecorded and its closing line unwritten.
 */
export function watchStdinClose(
  stdin: { once(event: string, listener: () => void): unknown },
  onClose: () => void,
): void {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    onClose();
  };
  stdin.once("close", fire);
  stdin.once("end", fire);
  stdin.once("close", fire);
}

class CallLogTransport implements Transport {
  /** Assigned after the wrap, by `Protocol.connect` and by `src/index.ts`; read when the inner transport calls. */
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];

  private readonly pending = new Map<string | number, PendingCall>();
  private readonly runId = randomUUID();
  private client: Client | null = null;
  private protocol: string | null = null;
  private headerWritten = false;
  private sequence = 0;
  private tapped = true;
  private closed = false;

  constructor(
    private readonly inner: Transport,
    private readonly log: CallLog,
    private readonly meta: CallLogMeta,
  ) {
    inner.onclose = () => this.handleClosed();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message, extra) => this.handleMessage(message, extra);
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion = (version: string): void => {
    this.protocol = version;
    this.inner.setProtocolVersion?.(version);
  };

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    // Flushed before the first `await`, so a caller that closes and exits in the same tick still gets its
    // in-flight calls recorded — the async half is the inner transport's, not the log's.
    this.handleClosed();
    return this.inner.close();
  }

  /**
   * Forwarded first, always: the record is built only once the response is on the wire. A fault that lands
   * while a response is still being written therefore costs that one record and nothing else — turning the
   * tap back on to catch it would mean holding the response back, which is the thing this cannot do.
   */
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.inner.send(message, options);
    if (!this.tapped) return;
    try {
      this.settle(message);
    } catch (e) {
      this.disable(e);
    }
  }

  private handleMessage(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    const handler = this.onmessage;
    if (handler === undefined) return;
    if (!this.tapped) return handler(message, extra);
    let call: PendingCall | undefined;
    try {
      call = this.observe(message);
    } catch (e) {
      this.disable(e);
    }
    // Two facts no response carries are noted by the language-server layer while the SDK's handler runs, so
    // they have to land in this call's bag and nowhere else.
    if (call === undefined) return handler(message, extra);
    withCallAnnotations(call.annotations, () => handler(message, extra));
  }

  private observe(message: JSONRPCMessage): PendingCall | undefined {
    if (isJSONRPCNotification(message)) {
      const cancelled = CancelledParams.safeParse(message.params);
      if (message.method === CANCELLED && cancelled.success) this.cancel(cancelled.data.requestId);
      return undefined;
    }
    if (!isJSONRPCRequest(message)) return undefined;
    if (message.method === INITIALIZE) this.readClient(message.params);
    if (message.method !== TOOL_CALL) return undefined;
    const params = ToolCallParams.safeParse(message.params);
    const call: PendingCall = {
      id: message.id,
      tool: params.success ? params.data.name.slice(0, TOOL_MAX_CHARS) : "",
      ...pickArgs(params.success ? params.data.arguments : undefined),
      receivedAt: Date.now(),
      beganAt: performance.now(),
      inflight: this.pending.size,
      annotations: newCallAnnotations(),
    };
    this.pending.set(call.id, call);
    return call;
  }

  private readClient(params: unknown): void {
    const read = InitializeParams.safeParse(params);
    if (!read.success) return;
    const info = read.data.clientInfo;
    this.client =
      info === undefined
        ? null
        : {
            name: info.name.slice(0, CLIENT_FIELD_MAX_CHARS),
            version: info.version.slice(0, CLIENT_FIELD_MAX_CHARS),
            ...(info.title === undefined ? {} : { title: info.title.slice(0, CLIENT_FIELD_MAX_CHARS) }),
          };
    this.protocol ??= read.data.protocolVersion ?? null;
  }

  /**
   * The SDK sends no response once a call is cancelled, so this notification is the only moment that call can
   * be recorded at all — which is also why its `spawned`/`readyWaitMs` carry only what the handler had noted
   * by then. A session created after the cancel arrives is `null` here, not `false`.
   */
  private cancel(id: string | number): void {
    const call = this.pending.get(id);
    if (call === undefined) return;
    this.pending.delete(id);
    this.record(call, neverAnswered(call.tool), "cancelled");
  }

  private settle(message: JSONRPCMessage): void {
    if (!isJSONRPCResultResponse(message) && !isJSONRPCErrorResponse(message)) return;
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const call = this.pending.get(id);
    if (call === undefined) return;
    this.pending.delete(id);
    this.record(call, summarizeCall(call.tool, message, call.args));
  }

  /** The one place a line reaches the log, so the run header is always the line before the first call. */
  private record(call: PendingCall, summary: CallSummary, aborted?: "cancelled" | "abandoned"): void {
    if (!this.tapped) return;
    this.writeHeader();
    this.sequence++;
    this.log.write(
      withinRecordCap({
        v: 1,
        type: "call",
        run: this.runId,
        seq: this.sequence,
        ts: new Date(call.receivedAt).toISOString(),
        tool: call.tool,
        lang: languageOf(call.tool),
        project: summary.project,
        args: call.args,
        argKeys: [...call.argKeys],
        ms: Math.max(0, Math.round(performance.now() - call.beganAt)),
        inflight: call.inflight,
        outcome: aborted ?? summary.outcome,
        errorClass: summary.errorClass,
        errorHead: summary.errorHead,
        limits: [...summary.limits],
        results: summary.results,
        capped: summary.capped,
        cache: summary.cache,
        indexState: summary.indexState,
        spawned: call.annotations.spawned,
        readyWaitMs: call.annotations.readyWaitMs,
        textBytes: summary.textBytes,
      } satisfies z.infer<typeof CallRecord>),
    );
  }

  private writeHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;
    this.log.write({
      v: 1,
      type: "run",
      run: this.runId,
      ts: new Date().toISOString(),
      pid: process.pid,
      build: this.meta.build,
      node: process.version,
      cwd: this.meta.cwd,
      protocol: this.protocol,
      client: this.client,
    });
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of [...this.pending.values()]) {
      this.pending.delete(call.id);
      try {
        this.record(call, neverAnswered(call.tool), "abandoned");
      } catch (e) {
        this.disable(e);
      }
    }
    try {
      this.log.close();
    } catch (e) {
      this.disable(e);
    } finally {
      // The SDK's teardown and `src/index.ts`'s dispose hang off this, so it runs whatever the log did.
      this.onclose?.();
    }
  }

  /** One line, then silence: a tap that threw once is not trusted to throw inside a caller's call. */
  private disable(cause: unknown): void {
    if (!this.tapped) return;
    this.tapped = false;
    const detail = cause instanceof Error ? cause.message : String(cause);
    void process.stderr.write(`call log tap disabled: ${detail}\n`);
  }
}

/** What a call that never answered is known by: its name, and whatever the session layer noted about it. */
function neverAnswered(tool: string): CallSummary {
  return summarizeCall(tool, {}, {});
}

function languageOf(tool: string): string | null {
  const [prefix] = tool.split("_");
  return prefix === undefined || prefix === "" || prefix === tool ? null : prefix;
}
