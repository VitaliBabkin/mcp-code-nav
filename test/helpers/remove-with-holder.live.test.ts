// The real Restart Manager lookup against a real holder: a child process that opens a file without
// `FILE_SHARE_DELETE`, which is what makes a delete fail with `EPERM` on Windows. Skipped elsewhere.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { holdersOf, removeFileNamingHolder } from "./remove-with-holder.js";

const itOnWindows = process.platform === "win32" ? it : it.skip;

/** A PowerShell that opens `path` (passed by environment, so a quote in it is harmless) with read/write sharing only and holds it until its stdin closes. */
function holdWithoutDeleteShare(path: string) {
  const script =
    "$f = [System.IO.File]::Open($env:HELD_PATH, 'Open', 'Read', 'ReadWrite'); " +
    "[Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $f.Dispose()";
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, HELD_PATH: path },
  });
  const held = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("held")) resolve();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("the holder exited before it held the file")));
  });
  return { child, held };
}

describe("the holder lookup, against a real holder", () => {
  itOnWindows("names the process that holds a file without delete sharing, in the failing delete's error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-holder-"));
    const file = join(dir, "held.txt");
    writeFileSync(file, "x");
    const { child, held } = holdWithoutDeleteShare(file);
    try {
      await held;
      expect(holdersOf(file)).toContain(`(pid ${child.pid})`);

      let message = "";
      try {
        removeFileNamingHolder(file, { maxRetries: 0, retryDelay: 0 });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("EPERM");
      expect(message).toContain(`is held by: `);
      expect(message).toContain(`(pid ${child.pid})`);
    } finally {
      child.stdin.end("\n");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => child.once("exit", resolve));
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  itOnWindows("answers an empty string for a file nothing holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-holder-"));
    try {
      const file = join(dir, "free.txt");
      writeFileSync(file, "x");
      expect(holdersOf(file)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
