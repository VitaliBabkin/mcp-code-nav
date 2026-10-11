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
  type GoNavigationScope,
  type ResolvedSymbol,
  environmentText,
  freshnessText,
  navigationScope,
  openGoQuery,
  typeAwareRequest,
} from "./go-navigation-shared.js";
import {
  CALL_HIERARCHY_ANSWER,
  inModuleFirst,
  type Located,
  locationKeyFactory,
  outsideRoot,
  pathOfUri,
  rangeStart,
  recordOf,
  type ReportedLocation,
  reportedLocation,
  unexpectedAnswerText,
} from "./lsp-locations.js";
import { OUTSIDE_MODULE_REASON, type NamedRow, nameLocations, namedRow } from "./location-naming.js";
import { candidateText, capsText, type Step, withArticle } from "./navigation-text.js";
import { CALLERS_LIMIT, REFERENCE_SITES_PER_FILE_LIMIT } from "./navigation-limits.js";
import { messageOf } from "../error-message.js";

const TOOL = "go_find_callers";

/** Only these kinds are ever called, so only these have callers. */
const CALLABLE_KINDS = new Set(["function", "method"]);

export type CallSite = { readonly line: number; readonly column: number | null };

export type CallerRow = NamedRow & {
  readonly callSites: CallSite[];
  readonly callSitesTruncated: number;
};

export type FindCallersPayload = {
  readonly resolved: ResolvedSymbol;
  readonly totalCallers: number;
  readonly callers: CallerRow[];
  readonly callersTruncated: number;
  readonly scope: GoNavigationScope;
};

/** One calling declaration: where it is, and the ranges in it that call the subject. */
interface CallerGroup extends Located {
  sites: CallSite[];
}

/** A group that survived the caps, with what its own cap dropped. */
interface CappedCaller extends Located {
  readonly sites: CallSite[];
  readonly truncated: number;
}

export const GoFindCallersInput = z.object({
  sourceRoots: GoSourceRootsSchema,
  file: GoDeclaringFileSchema,
  symbol: NameInput
    .describe(
      "A function or method: exact name as declared at the top level of `file`; a method takes its receiver " +
        "(`Concrete.Get` or `(*Concrete).Get`), and a bare `Get` means the package-level `Get`.",
    ),
  timeBudgetMs: timeBudgetSchema(60_000),
});

export type GoFindCallersInputType = z.infer<typeof GoFindCallersInput>;

export interface GoFindCallersDeps {
  /**
   * Seam for the `go` subprocesses that state the port this answer was computed under; a test injects one
   * so the default suite never runs a Go toolchain (see CONTRIBUTING.md).
   */
  exec?: GoExecFn;
}

function callableFor(symbol: LspDocumentSymbol): Step<string> {
  const kind = symbolKindName(symbol.kind);
  if (CALLABLE_KINDS.has(kind)) return { ok: true, value: kind };
  return {
    ok: false,
    error:
      `${TOOL} failed: "${symbol.name}" is ${withArticle(kind)}, and only a function or a method has ` +
      "callers. A type, variable or constant is never called - ask go_find_references for where it is used " +
      "instead.",
  };
}

/** gopls has the declaration and still offers nothing to ask calls about. */
function noItemText(tool: string, symbol: string): string {
  return (
    `${tool} failed: gopls returned no call-hierarchy item for "${symbol}", so this server cannot address ` +
    "the call hierarchy. It will not answer the question with a references list instead - a mention is not " +
    "a call. Check that the declaration is a function or method gopls has loaded, then call again."
  );
}

function unexpectedCallText(symbol: string, received: unknown, part?: string): string {
  return unexpectedAnswerText("gopls", TOOL, received, symbol, part, CALL_HIERARCHY_ANSWER);
}

/**
 * The position a caller row is named from: the item's own declaration range, never the item's `name` or
 * `kind` — gopls spells a method item with the bare member name and a function kind, and a row must read
 * the way this tool's own `symbol` input spells that declaration.
 */
function readItem(
  symbol: string,
  moduleRoot: string,
  keyOf: (file: string) => string,
  raw: unknown,
  part: string,
): Step<ReportedLocation> {
  const item = recordOf(raw);
  const file = pathOfUri(item.uri);
  const start = rangeStart(item.range);
  if (file === undefined || start === undefined) {
    return { ok: false, error: unexpectedCallText(symbol, raw, part) };
  }
  return { ok: true, value: reportedLocation(file, start, outsideRoot(moduleRoot), keyOf(file)) };
}

