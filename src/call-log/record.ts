/** The per-call log's line schema — the source of truth for the writer and for `scripts/call-stats.ts`. */
import { z } from "zod";

/**
 * `ArgValue` is the closed shape a logged argument can take: a scalar or a list of paths. Anything else a
 * caller sent is recorded by name in `argKeys` instead, so a future parameter never fails an older reader.
 */
const ArgValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const RunRecord = z.object({
  v: z.literal(1),
  type: z.literal("run"),
  run: z.string(),
  ts: z.string(),
  pid: z.number().int(),
  build: z.string(),
  node: z.string(),
  cwd: z.string(),
  protocol: z.string().nullable(),
  client: z
    .object({ name: z.string(), version: z.string(), title: z.string().optional() })
    .nullable(),
});

export const CallRecord = z.object({
  v: z.literal(1),
  type: z.literal("call"),
  run: z.string(),
  seq: z.number().int().positive(),
  ts: z.string(),
  tool: z.string().max(80),
  lang: z.string().nullable(),
  project: z.string().nullable(),
  args: z.record(ArgValue),
  argKeys: z.array(z.string()),
  argsDropped: z.boolean().optional(),
  ms: z.number().int().nonnegative(),
  inflight: z.number().int().nonnegative(),
  outcome: z.enum(["ok", "error", "partial", "protocol-error", "cancelled", "abandoned"]),
  errorClass: z.string().nullable(),
  errorHead: z.string().nullable(),
  limits: z.array(z.string()),
  results: z.number().int().nonnegative().nullable(),
  capped: z.boolean(),
  cache: z.enum(["hit", "partial", "miss", "disabled"]).nullable(),
  indexState: z.enum(["quiescent", "building", "unknown"]).nullable(),
  spawned: z.boolean().nullable(),
  readyWaitMs: z.number().int().nonnegative().nullable(),
  textBytes: z.number().int().nonnegative(),
});

/** What the bounded queue refused to hold, stated once when the run closes. */
export const CloseRecord = z.object({
  v: z.literal(1),
  type: z.literal("close"),
  run: z.string(),
  ts: z.string(),
  dropped: z.number().int().nonnegative(),
});

export const CallLogLine = z.discriminatedUnion("type", [RunRecord, CallRecord, CloseRecord]);

/**
 * Arguments recorded in plaintext. Everything is a path, a name, or a small scalar — no tool takes source
 * text — and the log stays on the local disk; it is off unless a directory is configured.
 * A parameter missing from this set is recorded by name only, so the drift-guard test is what binds a new
 * tool to this list.
 */
export const LOGGED_ARG_KEYS: ReadonlySet<string> = new Set([
  "projectRoot",
  "sourceRoots",
  "file",
  "files",
  "name",
  "symbol",
  "anchor",
  "qualifiedName",
  "kind",
  "derivation",
  "depth",
  "includeDeclaration",
  "timeBudgetMs",
]);

/**
 * Where each tool's answer count lives. A selector reads a payload it was not built for and answers `null`
 * rather than throwing, so a payload change costs a report a column and never a call. `cpp_find_symbol`
 * answers one declaration and has no list to count, hence the constant 1.
 */
export const RESULT_COUNT_SELECTORS: Readonly<Record<string, (payload: unknown) => number | null>> = {
  cpp_file_symbols: (payload) => lengthOf(payload, "symbols"),
  go_file_symbols: (payload) => lengthOf(payload, "symbols"),
  cpp_find_symbol: (payload) => (asRecord(payload) === undefined ? null : 1),
  go_find_symbol: (payload) => lengthOf(payload, "declarations"),
  cpp_find_references: (payload) => countOf(payload, "totalReferences"),
  go_find_references: (payload) => countOf(payload, "totalReferences"),
  cpp_find_callers: (payload) => countOf(payload, "totalCallers"),
  go_find_callers: (payload) => countOf(payload, "totalCallers"),
  cpp_find_derived_classes: (payload) => lengthOf(payload, "matches"),
  go_find_implementations: (payload) => lengthOf(payload, "implementations"),
  ts_file_symbols: (payload) => lengthOf(payload, "symbols"),
  ts_find_symbol: (payload) => lengthOf(payload, "declarations"),
  ts_find_references: (payload) => countOf(payload, "totalReferences"),
  ts_find_callers: (payload) => countOf(payload, "totalCallers"),
  ts_find_implementations: (payload) => lengthOf(payload, "implementations"),
};

function asRecord(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function lengthOf(payload: unknown, key: string): number | null {
  const list = asRecord(payload)?.[key];
  return Array.isArray(list) ? list.length : null;
}

function countOf(payload: unknown, key: string): number | null {
  const value = asRecord(payload)?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
