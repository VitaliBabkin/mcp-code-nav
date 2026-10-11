/**
 * The stats report over the per-call log, with an opt-in view of Claude Code transcripts.
 * Read-only: the report goes to stdout
 * and nothing else is written. The two sources are never joined, because they share no key; each section
 * states its own denominator, and the footer names the calls neither source can see.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveCallLogConfig } from "../src/call-log/config.js";
import { classifyError } from "../src/call-log/error-class.js";
import { CallLogLine, type CallRecord, type RunRecord } from "../src/call-log/record.js";

/** At most this many tool events of any kind may sit between a failed call's result and the call that retries it. */
export const RETRY_WINDOW_EVENTS = 3;
/** A retry must start no later than this after the failed call's result; past it the agent moved on. */
export const RETRY_MAX_GAP_MS = 600_000;
/** How far after a call a same-identifier fallback search is still attributed to that call. */
export const FALLBACK_WINDOW_EVENTS = 5;

const DEFAULT_SERVER_NAME = "mcp-code-nav";
const OUTCOMES = ["ok", "error", "partial", "protocol-error", "cancelled", "abandoned"] as const;
const FAILING = ["error", "partial", "protocol-error"];
const ABORTED = ["cancelled", "abandoned"];
const CALL_FILE = /^calls-.*\.jsonl$/;
const JSONL = /\.jsonl$/;
const SUBAGENT_PATH = /(^|[\\/])subagents([\\/]|$)/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Claude Code refuses a bad argument before sending anything and says so in the transcript's own result. */
const CLIENT_SIDE_REJECTION = /InputValidationError/;
/** The "client-side class" bucket: a rejection the server never saw, so never classified. */
const CLIENT_SIDE_CLASS = "client-side-rejection";
const NO_PROJECT = "(no project)";
const NO_CLIENT = "(unknown client)";
const NO_CLASS = "unclassified";
const NO_BUILD = "(unknown build)";
const HEAD_ROWS = 20;
const DAY_MS = 86_399_999;
const USAGE =
  "usage: npm run stats -- [--logs <dir>] [--since <date>] [--until <date>] [--transcripts [<dir>]] [--server-name <name>] [--json]";
/** Anything outside this set is refused at the boundary rather than silently ignored. */
const KNOWN_FLAGS = new Set(["logs", "since", "until", "transcripts", "server-name", "json"]);

/**
 * The argument naming an identifier, per tool — only those calls can be followed by a same-identifier
 * fallback. A drift guard in `test/call-log/tools-surface.test.ts` binds this list to the schemas the server
 * actually registers, because a tool added beside these keys is otherwise silently unanalysed.
 */
export const IDENTIFIER_ARG: Readonly<Record<string, string>> = {
  cpp_find_symbol: "name",
  cpp_find_references: "name",
  cpp_find_callers: "name",
  cpp_find_derived_classes: "qualifiedName",
  go_find_symbol: "symbol",
  go_find_references: "symbol",
  go_find_callers: "symbol",
  go_find_implementations: "symbol",
  ts_find_symbol: "symbol",
  ts_find_references: "symbol",
  ts_find_callers: "symbol",
  ts_find_implementations: "symbol",
};

const SEARCH_PROGRAM = /\b(?:rg|ag|findstr|grep)\b|select-string/i;

type CallLine = z.infer<typeof CallRecord>;
type RunLine = z.infer<typeof RunRecord>;

export type Window = { readonly from: number | null; readonly to: number | null };

export type StatsOptions = {
  readonly logs: string;
  readonly transcripts: string | undefined;
  readonly serverName: string;
  readonly window: Window;
  readonly json: boolean;
};

const ArgSchema = z
  .object({
    logs: z.string().min(1),
    since: z.string(),
    until: z.string(),
    transcripts: z.string(),
    serverName: z.string().regex(/^[A-Za-z0-9._-]+$/),
    json: z.literal(true),
  })
  .partial()
  .strict();

type Flags = z.infer<typeof ArgSchema>;

/* ----------------------------------------------------------------- arguments */

/**
 * A date spelled as a bare `YYYY-MM-DD` bounds a whole UTC day, so `--until 2026-09-30` covers that day
 * instead of its first millisecond. A timestamp must carry a zone, because every stamp it is compared
 * against is UTC.
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv, home: string): StatsOptions {
  const read = ArgSchema.safeParse(readFlags(argv));
  if (!read.success) throw new Error(`bad stats arguments: ${describeIssues(read.error)}\n${USAGE}`);
  const flags = read.data;
  return {
    logs: resolve(flags.logs ?? defaultLogDir(env, home)),
    transcripts: flags.transcripts === undefined ? undefined : resolve(flags.transcripts || defaultTranscriptsDir(home)),
    serverName: flags.serverName ?? DEFAULT_SERVER_NAME,
    window: { from: instant(flags.since, "since", false), to: instant(flags.until, "until", true) },
    json: flags.json === true,
  };
}

/**
 * The directory the server writes to when it is told one, so the report reads the log where it actually is;
 * with the log off or unset there is no such directory, and the conventional `~/.mcp-code-nav/calls` is used.
 */
export function defaultLogDir(env: NodeJS.ProcessEnv, home: string): string {
  const config = resolveCallLogConfig(env);
  return config.kind === "on" ? config.dir : join(home, ".mcp-code-nav", "calls");
}

export function defaultTranscriptsDir(home: string): string {
  return join(home, ".claude", "projects");
}

function readFlags(argv: readonly string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) throw new Error(`unexpected argument "${token}"\n${USAGE}`);
    const name = token.slice(2);
    if (!KNOWN_FLAGS.has(name)) throw new Error(`unknown option --${name}\n${USAGE}`);
    const flag = camel(name);
    if (flag === "json") {
      flags["json"] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      // `--transcripts` is the only flag that may stand alone; bare means its default directory.
      if (flag !== "transcripts") throw new Error(`--${name} needs a value\n${USAGE}`);
      flags["transcripts"] = "";
      continue;
    }
    flags[flag] = value;
    index++;
  }
  return flags;
}

