import { Direct, LABEL, runJob, type Handler } from "./handler.js";

/** Calls `handle` on a concrete `Direct`; the JSDoc is what makes tsgo's item range start above `export`. */
export function directCall(): string {
  const worker = new Direct();
  return worker.handle("a");
}

export function interfaceCall(worker: Handler): string {
  return worker.handle("b");
}

const picked = new Direct().handle;

export function functionValueCall(): string {
  return picked("c");
}

export function register(): unknown[] {
  return [1].map(new Direct().handle);
}

export function boundToNull(): unknown {
  return new Direct().handle.bind(null);
}

export function passJobBare(): unknown[] {
  return [1].map(runJob);
}

// A line comment leads this declaration as well.
export function arrowCall(): string {
  return runJob("d");
}

export function labelUse(): string {
  return LABEL;
}

/*
  `register`, `boundToNull` and `passJobBare` are MENTIONS of a member, never calls: the first two pass
  `handle` as a value (each is credited to its enclosing function, because a
  property access on the right side is enough), and the third passes `runJob` BARE, which the same rule does
  not reach. The two `[1].map(...)` lines are type errors on purpose - a value handed to `map` whose parameter
  does not match its callback is exactly what a mention looks like here.

  `directCall` and `arrowCall` carry a leading comment on purpose: a call-hierarchy item's range starts at that
  comment while `documentSymbol`'s range starts at `export`, and the rows must still be named.
*/