function describedItem(value: unknown): string {
  const item = recordOf(value);
  const name = typeof item.name === "string" && item.name !== "" ? item.name : "<unnamed>";
  const kind = typeof item.kind === "number" ? symbolKindName(item.kind) : "?";
  const file = pathOfUri(item.uri) ?? "<unreadable uri>";
  const start = rangeStart(item.range);
  return candidateText(name, kind, file, start === undefined ? "?" : start.line + 1);
}

/**
 * `prepareCallHierarchy` must yield exactly one item, which is handed back to the second request unchanged.
 * Nothing is an error the caller cannot branch on without guessing, and several are listed rather than picked.
 */
function preparedItem(
  result: unknown,
  moduleRoot: string,
  symbol: string,
  keyOf: (file: string) => string,
): Step<unknown> {
  if (result !== null && result !== undefined && !Array.isArray(result)) {
    return { ok: false, error: unexpectedCallText(symbol, result) };
  }
  const items = Array.isArray(result) ? result : [];
  if (items.length === 0) return { ok: false, error: noItemText(TOOL, symbol) };
  if (items.length > 1) {
    const lines = items.map(describedItem).join("\n");
    return {
      ok: false,
      error:
        `${TOOL} failed: gopls offered ${items.length} call-hierarchy items for "${symbol}", and picking one ` +
        `would be a guess, so they are listed:\n${lines}`,
    };
  }
  const only = items[0];
  const position = readItem(symbol, moduleRoot, keyOf, only, "the call-hierarchy item");
  return position.ok ? { ok: true, value: only } : position;
}

function callSitesOf(value: unknown, symbol: string): Step<CallSite[]> {
  if (value === null || value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: unexpectedCallText(symbol, value) };
  const sites: CallSite[] = [];
  for (const [index, range] of value.entries()) {
    const start = rangeStart(range);
    if (start === undefined) {
      return { ok: false, error: unexpectedCallText(symbol, value[index], `call site ${index + 1}`) };
    }
    sites.push({ line: start.line + 1, column: start.character === undefined ? null : start.character + 1 });
  }
  return { ok: true, value: sites };
}

/**
 * Incoming calls merge into one group per calling declaration: a server may report the same caller several
 * times with different ranges, and "who calls this" is answered by declaration. In-module callers are kept
 * ahead of external ones, so a cap drops external rows first.
 */
function callerEntries(
  result: unknown,
  moduleRoot: string,
  symbol: string,
  keyOf: (file: string) => string,
): Step<CallerGroup[]> {
  if (result !== null && result !== undefined && !Array.isArray(result)) {
    return { ok: false, error: unexpectedCallText(symbol, result) };
  }
  const byKey = new Map<string, CallerGroup>();
  const entries = Array.isArray(result) ? result : [];
  for (const [index, entry] of entries.entries()) {
    const raw = recordOf(entry);
    const position = readItem(symbol, moduleRoot, keyOf, raw.from, `entry ${index + 1}`);
    if (!position.ok) return position;
    const sites = callSitesOf(raw.fromRanges, symbol);
    if (!sites.ok) return sites;
    const location = position.value;
    const groupKey = `${location.key}:${location.line}:${location.character ?? -1}`;
    const seen = byKey.get(groupKey);
    if (seen === undefined) byKey.set(groupKey, { location, sites: sites.value });
    else seen.sites.push(...sites.value);
  }
  return { ok: true, value: inModuleFirst([...byKey.values()], (group) => group.location.external) };
}

function capCallers(groups: readonly CallerGroup[]): {
  capped: CappedCaller[];
  callersTruncated: number;
  sitesTruncated: number;
} {
  const kept = groups.slice(0, CALLERS_LIMIT).map((group) => {
    const sites = group.sites.slice(0, REFERENCE_SITES_PER_FILE_LIMIT);
    return { location: group.location, sites, truncated: group.sites.length - sites.length };
  });
  const sitesTruncated = kept.reduce((total, group) => total + group.truncated, 0);
  return { capped: kept, callersTruncated: groups.length - kept.length, sitesTruncated };
}

/**
 * The naming of a capped listing: a row's `name` and `kind` come from the transient-outline fan-out at the
 * item's own position, so the reads are bounded by what survived the caps and an external file is never
 * opened.
 */
async function buildCallers(
  session: LspSession,
  capped: readonly CappedCaller[],
  queriedFile: string,
  queriedOutline: readonly LspDocumentSymbol[],
  budget: Budget,
): Promise<CallerRow[]> {
  const named = await nameLocations(
    session,
    capped,
    queriedFile,
    queriedOutline,
    budget,
    OUTSIDE_MODULE_REASON,
  );
  return named.map((entry) => ({ ...namedRow(entry), callSites: entry.sites, callSitesTruncated: entry.truncated }));
}