function instant(value: string | undefined, bound: "since" | "until", endOfDay: boolean): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || !isStamped(value)) {
    throw new Error(`--${bound} "${value}" is not YYYY-MM-DD or a timestamp with a zone, like 2026-09-18T00:00:00Z`);
  }
  return endOfDay && DATE_ONLY.test(value) ? parsed + DAY_MS : parsed;
}

function isStamped(value: string): boolean {
  return DATE_ONLY.test(value) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.test(value);
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

/* --------------------------------------------------------------------- log */

export type LogScan = {
  readonly dir: string;
  files: number;
  runs: Map<string, RunLine>;
  calls: CallLine[];
  closeLines: number;
  dropped: number;
  malformed: number;
  unsupportedVersion: number;
  duplicates: number;
  unreadable: number;
  readError: string | null;
};

export async function scanCallLog(dir: string, window: Window): Promise<LogScan> {
  const scan: LogScan = {
    dir,
    files: 0,
    runs: new Map(),
    calls: [],
    closeLines: 0,
    dropped: 0,
    malformed: 0,
    unsupportedVersion: 0,
    duplicates: 0,
    unreadable: 0,
    readError: null,
  };
  const listing = await readdir(dir).catch((error: unknown) => {
    scan.readError = describeError(error);
    return undefined;
  });
  if (listing === undefined) return scan;
  const seen = new Set<string>();
  for (const name of listing.filter((entry) => CALL_FILE.test(entry)).sort()) {
    scan.files++;
    const text = await readFile(join(dir, name), "utf8").catch((error: unknown) => {
      scan.unreadable++;
      scan.readError ??= describeError(error);
      return undefined;
    });
    if (text === undefined) continue;
    for (const line of text.split("\n")) {
      if (line.trim() !== "") readLogLine(line, scan, seen, window);
    }
  }
  return scan;
}

/**
 * A line the reader cannot use is a count, never a crash — the report reads logs written by a newer server.
 * A call is identified by its run and sequence rather than its position, because the signal path can hand
 * one line to the filesystem twice.
 */
function readLogLine(line: string, scan: LogScan, seen: Set<string>, window: Window): void {
  const record = asRecord(parseJson(line));
  if (record === undefined) {
    scan.malformed++;
    return;
  }
  if (typeof record["v"] === "number" && record["v"] !== 1) {
    scan.unsupportedVersion++;
    return;
  }
  const read = CallLogLine.safeParse(record);
  if (!read.success) {
    scan.malformed++;
    return;
  }
  if (read.data.type === "run") {
    if (!scan.runs.has(read.data.run)) scan.runs.set(read.data.run, read.data);
    return;
  }
  if (read.data.type === "close") {
    scan.closeLines++;
    scan.dropped += read.data.dropped;
    return;
  }
  const call = read.data;
  const key = `${call.run}\u0000${call.seq}`;
  if (seen.has(key)) {
    scan.duplicates++;
    return;
  }
  seen.add(key);
  if (inWindow(Date.parse(call.ts), window)) scan.calls.push(call);
}

/** The client family a raw `clientInfo.name` belongs to, mapped by prefix. */
export function clientFamily(run: RunLine | undefined): string {
  const name = run?.client?.name;
  if (name === undefined || name === "") return NO_CLIENT;
  if (name.startsWith("claude-code")) return "claude-code";
  if (name.startsWith("qwen-cli-mcp-client-")) return "qwen-code";
  if (name.startsWith("codex-mcp-client")) return "codex";
  return name;
}

type Group = {
  key: string;
  calls: number;
  outcomes: Map<string, number>;
  failures: number;
  aborted: number;
  classes: Map<string, number>;
  ms: number[];
  bytes: number[];
  cold: number;
  coldBase: number;
  empty: number;
  emptyBase: number;
  capped: number;
  limits: Map<string, number>;
  clients: Map<string, { name: string; version: string; calls: number }>;
};

export type UnclassifiedHead = { tool: string; head: string; count: number };

export type LogStats = {
  byTool: Group[];
  byClient: Group[];
  byProject: Group[];
  limits: Map<string, number>;
  heads: UnclassifiedHead[];
  builds: { build: string; calls: number }[];
};

export function summarizeLog(scan: LogScan): LogStats {
  const tools = new Map<string, Group>();
  const clients = new Map<string, Group>();
  const projects = new Map<string, Group>();
  const limits = new Map<string, number>();
  const builds = new Map<string, number>();
  const heads = new Map<string, UnclassifiedHead>();
  for (const call of scan.calls) {
    const run = scan.runs.get(call.run);
    addCall(group(tools, call.tool), call);
    addCall(group(clients, clientFamily(run)), call, clientIdentity(run));
    addCall(group(projects, call.project ?? NO_PROJECT), call);
    for (const code of call.limits) bump(limits, code);
    bump(builds, run?.build ?? NO_BUILD);
    if (FAILING.includes(call.outcome) && call.errorClass === "other") {
      const head = call.errorHead ?? "";
      const key = `${call.tool}\u0000${head}`;
      const seen = heads.get(key);
      if (seen !== undefined) seen.count++;
      else heads.set(key, { tool: call.tool, head, count: 1 });
    }
  }
  return {
    byTool: sortedGroups(tools),
    byClient: sortedGroups(clients),
    byProject: sortedGroups(projects),
    limits: sortCounts(limits),
    heads: [...heads.values()]
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool) || a.head.localeCompare(b.head))
      .slice(0, HEAD_ROWS),
    builds: [...builds.entries()]
      .map(([build, calls]) => ({ build, calls }))
      .sort((a, b) => b.calls - a.calls || a.build.localeCompare(b.build)),
  };
}

