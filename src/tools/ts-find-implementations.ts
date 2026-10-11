import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolKindName, type LspDocumentSymbol } from "../clangd/outline.js";
import { textDocumentId } from "../lsp/document-uri.js";
import type { LspSession } from "../lsp/session.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { errorResult, successResult } from "../mcp-response.js";
import { pathKey } from "../paths/path-containment.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import type { Budget } from "./budget.js";
import { inModuleFirst, type ReportedLocation, toReported } from "./lsp-locations.js";
import { type NamedRow, nameLocations, namedRow } from "./location-naming.js";
import { IMPLEMENTATIONS_LIMIT } from "./navigation-limits.js";
import { capsText, type Step, withArticle } from "./navigation-text.js";
import { NameInput, PathInput } from "./input-limits.js";
import { resolutionNote } from "./shared.js";
import { implementationsSubject, type TsSubject } from "./ts-addressing.js";
import {
  OUTSIDE_WORKSPACE_REASON,
  mentionNameOf,
  openTsQuery,
  tsFileExternal,
  tsNavigationScope,
  tsResolvedOf,
  tsRowSpeller,
  tsScopeText,
  summarised,
  tsTypeAwareRequest,
  withoutSubjectPositions,
  type TsNavigationScope,
  type TsQueryDeps,
  type TsResolvedSymbol,
} from "./ts-navigation-shared.js";
import { type HumanSummary, TsSourceRootsSchema, timeBudgetSchema, withSummary } from "./ts-shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "ts_find_implementations";

/** A row of the listing: the implementation this server can name, or the location it could not. */
export type TsImplementationRow = NamedRow;

/**
 * The shape: no `direction` field, because tsgo's `textDocument/implementation` answer is
 * one-directional — it names the declarations that satisfy the subject, never the ones the subject satisfies,
 * and a field that can only ever hold one value would claim a choice the caller never made.
 */
export type TsFindImplementationsPayload = {
  readonly resolved: TsResolvedSymbol;
  readonly implementations: TsImplementationRow[];
  readonly truncated: number;
  readonly scope: TsNavigationScope;
};

export const TsFindImplementationsInput = z.object({
  sourceRoots: TsSourceRootsSchema,
  file: PathInput
    .describe("The file declaring the symbol: absolute, or relative to exactly one sourceRoots entry."),
  symbol: NameInput
    .describe(
      "Name as declared in `file`: top-level, or a dotted path through classes, interfaces, enums and " +
        "namespaces (`ExecDriver.run`, `Ns.Inner.x`).",
    ),
  timeBudgetMs: timeBudgetSchema(60_000),
});

export type TsFindImplementationsInputType = z.infer<typeof TsFindImplementationsInput>;

/** The four kinds an implementations question can be asked of; anything else has no question tsgo can be given. */
const ASKABLE_KINDS = new Set(["interface", "class", "method", "property"]);

/**
 * The kind gate reads the entry the question is actually asked at, which for a merged symbol is the interface or
 * class preferred over whichever declaration the server listed first — `declare namespace N {}`
 * beside `declare class N {}` is one symbol whose class half answers this question fine.
 */
function askableFor(symbol: string, subject: TsSubject): Step<void> {
  if (ASKABLE_KINDS.has(subject.kind)) return { ok: true, value: undefined };
  return {
    ok: false,
    error:
      `${TOOL} failed: "${symbol}" is ${withArticle(subject.kind)}, and only an interface, class, method or ` +
      "property has implementations. tsgo answers that question for those four; for any other declaration " +
      "ask ts_find_references for where it is used.",
  };
}

/**
 * Rows in priority order: the in-workspace locations first, each in the order the server reported them,
 * then the external ones — so the cap drops external rows before real ones, and the naming step never reads a
 * file whose row it dropped.
 */
async function buildRows(
  session: LspSession,
  locations: readonly ReportedLocation[],
  queriedFile: string,
  queriedOutline: readonly LspDocumentSymbol[],
  budget: Budget,
): Promise<{ rows: TsImplementationRow[]; truncated: number }> {
  const ordered = inModuleFirst(locations, (location) => location.external);
  const kept = ordered.slice(0, IMPLEMENTATIONS_LIMIT).map((location) => ({ location }));
  const named = await nameLocations(
    session,
    kept,
    queriedFile,
    queriedOutline,
    budget,
    OUTSIDE_WORKSPACE_REASON,
    false,
    tsRowSpeller(),
  );
  return { rows: named.map(namedRow), truncated: ordered.length - kept.length };
}

