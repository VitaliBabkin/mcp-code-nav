import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { ZodTypeAny } from "zod";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { SERVER_INSTRUCTIONS } from "../../src/server-instructions.js";
import { registerCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";
import { registerCppFindCallers } from "../../src/tools/cpp-find-callers.js";
import { registerCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";
import { registerCppFindReferences } from "../../src/tools/cpp-find-references.js";
import { registerCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { CLANGD_DISK_CLAUSE, SourceRootsSchema } from "../../src/tools/shared.js";
import { cleanExec } from "../helpers/cpp-find-derived-classes.js";

// the three model-facing texts that state what a derived `sourceRoots` and the degraded outline
// changed. Each is pinned verbatim.

const CPP_INSTRUCTIONS =
  "C++ tools run clangd and clang-query on one `projectRoot`, the build directory holding compile_commands.json " +
  "from a native build on this host (`sourceRoots` defaults to its source tree): a database from Docker, WSL or " +
  "another OS names paths this host cannot open, so cpp_find_derived_classes fails and the clangd tools degrade " +
  "without saying so - use grep there.";

const SOURCE_ROOTS_DESCRIPTION =
  "Absolute directories `file`/`files` may resolve within, besides projectRoot. Omitted or empty: the source tree " +
  "derived from compile_commands.json.";

const FILE_SYMBOLS_SENTENCE =
  "With no compile_commands.json in projectRoot it still answers from a default-flags parse and says so.";

interface Registered {
  readonly description: string;
  readonly inputSchema: Record<string, ZodTypeAny>;
}

function registeredOf(register: (server: McpServer) => void): Registered {
  const registerTool = vi.fn();
  register({ registerTool } as unknown as McpServer);
  return registerTool.mock.calls[0]?.[1] as Registered;
}

const tools: readonly [string, (server: McpServer) => void][] = [
  ["cpp_file_symbols", (server) => registerCppFileSymbols(server, new LspSessionManager())],
  ["cpp_find_symbol", (server) => registerCppFindSymbol(server, new LspSessionManager())],
  ["cpp_find_references", (server) => registerCppFindReferences(server, new LspSessionManager())],
  ["cpp_find_callers", (server) => registerCppFindCallers(server, new LspSessionManager())],
  [
    "cpp_find_derived_classes",
    (server) => registerCppFindDerivedClasses(server, { exec: cleanExec, cache: new SweepCache() }),
  ],
];

describe("the instructions' C++ paragraph", () => {
  it("states that sourceRoots defaults to the source tree of the build directory, verbatim", () => {
    expect(SERVER_INSTRUCTIONS).toContain(CPP_INSTRUCTIONS);
  });

  it("stays under the 2,000-char ceiling both pins name", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2000);
  });
});

describe("the sourceRoots parameter", () => {
  it("is described verbatim by the shared schema", () => {
    expect(SourceRootsSchema.description).toBe(SOURCE_ROOTS_DESCRIPTION);
  });

  for (const [name, register] of tools) {
    it(`${name} carries that description`, () => {
      expect(registeredOf(register).inputSchema.sourceRoots?.description).toBe(SOURCE_ROOTS_DESCRIPTION);
    });
  }
});

describe("the cpp_file_symbols description", () => {
  it("gains the default-flags sentence directly before the disk clause", () => {
    const { description } = registeredOf(tools[0]![1]);

    expect(description).toContain(`${FILE_SYMBOLS_SENTENCE} ${CLANGD_DISK_CLAUSE}`);
  });

  it("is the only C++ description that says so", () => {
    for (const [name, register] of tools.slice(1)) {
      expect(registeredOf(register).description, name).not.toContain("default-flags parse");
    }
  });
});
