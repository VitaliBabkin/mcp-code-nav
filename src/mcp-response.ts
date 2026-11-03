import { type ErrorReason, reasonFields } from "./error-reason.js";

/**
 * Success result: the `text` block duplicates `structuredContent` for clients that read only the prose. `text`
 * overrides the JSON dump for callers whose first read is the prose; `structuredContent` is the same object either way.
 */
export function successResult<T>(structuredContent: T, text?: string) {
  return {
    content: [{ type: "text" as const, text: text ?? JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

/**
 * Execution error: `isError: true` inside a normal result, never a thrown JSON-RPC error. The prose says why for a
 * reader; `reason` and `retryable` say it for a caller that branches.
 */
export function errorResult(text: string, reason: ErrorReason) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
    structuredContent: reasonFields(reason),
  };
}

/** An execution that produced usable but incomplete data: `isError: true` so the caller branches, payload still carried. */
export function partialResult<T extends object>(text: string, reason: ErrorReason, payload: T) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
    structuredContent: { ...payload, ...reasonFields(reason) },
  };
}

/** The human summary as the first key, for clients that pass the model `structuredContent` and drop `content`. */
export type WithSummary<T extends object> = { readonly summary: string } & T;

/** `{ summary, ...payload }`: the key order is the contract, a reader meets the summary before anything else. */
export function withSummary<T extends object>(summary: string, payload: T): WithSummary<T> {
  return { summary, ...payload };
}
