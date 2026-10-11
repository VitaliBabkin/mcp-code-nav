import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { fileStamp } from "../../src/lsp/file-stamp.js";
import { attachLifecycleHandlers, type LspConnection, type LspProcess, type SpawnLsp } from "../../src/lsp/process.js";
import { resolveTsgoBinary, defaultTsExec, type TsgoBinary } from "../../src/tsgo/binary.js";
import type { LanguageServerConfig, SpawnAttempt } from "../../src/lsp/server-config.js";

/**
 * The live harness for the TypeScript backend: the located server, a spawn that records what the session sent
 * and which process it started, and the process-tree read the automatic-type-acquisition gate needs. Every
 * measurement is a claim about a running process, so it is taken here, against the
 * real `tsc.exe`, and never from a mock.
 */

const located = await resolveTsgoBinary();

/** The executable this host actually has, or `undefined` with the reason the search gave. */
export const tsgoBinary: TsgoBinary | undefined = "binary" in located ? located.binary : undefined;

/** Why there is no server to measure against, kept so a skipped suite can still say what it looked for. */
export const tsgoMiss: string = "unavailable" in located ? located.unavailable : "";

/** Whether this host has a server at all, so a suite can gate on a second condition as well. */
export const tsgoAvailable = tsgoBinary !== undefined;

/** A suite whose server is not on this host skips rather than fails, the way the gopls and clangd ones do. */
export const itIfTsgoAvailable = tsgoAvailable ? it : it.skip;

/** The server to measure against, for a case that only runs under `itIfTsgoAvailable`. */
export function requireTsgo(): TsgoBinary {
  if (tsgoBinary === undefined) throw new Error(`no TypeScript 7 native server on this host: ${tsgoMiss}`);
  return tsgoBinary;
}

export const fixtures = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures"));
export const tsFixtureRoot = join(fixtures, "ts-file-symbols");

export const CALL_BUDGET_MS = 240_000;

/**
 * Writes a live case's raw evidence to `.work/<dir>/<name>.json`, only when `MCP_CODE_NAV_LIVE_EVIDENCE` is set:
 * a suite run leaves nothing beside the sources unless someone asked for the record.
 */
export function recordEvidence(directory: string, name: string, answer: unknown): void {
  if (!process.env.MCP_CODE_NAV_LIVE_EVIDENCE) return;
  const target = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".work", directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${name}.json`), `${JSON.stringify(answer, null, 2)}
`, "utf-8");
}

export interface LiveResult {
  readonly content: readonly { readonly text?: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export function textOf(result: LiveResult): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

export function payloadOf<T>(result: LiveResult, tool: string): T {
  if (result.isError) throw new Error(`${tool} failed: ${textOf(result)}`);
  return result.structuredContent as T;
}

/** One server-to-client request that reached this client, with what the config answered it with. */
export interface ServerRequest {
  readonly method: string;
  readonly params: unknown;
  readonly answer: unknown;
}

/** What one document the session opened looked like on the wire, read back from the notification. */
export interface OpenedDocument {
  readonly file: string;
  readonly languageId: string;
}

export interface TsgoProcessLog {
  readonly spawn: SpawnLsp;
  readonly pids: number[];
  readonly opened: OpenedDocument[];
  /** Every request this client sent the server, in order — what a refusal cost, and what it did not ask. */
  readonly methods: string[];
  /** Every request the server sent this client, in the order it sent it — the gate's proof of delivery. */
  readonly serverRequests: ServerRequest[];
  /** Everything every child this log started wrote to stderr — where tsgo's own file-watching lines land. */
  stderrText(): string;
}

/**
 * A spawn that behaves like `defaultSpawnLsp` and keeps the three things a measurement needs and the
 * production `LspProcess` deliberately does not expose: the child's pid, which the process-tree gate walks
 * down from; the child's stderr, where tsgo says what it decided about watching and acquiring; and the
 * server's own requests, so a gate can tell "answered so" from "never asked".
 */
export function tsgoProcessLog(): TsgoProcessLog {
  const pids: number[] = [];
  const opened: OpenedDocument[] = [];
  const methods: string[] = [];
  const serverRequests: ServerRequest[] = [];
  let stderr = "";
  return {
    pids,
    opened,
    methods,
    serverRequests,
    stderrText: () => stderr,
    spawn: (root: string, config: LanguageServerConfig): LspProcess => {
      const attempt: SpawnAttempt = { config, attempted: config.command, fromOverride: false };
      const child = spawn(config.command, [...config.argv(root)], {
        cwd: root,
        env: { ...process.env, ...config.childEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      pids.push(child.pid as number);
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const raw = createMessageConnection(
        new StreamMessageReader(child.stdout as NodeJS.ReadableStream),
        new StreamMessageWriter(child.stdin as NodeJS.WritableStream),
      );
      raw.listen();
      const lifecycle = attachLifecycleHandlers(child, raw, attempt);
      const connection: LspConnection = {
        sendRequest: <R>(method: string, params?: unknown) => {
          methods.push(method);
          return raw.sendRequest<R>(method, params);
        },
        sendNotification: async (method, params) => {
          if (method === "textDocument/didOpen") opened.push(openedDocument(params));
          await raw.sendNotification(method, params);
        },
        onRequest: (method, handler) =>
          raw.onRequest(method, (...params: unknown[]) => {
            const answer = (handler as (...args: unknown[]) => unknown)(...params);
            serverRequests.push({ method, params: params[0], answer });
            return answer;
          }),
        onProgress: (type, token, handler) => raw.onProgress(type, token, handler),
      };
      return {
        connection,
        isAlive: lifecycle.isAlive,
        kill: () => child.kill(),
        spawnFailure: lifecycle.spawnFailure,
      };
    },
  };
}

function openedDocument(params: unknown): OpenedDocument {
  const doc = (params as { textDocument?: { uri?: string; languageId?: string } })?.textDocument ?? {};
  return { file: doc.uri === undefined ? "" : fileURLToPath(doc.uri), languageId: doc.languageId ?? "" };
}

/** One row of the machine's process table, as far as the gate needs it. */
export interface ProcessInfo {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly commandLine: string;
}

/**
 * The processes `pid` started, read one parent at a time: on Windows `Win32_Process` carries the parent, which
 * `tasklist` does not, and a count of images cannot tell a child of this server's own `tsc.exe` from one of any
 * other process on the machine. A filtered read is chosen over a whole-table dump because the other live suites
 * are tearing down beside this one, and a full `ConvertTo-Json` of every process on the host is the heavy part.
 */
export function childrenOf(pid: number): ProcessInfo[] {
  return process.platform === "win32" ? windowsChildren(pid) : posixChildren(pid);
}

function windowsChildren(pid: number): ProcessInfo[] {
  const script =
    `Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=${pid}" | ` +
    "Select-Object -Property ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const printed = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (printed.trim() === "") return [];
  const parsed: unknown = JSON.parse(printed);
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    parentPid: Number(row.ParentProcessId),
    name: String(row.Name ?? ""),
    commandLine: String(row.CommandLine ?? ""),
  }));
}

