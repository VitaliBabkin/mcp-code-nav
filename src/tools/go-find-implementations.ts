import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolKindName, type LspDocumentSymbol } from "../clangd/outline.js";
import type { GoExecFn } from "../gopls/go-env.js";
import { textDocumentId } from "../lsp/document-uri.js";
import type { LspSession } from "../lsp/session.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { errorResult, successResult } from "../mcp-response.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { NameInput } from "./input-limits.js";
import { resolutionNote } from "./shared.js";
import type { Budget } from "./budget.js";
import { GoDeclaringFileSchema, GoSourceRootsSchema, timeBudgetSchema } from "./go-shared.js";
import {
  environmentScope,
  environmentText,
  freshnessText,
  type GoScopeBase,
  openGoQuery,
  type ResolvedSymbol,
  typeAwareRequest,
} from "./go-navigation-shared.js";
import { inModuleFirst, outsideRoot, type ReportedLocation, toReported } from "./lsp-locations.js";
import { OUTSIDE_MODULE_REASON, type NamedRow, nameLocations, namedRow } from "./location-naming.js";
import { IMPLEMENTATIONS_LIMIT } from "./navigation-limits.js";
import { type Step, withArticle } from "./navigation-text.js";
import { messageOf } from "../error-message.js";

const TOOL = "go_find_implementations";

type GoImplementationDirection = "implementers-of-interface" | "interfaces-implemented-by-type";

type ImplementationRow = NamedRow;

type FindImplementationsPayload = {
  readonly resolved: ResolvedSymbol;
  readonly direction: GoImplementationDirection;
  readonly implementations: ImplementationRow[];
  readonly truncated: number;
  readonly scope: GoScopeBase;
};

export const GoFindImplementationsInput = z.object({
  sourceRoots: GoSourceRootsSchema,
  file: GoDeclaringFileSchema,
  symbol: NameInput
    .describe("An interface or named type: exact name as declared at the top level of `file`."),
  timeBudgetMs: timeBudgetSchema(60_000),
});

export type GoFindImplementationsInputType = z.infer<typeof GoFindImplementationsInput>;

export interface GoFindImplementationsDeps {
  /**
   * Seam for the `go` subprocesses that state the port this answer was computed under; a test injects one
   * so the default suite never runs a Go toolchain (see CONTRIBUTING.md).
   */
  exec?: GoExecFn;
}

/**
 * The kind table, keyed on the same kind names the outline emits. `textDocument/implementation`
 * is symmetric in gopls, so the direction is a property of the resolved kind and is echoed rather than
 * chosen; a kind with no defined direction is an error naming it, never a guess.
 */
function directionFor(symbol: LspDocumentSymbol): Step<GoImplementationDirection> {
  const kind = symbolKindName(symbol.kind);
  if (kind === "interface") return { ok: true, value: "implementers-of-interface" };
  if (kind === "struct" || kind === "class") return { ok: true, value: "interfaces-implemented-by-type" };
  if (kind === "function") {
    return {
      ok: false,
      error:
        `${TOOL} failed: "${symbol.name}" is reported as a function, and gopls reports a real \`func\` and a ` +
        "named func type identically in an outline, so the direction of this question cannot be decided from " +
        "the outline. Known gap: name the interface or the named type instead.",
    };
  }
  return {
    ok: false,
    error:
      `${TOOL} failed: "${symbol.name}" is ${withArticle(kind)}, and only named types and interfaces have a direction ` +
      "to ask about.",
  };
}

/**
 * Rows in priority order: the in-module locations first, each in the order the server reported them,
 * then the external ones — so the cap drops external rows before real ones, and the naming step never
 * reads a file whose row it dropped.
 */
async function buildRows(
  session: LspSession,
  locations: readonly ReportedLocation[],
  queriedFile: string,
  queriedOutline: readonly LspDocumentSymbol[],
  budget: Budget,
): Promise<{ rows: ImplementationRow[]; truncated: number }> {
  const ordered = inModuleFirst(locations, (location) => location.external);
  const kept = ordered.slice(0, IMPLEMENTATIONS_LIMIT).map((location) => ({ location }));
  const named = await nameLocations(session, kept, queriedFile, queriedOutline, budget, OUTSIDE_MODULE_REASON);
  return { rows: named.map(namedRow), truncated: ordered.length - kept.length };
}

function rowText(row: ImplementationRow): string {
  const name = row.name ?? "<unnamed>";
  const kind = row.kind ?? "?";
  return `  ${name} (${kind}) ${row.file}:${row.line}${row.reason ? ` - ${row.reason}` : ""}`;
}

/** The same JSON, phrased once for a reader who will not parse it. */
function humanSummary(payload: FindImplementationsPayload): string {
  const { resolved, direction, implementations, truncated, scope } = payload;
  const question =
    direction === "implementers-of-interface"
      ? `Implementations of ${resolved.kind} "${resolved.name}" (${resolved.file}:${resolved.line})`
      : `Interfaces implemented by ${resolved.kind} "${resolved.name}" (${resolved.file}:${resolved.line})`;
  const tail = truncated > 0 ? `, ${truncated} row(s) dropped by the ${IMPLEMENTATIONS_LIMIT}-row cap` : "";
  const rows = implementations.map(rowText).join("\n");
  return `${question} in module "${scope.moduleRoot}"${environmentText(scope)} - ${implementations.length} row(s), freshness: ${freshnessText(scope.freshness)}${tail}.\n${rows}`;
}

export async function runGoFindImplementations(
  sessions: LspSessionManager,
  input: GoFindImplementationsInputType,
  deps: GoFindImplementationsDeps = {},
) {
  let resolution: ResolvedPath | undefined;
  try {
    const opened = await openGoQuery(TOOL, sessions, input, deps, directionFor, (resolved) => {
      resolution = resolved;
    });
    if (!opened.ok) return errorResult(opened.error);
    const query = opened.value;
    const { file, moduleRoot, budget, session, symbols, picked, freshness, toolchain, gated: direction } = query;

    const params = { textDocument: textDocumentId(file), position: picked.position };
    const answered = await typeAwareRequest(
      TOOL,
      query,
      input.symbol,
      "textDocument/implementation",
      params,
      `answer the query for "${input.symbol}"`,
    );
    if (!answered.ok) return errorResult(answered.error);
    const locations = toReported("gopls", TOOL, answered.value, outsideRoot(moduleRoot), input.symbol);
    if (!locations.ok) return errorResult(locations.error);

    const { rows, truncated } = await buildRows(session, locations.value, file, symbols, budget);
    const scope: GoScopeBase = {
      moduleRoot,
      freshness,
      ...(await environmentScope(session, budget, moduleRoot, file, toolchain)),
    };
    const payload: FindImplementationsPayload = {
      resolved: picked.resolved,
      direction,
      implementations: rows,
      truncated,
      scope,
    };
    return successResult(payload, humanSummary(payload));
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.file, resolution)}`);
  }
}

export function registerGoFindImplementations(
  server: McpServer,
  sessions: LspSessionManager,
  deps: GoFindImplementationsDeps = {},
) {
  server.registerTool(
    TOOL,
    {
      title: "Find Go interface implementations",
      description:
        "Find the types implementing a Go interface, or the interfaces a named Go type implements, from " +
        "gopls's type checker - Go satisfies interfaces implicitly, so grep has nothing to key on. The " +
        "direction follows from what `symbol` names and is echoed as `direction`.",
      inputSchema: GoFindImplementationsInput.shape,
    },
    async (args) => runGoFindImplementations(sessions, args as GoFindImplementationsInputType, deps),
  );
}