function callerText(row: CallerRow): string {
  const name = row.name ?? "<unnamed>";
  const kind = row.kind ?? "?";
  const external = row.external ? " outside the module" : "";
  const tail = row.callSitesTruncated > 0 ? `, ${row.callSitesTruncated} call site(s) not listed` : "";
  return `  ${name} (${kind}) ${row.file}:${row.line}${external}${row.reason ? ` - ${row.reason}` : ""}${tail}`;
}

function siteText(site: CallSite): string {
  const column = site.column === null ? "" : `:${site.column}`;
  return `    called at ${site.line}${column}`;
}

/** The same JSON, phrased once for a reader who will not parse it. */
function humanSummary(payload: FindCallersPayload): string {
  const { resolved, totalCallers, callers, callersTruncated, scope } = payload;
  const sites = callers.reduce((total, row) => total + row.callSitesTruncated, 0);
  const listing = callers.map((row) => [callerText(row), ...row.callSites.map(siteText)].join("\n")).join("\n");
  const tail = capsText([
    callersTruncated > 0 ? `${callersTruncated} caller(s) dropped by the ${CALLERS_LIMIT}-caller cap` : undefined,
    sites > 0
      ? `${sites} call site(s) dropped by the ${REFERENCE_SITES_PER_FILE_LIMIT}-sites-per-caller cap`
      : undefined,
  ]);
  const head =
    `Callers of ${resolved.kind} "${resolved.name}" (${resolved.file}:${resolved.line}) in module ` +
    `"${scope.moduleRoot}"${environmentText(scope)} - ${callers.length} caller(s) listed from ` +
    `${totalCallers} found, visibility: ${scope.visibility}, ` +
    `freshness: ${freshnessText(scope.freshness)}${tail}.`;
  return `${head}\nlimits: ${scope.limits.join(", ")}${listing === "" ? "" : `\n${listing}`}`;
}

export async function runGoFindCallers(
  sessions: LspSessionManager,
  input: GoFindCallersInputType,
  deps: GoFindCallersDeps = {},
) {
  let resolution: ResolvedPath | undefined;
  try {
    const opened = await openGoQuery(TOOL, sessions, input, deps, callableFor, (resolved) => {
      resolution = resolved;
    });
    if (!opened.ok) return errorResult(opened.error);
    const query = opened.value;
    const { file, moduleRoot, budget, session, symbols, picked } = query;
    const keyOf = locationKeyFactory();

    const prepared = await typeAwareRequest(
      TOOL,
      query,
      input.symbol,
      "textDocument/prepareCallHierarchy",
      { textDocument: textDocumentId(file), position: picked.position },
      `prepare the call hierarchy for "${input.symbol}"`,
    );
    if (!prepared.ok) return errorResult(prepared.error);
    const item = preparedItem(prepared.value, moduleRoot, input.symbol, keyOf);
    if (!item.ok) return errorResult(item.error);

    const incoming = await typeAwareRequest(
      TOOL,
      query,
      input.symbol,
      "callHierarchy/incomingCalls",
      { item: item.value },
      `return the incoming calls of "${input.symbol}"`,
    );
    if (!incoming.ok) return errorResult(incoming.error);
    const groups = callerEntries(incoming.value, moduleRoot, input.symbol, keyOf);
    if (!groups.ok) return errorResult(groups.error);

    const { capped, callersTruncated, sitesTruncated } = capCallers(groups.value);
    const rows = await buildCallers(session, capped, file, symbols, budget);
    const scope = await navigationScope(query, "callers", callersTruncated > 0 || sitesTruncated > 0);
    const payload: FindCallersPayload = {
      resolved: picked.resolved,
      totalCallers: groups.value.length,
      callers: rows,
      callersTruncated,
      scope,
    };
    return successResult(payload, humanSummary(payload));
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.file, resolution)}`);
  }
}

const TOOL_DESCRIPTION =
  "Find who calls a Go function or method from gopls's call hierarchy - unlike grep, it separates calls " +
  "from mentions and same-named functions. Counts are exact even when the listing is capped. For a method " +
  "it also lists calls through an interface value, including ones another implementation serves at run " +
  "time; calls through a func-typed variable or reflection are absent. An empty listing is a real answer, " +
  "returned only once the module has loaded.";

export function registerGoFindCallers(
  server: McpServer,
  sessions: LspSessionManager,
  deps: GoFindCallersDeps = {},
) {
  server.registerTool(
    TOOL,
    {
      title: "Find who calls a Go function or method",
      description: TOOL_DESCRIPTION,
      inputSchema: GoFindCallersInput.shape,
    },
    async (args) => runGoFindCallers(sessions, args as GoFindCallersInputType, deps),
  );
}
