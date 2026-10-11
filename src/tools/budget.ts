// One tool call's wall-clock ceiling, and the race that bounds a wait by it. Nothing here knows what it is
// waiting for: a language-server request, a subprocess, a directory walk — the caller decides, and every
// call that spends a budget shares this expiry rather than writing its own.

/** One call's wall-clock ceiling, counting down from the moment the handler started. */
export interface Budget {
  readonly ceilingMs: number;
  remainingMs(): number;
}

export function budgetOf(ceilingMs: number): Budget {
  const expiresAt = Date.now() + ceilingMs;
  return { ceilingMs, remainingMs: () => Math.max(0, expiresAt - Date.now()) };
}

/**
 * Bounds the caller's wait, not the request: an in-flight request is not cancelled and the session stays
 * busy until the server answers. `undefined` is the timeout marker; a
 * caller whose value type could itself be `undefined` has nothing to race.
 */
export async function withinBudget<T>(work: Promise<T>, budget: Budget): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budget.remainingMs());
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
