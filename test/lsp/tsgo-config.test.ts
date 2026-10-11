import { describe, expect, it } from "vitest";
import { clangdConfig, goplsConfig, tsgoConfig, type LanguageServerConfig } from "../../src/lsp/server-config.js";
import type { TsgoBinary } from "../../src/tsgo/binary.js";
import { fakeServer, sessionOver, uriOf } from "../helpers/fake-lsp.js";

/** A located native server; the suite never resolves a real one. */
const BINARY: TsgoBinary = { executable: "C:/fake/lib/tsc.exe", version: "7.0.2", source: "global" };

const TSGO = tsgoConfig(BINARY);

/** The params half of a document-scoped request; only the method matters to the allow-list. */
const DOCUMENT_PARAMS = {
  textDocument: { uri: uriOf("/proj/a.ts") },
  position: { line: 4, character: 17 },
};

interface InitializeParams {
  processId?: number;
  rootUri?: string;
  capabilities: {
    textDocument?: Record<string, unknown>;
    window?: unknown;
    workspace?: unknown;
  };
}

function initializeParams(config: LanguageServerConfig, root: string): InitializeParams {
  return config.initializeParams(root) as InitializeParams;
}

/** The `workspace/configuration` answer the config's table gives. */
function configuration(params: unknown): unknown[] {
  return TSGO.serverRequests?.["workspace/configuration"]?.(params) as unknown[];
}

/** What a section that can carry the settings is answered: acquisition off, and the hover length at its ceiling. */
const TYPE_ACQUISITION_OFF = { disableAutomaticTypeAcquisition: true, maximumHoverLength: 2_147_483_647 };

