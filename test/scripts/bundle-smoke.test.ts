import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const BUNDLE = join(ROOT, "dist-bundle", "index.js");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const TS_TOOLS = ["ts_file_symbols", "ts_find_symbol", "ts_find_references", "ts_find_callers", "ts_find_implementations"];
const PROBE_TIMEOUT_MS = 15_000;

interface Reply {
  id?: number;
  result?: { tools?: { name: string }[] };
  error?: unknown;
}

interface Probe {
  initialize: Reply;
  tools: string[];
  exited: boolean;
  stderr: string;
}

/** Spawns the bundle, answers `initialize` + `tools/list` over stdio, and reports both replies and the exit state. */
async function probeBundle(): Promise<Probe> {
  const child = spawn(process.execPath, [BUNDLE], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  let exited = false;
  child.on("exit", () => (exited = true));

  const send = (message: object): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
  const replies = new Promise<Map<number, Reply>>((resolve, reject) => {
    const byId = new Map<number, Reply>();
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`no tools/list reply in ${PROBE_TIMEOUT_MS} ms: ${stderr}`)), PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        const reply = JSON.parse(line) as Reply;
        if (reply.id !== undefined) byId.set(reply.id, reply);
      }
      if (byId.has(1) && byId.has(2)) {
        clearTimeout(timer);
        resolve(byId);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`bundle exited before answering: ${stderr}`));
    });
  });

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bundle-smoke", version: "0" } },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  try {
    const byId = await replies;
    const tools = (byId.get(2)?.result?.tools ?? []).map((tool) => tool.name);
    return { initialize: byId.get(1) ?? {}, tools, exited, stderr };
  } finally {
    child.kill();
  }
}

describe("bundle", () => {
  beforeAll(async () => {
    await execFileAsync(process.execPath, [TSX_CLI, "scripts/bundle.ts"], { cwd: ROOT });
  }, 60_000);

  it("starts over stdio, answers initialize and lists the ts_ tools", async () => {
    const { initialize, tools, exited, stderr } = await probeBundle();
    expect(exited, stderr).toBe(false);
    expect(initialize.error).toBeUndefined();
    expect(initialize.result).toBeDefined();
    expect(tools).toEqual(expect.arrayContaining(TS_TOOLS));
  }, 30_000);
});
