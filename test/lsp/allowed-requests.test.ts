import { describe, expect, it, vi } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { clangdConfig, goplsConfig, type LanguageServerConfig } from "../../src/lsp/server-config.js";
import { fakeServer, sessionOver } from "../helpers/fake-lsp.js";
import { sym } from "../helpers/fake-clangd.js";

const SYMBOL = sym("Foo", 5);

const IMPLEMENTATION_PARAMS = {
  textDocument: { uri: "file:///proj/a.go" },
  position: { line: 14, character: 5 },
};

const REFERENCE_PARAMS = {
  textDocument: { uri: "file:///proj/a.go" },
  position: { line: 14, character: 5 },
  context: { includeDeclaration: false },
};

const CALL_HIERARCHY_PARAMS = { item: { name: "Get", kind: 6, uri: "file:///proj/a.go" } };

const WORKSPACE_SYMBOL_PARAMS = { query: "Get" };

function started(config: LanguageServerConfig, respond: (method: string, params: unknown) => unknown = () => [SYMBOL]) {
  const server = fakeServer({ respond });
  const session = sessionOver(server, { root: "/proj", config, readFile: () => "content" });
  return { server, session };
}

describe("the one guarded send()", () => {
  it("lists exactly the methods each server may be asked for", () => {
    expect([...clangdConfig.allowedRequests]).toEqual([
      "initialize",
      "shutdown",
      "textDocument/documentSymbol",
      "textDocument/hover",
      "textDocument/references",
      "textDocument/prepareCallHierarchy",
      "callHierarchy/incomingCalls",
      "workspace/symbol",
    ]);
    expect([...goplsConfig.allowedRequests]).toEqual([
      "initialize",
      "shutdown",
      "textDocument/documentSymbol",
      "textDocument/implementation",
      "textDocument/references",
      "textDocument/prepareCallHierarchy",
      "callHierarchy/incomingCalls",
      "textDocument/hover",
      "workspace/symbol",
    ]);
  });

  it.each([
    ["textDocument/references", REFERENCE_PARAMS],
    ["textDocument/prepareCallHierarchy", IMPLEMENTATION_PARAMS],
    ["callHierarchy/incomingCalls", CALL_HIERARCHY_PARAMS],
    ["textDocument/hover", IMPLEMENTATION_PARAMS],
    ["workspace/symbol", WORKSPACE_SYMBOL_PARAMS],
  ])("lets %s through request() under the gopls config", async (method, params) => {
    const { server, session } = started(goplsConfig);
    await expect(session.request<unknown>(method, params)).resolves.toEqual([SYMBOL]);
    expect(server.methods).toEqual(["initialize", method]);
  });

  it.each(["textDocument/definition", "callHierarchy/outgoingCalls"])(
    "refuses %s under both configs, because no tool issues it",
    async (method) => {
      for (const config of [clangdConfig, goplsConfig]) {
        const { server, session } = started(config);
        await expect(session.request<unknown>(method, IMPLEMENTATION_PARAMS)).rejects.toThrow(
          new RegExp(`${config.id} will not be asked for "${method.replace("/", "\\/")}"`),
        );
        // Refused before the connection was touched, so not even the lifecycle request went out.
        expect(server.methods).toEqual([]);
      }
    },
  );

  // The two configs now differ by exactly one method. `textDocument/implementation` reaches gopls only —
  // the project rules keeps the C++ hierarchy question clang-query's — while `workspace/symbol` reaches both,
  // because each backend holds the index the other's project-wide declaration question is read from
  //.
  it("admits workspace/symbol under both configs and implementation under gopls alone", async () => {
    for (const config of [clangdConfig, goplsConfig]) {
      const { server, session } = started(config);
      await expect(session.request<unknown>("workspace/symbol", WORKSPACE_SYMBOL_PARAMS)).resolves.toEqual([
        SYMBOL,
      ]);
      expect(server.methods).toEqual(["initialize", "workspace/symbol"]);
    }

    const refused = started(clangdConfig);
    await expect(refused.session.request<unknown>("textDocument/implementation", IMPLEMENTATION_PARAMS)).rejects.toThrow(
      /clangd will not be asked for "textDocument\/implementation"/,
    );
    expect(refused.server.methods).toEqual([]);
  });

  it("lets textDocument/hover through request() under both configs", async () => {
    for (const config of [clangdConfig, goplsConfig]) {
      const { server, session } = started(config);
      await expect(session.request<unknown>("textDocument/hover", IMPLEMENTATION_PARAMS)).resolves.toEqual([SYMBOL]);
      expect(server.methods).toEqual(["initialize", "textDocument/hover"]);
    }
  });

  it("refuses textDocument/implementation under the clangd config, and the connection never sees it", async () => {
    const { server, session } = started(clangdConfig);
    await expect(session.request("textDocument/implementation", IMPLEMENTATION_PARAMS)).rejects.toThrow(
      /clangd will not be asked for "textDocument\/implementation"/,
    );
    expect(server.methods).not.toContain("textDocument/implementation");
    // Refused before the connection was touched, so not even the lifecycle request went out.
    expect(server.methods).toEqual([]);
  });

  it("still refuses it after the transient outline route has been used", async () => {
    const { server, session } = started(clangdConfig);
    await session.documentSymbolTransient("/proj/a.cpp");
    expect(server.methods).toEqual(["initialize", "textDocument/documentSymbol"]);

    await expect(session.request("textDocument/implementation", IMPLEMENTATION_PARAMS)).rejects.toThrow(
      /clangd will not be asked for "textDocument\/implementation"/,
    );
    expect(server.methods).toEqual(["initialize", "textDocument/documentSymbol"]);
  });

  it("sends initialize to the connection under both configs", async () => {
    for (const config of [clangdConfig, goplsConfig]) {
      const { server, session } = started(config);
      await session.documentSymbol("/proj/a");
      expect(server.methods[0]).toBe("initialize");
      expect(server.requests[0]?.[1]).toMatchObject({
        capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      });
    }
  });

  it("tells clangd it reads markdown hovers and wants progress, which is what a signature and an index state depend on", async () => {
    const clangd = started(clangdConfig);
    await clangd.session.documentSymbol("/proj/a.cpp");
    expect(clangd.server.requests[0]?.[1]).toMatchObject({
      capabilities: {
        textDocument: { hover: { contentFormat: ["markdown", "plaintext"] } },
        window: { workDoneProgress: true },
      },
    });

    // gopls answers markdown unasked, so nothing is declared to it and its initialize params do not move.
    const gopls = started(goplsConfig);
    await gopls.session.documentSymbol("/proj/a.go");
    const goplsCapabilities = (gopls.server.requests[0]?.[1] as { capabilities: { textDocument?: Record<string, unknown> } })
      .capabilities;
    expect(goplsCapabilities.textDocument?.hover).toBeUndefined();
  });

  it("keeps clangd's compile database in the initialize params and gopls without initializationOptions", async () => {
    const clangd = started(clangdConfig);
    await clangd.session.documentSymbol("/proj/a.cpp");
    expect(clangd.server.requests[0]?.[1]).toMatchObject({ initializationOptions: { compilationDatabasePath: "/proj" } });

    const gopls = started(goplsConfig);
    await gopls.session.documentSymbol("/proj/a.go");
    expect(gopls.server.requests[0]?.[1]).not.toHaveProperty("initializationOptions");
  });

  it("opens a document with the config's languageId", async () => {
    for (const [config, languageId] of [
      [clangdConfig, "cpp"],
      [goplsConfig, "go"],
    ] as const) {
      const { server, session } = started(config);
      await session.documentSymbol("/proj/a");
      const didOpen = server.notifications.find(([method]) => method === "textDocument/didOpen");
      expect(didOpen?.[1]).toMatchObject({ textDocument: { languageId } });
    }
  });

  it("lets textDocument/implementation through request() under the gopls config", async () => {
    const { server, session } = started(goplsConfig);
    await expect(session.request<LspDocumentSymbol[]>("textDocument/implementation", IMPLEMENTATION_PARAMS)).resolves.toEqual([SYMBOL]);
    // The refused method above started nothing; an allowed one starts the session it needs.
    expect(server.methods).toEqual(["initialize", "textDocument/implementation"]);
  });

  it("reports a confident empty for a server whose config needs no warmth, without retrying", async () => {
    const sleep = vi.fn(async () => {});
    const server = fakeServer({ respond: () => [] });
    const session = sessionOver(server, { root: "/proj", config: goplsConfig, readFile: () => "content", sleep });
    expect(await session.documentSymbol("/proj/a.go")).toEqual({ state: "empty" });
    expect(sleep).not.toHaveBeenCalled();
  });
});
