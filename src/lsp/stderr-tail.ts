import type { Readable } from "node:stream";

/** How much of a child's stderr is kept; older text is dropped so a chatty server cannot grow memory. */
export const STDERR_TAIL_CHARS = 8 * 1024;

/** The most recent text a child wrote to stderr, bounded to `limit` characters. */
export class StderrTail {
  private text = "";
  private finish: () => void = () => {};
  /** Resolves once the stream has ended, i.e. once the tail holds everything the child wrote. */
  readonly settled: Promise<void> = new Promise((resolve) => {
    this.finish = resolve;
  });

  constructor(private readonly limit: number = STDERR_TAIL_CHARS) {}

  push(chunk: string): void {
    this.text = (this.text + chunk).slice(-this.limit);
  }

  /** Marks the stream as ended; a tail whose stream never existed is settled from the start. */
  end(): void {
    this.finish();
  }

  /** The kept text without surrounding blank space; empty when the child wrote nothing. */
  read(): string {
    return this.text.trim();
  }
}

/**
 * Reads a child's stderr to the end into `tail`. An unread pipe fills (a few KiB on Windows, 64 KiB on Linux) and
 * then blocks the child's own writes, which would hang a server that logs a lot; reading it also keeps the last
 * words of a crashing server for the error that follows.
 */
export function drainStderr(stream: Readable | null, tail: StderrTail): void {
  if (stream === null) {
    tail.end();
    return;
  }
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => tail.push(chunk));
  // A broken pipe on a dying child is not a second failure worth reporting.
  stream.on("error", () => tail.end());
  stream.on("close", () => tail.end());
}

/** The stderr tail as a block that can be appended to an error message; empty when there is nothing to say. */
export function stderrNote(serverId: string, tail: string | undefined): string {
  if (tail === undefined || tail === "") return "";
  return `\n${serverId} stderr (last ${STDERR_TAIL_CHARS} characters at most):\n${tail}`;
}
