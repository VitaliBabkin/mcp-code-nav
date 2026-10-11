/** What the transport tap reads out of a wire message: the logged arguments, and everything derived from a response. */
import { Buffer } from "node:buffer";
import { z } from "zod";
import { classifyError } from "./error-class.js";
import { CallRecord, LOGGED_ARG_KEYS, RESULT_COUNT_SELECTORS } from "./record.js";

/** A value the log can carry in plaintext — exactly the shape `ArgValue` in `record.ts` admits. */
export type LoggedArgValue = string | number | boolean | string[];

const MAX_ARG_STRING_CHARS = 300;
const MAX_ARG_ARRAY_ENTRIES = 20;
const MAX_ARG_KEY_NAMES = 100;
const MAX_ARG_KEY_CHARS = 80;
const MAX_PROJECT_CHARS = 300;
const MAX_RECORD_BYTES = 4096;
const CACHE_STATES = ["hit", "partial", "miss", "disabled"] as const;
const INDEX_STATES = ["quiescent", "building", "unknown"] as const;

/** What one call answered, read without touching a field the log has no business knowing. */
export type CallSummary = {
  readonly outcome: "ok" | "error" | "partial" | "protocol-error";
  readonly errorClass: string | null;
  readonly errorHead: string | null;
  readonly limits: readonly string[];
  readonly results: number | null;
  readonly capped: boolean;
  readonly cache: "hit" | "partial" | "miss" | "disabled" | null;
  readonly indexState: "quiescent" | "building" | "unknown" | null;
  readonly textBytes: number;
  readonly project: string | null;
};

type DerivedFields = Omit<CallSummary, "outcome" | "errorClass" | "errorHead" | "textBytes">;

/**
 * Allow-listed argument values plus the names of everything else, so an unexpected parameter stays countable
 * without its contents being copied to disk. A value whose shape `ArgValue` does not admit is named rather
 * than recorded — the log never carries an object — and the names are themselves bounded, because a caller
 * choosing many long key names must not be able to fill a record with nothing but them.
 */
export function pickArgs(rawArguments: unknown): {
  readonly args: Record<string, LoggedArgValue>;
  readonly argKeys: readonly string[];
} {
  const args: Record<string, LoggedArgValue> = {};
  const argKeys: string[] = [];
  for (const [key, value] of Object.entries(asRecord(rawArguments) ?? {})) {
    const logged = LOGGED_ARG_KEYS.has(key) ? loggedArgValue(value) : undefined;
    if (logged !== undefined) {
      args[key] = logged;
    } else if (argKeys.length < MAX_ARG_KEY_NAMES) {
      argKeys.push(key.slice(0, MAX_ARG_KEY_CHARS));
    }
  }
  return { args, argKeys };
}

/**
 * Over the record byte cap the arguments go first, because they are the unbounded part of a record: the
 * values, then — if the caller's own key names alone still overflow it — the names with them. `argsDropped`
 * states that neither survived.
 */
export function withinRecordCap(record: z.infer<typeof CallRecord>): z.infer<typeof CallRecord> {
  if (fitsRecord(record)) return record;
  const withoutArgs = { ...record, args: {}, argsDropped: true };
  return fitsRecord(withoutArgs) ? withoutArgs : { ...withoutArgs, argKeys: [] };
}

function fitsRecord(record: z.infer<typeof CallRecord>): boolean {
  return Buffer.byteLength(JSON.stringify(record), "utf8") <= MAX_RECORD_BYTES;
}

/**
 * Reads one outgoing JSON-RPC message as a call outcome. A JSON-RPC error response is `protocol-error` and
 * carries no payload fields, because the SDK answered before any tool ran.
 */
export function summarizeCall(
  tool: string,
  response: unknown,
  args: Readonly<Record<string, LoggedArgValue>>,
): CallSummary {
  const message = asRecord(response);
  const jsonRpcError = asRecord(message?.["error"]);
  if (jsonRpcError !== undefined && message?.["result"] === undefined) {
    return {
      outcome: "protocol-error",
      ...classify(textOf(jsonRpcError, "message") ?? ""),
      ...derive(undefined, tool, args),
      textBytes: 0,
    };
  }

  const result = asRecord(message?.["result"]);
  const structured = asRecord(result?.["structuredContent"]);
  const failed = result?.["isError"] === true;
  return {
    outcome: !failed ? "ok" : structured === undefined ? "error" : "partial",
    ...classify(failed ? firstTextBlock(result) : ""),
    ...derive(structured, tool, args),
    textBytes: textBytesOf(result),
  };
}

function classify(text: string): { errorClass: string | null; errorHead: string | null } {
  return text === "" ? { errorClass: null, errorHead: null } : classifyError(text);
}

function derive(
  structured: Record<string, unknown> | undefined,
  tool: string,
  args: Readonly<Record<string, LoggedArgValue>>,
): DerivedFields {
  const scope = asRecord(structured?.["scope"]);
  const limits = stringArray(scope?.["limits"]);
  return {
    limits,
    capped: limits.includes("listing-capped"),
    results: RESULT_COUNT_SELECTORS[tool]?.(structured) ?? null,
    cache: oneOf(CACHE_STATES, asRecord(structured?.["sweep"])?.["cache"]),
    indexState: oneOf(INDEX_STATES, asRecord(scope?.["index"])?.["state"]),
    project: projectOf(scope, args),
  };
}

/**
 * The C++ root the answer carries or the caller named; a Go answer names its module and a TS answer its
 * workspace, else the first declared root.
 */
function projectOf(scope: Record<string, unknown> | undefined, args: Readonly<Record<string, LoggedArgValue>>) {
  const root =
    textOf(scope ?? {}, "projectRoot") ??
    textOf(args, "projectRoot") ??
    textOf(scope ?? {}, "moduleRoot") ??
    textOf(scope ?? {}, "workspaceRoot") ??
    firstString(args["sourceRoots"]);
  return root === null ? null : root.slice(0, MAX_PROJECT_CHARS);
}

function firstTextBlock(result: Record<string, unknown> | undefined): string {
  for (const block of contentBlocks(result)) {
    const entry = asRecord(block);
    if (entry?.["type"] === "text" && typeof entry["text"] === "string") return entry["text"];
  }
  return "";
}

function textBytesOf(result: Record<string, unknown> | undefined): number {
  return contentBlocks(result).reduce<number>((total, block) => {
    const entry = asRecord(block);
    return entry?.["type"] === "text" && typeof entry["text"] === "string"
      ? total + Buffer.byteLength(entry["text"], "utf8")
      : total;
  }, 0);
}

function contentBlocks(result: Record<string, unknown> | undefined): readonly unknown[] {
  const blocks = result?.["content"];
  return Array.isArray(blocks) ? blocks : [];
}

function loggedArgValue(value: unknown): LoggedArgValue | undefined {
  if (typeof value === "string") return value.slice(0, MAX_ARG_STRING_CHARS);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return (value as string[]).slice(0, MAX_ARG_ARRAY_ENTRIES);
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

function textOf(container: Record<string, unknown>, key: string): string | null {
  const value = container[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function firstString(value: unknown): string | null {
  const [first] = Array.isArray(value) ? value : [];
  return typeof first === "string" && first !== "" ? first : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
