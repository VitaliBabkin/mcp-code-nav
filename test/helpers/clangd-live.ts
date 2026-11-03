import { execFileSync } from "node:child_process";
import { it } from "vitest";

/** clangd is optional on this host in exactly the way gopls is, so the suite skips rather than failing with
 *  the symptom it exists to detect. `MCP_CODE_NAV_CLANGD` overrides, as it does at runtime. */
export function isClangdAvailable(): boolean {
  try {
    execFileSync(process.env.MCP_CODE_NAV_CLANGD ?? "clangd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const itIfClangd = isClangdAvailable() ? it : it.skip;
