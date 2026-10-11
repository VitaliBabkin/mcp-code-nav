import { statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toOutline, type OutlineSymbol } from "../clangd/outline.js";
import { clangdConfig, clangdNoDatabaseConfig } from "../lsp/server-config.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { errorResult, successResult, withSummary } from "../mcp-response.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { declaredRoots, missingCompileDbHint, resolveCppSourceRoots } from "./cpp-navigation-shared.js";
import { PathInput } from "./input-limits.js";
import type { NavigationLimit } from "./navigation-limits.js";
import { cppSourceRoots, type CppSourceRootsBlock } from "../clang-query/derived-source-roots.js";
import {
  CLANGD_DISK_CLAUSE,
  CPP_PROJECT_ROOT_DESCRIPTION,
  fileNotFoundHint,
  isPathResolutionError,
  pathFixHint,
  resolveAndCheckIgnored,
  resolutionNote,
  SourceRootsSchema,
} from "./shared.js";
import { messageOf } from "../error-message.js";

export const CppFileSymbolsInput = z.object({
  projectRoot: PathInput.describe(CPP_PROJECT_ROOT_DESCRIPTION),
  file: PathInput.describe(
    "C++ source or header: absolute, or relative - a relative path is resolved against projectRoot and " +
      "each sourceRoots entry, and must exist under exactly one of them.",
  ),
  sourceRoots: SourceRootsSchema,
  depth: z
    .number()
    .int()
    .min(0)
    .max(1)
    .default(1)
    .describe("0: top-level symbols only. 1 (default): also their immediate children, e.g. a class's methods."),
});

export type CppFileSymbolsInputType = z.infer<typeof CppFileSymbolsInput>;

/** The first sentence of the summary; the full missing-database text follows it. */
const DEGRADED_SUMMARY_HEAD =
  "Parsed without a compile database: clangd used default flags, with no include paths or defines from a build, " +
  "so a declaration hidden behind a macro or a missing header may be absent or misnamed. ";

/** A default-flags parse that found nothing proves nothing about the file, so it is not an answer. */
function emptyDegradedParse(missingDb: string, absoluteFile: string): ReturnType<typeof errorResult> {
  return errorResult(
    `${missingDb} Without it, a default-flags parse of "${absoluteFile}" found no symbols, which does not show ` +
      "the file is empty.",
  );
}

/** Whether `projectRoot` is a directory clangd can be rooted at; a missing one keeps variant 3's error. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function runCppFileSymbols(sessions: LspSessionManager, input: CppFileSymbolsInputType) {
  let resolution: ResolvedPath | undefined;
  let sourceRoots: CppSourceRootsBlock | undefined;
  try {
    const missingDb = await missingCompileDbHint(input.projectRoot);
    const degraded = missingDb !== undefined;
    if (degraded && !isDirectory(input.projectRoot)) return errorResult(missingDb);

    // Nothing is derived without a database: the degraded call resolves against projectRoot and what was declared.
    const block = degraded
      ? cppSourceRoots(declaredRoots(input.sourceRoots), () => ({ kind: "none", reason: "compile-db-unlistable" }))
      : resolveCppSourceRoots(input.projectRoot, input.sourceRoots).block;
    sourceRoots = block;
    let absoluteFile: string;
    try {
      resolution = resolveAndCheckIgnored(input.projectRoot, input.file, [...block.roots]);
      absoluteFile = resolution.absolutePath;
    } catch (e) {
      if (isPathResolutionError(e)) {
        const fix = pathFixHint(e, { projectRoot: input.projectRoot, file: input.file, sourceRoots: block });
        return errorResult(`cpp_file_symbols failed: ${e.message}${fix}`);
      }
      throw e;
    }

    const session = sessions.get(input.projectRoot, degraded ? clangdNoDatabaseConfig : clangdConfig);
    const result = await session.documentSymbol(absoluteFile);
    if (result.state === "cold-empty") {
      if (degraded) return emptyDegradedParse(missingDb, absoluteFile);
      return errorResult(
        `cpp_file_symbols failed: "${absoluteFile}" produced no symbols while clangd's index for this ` +
          "project was not yet confirmed warm — this is not confirmed to be a genuinely empty file, retry once the index has warmed up.",
      );
    }
    const symbols: OutlineSymbol[] = result.state === "ok" ? toOutline(result.symbols, input.depth) : [];
    if (!degraded) {
      // MCP's structuredContent is spec'd as a JSON object, not a bare array — the payload is an array of
      // {...} objects, wrapped here under `symbols` to satisfy that constraint.
      return successResult({ symbols });
    }
    if (symbols.length === 0) return emptyDegradedParse(missingDb, absoluteFile);
    const summary = DEGRADED_SUMMARY_HEAD + missingDb;
    const scope = { projectRoot: input.projectRoot, limits: ["parsed-without-compile-database"] satisfies NavigationLimit[] };
    return successResult(withSummary(summary, { symbols, scope }), summary);
  } catch (e) {
    const hint = sourceRoots === undefined ? "" : fileNotFoundHint(e, sourceRoots);
    return errorResult(
      `cpp_file_symbols failed: ${messageOf(e)}${resolutionNote(input.file, resolution)}${hint}`,
    );
  }
}

export function registerCppFileSymbols(server: McpServer, sessions: LspSessionManager) {
  server.registerTool(
    "cpp_file_symbols",
    {
      title: "Get C++ file structure",
      description:
        "Outline one C++ file via clangd: its classes, functions, methods and fields. Use it to see what " +
        "a file declares before reading it. " +
        "With no compile_commands.json in projectRoot it still answers from a default-flags parse and says so. " +
        CLANGD_DISK_CLAUSE,
      inputSchema: CppFileSymbolsInput.shape,
    },
    async (args) => runCppFileSymbols(sessions, args as CppFileSymbolsInputType),
  );
}
