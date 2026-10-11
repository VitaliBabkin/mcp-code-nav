import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toOutline, type OutlineSymbol } from "../clangd/outline.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { errorResult, successResult } from "../mcp-response.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { withinBudget } from "./budget.js";
import { GoSourceRootsSchema, resolveGoTarget, timeBudgetSchema } from "./go-shared.js";
import { PathInput } from "./input-limits.js";
import { resolutionNote } from "./shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "go_file_symbols";

/** The first call against a module waits for gopls's whole package load, so the wait needs a ceiling. */
const DEFAULT_TIME_BUDGET_MS = 60_000;

export const GoFileSymbolsInput = z.object({
  sourceRoots: GoSourceRootsSchema,
  file: PathInput
    .describe("Go source file: absolute, or relative - it must exist under exactly one sourceRoots entry."),
  depth: z
    .number()
    .int()
    .min(0)
    .max(1)
    .default(1)
    .describe(
      "0: top-level declarations only. 1 (default): also their immediate children - methods, struct fields, " +
        "interface methods.",
    ),
  timeBudgetMs: timeBudgetSchema(DEFAULT_TIME_BUDGET_MS),
});

export type GoFileSymbolsInputType = z.infer<typeof GoFileSymbolsInput>;

export async function runGoFileSymbols(sessions: LspSessionManager, input: GoFileSymbolsInputType) {
  let resolution: ResolvedPath | undefined;
  try {
    const target = resolveGoTarget(TOOL, sessions, input);
    if (!target.ok) return errorResult(target.error);
    const { file, moduleRoot, budget, session } = target.value;
    resolution = target.value.resolution;

    const outline = await withinBudget(session.documentSymbol(file), budget);
    if (outline === undefined) {
      return errorResult(
        `${TOOL} failed: gopls did not answer for "${file}" within its ` +
          `${budget.ceilingMs} ms budget. The module rooted at "${moduleRoot}" may still be loading ` +
          "its packages; raise timeBudgetMs or call again, and do not read this as an empty file.",
      );
    }
    // gopls's documentSymbol is syntactic and never premature, so an empty outline is a real answer
    // about an empty file rather than an index that has not caught up.
    const symbols: OutlineSymbol[] = outline.state === "ok" ? toOutline(outline.symbols, input.depth) : [];
    return successResult({ symbols });
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.file, resolution)}`);
  }
}

export function registerGoFileSymbols(server: McpServer, sessions: LspSessionManager) {
  server.registerTool(
    TOOL,
    {
      title: "Get Go file structure",
      description:
        "Outline one Go file via gopls: its package, types, functions, methods, constants and variables. " +
        "Use it to see what a file declares before reading it. Syntactic only - it answers no type " +
        "question, such as who implements an interface.",
      inputSchema: GoFileSymbolsInput.shape,
    },
    async (args) => runGoFileSymbols(sessions, args as GoFileSymbolsInputType),
  );
}