/** One `ps` row: pid, parent, executable, command line — the same four columns the Windows read returns. */
function posixChildren(pid: number): ProcessInfo[] {
  const printed = execFileSync("ps", ["-eo", "pid=,ppid=,comm=,args="], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows: ProcessInfo[] = [];
  for (const line of printed.split(/\r?\n/)) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (fields === null || Number(fields[2]) !== pid) continue;
    rows.push({ pid: Number(fields[1]), parentPid: pid, name: fields[3], commandLine: fields[4] ?? "" });
  }
  return rows;
}

/** Every process `pid` started, directly or through one of its own children. */
export function descendantsOf(pid: number): ProcessInfo[] {
  const found: ProcessInfo[] = [];
  const pending = [pid];
  while (pending.length > 0) {
    for (const child of childrenOf(pending.shift() as number)) {
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found;
}

/** What automatic type acquisition looks like from outside: an installer running as the server's own child. */
export function isAcquisitionProcess(row: ProcessInfo): boolean {
  return (
    /^(npm|npm\.cmd|npm-cli\.js|node|npx)(\..*)?$/i.test(row.name) ||
    /npm install|types-registry|typingsInstaller|@types\//i.test(row.commandLine)
  );
}

/** How a descendant list reads in a report: name, pid and a clipped command line, one per line. */
export function describeProcesses(rows: readonly ProcessInfo[]): string[] {
  return rows.map((row) => `${row.name} pid=${row.pid} parent=${row.parentPid} ${row.commandLine.slice(0, 120)}`);
}

/**
 * A child this test starts itself, to prove the process-tree read can see one at all. A gate that counts zero
 * is worth nothing until the counting has been shown to be able to count.
 */
export async function withKnownChild<T>(probe: (pid: number) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
  try {
    return await probe(child.pid as number);
  } finally {
    child.kill();
  }
}

/** The files under `dir` a tsgo answer would cover, bounded so a stray huge tree cannot hang a gate. */
export function firstSourceUnder(dir: string, extensions: readonly string[], limit = 200): string | undefined {
  const queue = [dir];
  let seen = 0;
  while (queue.length > 0 && seen < limit) {
    const current = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    seen += entries.length;
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) queue.push(path);
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        return path;
      }
    }
  }
  return undefined;
}

/** `size|mtimeMs` for each path, so a run can be proved to have written nothing. */
export function stampsOf(paths: readonly string[]): Map<string, string> {
  const stamps = new Map<string, string>();
  for (const path of paths) stamps.set(path, fileStamp(path) ?? "unreadable");
  return stamps;
}

export interface ListingResult {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnCode?: string;
  readonly ms: number;
  readonly lines: string[];
}

/** `tsc --listFilesOnly -p <config>`: the compiler's own answer about which files a project reads. */
export async function listFilesOnly(binary: TsgoBinary, configPath: string): Promise<ListingResult> {
  const started = Date.now();
  const result = await defaultTsExec(binary.executable, ["--listFilesOnly", "-p", configPath], dirname(configPath));
  const lines = `${result.stdout}`.split(/\r?\n/).filter((line) => line.trim() !== "");
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnCode: result.spawnCode,
    ms: Date.now() - started,
    lines,
  };
}

/** Where an evidence run writes the answers a report quotes verbatim; unset means the suite writes nothing. */
const evidenceDir = process.env.MCP_CODE_NAV_LIVE_EVIDENCE;

/**
 * When `MCP_CODE_NAV_LIVE_EVIDENCE` names a directory, writes the answer there as `<name>.json`; always returns
 * it. A report that must quote what the server said, rather than what its own case asserted about it, sets that
 * variable for the one run it needs: vitest's default reporter re-renders its status line over the
 * `console.info` blocks of every case that finished before the last moment of the run, so a printed answer is
 * not a captured one.
 */
export function recordAnswer<T>(name: string, answer: T): T {
  if (evidenceDir === undefined || evidenceDir.trim() === "") return answer;
  const dir = resolve(evidenceDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(answer, null, 2)}\n`, "utf-8");
  return answer;
}
