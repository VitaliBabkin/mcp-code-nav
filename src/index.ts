#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BUILD_IDENTITY } from "./build-identity.js";
import { resolveCallLogConfig, type CallLogConfig } from "./call-log/config.js";
import { watchStdinClose, withCallLog } from "./call-log/logging-transport.js";
import { openCallLog } from "./call-log/writer.js";
import { SweepCache } from "./clang-query/sweep-cache.js";
import { resolveRequestTimeoutMs } from "./lsp/request-control.js";
import { withRequestCancellation } from "./request-cancellation.js";
import { LspSessionManager } from "./lsp/session-manager.js";
import { registerCppFindDerivedClasses } from "./tools/cpp-find-derived-classes.js";
import { registerCppFindCallers } from "./tools/cpp-find-callers.js";
import { registerCppFindReferences } from "./tools/cpp-find-references.js";
import { registerCppFindSymbol } from "./tools/cpp-find-symbol.js";
import { registerCppFileSymbols } from "./tools/cpp-file-symbols.js";
import { registerGoFileSymbols } from "./tools/go-file-symbols.js";
import { registerGoFindCallers } from "./tools/go-find-callers.js";
import { registerGoFindImplementations } from "./tools/go-find-implementations.js";
import { registerGoFindReferences } from "./tools/go-find-references.js";
import { registerGoFindSymbol } from "./tools/go-find-symbol.js";
import { registerTsFindCallers } from "./tools/ts-find-callers.js";
import { registerTsFindImplementations } from "./tools/ts-find-implementations.js";
import { registerTsFindReferences } from "./tools/ts-find-references.js";
import { registerTsFindSymbol } from "./tools/ts-find-symbol.js";
import { registerTsFileSymbols } from "./tools/ts-file-symbols.js";
import { SERVER_INSTRUCTIONS } from "./server-instructions.js";

// stdout belongs to the MCP protocol, so the identity this process was built as goes to stderr.
process.stderr.write(`mcp-code-nav ${BUILD_IDENTITY}\n`);

/** Where this session's calls land — the one startup line, stated for every configuration it can read. */
function callLogStartupLine(config: CallLogConfig): string {
  if (config.kind === "on") return `call log ${config.dir}`;
  if (config.kind === "off") return "call log off";
  return `call log off: invalid MCP_CODE_NAV_CALL_LOG "${config.value}"`;
}

const callLogConfig = resolveCallLogConfig(process.env);
const callLog = openCallLog(callLogConfig);
process.stderr.write(`mcp-code-nav ${callLogStartupLine(callLogConfig)}\n`);

const server = new McpServer(
  { name: "mcp-code-nav", version: BUILD_IDENTITY },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

// What is specific to a language server lives on its `LanguageServerConfig` — for gopls that includes the
// module walk proving its package graph, which is why a clangd session never runs one.
const sessions = new LspSessionManager({
  requestTimeoutMs: resolveRequestTimeoutMs(process.env, (message) => process.stderr.write(`mcp-code-nav ${message}\n`)),
});
const sweepCache = new SweepCache();

registerCppFileSymbols(server, sessions);
registerCppFindSymbol(server, sessions);
registerCppFindReferences(server, sessions);
registerCppFindCallers(server, sessions);
registerCppFindDerivedClasses(server, { cache: sweepCache });
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

// Assigned before `connect`, which chains its own teardown onto whatever is already here: `onclose` is the
// one place this process tears anything down.
const transport = withCallLog(withRequestCancellation(new StdioServerTransport()), callLog, {
  build: BUILD_IDENTITY,
  cwd: process.cwd(),
});
transport.onclose = () => {
  sessions.disposeAll();
  callLog.close();
};

/**
 * The tap's `close()` flushes in-flight calls and drains the log inside its synchronous prefix, then runs the
 * `onclose` above, so every way this process ends shares one teardown and a handler only has to reach it.
 */
function shutdown(): void {
  void transport.close();
  process.exit(0);
}

// A client that hangs up by closing the pipe never reaches `onclose` in this SDK's stdio transport.
watchStdinClose(process.stdin, shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(transport);
