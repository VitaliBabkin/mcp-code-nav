/** The per-call bag the transport tap opens around the SDK's handler, so a fact no response carries can still reach the record. */
import { AsyncLocalStorage } from "node:async_hooks";

/** What a call learns from inside the language-server layer that its response does not state. */
export type CallAnnotations = {
  spawned: boolean | null;
  readyWaitMs: number | null;
};

const annotations = new AsyncLocalStorage<CallAnnotations>();

/** A fresh bag for one call; the tap keeps the reference and reads it when the response goes out. */
export function newCallAnnotations(): CallAnnotations {
  return { spawned: null, readyWaitMs: null };
}

/** Runs `handler` with `bag` as this call's annotations, so anything noted below it lands in this call. */
export function withCallAnnotations<T>(bag: CallAnnotations, handler: () => T): T {
  return annotations.run(bag, handler);
}

/**
 * Whether the session this call asked for was started by it. `true` wins over `false` because a call that
 * created one session and reused another was still the one that paid the spawn.
 */
export function noteSession(created: boolean): void {
  const bag = annotations.getStore();
  if (bag === undefined) return;
  bag.spawned = created || (bag.spawned ?? false);
}

/**
 * How long this call waited for its language server to prove readiness, summed across the waits of one call.
 * A zero is a fact, not an absence: it says the session was already proven, which a `null` does not.
 */
export function noteReadyWait(ms: number): void {
  const bag = annotations.getStore();
  if (bag === undefined || !Number.isFinite(ms) || ms < 0) return;
  bag.readyWaitMs = Math.round((bag.readyWaitMs ?? 0) + ms);
}
