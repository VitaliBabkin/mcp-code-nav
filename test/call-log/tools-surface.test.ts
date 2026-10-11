import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { CallLogLine } from "../../src/call-log/record.js";
import { LOGGED_ARG_KEYS, RESULT_COUNT_SELECTORS } from "../../src/call-log/record.js";
import { IDENTIFIER_ARG } from "../../scripts/call-stats.js";
import { withCallLog } from "../../src/call-log/logging-transport.js";
import type { CallLog } from "../../src/call-log/writer.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { SERVER_INSTRUCTIONS } from "../../src/server-instructions.js";
import { registerCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";
import { registerCppFindCallers } from "../../src/tools/cpp-find-callers.js";
import { registerCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";
import { registerCppFindReferences } from "../../src/tools/cpp-find-references.js";
import { registerCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { registerGoFileSymbols } from "../../src/tools/go-file-symbols.js";
import { registerGoFindCallers } from "../../src/tools/go-find-callers.js";
import { registerGoFindImplementations } from "../../src/tools/go-find-implementations.js";
import { registerGoFindReferences } from "../../src/tools/go-find-references.js";
import { registerGoFindSymbol } from "../../src/tools/go-find-symbol.js";
import { registerTsFileSymbols } from "../../src/tools/ts-file-symbols.js";
import { registerTsFindCallers } from "../../src/tools/ts-find-callers.js";
import { registerTsFindImplementations } from "../../src/tools/ts-find-implementations.js";
import { registerTsFindReferences } from "../../src/tools/ts-find-references.js";
import { registerTsFindSymbol } from "../../src/tools/ts-find-symbol.js";
import { fakeProcessByFile, sessionsFor, symAt } from "../helpers/fake-clangd.js";

type Line = z.infer<typeof CallLogLine>;

const META = { build: "v1.2.3", cwd: "D:\\work" };
const PROTOCOL = "2025-06-18";

/** The registrations `src/index.ts` performs, in the order it performs them. */
function registerAll(server: McpServer, sessions: LspSessionManager): void {
  registerCppFileSymbols(server, sessions);
  registerCppFindSymbol(server, sessions);
  registerCppFindReferences(server, sessions);
  registerCppFindCallers(server, sessions);
  registerCppFindDerivedClasses(server, { cache: new SweepCache() });
  registerGoFileSymbols(server, sessions);
  registerGoFindImplementations(server, sessions);
  registerGoFindReferences(server, sessions);
  registerGoFindCallers(server, sessions);
  registerGoFindSymbol(server, sessions);
  registerTsFileSymbols(server, sessions);
  registerTsFindReferences(server, sessions);
  registerTsFindCallers(server, sessions);
  registerTsFindImplementations(server, sessions);
  registerTsFindSymbol(server, sessions);
}

interface Wire {
  readonly lines: Line[];
  readonly request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly initialize: () => Promise<Record<string, unknown>>;
  readonly listTools: () => Record<string, unknown>[];
  readonly close: () => Promise<void>;
}

/**
 * A client that speaks JSON-RPC straight onto the in-memory transport, so what the server put on the wire is
 * compared as bytes rather than as an SDK object the client would have re-shaped first.
 */
async function connectOverTap(tap: boolean, sessions: LspSessionManager = new LspSessionManager({ sleep: async () => {} })): Promise<Wire> {
  const server = new McpServer({ name: "mcp-code-nav", version: "test" }, { instructions: SERVER_INSTRUCTIONS });
  registerAll(server, sessions);

  const lines: Line[] = [];
  const log: CallLog = { write: (line) => void lines.push(line as Line), close: () => {} };
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(tap ? withCallLog(serverSide, log, META) : serverSide);

  const waiting = new Map<string | number, (message: JSONRPCMessage) => void>();
  clientSide.onmessage = (message) => {
    if (!("id" in message)) return;
    const id = message.id as string | number;
    waiting.get(id)?.(message);
    waiting.delete(id);
  };
  await clientSide.start();

  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const reply = new Promise<JSONRPCMessage>((resolve) => waiting.set(id, resolve));
    await clientSide.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
    const message = (await reply) as Record<string, unknown>;
    return "error" in message ? { __error: message.error } : message.result;
  };

  const tools: Record<string, unknown>[] = [];
  return {
    lines,
    request,
    listTools: () => tools,
    initialize: async () => {
      const result = await request("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "surface-test", version: "0.0.1" },
      });
      await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
      const listed = await request("tools/list", {});
      tools.push(...((listed?.tools as Record<string, unknown>[]) ?? []));
      return result;
    },
    close: async () => {
      await clientSide.close();
      await server.close();
    },
  };
}

const tempDirs: string[] = [];

function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-surface-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the wire surface that must not have changed", () => {
  it("serves the identical tools/list with the tap in front of the transport", async () => {
    const plain = await connectOverTap(false);
    await plain.initialize();
    const tapped = await connectOverTap(true);
    await tapped.initialize();

    expect(JSON.stringify(tapped.listTools())).toBe(JSON.stringify(plain.listTools()));
    expect(tapped.lines).toEqual([]);
    await plain.close();
    await tapped.close();
  });

  it("serves the identical instructions, byte for byte, and they are the ones the server declares", async () => {
    const plain = await connectOverTap(false);
    const tapped = await connectOverTap(true);
    const fromPlain = await plain.initialize();
    const fromTapped = await tapped.initialize();

    expect(fromTapped.instructions).toBe(fromPlain.instructions);
    expect(fromTapped.instructions).toBe(SERVER_INSTRUCTIONS);
    await plain.close();
    await tapped.close();
  });

  it("registers the fifteen tools and no log entry among them", async () => {
    const wire = await connectOverTap(true);
    await wire.initialize();

    expect(wire.listTools().map((tool) => tool.name).sort()).toEqual(
      [
        "cpp_file_symbols",
        "cpp_find_callers",
        "cpp_find_derived_classes",
        "cpp_find_references",
        "cpp_find_symbol",
        "go_file_symbols",
        "go_find_callers",
        "go_find_implementations",
        "go_find_references",
        "go_find_symbol",
        "ts_file_symbols",
        "ts_find_callers",
        "ts_find_implementations",
        "ts_find_references",
        "ts_find_symbol",
      ].sort(),
    );
    await wire.close();
  });
});