function addCall(group: Group, call: CallLine, client?: { name: string; version: string }): void {
  group.calls++;
  bump(group.outcomes, call.outcome);
  if (client !== undefined) bumpClient(group.clients, client);
  if (FAILING.includes(call.outcome)) {
    group.failures++;
    bump(group.classes, call.errorClass ?? NO_CLASS);
  }
  if (ABORTED.includes(call.outcome)) group.aborted++;
  group.ms.push(call.ms);
  group.bytes.push(call.textBytes);
  if (call.capped) group.capped++;
  for (const code of call.limits) bump(group.limits, code);
  if (call.spawned !== null) {
    group.coldBase++;
    if (call.spawned || (call.readyWaitMs ?? 0) > 0) group.cold++;
  }
  if (call.outcome === "ok" && call.results !== null) {
    group.emptyBase++;
    if (call.results === 0) group.empty++;
  }
}

function clientIdentity(run: RunLine | undefined): { name: string; version: string } | undefined {
  const client = run?.client;
  return client === null || client === undefined || client.name === "" ? undefined : { name: client.name, version: client.version };
}

/* -------------------------------------------------------------- transcripts */

export type TranscriptCall = {
  tool: string;
  ours: string | null;
  id: string;
  input: Record<string, unknown>;
  startMs: number;
  /** Where its `tool_use` block sits in the file's tool-block stream; `calls` is in this order by construction. */
  usePos: number;
  /** Where the `tool_result` that answered it sits — `null` for a call nobody ever answered. */
  resultPos: number | null;
  endMs: number | null;
  ok: boolean | null;
  errorClass: string | null;
  errorHead: string | null;
  clientSide: boolean;
};

export type TranscriptFileRef = { path: string; kind: "main" | "subagent" };

export type TranscriptScan = {
  dir: string;
  files: TranscriptFileRef[];
  readError: string | null;
};

/** What a call of ours is remembered as once its file has been tallied: the coverage line divides by these. */
export type TranscriptCallRef = { tool: string; startMs: number; clientSide: boolean };

/**
 * The inventory of transcript files, nothing more. Parsed calls are not held here: a full-history sweep of
 * `~/.claude/projects` is far larger than the report needs at any one moment, so each file is parsed,
 * tallied and released inside `summarizeTranscripts`.
 */
export async function scanTranscripts(dir: string): Promise<TranscriptScan> {
  const scan: TranscriptScan = { dir, files: [], readError: null };
  for (const path of await jsonlFiles(dir, scan)) {
    scan.files.push({ path, kind: SUBAGENT_PATH.test(path) ? "subagent" : "main" });
  }
  return scan;
}

async function jsonlFiles(dir: string, scan: TranscriptScan): Promise<string[]> {
  const found: string[] = [];
  const stack = [dir];
  for (const current of stack) {
    const entries = await readdir(current, { withFileTypes: true }).catch((error: unknown) => {
      scan.readError ??= describeError(error);
      return undefined;
    });
    if (entries === undefined) continue;
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (JSONL.test(entry.name)) found.push(path);
    }
  }
  return found.sort();
}

/**
 * One transcript file in order, so an agent's context is never mixed with another's. A `tool_use` opens a
 * call and the matching `tool_result` settles it by `tool_use_id`; a call nobody answered keeps `ok: null`
 * and no result position, and is counted as a call but never as a failure and never as reacted to.
 */
export function parseTranscript(jsonl: string, serverName: string): TranscriptCall[] {
  const prefix = `mcp__${serverName}__`;
  const calls: TranscriptCall[] = [];
  const open = new Map<string, TranscriptCall>();
  let position = 0;
  for (const line of jsonl.split("\n")) {
    const record = asRecord(parseJson(line));
    if (record === undefined) continue;
    const blocks = contentBlocks(asRecord(record["message"])?.["content"]);
    if (blocks.length === 0) continue;
    const stamp = Date.parse(String(record["timestamp"] ?? ""));
    for (const block of blocks) {
      const item = asRecord(block);
      if (item === undefined) continue;
      const type = item["type"];
      if (type !== "tool_use" && type !== "tool_result") continue;
      const at = position++;
      if (type === "tool_use") {
        const call = openCall(item, prefix, stamp, at);
        if (call !== undefined) {
          open.set(call.id, call);
          calls.push(call);
        }
      } else {
        settleCall(open, item, stamp, at);
      }
    }
  }
  return calls;
}

function openCall(item: Record<string, unknown>, prefix: string, stamp: number, at: number): TranscriptCall | undefined {
  const id = typeof item["id"] === "string" ? item["id"] : "";
  if (id === "") return undefined;
  const name = typeof item["name"] === "string" ? item["name"] : "";
  return {
    tool: name,
    ours: name.startsWith(prefix) ? name.slice(prefix.length) : null,
    id,
    input: asRecord(item["input"]) ?? {},
    startMs: stamp,
    usePos: at,
    resultPos: null,
    endMs: null,
    ok: null,
    errorClass: null,
    errorHead: null,
    clientSide: false,
  };
}

/**
 * Only this server's calls are read past the verdict: the report classifies its own failures and nothing
 * else's, and retaining a whole `~/.claude/projects` sweep of other tools' output is memory it never uses.
 * Even for our own calls the text lives only inside this function — the record keeps the class and head.
 */
