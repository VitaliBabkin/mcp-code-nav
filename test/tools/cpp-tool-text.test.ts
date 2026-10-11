import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { registerCppFindCallers } from "../../src/tools/cpp-find-callers.js";
import { registerCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";
import { registerCppFindReferences } from "../../src/tools/cpp-find-references.js";
import { registerCppFindSymbol, CppFindSymbolInput } from "../../src/tools/cpp-find-symbol.js";
import { registerCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";
import { CLANGD_DISK_CLAUSE } from "../../src/tools/shared.js";
import { cleanExec } from "../helpers/cpp-find-derived-classes.js";

/**
 * One tool's registered `description`, read back through a stub server: the SDK's `McpServer` cannot be
 * built without a transport and only `registerTool` is reached, which is what lets the text a calling
 * model reads be asserted like any other contract.
 */
function descriptionOf(register: (server: McpServer) => void): string {
  const registerTool = vi.fn();
  register({ registerTool } as unknown as McpServer);
  const config = registerTool.mock.calls[0]?.[1] as { description?: string };
  return config.description ?? "";
}

const clangdTools: readonly [string, (server: McpServer) => void][] = [
  ["cpp_file_symbols", (server) => registerCppFileSymbols(server, new LspSessionManager())],
  ["cpp_find_symbol", (server) => registerCppFindSymbol(server, new LspSessionManager())],
  ["cpp_find_references", (server) => registerCppFindReferences(server, new LspSessionManager())],
  ["cpp_find_callers", (server) => registerCppFindCallers(server, new LspSessionManager())],
];

/**
 * the full read-only sentence lives in `instructions`; the text an agent pays per
 * tool is the short clause, so the side effect still reaches the caller who is choosing this tool.
 */
describe("what the C++ tools say about the caller's disk", () => {
  for (const [name, register] of clangdTools) {
    it(`${name} ends with the clangd disk clause`, () => {
      const text = descriptionOf(register);
      expect(text).toContain(CLANGD_DISK_CLAUSE);
      expect(text).toContain(".cache/clangd");
    });
  }

  it("keeps the clause out of cpp_find_derived_classes, whose sweep starts no clangd session", () => {
    const text = descriptionOf((server) =>
      registerCppFindDerivedClasses(server, { exec: cleanExec, cache: new SweepCache() }),
    );

    expect(text).not.toContain(".cache/clangd");
  });
});

/**
 * What `cpp_find_symbol` answers with,
 * whose words those are, and which of its two branches carries the boundary claim. The search order and the
 * exactness rule are now the input schema's to state, so they are pinned on the parameters.
 */
describe("what cpp_find_symbol says about the search it ran and the text it returns", () => {
  const text = () =>
    descriptionOf((server) => registerCppFindSymbol(server, new LspSessionManager()));

  it("says the description is clangd's own rendering, verbatim", () => {
    expect(text()).toContain("as clangd's hover renders them, verbatim");
  });

  it("says only the index branch carries `scope`, and what that branch's location is worth", () => {
    expect(text()).toContain("clangd's index");
    expect(text()).toContain("carries `scope`");
    expect(text()).toContain("not stably one of them");
    expect(text()).toContain("pass `file` for the header");
    // The text must not promise one of the two locations: which one the index names is not stable.
    expect(text()).not.toContain("rather than the declaring header");
  });

  it("keeps the one-declaration promise the wider search does not widen", () => {
    expect(text()).toContain("one declaration");
    expect(text()).toContain("fails and lists them");
  });

  it("states where a name is looked for when no file is given, on the parameter that omits it", () => {
    expect(CppFindSymbolInput.shape.file.description).toContain("the files this session opened, then clangd's index");
  });

  it("states that the match is exact, on the parameter that carries the name", () => {
    expect(CppFindSymbolInput.shape.name.description).toContain("Exact name");
  });
});