describe("tsgoConfig", () => {
  it("is one tsc.exe --lsp --stdio named by the located executable, with no warmth and no progress to wait for", () => {
    expect(TSGO.id).toBe("tsgo");
    expect(TSGO.command).toBe("C:/fake/lib/tsc.exe");
    expect(TSGO.argv("/any/workspace")).toEqual(["--lsp", "--stdio"]);
    expect(TSGO.argv("D:/other/workspace")).toEqual(["--lsp", "--stdio"]);
    expect(tsgoConfig({ executable: "/usr/local/lib/tsc", version: "7.0.2", source: "override" }).command).toBe(
      "/usr/local/lib/tsc",
    );
    expect(TSGO.childEnv).toEqual({});
    expect(TSGO.documentSymbolNeedsWarmth).toBe(false);
    expect(TSGO.readinessProof).toBe("documents-opened");
  });

  it("lists exactly the ten methods tsgo may be asked for, in the order the config states them", () => {
    expect([...TSGO.allowedRequests]).toEqual([
      "initialize",
      "shutdown",
      "textDocument/documentSymbol",
      "textDocument/references",
      "textDocument/implementation",
      "textDocument/prepareCallHierarchy",
      "callHierarchy/incomingCalls",
      "textDocument/hover",
      "workspace/symbol",
      "textDocument/definition",
    ]);
  });

  it.each(["callHierarchy/outgoingCalls"])(
    "refuses %s through request(), naming the whole allow-list, and the connection never sees it",
    async (method) => {
      const server = fakeServer({ respond: () => [] });
      const session = sessionOver(server, { root: "/proj", config: TSGO, readFile: () => "export const x = 1;\n" });
      await expect(session.request<unknown>(method, DOCUMENT_PARAMS)).rejects.toThrow(
        new RegExp(`tsgo will not be asked for "${method.replace("/", "\\/")}"`),
      );
      await expect(session.request<unknown>(method, DOCUMENT_PARAMS)).rejects.toThrow(
        "this server only ever sends initialize, shutdown, textDocument/documentSymbol, textDocument/references, " +
          "textDocument/implementation, textDocument/prepareCallHierarchy, callHierarchy/incomingCalls, " +
          "textDocument/hover, workspace/symbol, textDocument/definition.",
      );
      // Refused before the connection was touched, so not even the lifecycle request went out.
      expect(server.methods).toEqual([]);
    },
  );

  it("lets textDocument/implementation through, which is the method clangd's config keeps out", async () => {
    const server = fakeServer({ respond: () => [] });
    const session = sessionOver(server, { root: "/proj", config: TSGO, readFile: () => "export const x = 1;\n" });
    await expect(session.request<unknown>("textDocument/implementation", DOCUMENT_PARAMS)).resolves.toEqual([]);
    expect(server.methods).toEqual(["initialize", "textDocument/implementation"]);
  });

  it("declares the capabilities its answers depend on and none that would make it wait for a token", () => {
    const caps = initializeParams(TSGO, "/proj").capabilities;
    expect(caps).toEqual({
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        hover: { contentFormat: ["markdown"] },
        callHierarchy: {},
      },
      workspace: { configuration: true },
    });
    // A client that asks for progress is a client that will wait for a `$/progress` tsgo never sends, and
    // declaring `didChangeWatchedFiles` would claim a disk watcher this server does not run.
    expect(caps.window).toBeUndefined();
    expect(caps.workspace.didChangeWatchedFiles).toBeUndefined();
  });

  it("sends those capabilities and the workspace root as initialize params", async () => {
    const server = fakeServer({ respond: () => [] });
    const session = sessionOver(server, { root: "/proj", config: TSGO, readFile: () => "export const x = 1;\n" });
    await session.documentSymbol("/proj/a.ts");
    expect(initializeParams(TSGO, "/proj").rootUri).toBe(uriOf("/proj"));
    expect(server.requests[0]?.[1]).toMatchObject({
      rootUri: uriOf("/proj"),
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          hover: { contentFormat: ["markdown"] },
          callHierarchy: {},
        },
      },
    });
    const caps = (server.requests[0]?.[1] as InitializeParams).capabilities;
    expect(caps.window).toBeUndefined();
    // The one workspace capability is the permission for the server to ask; a watcher is not claimed.
    expect(caps.workspace).toEqual({ configuration: true });
  });

  it("registers the config's server-request table on the connection the session starts", async () => {
    const server = fakeServer({ respond: (method) => (method === "textDocument/documentSymbol" ? [] : {}) });
    const session = sessionOver(server, { root: "/proj", config: TSGO, readFile: () => "export const x = 1;\n" });
    await session.documentSymbol("/proj/a.ts");
    expect(server.registeredRequestHandlers).toContain("workspace/configuration");
    expect(server.registeredRequestHandlers).toContain("client/registerCapability");

    // The table is what the session registers: a config that carries none leaves only the progress handler.
    const gopls = fakeServer({ respond: (method) => (method === "textDocument/documentSymbol" ? [] : {}) });
    const goplsSession = sessionOver(gopls, { root: "/mod", config: goplsConfig, readFile: () => "package main\n" });
    await goplsSession.documentSymbol("/mod/a.go");
    expect(gopls.registeredRequestHandlers).not.toContain("workspace/configuration");
    expect(gopls.registeredRequestHandlers).not.toContain("client/registerCapability");
  });

  it("answers one value per requested item, in order, turning automatic type acquisition off where a section carries it", () => {
    expect(
      configuration({
        items: [
          { configurationSection: "editor" },
          { configurationSection: "typescript" },
          { configurationSection: "js/ts" },
          { configurationSection: "javascript" },
          { scopeUri: uriOf("/proj/a.ts") },
          { configurationSection: "json" },
        ],
      }),
    ).toEqual([null, TYPE_ACQUISITION_OFF, TYPE_ACQUISITION_OFF, TYPE_ACQUISITION_OFF, null, null]);
  });

  it("answers the four sections tsgo actually asks about with exactly four values", () => {
    const answer = configuration({
      items: [
        { configurationSection: "javascript" },
        { configurationSection: "typescript" },
        { configurationSection: "js/ts" },
        { configurationSection: "editor" },
      ],
    });
    expect(answer).toHaveLength(4);
    expect(answer).toEqual([TYPE_ACQUISITION_OFF, TYPE_ACQUISITION_OFF, TYPE_ACQUISITION_OFF, null]);
  });

  it("answers the request tsgo 7.0.2 really sends, whose items are keyed `section` and not `configurationSection`", () => {
    // Measured live against a large real-world workspace: reading only the specification's field name
    // answers `[null,null,null,null]` and acquisition is never told to stay off.
    const answer = configuration({
      items: [{ section: "js/ts" }, { section: "typescript" }, { section: "javascript" }, { section: "editor" }],
    });

    expect(answer).toEqual([TYPE_ACQUISITION_OFF, TYPE_ACQUISITION_OFF, TYPE_ACQUISITION_OFF, null]);
  });

  it("answers an item set it cannot see through with no values at all", () => {
    expect(configuration({})).toEqual([]);
  });

  it("declines the file-watching registration with a plain null", () => {
    expect(
      TSGO.serverRequests?.["client/registerCapability"]?.({
        registrations: [{ id: "1", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [] } }],
      }),
    ).toBeNull();
  });

  it("picks the languageId per extension, where every other server answers a constant", () => {
    expect(TSGO.languageIdFor("/proj/a.ts")).toBe("typescript");
    expect(TSGO.languageIdFor("/proj/a.tsx")).toBe("typescriptreact");
    expect(TSGO.languageIdFor("/proj/a.js")).toBe("javascript");
    expect(TSGO.languageIdFor("/proj/a.jsx")).toBe("javascriptreact");
    // A file outside the accepted set is opened as TypeScript, which is what tsgo itself assumes for it.
    expect(TSGO.languageIdFor("/proj/a.md")).toBe("typescript");
    expect(clangdConfig.languageIdFor("/proj/a")).toBe("cpp");
    expect(goplsConfig.languageIdFor("/proj/a")).toBe("go");
  });
});
