// The text a calling model reads for the five `ts_` tools, pinned verbatim, and the size it costs at spawn.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { SERVER_INSTRUCTIONS } from "../../src/server-instructions.js";
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

interface Registered {
  readonly description: string;
  readonly parameters: Readonly<Record<string, string>>;
}

/** One tool's registered text, read back through a stub server, with every parameter description beside it. */
function registeredText(register: (server: McpServer) => void): Registered {
  const registerTool = vi.fn();
  register({ registerTool } as unknown as McpServer);
  const config = registerTool.mock.calls[0]?.[1] as {
    description?: string;
    inputSchema?: Record<string, { description?: string }>;
  };
  return {
    description: config.description ?? "",
    parameters: Object.fromEntries(
      Object.entries(config.inputSchema ?? {}).map(([name, schema]) => [name, schema.description ?? ""]),
    ),
  };
}

const sessions = new LspSessionManager();

const TS_TOOLS = {
  ts_file_symbols: (server: McpServer) => registerTsFileSymbols(server, sessions),
  ts_find_symbol: (server: McpServer) => registerTsFindSymbol(server, sessions),
  ts_find_references: (server: McpServer) => registerTsFindReferences(server, sessions),
  ts_find_callers: (server: McpServer) => registerTsFindCallers(server, sessions),
  ts_find_implementations: (server: McpServer) => registerTsFindImplementations(server, sessions),
} satisfies Record<string, (server: McpServer) => void>;

const GO_TOOLS = [
  (server: McpServer) => registerGoFileSymbols(server, sessions),
  (server: McpServer) => registerGoFindSymbol(server, sessions),
  (server: McpServer) => registerGoFindReferences(server, sessions),
  (server: McpServer) => registerGoFindCallers(server, sessions),
  (server: McpServer) => registerGoFindImplementations(server, sessions),
];

function textChars(tools: readonly Registered[]): number {
  return tools.reduce(
    (total, tool) =>
      total + tool.description.length + Object.values(tool.parameters).reduce((sum, text) => sum + text.length, 0),
    0,
  );
}

/** The `/context` estimator: chars / 3 plus ~230 of schema structure per tool. */
function contextTokens(tools: readonly Registered[]): number {
  return Math.round(textChars(tools) / 3 + 230 * tools.length);
}

const SOURCE_ROOTS =
  "Absolute directories bounding this call, at least one; the path you pass and its npm workspace must lie " +
  "inside one of them.";
const TIME_BUDGET = "Ceiling in ms, default 60000; a workspace's first call also waits for its projects to load.";
const FILE = "The file declaring the symbol: absolute, or relative to exactly one sourceRoots entry.";
const SYMBOL =
  "Name as declared in `file`: top-level, or a dotted path through classes, interfaces, enums and namespaces " +
  "(`ExecDriver.run`, `Ns.Inner.x`).";

/** The sentence four tools gain, where the caller needs it before calling. */
const UNCOVERED_SENTENCE =
  "Files no tsconfig includes are not searched: if `scope.uncoveredSources.mentioning` lists any, the answer is " +
  "incomplete until you grep them.";