function settleCall(
  open: Map<string, TranscriptCall>,
  item: Record<string, unknown>,
  stamp: number,
  at: number,
): void {
  const call = open.get(String(item["tool_use_id"] ?? ""));
  if (call === undefined) return;
  open.delete(call.id);
  call.endMs = stamp;
  call.resultPos = at;
  const failed = item["is_error"] === true;
  if (call.ours === null) {
    call.ok = !failed;
    return;
  }
  const text = resultText(item["content"]);
  call.clientSide = CLIENT_SIDE_REJECTION.test(text);
  if (!failed && !call.clientSide) {
    call.ok = true;
    return;
  }
  call.ok = false;
  const classified = classifyError(text);
  call.errorClass = call.clientSide ? CLIENT_SIDE_CLASS : classified.errorClass;
  call.errorHead = classified.errorHead;
}

function contentBlocks(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  return contentBlocks(value)
    .map((block) => asRecord(block)?.["text"])
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

export type Retry = { tool: string; changed: boolean; changedKeys: string[]; recovered: boolean };

/**
 * A retry is the first call to the same tool that starts after the failed call's *result*, inside the event
 * and time windows. Pairing each failure with its own next call is what keeps one call belonging to at most
 * one retry; a successful call is never a candidate, and neither is a call issued in the same batch as the
 * failure, because it cannot be a reaction to an answer that had not arrived yet. The window says which
 * failures get reported — it never removes events, since a count of the events between two calls is only
 * true of the whole file.
 */
export function detectRetries(calls: readonly TranscriptCall[], window: Window): Retry[] {
  const waiting = new Map<string, TranscriptCall[]>();
  const retries: Retry[] = [];
  for (const [index, call] of calls.entries()) {
    const tool = call.ours;
    if (tool === null) continue;
    const credited = claimOldest(waiting, tool, calls, index, call, window);
    if (credited !== undefined) retries.push(credited);
    if (call.ok === false && call.resultPos !== null) {
      const pending = waiting.get(tool) ?? [];
      pending.push(call);
      waiting.set(tool, pending);
    }
  }
  return retries;
}

/**
 * Pair this call with the oldest waiting failure of its tool. Two calls that failed in the same batch each
 * keep a slot, so the later one cannot overwrite the earlier one's claim — which failure a call answers is a
 * fact of the file, and the window only says whether the report shows it. A failure whose window this call
 * has already outrun is dropped without credit, because no later call is closer to it than this one is.
 */
function claimOldest(
  waiting: Map<string, TranscriptCall[]>,
  tool: string,
  calls: readonly TranscriptCall[],
  index: number,
  call: TranscriptCall,
  window: Window,
): Retry | undefined {
  const pending = waiting.get(tool);
  if (pending === undefined) return undefined;
  for (let slot = 0; slot < pending.length; ) {
    const failed = pending[slot];
    if (failed === undefined) break;
    if (!reactsTo(failed, call)) {
      slot++;
      continue;
    }
    pending.splice(slot, 1);
    if (!withinRetryWindow(calls, failed, index, call)) continue;
    return inWindow(failed.startMs, window) ? retryRecord(tool, failed, call) : undefined;
  }
  return undefined;
}

/** Did this call start at or after the moment the other one was answered? */
function reactsTo(before: TranscriptCall, after: TranscriptCall): boolean {
  if (before.resultPos === null || after.usePos <= before.resultPos) return false;
  if (before.endMs === null || Number.isNaN(before.endMs) || Number.isNaN(after.startMs)) return false;
  return after.startMs >= before.endMs;
}

function withinRetryWindow(
  calls: readonly TranscriptCall[],
  failed: TranscriptCall,
  atIndex: number,
  after: TranscriptCall,
): boolean {
  if (atIndex - firstIndexAfter(calls, failed.resultPos ?? -1) > RETRY_WINDOW_EVENTS) return false;
  const gap = after.startMs - (failed.endMs ?? after.startMs);
  return gap >= 0 && gap <= RETRY_MAX_GAP_MS;
}

/** The index of the first call whose `tool_use` sits after `pos`; the array is in block order by construction. */
function firstIndexAfter(calls: readonly TranscriptCall[], pos: number): number {
  let low = 0;
  let high = calls.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((calls[mid]?.usePos ?? 0) > pos) high = mid;
    else low = mid + 1;
  }
  return low;
}

function retryRecord(tool: string, before: TranscriptCall, after: TranscriptCall): Retry {
  const keys = differingKeys(before.input, after.input);
  return { tool, changed: keys.length > 0, changedKeys: keys, recovered: after.ok === true };
}

function differingKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].sort().filter((key) => canonical(before[key]) !== canonical(after[key]));
}

/** Keys sorted at every depth, so arguments that differ only in order count as identical. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export type FallbackHit = { tool: string; identifier: string; kind: "grep" | "shell" | "lsp-symbol"; afterOk: boolean };
export type NavHit = { tool: string; afterOk: boolean };

/**
 * Within the window after a call that named an identifier, the first event that is either a search for that
 * same identifier or a built-in LSP navigation decides the column: navigation carries a position rather than
 * a name, so it is counted apart and never claimed as a same-identifier fallback. The window runs from the
 * call's *result*, so a search issued in the same batch as the call — a deliberate second source, not a
 * reaction — is not one, and a call nobody answered has no result to run a window from.
 */
export function detectFallbacks(
  calls: readonly TranscriptCall[],
  window: Window,
): { fallbacks: FallbackHit[]; nav: NavHit[] } {
  const fallbacks: FallbackHit[] = [];
  const nav: NavHit[] = [];
  for (const call of calls) {
    if (!inWindow(call.startMs, window)) continue;
    const tool = call.ours;
    const resultPos = call.resultPos;
    if (tool === null || resultPos === null) continue;
    const identifier = identifierOf(tool, call.input);
    if (identifier === undefined) continue;
    const word = wholeWord(identifier);
    const afterOk = call.ok === true;
    for (const next of eventsAfter(calls, resultPos)) {
      const kind = fallbackKind(next, word);
      if (kind !== undefined) {
        fallbacks.push({ tool, identifier, kind, afterOk });
        break;
      }
      if (isLspNav(next)) {
        nav.push({ tool, afterOk });
        break;
      }
    }
  }
  return { fallbacks, nav };
}