describe("the drift guard, read off the schemas the server actually registered", () => {
  it("every parameter of every tool is in LOGGED_ARG_KEYS, or this test names it", async () => {
    const wire = await connectOverTap(true);
    await wire.initialize();

    const unlogged: string[] = [];
    for (const tool of wire.listTools()) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
      for (const key of Object.keys(schema?.properties ?? {})) {
        if (!LOGGED_ARG_KEYS.has(key)) unlogged.push(`${String(tool.name)}.${key}`);
      }
    }
    expect(unlogged).toEqual([]);
    await wire.close();
  });

  it("every tool has a result-count selector, so its answers are never silently uncounted", async () => {
    const wire = await connectOverTap(true);
    await wire.initialize();

    const missing = wire.listTools().filter((tool) => RESULT_COUNT_SELECTORS[String(tool.name)] === undefined);
    expect(missing.map((tool) => tool.name)).toEqual([]);
    await wire.close();
  });

  it("the stats report names exactly the tools whose schema carries an identifier, by the key it carries", async () => {
    const wire = await connectOverTap(false);
    await wire.initialize();

    const keyedOnAnIdentifier = wire
      .listTools()
      .filter((tool) => {
        const properties = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        return ["name", "symbol", "qualifiedName"].some((key) => properties[key] !== undefined);
      })
      .map((tool) => String(tool.name))
      .sort();
    expect(Object.keys(IDENTIFIER_ARG).sort()).toEqual(keyedOnAnIdentifier);
    for (const [tool, key] of Object.entries(IDENTIFIER_ARG)) {
      expect(LOGGED_ARG_KEYS.has(key)).toBe(true);
      expect(RESULT_COUNT_SELECTORS[tool]).toBeTypeOf("function");
    }
    await wire.close();
  });

  it("keeps this list in step with the registrations src/index.ts performs", () => {
    const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    const registered = [...source.matchAll(/\bregister[A-Za-z]+(?=\()/g)].map(([name]) => name).sort();
    const expected = [
      "registerCppFileSymbols",
      "registerCppFindCallers",
      "registerCppFindDerivedClasses",
      "registerCppFindReferences",
      "registerCppFindSymbol",
      "registerGoFileSymbols",
      "registerGoFindCallers",
      "registerGoFindImplementations",
      "registerGoFindReferences",
      "registerGoFindSymbol",
      "registerTsFileSymbols",
      "registerTsFindCallers",
      "registerTsFindImplementations",
      "registerTsFindReferences",
      "registerTsFindSymbol",
    ].sort();

    expect(registered).toEqual(expected);
  });
});

