import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSpawnLsp } from "../../src/lsp/process.js";
import { clangdConfig, type LanguageServerConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { drainStderr, STDERR_TAIL_CHARS, stderrNote, StderrTail } from "../../src/lsp/stderr-tail.js";

describe("StderrTail", () => {
  it("keeps only the last `limit` characters", () => {
    const tail = new StderrTail(10);
    tail.push("0123456789");
    tail.push("abcdef");
    expect(tail.read()).toBe("6789abcdef");
  });

  it("reads as empty before anything was written and trims surrounding blank space", () => {
    const tail = new StderrTail();
    expect(tail.read()).toBe("");
    tail.push("\n  last words \n\n");
    expect(tail.read()).toBe("last words");
  });
});

describe("drainStderr", () => {
  it("collects every chunk and settles when the stream closes", async () => {
    const stream = new PassThrough();
    const tail = new StderrTail();
    drainStderr(stream, tail);
    stream.write("first\n");
    stream.write(Buffer.from("second\n"));
    stream.end();
    await tail.settled;
    expect(tail.read()).toBe("first\nsecond");
  });

  it("settles at once when the child has no stderr stream", async () => {
    const tail = new StderrTail();
    drainStderr(null, tail);
    await expect(tail.settled).resolves.toBeUndefined();
  });

  it("does not throw on a stream error and still settles", async () => {
    const stream = new PassThrough();
    const tail = new StderrTail();
    drainStderr(stream, tail);
    stream.destroy(new Error("broken pipe"));
    await expect(tail.settled).resolves.toBeUndefined();
  });
});

describe("stderrNote", () => {
  it("is empty when there is nothing to report", () => {
    expect(stderrNote("gopls", undefined)).toBe("");
    expect(stderrNote("gopls", "")).toBe("");
  });

  it("names the server and carries the text", () => {
    expect(stderrNote("gopls", "panic: boom")).toContain("gopls stderr");
    expect(stderrNote("gopls", "panic: boom")).toContain("panic: boom");
  });
});

/**
 * These start a real child process (this Node binary running a tiny script) behind the real `defaultSpawnLsp`,
 * because the defect is an operating-system pipe filling up, which no fake reproduces.
 */
describe("defaultSpawnLsp with a child that writes to stderr", () => {
  let dir: string;
  const noOverride = "MCP_CODE_NAV_TEST_NO_SUCH_OVERRIDE";

  const configRunning = (script: string): LanguageServerConfig => ({
    ...clangdConfig,
    command: process.execPath,
    commandEnvOverride: noOverride,
    argv: () => [script],
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-stderr-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("drains a stream far larger than a pipe buffer, so the child is never blocked, and keeps a bounded tail", async () => {
    const script = join(dir, "chatty.js");
    // 4 MiB of stderr, then a recognisable last line; an undrained pipe would stop this child mid-write.
    writeFileSync(
      script,
      [
        "const chunk = 'x'.repeat(1023) + '\\n';",
        "for (let i = 0; i < 4096; i++) process.stderr.write(chunk);",
        "process.stderr.write('final words\\n', () => process.exit(0));",
      ].join("\n"),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const proc = defaultSpawnLsp(dir, configRunning(script));
    await proc.stderrSettled?.();

    const tail = proc.stderrTail?.() ?? "";
    expect(tail.endsWith("final words")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(STDERR_TAIL_CHARS);
    proc.kill();
  }, 30_000);

  it("reports a crash on this server's stderr with the child's last words", async () => {
    const script = join(dir, "crash.js");
    writeFileSync(script, "process.stderr.write('fatal: index corrupted\\n', () => process.exit(3));");
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const proc = defaultSpawnLsp(dir, configRunning(script));
    await proc.stderrSettled?.();
    await vi.waitFor(() => expect(written.join("")).toContain("exited (code 3)"));

    expect(written.join("")).toContain("fatal: index corrupted");
    proc.kill();
  }, 30_000);

  it("does not report a child that this server killed itself", async () => {
    const script = join(dir, "idle.js");
    writeFileSync(script, "setInterval(() => {}, 1000);");
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const proc = defaultSpawnLsp(dir, configRunning(script));
    proc.kill();
    await proc.stderrSettled?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(written.join("")).not.toContain("exited");
  }, 30_000);

  it("puts the dead child's stderr into the error a request fails with", async () => {
    const script = join(dir, "dies.js");
    writeFileSync(script, "process.stderr.write('fatal: cannot load workspace\\n', () => process.exit(2));");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const session = new LspSession({ root: dir, config: configRunning(script) });

    const failure = await session.documentSymbol(join(dir, "a.cpp")).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("fatal: cannot load workspace");
    session.dispose();
  }, 30_000);
});