/** The tool events that follow the given block position, up to the fallback window. */
function eventsAfter(calls: readonly TranscriptCall[], pos: number): TranscriptCall[] {
  const from = firstIndexAfter(calls, pos);
  return calls.slice(from, from + FALLBACK_WINDOW_EVENTS);
}

function fallbackKind(call: TranscriptCall, word: RegExp): FallbackHit["kind"] | undefined {
  if (call.tool === "Grep" && word.test(textInput(call, "pattern"))) return "grep";
  if ((call.tool === "Bash" || call.tool === "PowerShell") && isSearchCommand(call, word)) return "shell";
  if (call.tool === "LSP" && textInput(call, "operation") === "workspaceSymbol" && word.test(textInput(call, "query"))) {
    return "lsp-symbol";
  }
  return undefined;
}

function isSearchCommand(call: TranscriptCall, word: RegExp): boolean {
  const command = textInput(call, "command");
  return SEARCH_PROGRAM.test(command) && word.test(command);
}

function isLspNav(call: TranscriptCall): boolean {
  return call.tool === "LSP" && textInput(call, "operation") !== "workspaceSymbol";
}

function textInput(call: TranscriptCall, key: string): string {
  const value = call.input[key];
  return typeof value === "string" ? value : "";
}

/** The last segment of the name it was given, usable only as a whole word: `ns::Foo::Bar` -> `Bar`. */
function identifierOf(tool: string, input: Record<string, unknown>): string | undefined {
  const key = IDENTIFIER_ARG[tool];
  const value = key === undefined ? undefined : input[key];
  if (typeof value !== "string") return undefined;
  // The parameter list goes with its opening paren, so `bar(int)` reads as `bar` and not as `barint`.
  const signature = (value.split(/::|\./).at(-1) ?? "").split("(")[0] ?? "";
  const identifier = signature.replaceAll("*", "").trim();
  return /^[A-Za-z_]\w{2,}$/.test(identifier) ? identifier : undefined;
}

function wholeWord(identifier: string): RegExp {
  return new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
}

/* --------------------------------------------------------- transcript stats */

export type TranscriptGroup = {
  kind: string;
  tool: string;
  calls: number;
  failures: number;
  failedCalls: number;
  clientSide: number;
  classes: Map<string, number>;
  latency: number[];
  retries: number;
  changed: number;
  recovered: number;
  changedKeys: Map<string, number>;
  fallbackAfterOk: number;
  fallbackAfterError: number;
  nav: number;
};

export type TranscriptStats = {
  groups: TranscriptGroup[];
  mainFiles: number;
  subagentFiles: number;
  ours: TranscriptCallRef[];
  unreadable: number;
  readError: string | null;
};

/**
 * One file at a time: read, parse, tally its calls, find its proxies, then let the parsed calls go — a
 * full-history sweep holds one file's calls plus a reference per call of ours, never the whole corpus. The
 * window is applied to what is tallied and attributed; it is never applied to the event list, because the
 * distance between two tool events is only true of the whole file.
 */
export async function summarizeTranscripts(
  scan: TranscriptScan,
  serverName: string,
  window: Window,
): Promise<TranscriptStats> {
  const stats: TranscriptStats = { groups: [], mainFiles: 0, subagentFiles: 0, ours: [], unreadable: 0, readError: null };
  const groups = new Map<string, TranscriptGroup>();
  for (const file of scan.files) {
    const text = await readFile(file.path, "utf8").catch((error: unknown) => {
      stats.unreadable++;
      stats.readError ??= describeError(error);
      return undefined;
    });
    if (text === undefined) continue;
    const calls = parseTranscript(text, serverName);
    if (!calls.some((call) => call.ours !== null)) continue;
    if (!tallyFile(groups, file.kind, calls, window, stats.ours)) continue;
    if (file.kind === "main") stats.mainFiles++;
    else stats.subagentFiles++;
  }
  stats.groups = [...groups.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || b.calls - a.calls || a.tool.localeCompare(b.tool),
  );
  return stats;
}

/** The calls of one file the window keeps, each paired with the tool name this server knows it by. */
function inWindowCalls(
  calls: readonly TranscriptCall[],
  window: Window,
): { call: TranscriptCall; tool: string }[] {
  const kept: { call: TranscriptCall; tool: string }[] = [];
  for (const call of calls) {
    if (call.ours !== null && inWindow(call.startMs, window)) kept.push({ call, tool: call.ours });
  }
  return kept;
}

/**
 * One file, in one agent's context: the calls the window keeps are tallied and their references kept for the
 * coverage line, while both proxies run over the file's whole event order and are attributed only to a kept
 * call. False when nothing of the file is inside the window, which is the signal not to count the file at all.
 */
function tallyFile(
  groups: Map<string, TranscriptGroup>,
  kind: string,
  calls: readonly TranscriptCall[],
  window: Window,
  ours: TranscriptCallRef[],
): boolean {
  const kept = inWindowCalls(calls, window);
  if (kept.length === 0) return false;
  for (const entry of kept) {
    addTranscriptCall(transcriptGroup(groups, kind, entry.tool), entry.call);
    ours.push({ tool: entry.tool, startMs: entry.call.startMs, clientSide: entry.call.clientSide });
  }
  for (const retry of detectRetries(calls, window)) {
    const group = transcriptGroup(groups, kind, retry.tool);
    group.retries++;
    if (retry.changed) group.changed++;
    if (retry.recovered) group.recovered++;
    for (const key of retry.changedKeys) bump(group.changedKeys, key);
  }
  const proxies = detectFallbacks(calls, window);
  for (const hit of proxies.fallbacks) {
    const group = transcriptGroup(groups, kind, hit.tool);
    if (hit.afterOk) group.fallbackAfterOk++;
    else group.fallbackAfterError++;
  }
  for (const seen of proxies.nav) {
    transcriptGroup(groups, kind, seen.tool).nav++;
  }
  return true;
}

