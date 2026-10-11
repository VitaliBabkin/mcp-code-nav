import { spawn, type ChildProcess } from "node:child_process";
import type { CancellationToken, Disposable, ErrorCodes, GenericRequestHandler, MessageConnection, ProgressToken, ProgressType } from "vscode-jsonrpc/node";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { LanguageServerUnavailableError, type LanguageServerConfig, type SpawnAttempt } from "./server-config.js";
import { drainStderr, stderrNote, StderrTail } from "./stderr-tail.js";

/**
 * The four `MessageConnection` operations this server uses. A real connection provides all of them;
 * the narrow type exists because `defaultSpawnLsp` hands back a connection whose writes wait for the
 * child, and only these four operations can be deferred without pretending to re-export the protocol.
 */
export interface LspConnection {
  sendRequest<R>(method: string, params?: unknown, token?: CancellationToken): Promise<R>;
  sendNotification(method: string, params?: unknown): Promise<void>;
  onRequest(method: string, handler: GenericRequestHandler<unknown, ErrorCodes>): Disposable;
  onProgress<P>(type: ProgressType<P>, token: ProgressToken, handler: (value: P) => void): Disposable;
}

/** One live language-server child process plus its JSON-RPC connection. */
export interface LspProcess {
  readonly connection: LspConnection;
  isAlive(): boolean;
  kill(): void;
  /** Why the child could not be spawned, when it could not; `undefined` otherwise. */
  spawnFailure(): LanguageServerUnavailableError | undefined;
  /** The last lines the child wrote to stderr, bounded; absent on a process that does not capture them. */
  stderrTail?(): string;
  /** Resolves when the child's stderr has ended, so a tail read after it is complete. */
  stderrSettled?(): Promise<void>;
}

/** Injection seam for tests — real spawning shells out to the config's binary. */
export type SpawnLsp = (root: string, config: LanguageServerConfig) => LspProcess;

/** The slice of `ChildProcess` (or a test double) `attachLifecycleHandlers` needs. */
export interface LifecycleChild {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
}

/** The slice of `MessageConnection` (or a test double) `attachLifecycleHandlers` needs. */
export interface DisposableConnection {
  dispose(): void;
}

/** What `attachLifecycleHandlers` tracks about one child process. */
export interface LifecycleState {
  isAlive(): boolean;
  spawnFailure(): LanguageServerUnavailableError | undefined;
}

/**
 * Tracks whether the child process is still alive and forces any in-flight `sendRequest` to
 * reject as soon as it isn't. Real `vscode-jsonrpc` does NOT auto-reject a pending request just
 * because its underlying stream closed — only `connection.dispose()` does that (verified by
 * reading its source) — so both a graceful `'exit'` and a spawn-time `'error'` (missing/
 * misconfigured binary, ENOENT) must call `dispose()` themselves, or a mid-request crash hangs
 * the caller forever instead of surfacing as a rejection `LspSession.documentSymbol` can catch
 * and retry against a respawned process. An `'error'` listener is also required independently of
 * this: Node re-throws an unhandled `'error'` event as an uncaught exception that kills the whole
 * process, so its absence takes down every project's session, not just the one call that hit it.
 *
 * The `'error'` argument is retained rather than discarded because a spawn failure cannot be thrown
 * from `spawn()` itself — Node delivers it asynchronously, after the process object has been handed
 * back. It is recorded here as a `LanguageServerUnavailableError` for the session to surface in place
 * of the connection's own opaque "disposed" rejection.
 */
