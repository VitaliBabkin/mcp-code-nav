import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolKindName, type LspDocumentSymbol } from "../clangd/outline.js";
import { textDocumentId } from "../lsp/document-uri.js";
import type { LspSession } from "../lsp/session.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { errorResult, successResult } from "../mcp-response.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import type { Budget } from "./budget.js";
import {
  CALL_HIERARCHY_ANSWER,
  inModuleFirst,
  type Located,
  locationKeyFactory,
  pathOfUri,
  rangeStart,
  recordOf,
  type ReportedLocation,
  reportedLocation,
  unexpectedAnswerText,
} from "./lsp-locations.js";
import { type NamedRow, nameLocations, namedRow } from "./location-naming.js";
import { CALLERS_LIMIT, REFERENCE_SITES_PER_FILE_LIMIT } from "./navigation-limits.js";
import { candidateText, capsText, type Step } from "./navigation-text.js";
import { NameInput, PathInput } from "./input-limits.js";
import { resolutionNote } from "./shared.js";
import {
  OUTSIDE_WORKSPACE_REASON,
  mentionNameOf,
  openTsQuery,
  tsFileExternal,
  tsNavigationScope,
  tsRowSpeller,
  tsScopeText,
  summarised,
  tsTypeAwareRequest,
  type TsNavigationScope,
  type TsQuery,
  type TsQueryDeps,
  type TsResolvedSymbol,
} from "./ts-navigation-shared.js";
import { type HumanSummary, TsSourceRootsSchema, timeBudgetSchema, withSummary } from "./ts-shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "ts_find_callers";

export type TsCallSite = { readonly line: number; readonly column: number | null };

export type TsCallerRow = NamedRow & {
  readonly callSites: TsCallSite[];
  readonly callSitesTruncated: number;
};

/**
 * `go_find_callers`' payload over a TypeScript workspace: one row per calling
 * declaration with the sites inside it, exact counts whatever the caps dropped, and the workspace `scope`.
 */
export type TsFindCallersPayload = {
  readonly resolved: TsResolvedSymbol;
  readonly totalCallers: number;
  readonly callers: TsCallerRow[];
  readonly callersTruncated: number;
  readonly scope: TsNavigationScope;
};

export const TsFindCallersInput = z.object({
  sourceRoots: TsSourceRootsSchema,
  file: PathInput
    .describe("The file declaring the symbol: absolute, or relative to exactly one sourceRoots entry."),
  symbol: NameInput
    .describe(
      "Name as declared in `file`: top-level, or a dotted path through classes, interfaces, enums and " +
        "namespaces (`ExecDriver.run`, `Ns.Inner.x`). An arrow-function `const` counts as callable.",
    ),
  timeBudgetMs: timeBudgetSchema(60_000),
});

export type TsFindCallersInputType = z.infer<typeof TsFindCallersInput>;

/** One calling declaration: where it is, and the ranges in it that call the subject. */
interface CallerGroup extends Located {
  sites: TsCallSite[];
  readonly moduleScope: boolean;
}

/** A group that survived the caps, with what its own cap dropped. */
interface CappedCaller extends Located {
  readonly moduleScope: boolean;
  readonly sites: TsCallSite[];
  readonly truncated: number;
}

/**
 * tsgo holds the declaration and still offers nothing to ask calls about — which is this tool's whole gate.
 * The server's answer is the test because tsgo's kind cannot tell an arrow-function `const` from
 * data, so a refusal says what the server said and points at the tool that answers mentions instead.
 */
function notCallableText(symbol: string, file: string): string {
  return (
    `${TOOL} failed: tsgo offers no call hierarchy for "${symbol}" in "${file}", so it is not callable - a ` +
    "variable, a constant that is not a function, a type or a plain object member never has callers. This " +
    "server will not answer the question with a references list instead: a mention is not a call. Name the " +
    "function, method or callable `const` and call again."
  );
}

function unexpectedCallText(symbol: string, received: unknown, part?: string): string {
  return unexpectedAnswerText("tsgo", TOOL, received, symbol, part, CALL_HIERARCHY_ANSWER);
}

/**
 * The position a caller row is named from: the item's identifier (`selectionRange`), never its `name` or `kind` —
 * a row must read the way this tool's own `symbol` input spells that declaration. The
 * item's `range` is no substitute: tsgo starts it at a leading comment, above every outline entry's range.
 * `range` is the fallback for an item that carries no selection.
 */
function readItem(
  symbol: string,
  workspaceRoot: string,
  keyOf: (file: string) => string,
  raw: unknown,
  part: string,
): Step<ReportedLocation> {
  const item = recordOf(raw);
  const file = pathOfUri(item.uri);
  const start = rangeStart(item.selectionRange) ?? rangeStart(item.range);
  if (file === undefined || start === undefined) {
    return { ok: false, error: unexpectedCallText(symbol, raw, part) };
  }
  return { ok: true, value: reportedLocation(file, start, tsFileExternal(workspaceRoot), keyOf(file)) };
}

const MODULE_SYMBOL_KIND = 2;