describe("the texts pinned verbatim", () => {
  it("ts_file_symbols", () => {
    expect(registeredText(TS_TOOLS.ts_file_symbols)).toEqual({
      description:
        "Outline one TypeScript or JavaScript file via tsgo: types, classes, functions and their members; " +
        "imports and re-exports are listed apart, in `bindings`. Use it to see what a file declares before " +
        "reading it.",
      parameters: {
        sourceRoots: SOURCE_ROOTS,
        file: "TypeScript or JavaScript file: absolute, or relative to exactly one sourceRoots entry.",
        depth: "0: top-level entries only. 1 (default): also the members of classes, interfaces, enums and namespaces.",
        timeBudgetMs: TIME_BUDGET,
      },
    });
  });

  it("ts_find_references", () => {
    expect(registeredText(TS_TOOLS.ts_find_references)).toEqual({
      description:
        "Find every use of a TypeScript symbol from tsgo's type checker - unlike grep, it tells real uses from " +
        "comments, strings and same-named identifiers. Counts are exact even when the listing is capped. For a " +
        `method it also lists uses of the interface method it satisfies. ${UNCOVERED_SENTENCE} An empty listing is a real answer.`,
      parameters: {
        sourceRoots: SOURCE_ROOTS,
        file: FILE,
        symbol: SYMBOL,
        includeDeclaration: "Also list the declaration itself. Import and re-export lines are always listed.",
        timeBudgetMs: TIME_BUDGET,
      },
    });
  });

  it("ts_find_callers", () => {
    expect(registeredText(TS_TOOLS.ts_find_callers)).toEqual({
      description:
        "Find who calls a TypeScript function, method or callable const from tsgo's call hierarchy - unlike " +
        "grep, it ignores comments, strings and same-named identifiers. For a method it also lists calls " +
        "through an interface value. A member mentioned as `x.m` without a call (a callback, a bind) is listed " +
        "as a caller, while a later call through that stored value, like any call through a function value, " +
        `is absent. Counts are exact even when capped. ${UNCOVERED_SENTENCE} An empty listing is a real answer.`,
      parameters: {
        sourceRoots: SOURCE_ROOTS,
        file: FILE,
        symbol: `${SYMBOL} An arrow-function \`const\` counts as callable.`,
        timeBudgetMs: TIME_BUDGET,
      },
    });
  });

  it("ts_find_implementations", () => {
    expect(registeredText(TS_TOOLS.ts_find_implementations)).toEqual({
      description:
        "Find the classes that implement a TypeScript interface or derive from a class, or the members that " +
        "implement a method or property, from tsgo's type checker, which follows `implements` and `extends`. " +
        "The subject itself is never a row. A type that matches only structurally, without naming the subject, " +
        `is never listed, and every answer says so. ${UNCOVERED_SENTENCE} An empty listing is a real answer.`,
      parameters: { sourceRoots: SOURCE_ROOTS, file: FILE, symbol: SYMBOL, timeBudgetMs: TIME_BUDGET },
    });
  });

  it("ts_find_symbol", () => {
    expect(registeredText(TS_TOOLS.ts_find_symbol)).toEqual({
      description:
        "Find every declaration of a name in a TypeScript workspace, with its signature and doc comment from " +
        "tsgo - declarations only, and a signature TypeScript inferred is shown though no line writes it. " +
        "Several declarations are several rows, not an error (cpp_find_symbol refuses instead). A row's " +
        "`container` is its directory; a type alias has kind `class`, as tsgo spells it. `ownedBy: null` marks " +
        "a row no project owns, usually build output such as `dist/*.d.ts` that importers bind to. " +
        UNCOVERED_SENTENCE,
      parameters: {
        sourceRoots: SOURCE_ROOTS,
        symbol:
          "Exact name: top-level, or a dotted path through classes, interfaces, enums and namespaces " +
          "(`Driver.run`); a bare name never matches a member.",
        anchor:
          "Absolute, or relative to exactly one sourceRoots entry. A FILE searches that file's own " +
          "declarations; a DIRECTORY searches the whole npm workspace.",
        timeBudgetMs: TIME_BUDGET,
      },
    });
  });
});

describe("the size of the TS text against the budget", () => {
  const ts = Object.values(TS_TOOLS).map(registeredText);
  const go = GO_TOOLS.map(registeredText);

  it("holds the five TS definitions to 4,800 characters, about 2.75k tokens by the `/context` estimator", () => {
    expect(textChars(ts), `ts ${contextTokens(ts)}, go ${contextTokens(go)} tokens by /context`).toBeLessThanOrEqual(
      4_800,
    );
    expect(contextTokens(ts)).toBeLessThanOrEqual(2_800);
  });

  it("states every TS tool in the routing map and the prerequisite sentence, within the 2,000-char ceiling", () => {
    for (const name of Object.keys(TS_TOOLS)) expect(SERVER_INSTRUCTIONS).toContain(name);
    expect(SERVER_INSTRUCTIONS).toContain("or a TypeScript interface or class: ts_find_implementations");
    expect(SERVER_INSTRUCTIONS).toContain(
      "TS tools need the TypeScript 7 native server (global `typescript@7`, or MCP_CODE_NAV_TSGO set to its " +
        "executable) and answer for the npm workspace holding the path you name; files no tsconfig project " +
        "includes, often tests, are not searched: an answer whose `scope.uncoveredSources.mentioning` lists files is " +
        "incomplete until you grep them.",
    );
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2_000);
  });
});