export function attachLifecycleHandlers(child: LifecycleChild, connection: DisposableConnection, attempt: SpawnAttempt): LifecycleState {
  let alive = true;
  let disposed = false;
  let failure: LanguageServerUnavailableError | undefined;
  const markDead = () => {
    alive = false;
    if (disposed) return;
    disposed = true;
    connection.dispose();
  };
  child.on("error", (error) => {
    failure ??= new LanguageServerUnavailableError(attempt, { code: error.code, cause: error });
    markDead();
  });
  child.on("exit", markDead);
  return { isAlive: () => alive, spawnFailure: () => failure };
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** The override names an absolute binary; without it `config.command` is looked up on PATH. */
function spawnAttempt(config: LanguageServerConfig): SpawnAttempt {
  const override = process.env[config.commandEnvOverride];
  return override ? { config, attempted: override, fromOverride: true } : { config, attempted: config.command, fromOverride: false };
}

function spawnChild(attempt: SpawnAttempt, root: string, config: LanguageServerConfig): ChildProcess {
  try {
    return spawn(attempt.attempted, [...config.argv(root)], {
      cwd: root,
      env: { ...process.env, ...config.childEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    // A `.cmd`/`.bat` override on Windows is refused here rather than by an async `'error'` event,
    // so it has to be converted at the one place that knows what was attempted.
    throw new LanguageServerUnavailableError(attempt, { code: errorCode(e), cause: e });
  }
}

/** Resolves when Node confirms the child exists; rejects with the error `spawnFailure()` reports. */
function whenSpawned(child: ChildProcess, lifecycle: LifecycleState): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    // Registered after `attachLifecycleHandlers` attached its own `'error'` listener, so Node calls
    // that one first and the failure is recorded by the time this runs.
    child.once("error", () => reject(lifecycle.spawnFailure()));
  });
}

/**
 * The connection as callers see it, with every write held until the child is known to exist.
 *
 * Writing to a stdin that was never opened does not merely fail the write: `sendRequest` runs its
 * write inside `new Promise(async (resolve, reject) => …)`, and vscode-jsonrpc rethrows right after
 * rejecting (connection.js:1122-1150), so `ERR_STREAM_DESTROYED` comes back as an unhandled
 * rejection that no caller can catch — a missing binary would take down the whole MCP server. Held
 * back until `'spawn'`, a child that never started rejects each call with its own
 * `LanguageServerUnavailableError` and nothing is ever written.
 */
function gatedConnection(connection: MessageConnection, spawned: Promise<void>): LspConnection {
  // Every caller gets the rejection through its own chain; this keeps the shared promise itself from
  // counting as unhandled when nothing happens to be mid-request at the moment the child dies.
  spawned.catch(() => {});
  const afterSpawn = <T>(write: () => Promise<T>): Promise<T> => spawned.then(write);
  return {
    sendRequest: <R>(method: string, params?: unknown, token?: CancellationToken) =>
      afterSpawn(() => (token === undefined ? connection.sendRequest<R>(method, params) : connection.sendRequest<R>(method, params, token))),
    sendNotification: (method, params) => afterSpawn(() => connection.sendNotification(method, params)),
    onRequest: (method, handler) => connection.onRequest(method, handler),
    onProgress: (type, token, handler) => connection.onProgress(type, token, handler),
  };
}

/**
 * One block on this server's own stderr when a child ends on its own (not by `kill()`), so a crash leaves its last
 * words in the diagnostics even when no request was in flight to carry them.
 */
function reportUnexpectedExit(config: LanguageServerConfig, tail: StderrTail, code: number | null, signal: string | null): void {
  const how = signal === null ? `code ${String(code)}` : `signal ${signal}`;
  process.stderr.write(`mcp-code-nav: ${config.id} exited (${how})${stderrNote(config.id, tail.read())}\n`);
}

export const defaultSpawnLsp: SpawnLsp = (root, config) => {
  const attempt = spawnAttempt(config);
  const child = spawnChild(attempt, root, config);
  if (!child.stdout || !child.stdin) {
    throw new Error(`failed to spawn ${config.command}: missing stdio streams`);
  }
  const tail = new StderrTail();
  drainStderr(child.stderr, tail);
  let killedByUs = false;
  // A binary that never started has nothing to report; its failure is the `LanguageServerUnavailableError`.
  let started = false;
  child.once("spawn", () => {
    started = true;
  });
  child.once("close", (code, signal) => {
    if (started && !killedByUs) reportUnexpectedExit(config, tail, code, signal);
  });
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();
  const lifecycle = attachLifecycleHandlers(child, connection, attempt);
  return {
    connection: gatedConnection(connection, whenSpawned(child, lifecycle)),
    isAlive: lifecycle.isAlive,
    kill: () => {
      killedByUs = true;
      child.kill();
    },
    spawnFailure: lifecycle.spawnFailure,
    stderrTail: () => tail.read(),
    stderrSettled: () => tail.settled,
  };
};
