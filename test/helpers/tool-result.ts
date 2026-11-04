import { expect } from "vitest";
import type { ErrorReasonFields } from "../../src/error-reason.js";

type TextContent = readonly { readonly type: "text"; readonly text: string }[];

/**
 * The payload type of each union member that has one. A member without `structuredContent`, or a plain error whose
 * only content is its reason, contributes nothing; a partial result's payload-plus-reason stays.
 */
type StructuredOf<R> = R extends { readonly structuredContent?: infer S }
  ? "structuredContent" extends keyof R
    ? PayloadOnly<Exclude<S, undefined>>
    : never
  : never;

/** Distributes over a merged union of payloads, dropping the members that are a reason and nothing else. */
type PayloadOnly<S> = S extends unknown ? ([ErrorReasonFields] extends [S] ? never : S) : never;

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

/** Any result shape a test holds, typed by the handler or loosely by the test. */
interface LooseResult {
  readonly isError?: boolean;
  readonly content?: readonly { readonly text?: string }[];
  readonly structuredContent?: unknown;
}

/** The result's text; every result carries one text block. */
export function textOf(result: LooseResult): string {
  return result.content?.[0]?.text ?? "";
}

/** The payload of a result the test expects to carry one; fails the test with the result's text otherwise. */
export function payloadOf<R extends { readonly content: TextContent }>(result: R): StructuredOf<R> {
  const view = resultView(result);
  if (view.structuredContent === undefined) {
    throw new Error(`expected a payload, got: ${textOf(view)}`);
  }
  return view.structuredContent;
}

/**
 * The payload of a successful call, read as the test's own description of the fields it checks; fails the test
 * naming `tool` and its text when the call was an error.
 */
export function payloadAs<T>(result: LooseResult, tool: string): T {
  expect(result.isError, `${tool} failed: ${textOf(result)}`).toBeFalsy();
  // The caller's `T` states only the fields its cases read; the handler's declared payload is not narrowed to it.
  return result.structuredContent as T;
}

/** The payload as a plain record, for tests that read fields by name; fails the test when there is none. */
export function recordOf(result: LooseResult): Record<string, unknown> {
  const { structuredContent } = result;
  if (typeof structuredContent !== "object" || structuredContent === null) {
    throw new Error(`expected a payload, got: ${textOf(result)}`);
  }
  // A payload is a JSON object: string keys only.
  return structuredContent as Record<string, unknown>;
}

export function scopeOf(result: LooseResult): Record<string, unknown> {
  return recordOf(result).scope as Record<string, unknown>;
}

export function limitsOf(result: LooseResult): string[] {
  return scopeOf(result).limits as string[];
}

/** An own property of `value`, or undefined when `value` is not an object or lacks it. */
export function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