function transcriptGroup(groups: Map<string, TranscriptGroup>, kind: string, tool: string): TranscriptGroup {
  const key = `${kind}\u0000${tool}`;
  const found = groups.get(key);
  if (found !== undefined) return found;
  const fresh: TranscriptGroup = {
    kind,
    tool,
    calls: 0,
    failures: 0,
    failedCalls: 0,
    clientSide: 0,
    classes: new Map<string, number>(),
    latency: [],
    retries: 0,
    changed: 0,
    recovered: 0,
    changedKeys: new Map<string, number>(),
    fallbackAfterOk: 0,
    fallbackAfterError: 0,
    nav: 0,
  };
  groups.set(key, fresh);
  return fresh;
}

function addTranscriptCall(group: TranscriptGroup, call: TranscriptCall): void {
  group.calls++;
  if (!Number.isNaN(call.startMs) && call.endMs !== null && !Number.isNaN(call.endMs)) {
    group.latency.push(Math.max(0, call.endMs - call.startMs));
  }
  if (call.ok === false) group.failedCalls++;
  if (call.ok !== false) return;
  group.failures++;
  if (call.clientSide) group.clientSide++;
  bump(group.classes, call.errorClass ?? NO_CLASS);
}

/* ------------------------------------------------------------------ report */

export type CoverageRow = { tool: string; log: number; transcript: number };
export type Coverage = { window: string | null; rows: CoverageRow[] };

export type Report = {
  options: StatsOptions;
  logs: LogScan;
  log: LogStats;
  transcripts: TranscriptScan | null;
  transcript: TranscriptStats | null;
  coverage: Coverage | null;
};

export async function buildReport(options: StatsOptions): Promise<Report> {
  const logs = await scanCallLog(options.logs, options.window);
  const log = summarizeLog(logs);
  const transcripts = options.transcripts === undefined ? null : await scanTranscripts(options.transcripts);
  const transcript =
    transcripts === null ? null : await summarizeTranscripts(transcripts, options.serverName, options.window);
  return {
    options,
    logs,
    log,
    transcripts,
    transcript,
    coverage: transcript === null ? null : coverageOf(logs, transcript),
  };
}

/**
 * Log calls attributed to `claude-code` against transcript calls over the window both sources reach — a
 * check that the tap counts what it should, not a join: the two share no key. The transcript side holds only
 * the calls that could have reached the server, because the ones that could not are the gap this line shows.
 */
function coverageOf(logs: LogScan, transcript: TranscriptStats): Coverage {
  const loggedRange = span(
    logs.calls
      .filter((call) => clientFamily(logs.runs.get(call.run)) === "claude-code")
      .map((call) => Date.parse(call.ts)),
  );
  const counted = transcript.ours.filter((ref) => !ref.clientSide);
  const transcribedRange = span(counted.map((ref) => ref.startMs));
  if (loggedRange === null || transcribedRange === null) return { window: null, rows: [] };
  const from = Math.max(loggedRange.from, transcribedRange.from);
  const to = Math.min(loggedRange.to, transcribedRange.to);
  if (from > to) return { window: null, rows: [] };
  const bounds: Window = { from, to };
  const rows = new Map<string, CoverageRow>();
  for (const call of logs.calls) {
    if (clientFamily(logs.runs.get(call.run)) === "claude-code" && inWindow(Date.parse(call.ts), bounds)) {
      coverageRow(rows, call.tool).log++;
    }
  }
  for (const ref of counted) {
    if (inWindow(ref.startMs, bounds)) coverageRow(rows, ref.tool).transcript++;
  }
  return { window: `${stamp(from)} .. ${stamp(to)}`, rows: [...rows.values()].sort((a, b) => a.tool.localeCompare(b.tool)) };
}

function coverageRow(rows: Map<string, CoverageRow>, tool: string): CoverageRow {
  const found = rows.get(tool);
  if (found !== undefined) return found;
  const fresh: CoverageRow = { tool, log: 0, transcript: 0 };
  rows.set(tool, fresh);
  return fresh;
}

/**
 * The earliest and latest readable stamp a source holds. A loop rather than `Math.min(...stamps)`: a whole
 * `~/.claude/projects` sweep is large enough for the spread to fail on the argument list.
 */
function span(stamps: readonly number[]): { from: number; to: number } | null {
  let from: number | undefined;
  let to: number | undefined;
  for (const ms of stamps) {
    if (Number.isNaN(ms)) continue;
    from = from === undefined || ms < from ? ms : from;
    to = to === undefined || ms > to ? ms : to;
  }
  return from === undefined || to === undefined ? null : { from, to };
}

/* ------------------------------------------------------------------ output */

export function renderText(report: Report): string {
  const lines: string[] = [
    `window    ${stampOrNull(report.options.window.from)} .. ${stampOrNull(report.options.window.to)}`,
  ];
  lines.push(...logLines(report.logs, report.log));
  lines.push(...classLines(report.log));
  if (report.transcripts !== null && report.transcript !== null) {
    lines.push(...transcriptLines(report.options.serverName, report.transcripts, report.transcript));
  }
  if (report.coverage !== null) lines.push(...coverageLines(report.coverage));
  lines.push(...footer(report.options.transcripts !== undefined));
  return `${lines.join("\n")}\n`;
}

