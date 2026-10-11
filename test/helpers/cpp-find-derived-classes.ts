import { vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClangQueryExecFn } from "../../src/clang-query/find-derived-classes.js";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { registerCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";

/** A sweep that answers cleanly and finds nothing. */
export const cleanExec: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });

/**
 * The `description` an MCP client sees, read back through a stub server: the SDK's `McpServer` cannot be
 * built without a transport and only `registerTool` is reached.
 */
export function registeredDescription(): string {
  const registerTool = vi.fn();
  registerCppFindDerivedClasses({ registerTool } as unknown as McpServer, { exec: cleanExec, cache: new SweepCache() });
  const config = registerTool.mock.calls[0]?.[1] as { description?: string };
  return config.description ?? "";
}
