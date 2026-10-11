/**
 * Success result: duplicated `text` block plus `structuredContent`, per `mcp-tool-response-contract.md`'s
 * backwards-compatibility rule. `text` overrides the JSON dump for callers whose first read is the prose;
 * `structuredContent` is the same object either way.
 */
export function successResult<T>(structuredContent: T, text?: string) {
  return {
    content: [{ type: "text" as const, text: text ?? JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

/** Execution error: `isError: true` inside a normal result, never a thrown JSON-RPC error — see `mcp-tool-response-contract.md`. */
export function errorResult(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

/** An execution that produced usable but incomplete data: `isError: true` so the caller branches, payload still carried. */
export function partialResult<T>(text: string, structuredContent: T) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

/** The human summary as the first key, for clients that pass the model `structuredContent` and drop `content`. */
export type WithSummary<T extends object> = { readonly summary: string } & T;

/** `{ summary, ...payload }`: the key order is the contract, a reader meets the summary before anything else. */
export function withSummary<T extends object>(summary: string, payload: T): WithSummary<T> {
  return { summary, ...payload };
}