function logLines(scan: LogScan, log: LogStats): string[] {
  const header = [
    "",
    `logs       ${scan.dir}`,
    `files ${scan.files}, calls ${scan.calls.length}, run headers ${scan.runs.size}, close lines ${scan.closeLines} (${scan.dropped} dropped)`,
    `skipped   ${scan.malformed} malformed, ${scan.unsupportedVersion} unsupported version, ${scan.duplicates} duplicate run+seq, ${scan.unreadable} unreadable files`,
  ];
  if (scan.readError !== null) header.push(`note      ${scan.readError}`);
  return [
    ...header,
    "",
    "by tool",
    ...table(GROUP_HEADERS, log.byTool.map(groupRow)),
    "",
    "by client family",
    ...table(GROUP_HEADERS, log.byClient.map(groupRow)),
    "",
    "by project",
    ...table(GROUP_HEADERS, log.byProject.map(groupRow)),
    "",
    "limits by code",
    ...table(["code", "calls"], [...log.limits].map(([code, calls]) => [code, String(calls)])),
    "",
    "calls by build (the run header's build, so an error-text change is attributable)",
    ...table(["build", "calls"], log.builds.map((row) => [row.build, String(row.calls)])),
  ];
}

const GROUP_HEADERS = ["key", "calls", ...OUTCOMES, "failures", "p50ms", "p95ms", "cold", "empty", "capped", "medBytes"];

function groupRow(group: Group): string[] {
  return [
    group.key,
    String(group.calls),
    ...OUTCOMES.map((outcome) => String(group.outcomes.get(outcome) ?? 0)),
    String(group.failures),
    display(percentile(group.ms, 0.5)),
    display(percentile(group.ms, 0.95)),
    share(group.cold, group.coldBase),
    share(group.empty, group.emptyBase),
    share(group.capped, group.calls),
    display(percentile(group.bytes, 0.5)),
  ];
}

function classLines(log: LogStats): string[] {
  const rows: string[][] = [];
  for (const [scope, groups] of [
    ["tool", log.byTool],
    ["client", log.byClient],
    ["project", log.byProject],
  ] as const) {
    for (const group of groups) {
      for (const [errorClass, count] of sortCounts(group.classes)) rows.push([scope, group.key, errorClass, String(count)]);
    }
  }
  return [
    "",
    "failures by error class (failure = error + partial + protocol-error; cancelled and abandoned sit in the aborted column, apart)",
    ...table(["scope", "key", "class", "count"], rows),
    "",
    `unclassified heads, class "other" (top ${HEAD_ROWS} — grow the anchor table from these)`,
    ...table(["count", "tool", "head"], log.heads.map((row) => [String(row.count), row.tool, row.head])),
  ];
}

function transcriptLines(serverName: string, scan: TranscriptScan, stats: TranscriptStats): string[] {
  const rows = stats.groups.map(transcriptRow);
  return [
    "",
    `transcripts ${scan.dir} (server ${serverName}; ${stats.mainFiles} main and ${stats.subagentFiles} subagent files with our calls, ${stats.unreadable} unreadable)`,
    ...table(TRANSCRIPT_HEADERS, rows),
    "",
    "retry changedKeys",
    ...table(["key", "count"], [...changedKeys(stats.groups)].map(([key, count]) => [key, String(count)])),
    "",
    "failure classes per tool (transcript)",
    ...table(
      ["kind", "tool", "class", "count"],
      stats.groups.flatMap((group) => [...sortCounts(group.classes)].map(([errorClass, count]) => [group.kind, group.tool, errorClass, String(count)])),
    ),
    "",
    `retry% divides by answered failures; the two p50/p95 columns are what the client observed between its tool_use and its tool_result, never the server's own ms.`,
    `Both proxies are measured from each call's result over a file's whole event order: --since/--until pick which calls are counted, never which events exist.`,
  ];
}

const TRANSCRIPT_HEADERS = [
  "kind",
  "tool",
  "calls",
  "failures",
  "client-side",
  "p50ms client",
  "p95ms client",
  "retry%",
  "changed/retries",
  "recovered/retries",
  "fallback after ok",
  "fallback after error",
  "lspNav",
];

function transcriptRow(group: TranscriptGroup): string[] {
  return [
    group.kind,
    group.tool,
    String(group.calls),
    String(group.failures),
    String(group.clientSide),
    display(percentile(group.latency, 0.5)),
    display(percentile(group.latency, 0.95)),
    share(group.retries, group.failedCalls),
    `${group.changed}/${group.retries}`,
    `${group.recovered}/${group.retries}`,
    String(group.fallbackAfterOk),
    String(group.fallbackAfterError),
    String(group.nav),
  ];
}

function changedKeys(groups: TranscriptGroup[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const group of groups) {
    for (const [key, count] of group.changedKeys) bump(totals, key, count);
  }
  return sortCounts(totals);
}

function coverageLines(coverage: Coverage): string[] {
  return [
    "",
    `coverage, claude-code only, over the window both sources reach (transcript side excludes the client-side rejections that never reached the server): ${coverage.window ?? "none — one side holds no call in it"}`,
    ...table(
      ["tool", "log calls", "transcript calls"],
      coverage.rows.map((row) => [row.tool, String(row.log), String(row.transcript)]),
    ),
  ];
}

function footer(withTranscripts: boolean): string[] {
  return [
    "",
    "Counted nowhere in this report, because nothing reaches the server for them: a client-side schema",
    "rejection (Claude Code's own InputValidationError), a permission denial, a tool the client did not load,",
    "a server that failed to start or connect, a call killed with no transport close, and every call made",
    "while the log was off or disabled.",
    withTranscripts
      ? "The transcript section counts the client-side class; the log section cannot. The sections are never"
      : "Transcripts were not scanned, so the client-side class is invisible here and the log's totals are a",
    withTranscripts
      ? "joined and never divide by a shared denominator."
      : "lower bound; pass --transcripts to see that class beside these numbers.",
  ];
}

