import { CancellationTokenSource } from "vscode-jsonrpc/node";
import { z } from "zod";
import type { LspConnection } from "./process.js";

/** Longest a single language-server request may stay unanswered before the caller gets a rejection. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

const ENV_VAR = "MCP_CODE_NAV_REQUEST_TIMEOUT_MS";
const TimeoutSchema = z.coerce.number().int().positive().max(3_600_000);

/**
 * The per-request timeout from the environment. Unset means the default; a value that is not a positive integer
 * (at most one hour) is reported through `onInvalid` and the default is used, so a typo never costs the server.
 */
export function resolveRequestTimeoutMs(env: NodeJS.ProcessEnv, onInvalid: (message: string) => void): number {
  const raw = env[ENV_VAR];
  if (raw === undefined || raw === "") return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = TimeoutSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  onInvalid(`${ENV_VAR}="${raw}" is not a positive integer of at most 3600000; using ${DEFAULT_REQUEST_TIMEOUT_MS}`);
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/** The server was sent a request and did not answer within the per-request timeout. */
export class RequestTimeoutError extends Error {
  constructor(
    readonly serverId: string,
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${serverId} did not answer ${method} within ${timeoutMs} ms; the request was cancelled.`);
    this.name = "RequestTimeoutError";
  }
}

/** The MCP client cancelled the call this request belonged to. */
export class RequestAbortedError extends Error {
  constructor(
    readonly serverId: string,
    readonly method: string,
  ) {
    super(`${serverId} ${method} was cancelled because the client cancelled the call.`);
    this.name = "RequestAbortedError";
  }
}

/** What bounds one request: the caller's cancellation, a deadline, and the server's name for messages. */
export interface RequestControl {
  readonly serverId: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Sends one request and settles it no later than the deadline or the signal. Either one also tells the server
 * (`$/cancelRequest` through the cancellation token) so it can stop the work, and rejects locally at once because
 * a server is not obliged to answer a cancellation.
 */
export function sendWithControl<R>(
  connection: LspConnection,
  method: string,
  params: unknown,
  control: RequestControl,
): Promise<R> {
  const { serverId, timeoutMs, signal } = control;
  if (signal?.aborted) return Promise.reject(new RequestAbortedError(serverId, method));
  const source = new CancellationTokenSource();
  return new Promise<R>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void, cancelServer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (cancelServer) source.cancel();
      source.dispose();
      settle();
    };
    const onAbort = (): void => finish(() => reject(new RequestAbortedError(serverId, method)), true);
    const timer = setTimeout(
      () => finish(() => reject(new RequestTimeoutError(serverId, method, timeoutMs)), true),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      connection.sendRequest<R>(method, params, source.token).then(
        (value) => finish(() => resolve(value), false),
        (error: unknown) => finish(() => reject(error), false),
      );
    } catch (error) {
      finish(() => reject(error), false);
    }
  });
}
