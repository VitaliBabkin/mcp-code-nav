import { execFileSync } from "node:child_process";
import { resolveTsgoBinary } from "../src/tsgo/binary.js";
import { describeTools, LIVE_TOOLS, missingRequired, parseRequired, type LiveTool } from "./helpers/live-requirements.js";

/** Whether `command --version` runs; the same lookup the server uses, so PATH and the overrides decide. */
function runs(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, [...args], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function probe(): Promise<Record<LiveTool, boolean>> {
  const located = await resolveTsgoBinary();
  return {
    clangd: runs(process.env.MCP_CODE_NAV_CLANGD ?? "clangd", ["--version"]),
    "clang-query": runs("clang-query", ["--version"]),
    gopls: runs(process.env.MCP_CODE_NAV_GOPLS ?? "gopls", ["version"]),
    tsgo: "binary" in located,
  };
}

/**
 * Runs once before the live suite. It states which tools were found, so a skipped file is never silent, and with
 * `MCP_CODE_NAV_LIVE_REQUIRE` (`all` or a list) it fails the run when a required tool is missing.
 */
export default async function setup(): Promise<void> {
  const found = await probe();
  const { required, invalid } = parseRequired(process.env.MCP_CODE_NAV_LIVE_REQUIRE);
  console.info(`live suite tools:\n  ${describeTools(found)}`);
  if (invalid.length > 0) {
    throw new Error(
      `MCP_CODE_NAV_LIVE_REQUIRE names unknown tools: ${invalid.join(", ")}. Known: ${LIVE_TOOLS.join(", ")}, or "all".`,
    );
  }
  const missing = missingRequired(required, found);
  if (missing.length > 0) {
    throw new Error(`The live suite requires ${missing.join(", ")} (MCP_CODE_NAV_LIVE_REQUIRE) but it was not found.`);
  }
}