/** Nearest rank: `sorted[ceil(p*n)-1]`, so a small group reports a value it actually observed. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

function sortCounts(counts: Map<string, number>): Map<string, number> {
  return new Map([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function bump(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

function bumpClient(clients: Map<string, { name: string; version: string; calls: number }>, client: { name: string; version: string }): void {
  const key = `${client.name}\t${client.version}`;
  const found = clients.get(key);
  if (found !== undefined) found.calls++;
  else clients.set(key, { ...client, calls: 1 });
}

function sortedGroups(groups: Map<string, Group>): Group[] {
  return [...groups.values()].sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

function group(groups: Map<string, Group>, key: string): Group {
  const found = groups.get(key);
  if (found !== undefined) return found;
  const fresh: Group = {
    key,
    calls: 0,
    outcomes: new Map<string, number>(),
    failures: 0,
    aborted: 0,
    classes: new Map<string, number>(),
    ms: [],
    bytes: [],
    cold: 0,
    coldBase: 0,
    empty: 0,
    emptyBase: 0,
    capped: 0,
    limits: new Map<string, number>(),
    clients: new Map<string, { name: string; version: string; calls: number }>(),
  };
  groups.set(key, fresh);
  return fresh;
}

function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["(none)"];
  const widths = headers.map((header, index) =>
    rows.reduce((widest, row) => Math.max(widest, (row[index] ?? "").length), header.length),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? cell.length)))
      .join("  ");
  return [line(headers), ...rows.map(line)];
}

function share(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${part}/${whole} ${((part / whole) * 100).toFixed(1)}%`;
}

function display(value: number | null): string {
  return value === null ? "—" : String(value);
}

function stamp(ms: number): string {
  return new Date(ms).toISOString();
}

function stampOrNull(ms: number | null): string {
  return ms === null ? "open" : stamp(ms);
}

function inWindow(ms: number, window: Window): boolean {
  if (Number.isNaN(ms)) return window.from === null && window.to === null;
  return (window.from === null || ms >= window.from) && (window.to === null || ms <= window.to);
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as Error & { code?: string }).code;
  return code === undefined ? error.message : `${code}: ${error.message}`;
}

/* -------------------------------------------------------------------- main */

/** `--json` is the same arithmetic in machine form; the raw client names and versions live only in it. */
export function jsonReport(report: Report): string {
  return `${JSON.stringify(jsonShape(report), null, 2)}\n`;
}

function jsonShape(report: Report): Record<string, unknown> {
  return {
    window: report.options.window,
    logs: {
      dir: report.logs.dir,
      files: report.logs.files,
      lines: {
        runHeaders: report.logs.runs.size,
        calls: report.logs.calls.length,
        closeLines: report.logs.closeLines,
        dropped: report.logs.dropped,
        malformed: report.logs.malformed,
        unsupportedVersion: report.logs.unsupportedVersion,
        duplicates: report.logs.duplicates,
        unreadable: report.logs.unreadable,
      },
      readError: report.logs.readError,
      byTool: report.log.byTool.map(jsonGroup),
      byClient: report.log.byClient.map(jsonGroup),
      byProject: report.log.byProject.map(jsonGroup),
      limits: Object.fromEntries(report.log.limits),
      builds: report.log.builds,
      unclassifiedHeads: report.log.heads,
    },
    transcripts:
      report.transcripts === null || report.transcript === null
        ? null
        : {
            dir: report.transcripts.dir,
            serverName: report.options.serverName,
            mainFiles: report.transcript.mainFiles,
            subagentFiles: report.transcript.subagentFiles,
            unreadable: report.transcript.unreadable,
            readError: report.transcript.readError,
            perToolAndKind: report.transcript.groups.map(jsonTranscriptGroup),
          },
    coverage: report.coverage,
    notCounted: [
      "a client-side schema rejection produced before the call was sent",
      "a permission denial",
      "a tool the client did not load",
      "a server that failed to start or connect",
      "a call killed with no transport close",
      "any call made while the log was off or disabled",
    ],
  };
}

function jsonGroup(group: Group): Record<string, unknown> {
  return {
    key: group.key,
    calls: group.calls,
    outcomes: Object.fromEntries(group.outcomes),
    failures: group.failures,
    aborted: group.aborted,
    errorClasses: Object.fromEntries(sortCounts(group.classes)),
    p50ms: percentile(group.ms, 0.5),
    p95ms: percentile(group.ms, 0.95),
    cold: { cold: group.cold, of: group.coldBase },
    empty: { empty: group.empty, of: group.emptyBase },
    capped: { capped: group.capped, of: group.calls },
    limits: Object.fromEntries(sortCounts(group.limits)),
    medianTextBytes: percentile(group.bytes, 0.5),
    clients: [...group.clients.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
  };
}

function jsonTranscriptGroup(group: TranscriptGroup): Record<string, unknown> {
  return {
    kind: group.kind,
    tool: group.tool,
    calls: group.calls,
    failures: group.failures,
    clientSideRejections: group.clientSide,
    errorClasses: Object.fromEntries(sortCounts(group.classes)),
    clientObservedP50Ms: percentile(group.latency, 0.5),
    clientObservedP95Ms: percentile(group.latency, 0.95),
    retry: {
      answeredFailures: group.failedCalls,
      retries: group.retries,
      changed: group.changed,
      recovered: group.recovered,
      changedKeys: Object.fromEntries(group.changedKeys),
    },
    fallback: { afterOk: group.fallbackAfterOk, afterError: group.fallbackAfterError, lspNav: group.nav },
  };
}

/** Exit 2 for a bad command line, 0 for a report — an unreadable log directory is a stated line count, not a failure. */
export async function main(argv: readonly string[]): Promise<number> {
  let options: StatsOptions;
  try {
    options = parseArgs(argv, process.env, homedir());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  process.stdout.write(renderOrJson(await buildReport(options)));
  return 0;
}

function renderOrJson(report: Report): string {
  return report.options.json ? jsonReport(report) : renderText(report);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