/**
 * tsgo's item for a SOURCE FILE, which is what a site with no enclosing callable is credited to: the Module
 * kind, named by the file's path, with an empty selection at 0:0. Outline containment cannot recognise it —
 * a file whose first declaration starts at 0:0 would contain that position and take the site — so the item
 * says what it is.
 */
function isSourceFileItem(raw: unknown): boolean {
  const item = recordOf(raw);
  if (item.kind !== MODULE_SYMBOL_KIND) return false;
  const selection = recordOf(item.selectionRange);
  const start = rangeStart(selection);
  const end = rangeStart({ start: selection.end });
  return (
    start?.line === 0 && start.character === 0 && end?.line === 0 && end.character === 0
  );
}

function describedItem(value: unknown): string {
  const item = recordOf(value);
  const name = typeof item.name === "string" && item.name !== "" ? item.name : "<unnamed>";
  const kind = typeof item.kind === "number" ? symbolKindName(item.kind) : "?";
  const file = pathOfUri(item.uri) ?? "<unreadable uri>";
  const start = rangeStart(item.selectionRange) ?? rangeStart(item.range);
  return candidateText(name, kind, file, start === undefined ? "?" : start.line + 1);
}

/**
 * `prepareCallHierarchy` must answer one item, which is handed back to the second request unchanged. None is
 * the not-callable refusal; several are listed rather than picked, because choosing one answers about a
 * declaration the caller did not name.
 */
function preparedItem(
  result: unknown,
  query: TsQuery,
  symbol: string,
  keyOf: (file: string) => string,
): Step<unknown> {
  if (result !== null && result !== undefined && !Array.isArray(result)) {
    return { ok: false, error: unexpectedCallText(symbol, result) };
  }
  const items = Array.isArray(result) ? result : [];
  if (items.length === 0) return { ok: false, error: notCallableText(symbol, query.file) };
  if (items.length > 1) {
    const lines = items.map(describedItem).join("\n");
    return {
      ok: false,
      error:
        `${TOOL} failed: tsgo offered ${items.length} call-hierarchy items for "${symbol}", and picking one ` +
        `would be a guess, so they are listed:\n${lines}`,
    };
  }
  const only = items[0];
  const position = readItem(symbol, query.workspaceRoot, keyOf, only, "the call-hierarchy item");
  return position.ok ? { ok: true, value: only } : position;
}

function callSitesOf(value: unknown, symbol: string): Step<TsCallSite[]> {
  if (value === null || value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: unexpectedCallText(symbol, value) };
  const sites: TsCallSite[] = [];
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
 * times with different ranges, and "who calls this" is answered by declaration. In-workspace callers are kept
 * ahead of external ones, so a cap drops external rows first.
 */
function callerEntries(result: unknown, query: TsQuery, symbol: string, keyOf: (file: string) => string): Step<CallerGroup[]> {
  if (result !== null && result !== undefined && !Array.isArray(result)) {
    return { ok: false, error: unexpectedCallText(symbol, result) };
  }
  const byKey = new Map<string, CallerGroup>();
  const entries = Array.isArray(result) ? result : [];
  for (const [index, entry] of entries.entries()) {
    const raw = recordOf(entry);
    const position = readItem(symbol, query.workspaceRoot, keyOf, raw.from, `entry ${index + 1}`);
    if (!position.ok) return position;
    const sites = callSitesOf(raw.fromRanges, symbol);
    if (!sites.ok) return sites;
    const location = position.value;
    const moduleScope = isSourceFileItem(raw.from);
    const groupKey = `${location.key}:${location.line}:${location.character ?? -1}:${moduleScope}`;
    const seen = byKey.get(groupKey);
    if (seen === undefined) byKey.set(groupKey, { location, sites: sites.value, moduleScope });
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
    return { location: group.location, moduleScope: group.moduleScope, sites, truncated: group.sites.length - sites.length };
  });
  const sitesTruncated = kept.reduce((total, group) => total + group.truncated, 0);
  return { capped: kept, callersTruncated: groups.length - kept.length, sitesTruncated };
}

/**
 * The reason a caller row has no name because TypeScript credited its site to the SOURCE FILE rather than to a
 * declaration. The generic "no declaration encloses" text would read as a
 * naming failure; this row is not one — the site is real and its caller is the file's top level.
 */
const MODULE_SCOPE_REASON = "at module scope; no declaration encloses this site";
const MODULE_SCOPE_ROW = { name: null, kind: null, reason: MODULE_SCOPE_REASON };

/**
 * The naming of a capped listing: a row's `name` and `kind` come from the transient-outline fan-out at the
 * item's own position, spelled the way this tool's `symbol` accepts it — so the reads are bounded by what
 * survived the caps, and an external file is never opened.
 */