function rowText(row: TsImplementationRow): string {
  const name = row.name ?? "<unnamed>";
  const kind = row.kind ?? "?";
  return `  ${name} (${kind}) ${row.file}:${row.line}${row.reason ? ` - ${row.reason}` : ""}`;
}

/** The same JSON, phrased once for a reader who will not parse it. */
function humanSummary(payload: TsFindImplementationsPayload): HumanSummary {
  const { resolved, implementations, truncated, scope } = payload;
  const tail = capsText([truncated > 0 ? `${truncated} row(s) dropped by the ${IMPLEMENTATIONS_LIMIT}-row cap` : undefined]);
  const rows = implementations.map(rowText).join("\n");
  const head =
    `Implementations of ${resolved.kind} "${resolved.name}" (${resolved.file}:${resolved.line})${tsScopeText(scope)} ` +
    `- ${implementations.length} row(s)${tail}.`;
  return summarised(head, scope, `limits: ${scope.limits.join(", ")}${rows === "" ? "" : `\n${rows}`}`);
}

export async function runTsFindImplementations(
  sessions: LspSessionManager,
  input: TsFindImplementationsInputType,
  deps: TsQueryDeps = {},
) {
  let resolution: ResolvedPath | undefined;
  try {
    // A namespace beside an interface of one name is not an implementable kind, so only the interface is asked
    // unless the caller chose with a prefix.
    const opened = await openTsQuery(
      TOOL,
      sessions,
      input,
      deps,
      (resolved) => {
        resolution = resolved;
      },
      (entry) => ASKABLE_KINDS.has(symbolKindName(entry.kind)),
    );
    if (!opened.ok) return errorResult(opened.error);
    const query = opened.value;
    const subject = implementationsSubject(query.subject);
    const gated = askableFor(input.symbol, subject);
    if (!gated.ok) return errorResult(gated.error);
    const resolved = tsResolvedOf(subject);

    const params = { textDocument: textDocumentId(query.file), position: subject.position };
    const answered = await tsTypeAwareRequest(
      TOOL,
      query,
      input.symbol,
      "textDocument/implementation",
      params,
      `answer the query for "${input.symbol}"`,
    );
    if (!answered.ok) return errorResult(answered.error);
    const locations = toReported("tsgo", TOOL, answered.value, tsFileExternal(query.workspaceRoot), input.symbol);
    if (!locations.ok) return errorResult(locations.error);

    const { rows, truncated } = await buildRows(
      query.session,
      // The subject's own declaration in this file is never a row about it.
      withoutSubjectPositions(locations.value, subject),
      query.file,
      query.symbols,
      query.budget,
    );
    const scope = await tsNavigationScope(
      query,
      {
        // The project rules, as `tsNavigationLimits` states in full: this tool's own code
        // is the structural one, and the interface-method over-report belongs to references and callers listings.
        capped: truncated > 0,
        correspondingMethods: false,
        structuralImplementers: true,
      },
      mentionNameOf(input.symbol),
    );
    const payload: TsFindImplementationsPayload = { resolved, implementations: rows, truncated, scope };
    const { summary, text } = humanSummary(payload);
    return successResult(withSummary(summary, payload), text);
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.file, resolution)}`);
  }
}

const TOOL_DESCRIPTION =
  "Find the classes that implement a TypeScript interface or derive from a class, or the members that " +
  "implement a method or property, from tsgo's type checker, which follows `implements` and `extends`. The " +
  "subject itself is never a row. A type that matches only structurally, without naming the subject, is " +
  "never listed, and every answer says so. Files no tsconfig includes are not searched: if " +
  "`scope.uncoveredSources.mentioning` lists any, the answer is incomplete until you grep them. An empty " +
  "listing is a real answer.";

export function registerTsFindImplementations(
  server: McpServer,
  sessions: LspSessionManager,
  deps: TsQueryDeps = {},
) {
  server.registerTool(
    TOOL,
    {
      title: "Find the TypeScript types implementing an interface",
      description: TOOL_DESCRIPTION,
      inputSchema: TsFindImplementationsInput.shape,
    },
    async (args) => runTsFindImplementations(sessions, args as TsFindImplementationsInputType, deps),
  );
}
