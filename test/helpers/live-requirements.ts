/** The external tools the live suite drives; each live file skips its cases when its tool is missing. */
export const LIVE_TOOLS = ["clangd", "clang-query", "gopls", "tsgo"] as const;

export type LiveTool = (typeof LIVE_TOOLS)[number];

/**
 * Which tools the run insists on, from `MCP_CODE_NAV_LIVE_REQUIRE`: `all`, or a comma-separated list of tool
 * names. Unset means none, and a missing tool then only skips its files. Unknown names are returned as `invalid`
 * so a typo fails the run instead of silently requiring nothing.
 */
export function parseRequired(value: string | undefined): { required: LiveTool[]; invalid: string[] } {
  const text = (value ?? "").trim();
  if (text === "") return { required: [], invalid: [] };
  if (text === "all") return { required: [...LIVE_TOOLS], invalid: [] };
  const names = text.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const known = (name: string): name is LiveTool => (LIVE_TOOLS as readonly string[]).includes(name);
  return { required: names.filter(known), invalid: names.filter((name) => !known(name)) };
}

/** The required tools that were not found. */
export function missingRequired(required: readonly LiveTool[], found: Readonly<Record<LiveTool, boolean>>): LiveTool[] {
  return required.filter((tool) => !found[tool]);
}

/** One line per tool saying whether it was found, so a skipped file is explained at the top of the run. */
export function describeTools(found: Readonly<Record<LiveTool, boolean>>): string {
  return LIVE_TOOLS.map((tool) => `${tool}: ${found[tool] ? "found" : "NOT FOUND (its live files skip)"}`).join("\n  ");
}