describe("what only the transport can see", () => {
  it("records the SDK's own input-validation refusal, which no callback wrapper would have reached", async () => {
    const wire = await connectOverTap(true);
    await wire.initialize();
    const result = (await wire.request("tools/call", {
      name: "cpp_file_symbols",
      arguments: { projectRoot: 7 },
    })) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(String((result.content as Record<string, unknown>[])[0]?.text)).toContain("Input validation error:");
    expect(wire.lines.at(-1)).toMatchObject({
      type: "call",
      tool: "cpp_file_symbols",
      outcome: "error",
      errorClass: "input-invalid",
      results: null,
      spawned: null,
    });
    await wire.close();
  });

  it("records a call to a tool this server does not have, by the name the caller sent", async () => {
    const wire = await connectOverTap(true);
    await wire.initialize();
    const result = (await wire.request("tools/call", {
      name: "cpp_find_evil_things",
      arguments: { projectRoot: "D:\\build" },
    })) as Record<string, unknown>;

    expect(String((result.content as Record<string, unknown>[])[0]?.text)).toContain(
      "Tool cpp_find_evil_things not found",
    );
    expect(wire.lines.at(-1)).toMatchObject({
      tool: "cpp_find_evil_things",
      lang: "cpp",
      outcome: "error",
      errorClass: "tool-unknown",
      argKeys: [],
    });
    await wire.close();
  });

  it("records a real handler's failure through the real wire", async () => {
    const root = projectRoot();
    const wire = await connectOverTap(true);
    await wire.initialize();
    const result = (await wire.request("tools/call", {
      name: "cpp_find_symbol",
      arguments: { projectRoot: root, name: "Foo", file: "a.cpp" },
    })) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(wire.lines.at(-1)).toMatchObject({
      outcome: "error",
      errorClass: "compile-db-missing",
      tool: "cpp_find_symbol",
      project: root,
      args: { projectRoot: root, name: "Foo", file: "a.cpp" },
      results: null,
      limits: [],
      spawned: null,
      readyWaitMs: null,
    });
    await wire.close();
  });

  it("records a degraded outline as ok, with its limit code, so a stats query can count them", async () => {
    const root = projectRoot();
    writeFileSync(join(root, "a.cpp"), "class Foo {};\n");
    const wire = await connectOverTap(true, sessionsFor(fakeProcessByFile(() => [symAt("Foo", 5, 0, 6)])));
    await wire.initialize();
    const result = (await wire.request("tools/call", {
      name: "cpp_file_symbols",
      arguments: { projectRoot: root, file: "a.cpp" },
    })) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(wire.lines.at(-1)).toMatchObject({
      outcome: "ok",
      tool: "cpp_file_symbols",
      results: 1,
      limits: ["parsed-without-compile-database"],
    });
    await wire.close();
  });

  it("records a TS handler's refusal as `ts`, in a class of its own rather than `other`", async () => {
    const root = projectRoot();
    writeFileSync(join(root, "notes.txt"), "x");
    const wire = await connectOverTap(true);
    await wire.initialize();
    const result = (await wire.request("tools/call", {
      name: "ts_file_symbols",
      arguments: { sourceRoots: [root], file: "notes.txt" },
    })) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(wire.lines.at(-1)).toMatchObject({
      tool: "ts_file_symbols",
      lang: "ts",
      outcome: "error",
      errorClass: "input-invalid",
      project: root,
      results: null,
    });
    await wire.close();
  });

  it("records a real handler's success, counting what it answered and what the session did", async () => {
    const root = projectRoot();
    writeFileSync(join(root, "a.cpp"), "class Foo {};\n");
    writeFileSync(join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "a.cpp" }]));
    const wire = await connectOverTap(true, sessionsFor(fakeProcessByFile(() => [symAt("Foo", 5, 0, 6)])));
    await wire.initialize();
    const result = (await wire.request("tools/call", {
      name: "cpp_file_symbols",
      arguments: { projectRoot: root, file: "a.cpp" },
    })) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    const [line] = wire.lines;
    expect(line).toMatchObject({ type: "run", client: { name: "surface-test", version: "0.0.1" }, protocol: PROTOCOL });
    expect(wire.lines.at(-1)).toMatchObject({
      type: "call",
      outcome: "ok",
      results: 1,
      project: root,
      spawned: true,
      readyWaitMs: null,
      textBytes: expect.any(Number),
    });
    await wire.close();
  });
});
