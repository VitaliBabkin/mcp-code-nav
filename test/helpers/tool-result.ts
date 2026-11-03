type TextContent = readonly { readonly type: "text"; readonly text: string }[];

/** The payload type of each union member that has one; a member without `structuredContent` contributes nothing. */
type StructuredOf<R> = R extends { readonly structuredContent?: infer S }
  ? "structuredContent" extends keyof R
    ? Exclude<S, undefined>
    : never
  : never;

/**
 * A tool result read as one shape. A handler returns a union of success, error and partial results, and only some
 * members carry `isError` or `structuredContent`, so a test reading either without narrowing does not compile.
 */
export interface ToolResultView<S> {
  readonly isError?: boolean;
  readonly content: TextContent;
  readonly structuredContent?: S;
}

export function resultView<R extends { readonly content: TextContent }>(
  result: R,
): ToolResultView<StructuredOf<R>>;
export function resultView(result: ToolResultView<unknown>): ToolResultView<unknown> {
  return result;
}

/** The payload of a result the test expects to carry one; fails the test with the result's text otherwise. */
export function payloadOf<R extends { readonly content: TextContent }>(result: R): StructuredOf<R> {
  const view = resultView(result);
  if (view.structuredContent === undefined) {
    throw new Error(
      `expected a payload, got: ${view.content.map((block) => block.text).join("\n")}`,
    );
  }
  return view.structuredContent;
}
