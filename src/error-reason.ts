/**
 * The closed set of causes an error result names in `structuredContent.reason`, and whether the identical call can
 * succeed later. `retryable` is a function of the reason alone, so a call site names the reason and never the flag.
 */

const RETRYABLE = {
  "input-invalid": false,
  "tool-unknown": false,
  "path-escape": false,
  "path-ambiguous": false,
  "path-ignored": false,
  "file-not-found": false,
  "no-module": false,
  "compile-db-missing": false,
  "compile-db-invalid": false,
  "server-unavailable": false,
  "symbol-not-found": false,
  "symbol-ambiguous": false,
  "symbol-kind-unsupported": false,
  "not-ready": true,
  "budget-exceeded": true,
  "request-timeout": true,
  "session-lost": true,
  cancelled: true,
  "sweep-failed": false,
  "unexpected-answer": false,
  internal: false,
} as const satisfies Record<string, boolean>;

export type ErrorReason = keyof typeof RETRYABLE;

export const ERROR_REASONS: readonly ErrorReason[] = Object.keys(RETRYABLE) as ErrorReason[];

/** True when the identical call, unchanged, may succeed later: readiness, budgets, restarts, cancellation. */
export function isRetryable(reason: ErrorReason): boolean {
  return RETRYABLE[reason];
}

/**
 * What an error result carries in `structuredContent`, beside any partial payload. A type alias, not an interface:
 * the SDK's `structuredContent` is an index-signature record, which only an alias satisfies.
 */
export type ErrorReasonFields = { readonly reason: ErrorReason; readonly retryable: boolean };

export function reasonFields(reason: ErrorReason): ErrorReasonFields {
  return { reason, retryable: isRetryable(reason) };
}
