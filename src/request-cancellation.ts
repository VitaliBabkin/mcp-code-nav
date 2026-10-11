/** The transport decorator that turns a client's `notifications/cancelled` into an `AbortSignal` for the call. */
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
import { withRequestSignal } from "./lsp/request-scope.js";

const CancelledParams = z.object({ requestId: z.union([z.string(), z.number()]) });

const CANCELLED = "notifications/cancelled";
const TOOL_CALL = "tools/call";

/**
 * Wraps the transport the server connects to. Each `tools/call` request is handled inside a scope that carries
 * an `AbortSignal`; the signal fires when the client cancels that request or the transport closes, and the
 * language-server layer reads it from the scope to cancel the work it started for the call.
 */
export function withRequestCancellation(inner: Transport): Transport {
  return new CancellationTransport(inner);
}

class CancellationTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];

  private readonly inflight = new Map<string | number, AbortController>();

  constructor(private readonly inner: Transport) {
    inner.onclose = () => {
      this.abortAll();
      this.onclose?.();
    };
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message, extra) => this.handleMessage(message, extra);
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion = (version: string): void => {
    this.inner.setProtocolVersion?.(version);
  };

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    this.abortAll();
    return this.inner.close();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.inner.send(message, options);
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== undefined) {
      this.inflight.delete(message.id);
    }
  }

  private handleMessage(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    const handler = this.onmessage;
    if (handler === undefined) return;
    if (isJSONRPCNotification(message) && message.method === CANCELLED) {
      const cancelled = CancelledParams.safeParse(message.params);
      if (cancelled.success) this.abort(cancelled.data.requestId);
    }
    if (isJSONRPCRequest(message) && message.method === TOOL_CALL) {
      const controller = new AbortController();
      this.inflight.set(message.id, controller);
      return withRequestSignal(controller.signal, () => handler(message, extra));
    }
    return handler(message, extra);
  }

  private abort(id: string | number): void {
    const controller = this.inflight.get(id);
    if (controller === undefined) return;
    this.inflight.delete(id);
    controller.abort(new Error("the client cancelled the call"));
  }

  private abortAll(): void {
    for (const id of [...this.inflight.keys()]) this.abort(id);
  }
}
