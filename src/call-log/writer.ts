/** The one writer of the call log: bounded, immediate, and unable to fail a call. */
import { Buffer } from "node:buffer";
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CallLogConfig } from "./config.js";
import { CallLogLine, CloseRecord } from "./record.js";

/** The disk operations the writer uses, so the default suite mocks the filesystem and not the log. */
export interface CallLogFs {
  appendFile(path: string, data: string): Promise<void>;
  appendFileSync(path: string, data: string): void;
  mkdirSync(path: string): void;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  remove(path: string): Promise<void>;
}

export interface CallLogDeps {
  readonly fs?: CallLogFs;
  readonly stderr?: (line: string) => void;
}

/** `write()` never throws and never awaits; `close()` drains synchronously. */
export interface CallLog {
  write(line: z.infer<typeof CallLogLine>): void;
  close(): void;
}

const MAX_QUEUE_ENTRIES = 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CALL_FILE = /^calls-[0-9T]{15}-[0-9]+\.jsonl$/;

const nodeFs: CallLogFs = {
  appendFile: (path, data) => appendFile(path, data, "utf8"),
  appendFileSync: (path, data) => appendFileSync(path, data, "utf8"),
  mkdirSync: (path) => void mkdirSync(path, { recursive: true }),
  readdir: (path) => readdir(path),
  stat: async (path) => {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  },
  remove: (path) => rm(path, { force: true }),
};

/**
 * `off` and an unusable value both get a log that exists and does nothing. The refusal is not stated here:
 * `src/index.ts` prints one startup line naming the value it refused, which is the stderr line, and
 * a second one from the writer would only repeat it.
 */
export function openCallLog(config: CallLogConfig, deps: CallLogDeps = {}): CallLog {
  if (config.kind !== "on") return new SilentCallLog();
  return new QueuedCallLog(config.dir, deps.fs ?? nodeFs, deps.stderr ?? defaultReport);
}

function defaultReport(line: string): void {
  void process.stderr.write(`${line}\n`);
}

class SilentCallLog implements CallLog {
  write(): void {}

  close(): void {}
}

class QueuedCallLog implements CallLog {
  private readonly queue: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private path: string | undefined;
  private bytes = 0;
  private dropped = 0;
  private runId = "";
  /** The line whose `appendFile` has been issued and not yet settled: what `close()` must not lose. */
  private outstanding: string | undefined;
  /** No further record is accepted: `close()` ran, or the size ceiling stopped the log. */
  private closed = false;
  /** A failure has been reported; the one line of stderr it is owed is spent. */
  private failed = false;

  constructor(
    private readonly dir: string,
    private readonly fs: CallLogFs,
    private readonly report: (line: string) => void,
  ) {
    void this.prune();
  }

  write(line: z.infer<typeof CallLogLine>): void {
    if (this.closed || this.failed) return;
    const accepted = CallLogLine.safeParse(line);
    if (!accepted.success) {
      return this.disable(new Error(`record did not match its schema: ${accepted.error.message}`));
    }
    if (this.queue.length >= MAX_QUEUE_ENTRIES) {
      this.dropped++;
      return;
    }
    if (accepted.data.type === "run") this.runId = accepted.data.run;
    this.queue.push(`${JSON.stringify(accepted.data)}\n`);
    this.chain = this.chain.then(() => this.appendNext()).catch((e: unknown) => this.disable(e));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.failed) return;
    const lines = this.queue.splice(0);
    // A large append can be part-written, so the replay opens its own line: the prefix stays one malformed line.
    if (this.outstanding !== undefined) lines.unshift(`\n${this.outstanding}`);
    this.outstanding = undefined;
    this.flush(lines);
    this.appendClosingLine();
  }

  /** The synchronous drain keeps the async writer's ceiling and its count, so the log's bound holds at exit too. */
  private flush(lines: string[]): void {
    for (const [index, line] of lines.entries()) {
      if (this.bytes >= MAX_FILE_BYTES) {
        this.dropped += lines.length - index;
        return;
      }
      if (!this.appendSync(line)) return;
      this.bytes += Buffer.byteLength(line, "utf8");
    }
  }

  private async appendNext(): Promise<void> {
    const line = this.queue.shift();
    if (line === undefined || this.closed || this.failed) return;
    const path = this.ensurePath();
    if (path === undefined) return;
    this.outstanding = line;
    try {
      await this.fs.appendFile(path, line);
    } catch (e) {
      // After `close()` the line was already written synchronously, so this failure loses nothing.
      return this.closed ? undefined : this.disable(e);
    }
    if (this.closed) return;
    this.outstanding = undefined;
    this.bytes += Buffer.byteLength(line, "utf8");
    if (this.bytes < MAX_FILE_BYTES) return;
    // A stop the log chose for itself still owes the run its closing line, with what it left unqueued.
    this.closed = true;
    this.dropped += this.queue.length;
    this.queue.length = 0;
    this.report(`call log stopped at ${MAX_FILE_BYTES} bytes: ${path}`);
    this.appendClosingLine();
  }

  private appendClosingLine(): void {
    if (this.failed || this.dropped === 0 || this.path === undefined) return;
    this.appendSync(`${JSON.stringify(closeRecord(this.runId, this.dropped))}\n`);
  }

  private appendSync(line: string): boolean {
    const path = this.ensurePath();
    if (path === undefined) return false;
    try {
      this.fs.appendFileSync(path, line);
      return true;
    } catch (e) {
      this.disable(e);
      return false;
    }
  }

  /** The directory and the file's name appear with the first record, not when the server starts. */
  private ensurePath(): string | undefined {
    if (this.path !== undefined) return this.path;
    try {
      this.fs.mkdirSync(this.dir);
    } catch (e) {
      this.disable(e);
      return undefined;
    }
    this.path = join(this.dir, callFileName());
    return this.path;
  }

  /** An unwritable log stays unwritable, so the failure costs one line of stderr and no more. */
  private disable(cause: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.outstanding = undefined;
    this.queue.length = 0;
    this.report(`call log disabled at ${this.path ?? this.dir}: ${describe(cause)}`);
  }

  private async prune(): Promise<void> {
    let names: string[];
    try {
      names = await this.fs.readdir(this.dir);
    } catch {
      return;
    }
    const now = Date.now();
    const kept: { name: string; size: number; mtimeMs: number }[] = [];
    let total = 0;
    for (const name of names) {
      if (!CALL_FILE.test(name)) continue;
      const info = await this.fs.stat(join(this.dir, name)).catch(() => undefined);
      if (info === undefined) continue;
      if (now - info.mtimeMs > MAX_AGE_MS) {
        await this.fs.remove(join(this.dir, name)).catch(() => undefined);
        continue;
      }
      kept.push({ name, ...info });
      total += info.size;
    }
    for (const oldest of kept.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= MAX_DIRECTORY_BYTES) break;
      total -= oldest.size;
      await this.fs.remove(join(this.dir, oldest.name)).catch(() => undefined);
    }
  }
}

/** `calls-<UTC yyyymmddThhmmss>-<pid>.jsonl` — one file per process, so no append ever races another. */
function callFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(/[-:]/g, "");
  return `calls-${stamp}-${process.pid}.jsonl`;
}

/** What the bounded queue refused to hold, in the run's closing line. */
function closeRecord(run: string, dropped: number): z.infer<typeof CloseRecord> {
  return { v: 1, type: "close", run, ts: new Date().toISOString(), dropped };
}

function describe(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const code = (cause as Error & { code?: string }).code;
  return code === undefined || cause.message.startsWith(code) ? cause.message : `${code}: ${cause.message}`;
}
