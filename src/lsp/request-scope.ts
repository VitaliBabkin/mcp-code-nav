/**
 * The cancellation signal of the MCP request currently being served, carried through `await`s so that work deep
 * in the language-server layer (a request to the child, a helper process) can stop when the client cancels,
 * without every tool function threading a parameter down to it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<AbortSignal>();

/** Runs `fn` with `signal` as the current request's signal; everything it awaits sees the same one. */
export function withRequestSignal<T>(signal: AbortSignal, fn: () => T): T {
  return scope.run(signal, fn);
}

/** The signal of the request this code is serving, or `undefined` outside any request (tests, scripts). */
export function currentRequestSignal(): AbortSignal | undefined {
  return scope.getStore();
}