async function buildCallers(
  session: LspSession,
  capped: readonly CappedCaller[],
  queriedFile: string,
  queriedOutline: readonly LspDocumentSymbol[],
  budget: Budget,
): Promise<TsCallerRow[]> {
  const named = await nameLocations(
    session,
    capped,
    queriedFile,
    queriedOutline,
    budget,
    OUTSIDE_WORKSPACE_REASON,
    false,
    tsRowSpeller(MODULE_SCOPE_REASON),
  );
  return named.map((entry) => {
    // A source-file item is module scope whatever the outline holds at 0:0; an external row keeps its own reason.
    const row = entry.moduleScope && !entry.location.external ? { ...entry, ...MODULE_SCOPE_ROW } : entry;
    return { ...namedRow(row), callSites: entry.sites, callSitesTruncated: entry.truncated };
  });
}

function callerText(row: TsCallerRow): string {
  const name = row.name ?? "<unnamed>";
  const kind = row.kind ?? "?";
  const external = row.external ? " outside the workspace" : "";
  const tail = row.callSitesTruncated > 0 ? `, ${row.callSitesTruncated} call site(s) not listed` : "";
  return `  ${name} (${kind}) ${row.file}:${row.line}${external}${row.reason ? ` - ${row.reason}` : ""}${tail}`;
}

function siteText(site: TsCallSite): string {
  const column = site.column === null ? "" : `:${site.column}`;
  return `    called at ${site.line}${column}`;
}

/** The same JSON, phrased once for a reader who will not parse it. */
function humanSummary(payload: TsFindCallersPayload): HumanSummary {
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
    `Callers of ${resolved.kind} "${resolved.name}" (${resolved.file}:${resolved.line})${tsScopeText(scope)} ` +
    `- ${callers.length} caller(s) listed from ${totalCallers} found${tail}.`;
  return summarised(head, scope, `limits: ${scope.limits.join(", ")}${listing === "" ? "" : `\n${listing}`}`);
}

export async function runTsFindCallers(
  sessions: LspSessionManager,
  input: TsFindCallersInputType,
  deps: TsQueryDeps = {},
) {
  let resolution: ResolvedPath | undefined;
  try {
    const opened = await openTsQuery(TOOL, sessions, input, deps, (resolved) => {
      resolution = resolved;
    });
    if (!opened.ok) return errorResult(opened.error);
    const query = opened.value;
    const keyOf = locationKeyFactory();

    const prepared = await tsTypeAwareRequest(
      TOOL,
      query,
      input.symbol,
      "textDocument/prepareCallHierarchy",
      { textDocument: textDocumentId(query.file), position: query.subject.position },
      `prepare the call hierarchy for "${input.symbol}"`,
    );
    if (!prepared.ok) return errorResult(prepared.error);
    const item = preparedItem(prepared.value, query, input.symbol, keyOf);
    if (!item.ok) return errorResult(item.error);

    const incoming = await tsTypeAwareRequest(
      TOOL,
      query,
      input.symbol,
      "callHierarchy/incomingCalls",
      { item: item.value },
      `return the incoming calls of "${input.symbol}"`,
    );
    if (!incoming.ok) return errorResult(incoming.error);
    const groups = callerEntries(incoming.value, query, input.symbol, keyOf);
    if (!groups.ok) return errorResult(groups.error);

    const { capped, callersTruncated, sitesTruncated } = capCallers(groups.value);
    const rows = await buildCallers(query.session, capped, query.file, query.symbols, query.budget);
    const scope = await tsNavigationScope(
      query,
      {
        capped: callersTruncated > 0 || sitesTruncated > 0,
        // tsgo credits a call made through an interface to the implementing method , which is the
        // same over-report Go's answer carries and states in the same code.
        correspondingMethods: query.subject.kind === "method",
        // A call through a function value is no hierarchy edge, and every caller answer says so.
        indirectDispatch: true,
        // The other half of that pair, and true of every answer here — a member
        // mentioned as `x.m` or `x["m"]` without being called is listed as a caller at that site.
        uncalledMentions: true,
      },
      mentionNameOf(input.symbol),
    );
    const payload: TsFindCallersPayload = {
      resolved: query.resolved,
      totalCallers: groups.value.length,
      callers: rows,
      callersTruncated,
      scope,
    };
    const { summary, text } = humanSummary(payload);
    return successResult(withSummary(summary, payload), text);
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.file, resolution)}`);
  }
}

const TOOL_DESCRIPTION =
  "Find who calls a TypeScript function, method or callable const from tsgo's call hierarchy - unlike grep, it " +
  "ignores comments, strings and same-named identifiers. For a method it also lists calls through an " +
  "interface value. A member mentioned as `x.m` without a call (a callback, a bind) is listed as a caller, " +
  "while a later call through that stored value, like any call through a function value, is absent. Counts " +
  "are exact even when capped. Files no tsconfig includes are not searched: if " +
  "`scope.uncoveredSources.mentioning` lists any, the answer is incomplete until you grep them. An empty " +
  "listing is a real answer.";

export function registerTsFindCallers(
  server: McpServer,
  sessions: LspSessionManager,
  deps: TsQueryDeps = {},
) {
  server.registerTool(
    TOOL,
    {
      title: "Find who calls a TypeScript function or method",
      description: TOOL_DESCRIPTION,
      inputSchema: TsFindCallersInput.shape,
    },
    async (args) => runTsFindCallers(sessions, args as TsFindCallersInputType, deps),
  );
}
