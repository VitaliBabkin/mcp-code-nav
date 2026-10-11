import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { symbolKindName, type LspDocumentSymbol } from "../clangd/outline.js";
import { textDocumentId } from "../lsp/document-uri.js";
import { clangdConfig } from "../lsp/server-config.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import type { IndexState, LspSession } from "../lsp/session.js";
import { errorResult, successResult } from "../mcp-response.js";
import { budgetOf, type Budget } from "./budget.js";
import {
  cppAnswerScope,
  cppQuestionDeclaration,
  missingCompileDbHint,
  noIndexDeclarationText,
  outsideEveryRoot,
  outsideSubjectText,
  resolveCppDeclaration,
  withEffectiveRoots,
  type CppAddress,
  type CppAnswerContext,
  type CppDeclaration,
  type CppNavigationScope,
  type CppTarget,
} from "./cpp-navigation-shared.js";
import {
  CALL_HIERARCHY_ANSWER,
  inModuleFirst,
  locationKeyFactory,
  pathOfUri,
  rangeStart,
  recordOf,
  type Located,
  type ReportedLocation,
  reportedLocation,
  unexpectedAnswerText,
} from "./lsp-locations.js";
import {
  OUTSIDE_SOURCE_ROOTS_REASON,
  type NamedRow,
  nameLocations,
  namedRow,
} from "./location-naming.js";
import {
  CALLERS_LIMIT,
  NAVIGATION_CEILING_MS,
  REFERENCE_SITES_PER_FILE_LIMIT,
} from "./navigation-limits.js";
import { candidateText, capsText, type Step, withArticle } from "./navigation-text.js";
import { CppAddressShape } from "./cpp-navigation-shared.js";
import { CLANGD_DISK_CLAUSE } from "./shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "cpp_find_callers";

/** A clangd answer read as a call hierarchy, which is a different shape from a location list. */
const CALLER_ANSWER = CALL_HIERARCHY_ANSWER;

/** The kinds a call can be made to. Anything else is a type, a field, a namespace — nothing calls those. */
const CALLABLE_KINDS = new Set(["function", "method", "constructor"]);

export type CallerSite = { readonly line: number; readonly column: number | null };

export type CallerRow = NamedRow & {
  readonly callSites: CallerSite[];
  readonly callSitesTruncated: number;
};

export type CppFindCallersPayload = {
  readonly resolved: Pick<CppDeclaration, "name" | "kind" | "file" | "line">;
  readonly totalCallers: number;
  readonly callers: CallerRow[];
  readonly callersTruncated: number;
  readonly scope: CppNavigationScope;
};

export const CppFindCallersInput = z.object(CppAddressShape);

export type CppFindCallersInputType = CppAddress;

interface CallerGroup extends Located {
  sites: CallerSite[];
}

interface CappedCaller extends Located {
  sites: CallerSite[];
  truncated: number;
}

function refusedKind(declaration: CppDeclaration): string {
  return (
    `${TOOL} failed: "${declaration.name}" is ${withArticle(declaration.kind)} declared at ` +
    `"${declaration.file}:${declaration.line}", and ${withArticle(declaration.kind)} is not called, so no ` +
    "one calls it. Ask `cpp_find_references` for where it is used instead."
  );
}

function noPositionText(declaration: CppDeclaration): string {
  return (
    `${TOOL} failed: clangd named no position for "${declaration.name}" in "${declaration.file}", so the ` +
    "call hierarchy would have to be prepared at a guessed location, which is the one input whose " +
    "staleness is silent."
  );
}

function unexpected(symbol: string, received: unknown, part?: string): string {
  return unexpectedAnswerText("clangd", TOOL, received, symbol, part, CALLER_ANSWER);
}

/** An answer that is not a list of items is a refusal, not an empty caller set. */
function asItems(result: unknown, symbol: string): Step<unknown[]> {
  if (result === null || result === undefined) return { ok: true, value: [] };
  if (!Array.isArray(result)) return { ok: false, error: unexpected(symbol, result) };
  return { ok: true, value: result };
}

function noItemText(symbol: string): string {
  return (
    `${TOOL} failed: clangd prepared no call-hierarchy item for "${symbol}", so it cannot say who calls it ` +
    "and this server will not answer the question with a reference listing instead. The declaration was " +
    "found; the caller relation was not."
  );
}

/** The one place a caller row's position comes from: the item's own declaration range, never its name. */
function readItem(
  symbol: string,
  outside: (file: string) => boolean,
  keyOf: (file: string) => string,
  raw: unknown,
  part: string,
): Step<ReportedLocation> {
  const item = recordOf(raw);
  const file = pathOfUri(item.uri);
  const start = rangeStart(item.range);
  if (file === undefined || start === undefined) return { ok: false, error: unexpected(symbol, raw, part) };
  return { ok: true, value: reportedLocation(file, start, outside, keyOf(file)) };
}

/**
 * `prepareCallHierarchy` must yield exactly one item, handed to the second request unchanged. Nothing is
 * an error the caller cannot branch on, and several are listed rather than picked — picking one would be a
 * guess about which overload or redeclaration the answer is about.
 */
function preparedItem(result: unknown, symbol: string, outside: (file: string) => boolean): Step<unknown> {
  const items = asItems(result, symbol);
  if (!items.ok) return items;
  const keyOf = locationKeyFactory();
  const only = items.value[0];
  if (items.value.length === 0) return { ok: false, error: noItemText(symbol) };
  if (items.value.length > 1) {
    const lines = items.value.map((value) => describedItem(value)).join("\n");
    return {
      ok: false,
      error:
        `${TOOL} failed: clangd offered ${items.value.length} call-hierarchy items for "${symbol}", and ` +
        `picking one would be a guess, so they are listed:\n${lines}`,
    };
  }
  const position = readItem(symbol, outside, keyOf, only, "the call-hierarchy item");
  return position.ok ? { ok: true, value: only } : position;
}

function describedItem(value: unknown): string {
  const item = recordOf(value);
  const name = typeof item.name === "string" && item.name !== "" ? item.name : "<unnamed>";
  const kind = typeof item.kind === "number" ? symbolKindName(item.kind) : "?";
  const file = pathOfUri(item.uri) ?? "<unreadable uri>";
  const start = rangeStart(item.range);
  return candidateText(name, kind, file, start === undefined ? "?" : start.line + 1);
}

function callSitesOf(value: unknown, symbol: string): Step<CallerSite[]> {
  if (value === null || value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: unexpected(symbol, value) };
  const sites: CallerSite[] = [];
  for (const [index, range] of value.entries()) {
    const start = rangeStart(range);
    if (start === undefined) return { ok: false, error: unexpected(symbol, value[index], `call site ${index + 1}`) };
    sites.push({ line: start.line + 1, column: start.character === undefined ? null : start.character + 1 });
  }
  return { ok: true, value: sites };
}

/** Incoming calls merge into one row per calling declaration, in-boundary callers ahead of external ones. */
function callerEntries(
  result: unknown,
  symbol: string,
  outside: (file: string) => boolean,
): Step<CallerGroup[]> {
  const entries = asItems(result, symbol);
  if (!entries.ok) return entries;
  const keyOf = locationKeyFactory();
  const byKey = new Map<string, CallerGroup>();
  for (const [index, entry] of entries.value.entries()) {
    const raw = recordOf(entry);
    const position = readItem(symbol, outside, keyOf, raw.from, `entry ${index + 1}`);
    if (!position.ok) return position;
    const sites = callSitesOf(raw.fromRanges, symbol);
    if (!sites.ok) return sites;
    const groupKey = `${position.value.key}:${position.value.line}:${position.value.character ?? -1}`;
    const seen = byKey.get(groupKey);
    if (seen === undefined) byKey.set(groupKey, { location: position.value, sites: sites.value });
    else seen.sites.push(...sites.value);
  }
  return { ok: true, value: inModuleFirst([...byKey.values()], (group) => group.location.external) };
}

function capCallers(groups: readonly CallerGroup[]): {
  capped: CappedCaller[];
  callersTruncated: number;
  sitesTruncated: number;
} {
  const kept = groups.slice(0, CALLERS_LIMIT);
  const capped = kept.map((group) => ({
    ...group,
    sites: group.sites.slice(0, REFERENCE_SITES_PER_FILE_LIMIT),
    truncated: group.sites.length - Math.min(group.sites.length, REFERENCE_SITES_PER_FILE_LIMIT),
  }));
  const sitesTruncated = groups.reduce(
    (total, group) => total + Math.max(0, group.sites.length - REFERENCE_SITES_PER_FILE_LIMIT),
    0,
  );
  return { capped, callersTruncated: groups.length - kept.length, sitesTruncated };
}

/**
 * Rows are named from each caller's own position by the transient outline fan-out — clangd, like gopls,
 * spells a method item with a bare member name, and a row has to read the way this server's own `name`
 * input spells a declaration. Naming happens after the caps, so a wide symbol costs a bounded number of
 * outline reads.
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
    OUTSIDE_SOURCE_ROOTS_REASON,
    // Rows name the calling declaration, which for C++ is a member: the deepest enclosing one, qualified.
    true,
  );
  return named.map((entry) => ({ ...namedRow(entry), callSites: entry.sites, callSitesTruncated: entry.truncated }));
}

/**
 * What the answer's window produced. `declaration` is absent only when the name resolved to nothing at all,
 * which the caller refuses with the index state the window just latched; the two hierarchy requests are then
 * unasked-for, because there was no callable subject to ask them about.
 */
type AskedCallers = {
  readonly target: CppTarget;
  readonly declaration?: CppDeclaration;
  readonly incoming?: unknown;
};

function callerText(row: CallerRow): string {
  const where = row.external ? "outside every declared source root" : row.file;
  const sites = row.callSitesTruncated > 0 ? `, ${row.callSitesTruncated} call site(s) not listed` : "";
  return `  ${row.name ?? "<unnamed>"} (${row.kind ?? "?"}) at ${where}:${row.line}${sites}${row.reason ? ` - ${row.reason}` : ""}`;
}

function humanSummary(payload: CppFindCallersPayload): string {
  const { resolved, totalCallers, callers, callersTruncated, scope } = payload;
  const sites = callers.reduce((total, row) => total + row.callSitesTruncated, 0);
  const listing = callers.map(callerText).join("\n");
  const tail = capsText([
    callersTruncated > 0 ? `${callersTruncated} caller row(s) dropped by the ${CALLERS_LIMIT}-row cap` : undefined,
    sites > 0 ? `${sites} call site(s) dropped by the ${REFERENCE_SITES_PER_FILE_LIMIT}-sites-per-caller cap` : undefined,
  ]);
  const head =
    `Callers of ${resolved.kind} "${resolved.name}" (${resolved.file}:${resolved.line}) in project ` +
    `"${scope.projectRoot}" - ${totalCallers} caller(s) across ${callers.length + callersTruncated} ` +
    `declaration(s), index: ${scope.index.state}${tail}.`;
  return `${head}\nlimits: ${scope.limits.join(", ")}${listing === "" ? "" : `\n${listing}`}`;
}

function emptyWhileNotQuiescent(symbol: string, state: IndexState): string {
  const why =
    state === "building"
      ? "clangd was indexing while this call ran, so the shards this answer came from are incomplete"
      : "clangd never reported indexing progress to this session, so its index state is not known";
  return (
    `${TOOL} failed: no callers of "${symbol}" were found, and that is not reportable as an answer: ${why}. ` +
    "Call again once indexing has settled — a `quiescent` index with no callers answers as a scoped empty instead."
  );
}

/** The caps, the naming of the capped rows, and the payload: everything after the hierarchy answered. */
async function callersAnswer(
  session: LspSession,
  context: CppAnswerContext,
  declaration: CppDeclaration,
  entries: readonly CallerGroup[],
  budget: Budget,
): Promise<CppFindCallersPayload> {
  const { capped, callersTruncated, sitesTruncated } = capCallers(entries);
  const callers = await buildCallers(session, capped, declaration.file, await outlineOf(session, declaration.file), budget);
  return {
    resolved: { name: declaration.name, kind: declaration.kind, file: declaration.file, line: declaration.line },
    totalCallers: entries.length,
    callers,
    callersTruncated,
    scope: cppAnswerScope(context, { capped: callersTruncated > 0 || sitesTruncated > 0, indirectDispatch: true }),
  };
}

export async function runCppFindCallers(sessions: LspSessionManager, raw: CppFindCallersInputType) {
  try {
    const missingDb = await missingCompileDbHint(raw.projectRoot);
    if (missingDb !== undefined) return errorResult(`${TOOL} failed: ${missingDb}`);

    const { roots, input } = withEffectiveRoots(raw);
    const session = sessions.get(input.projectRoot, clangdConfig);
    // One budget per call. Naming the rows is bounded by what this call has left, never by how long this
    // process has been up: a ceiling taken at import would be spent before its first question was asked.
    const budget = budgetOf(NAVIGATION_CEILING_MS);
    const resolved = await resolveCppDeclaration(TOOL, session, input, roots.block);
    if (!resolved.ok) return errorResult(resolved.error);
    const outside = outsideEveryRoot(input.projectRoot, input.sourceRoots);
    const reading = await session.indexDriftReading(input.sourceRoots);

    // One answer, one window: clangd's reply to the second request is only meaningful beside the item the
    // first produced, and the state is about the span the answer was computed across — which is also
    // the span of the symbol query that had to come first when the declaration itself came from the index. A
    // refusal inside the window is carried out as the step it is, not as an empty caller list.
    const { value: asked, index } = await session.withIndexWindow(async (): Promise<Step<AskedCallers>> => {
      const target = await cppQuestionDeclaration(TOOL, input, resolved.value, (query) =>
        session.request<unknown>("workspace/symbol", { query }),
      );
      if (!target.ok) return target;
      const declaration = target.value.declaration;
      if (declaration === undefined) return { ok: true, value: { target: target.value } };
      if (!CALLABLE_KINDS.has(declaration.kind)) return { ok: false, error: refusedKind(declaration) };
      if (declaration.namePosition === undefined) return { ok: false, error: noPositionText(declaration) };
      // As in `cpp_find_references`: the hierarchy is answered from the AST of the declaring document, which the
      // index branch may have just named from a file beyond the boundary. `callHierarchy/incomingCalls` needs
      // no document and is asked against the item, so it stays outside the hold.
      if (outside(declaration.file)) return { ok: false, error: outsideSubjectText(TOOL, input.name, declaration) };
      const position = declaration.namePosition;
      const prepared = await session.withTransientDocument(declaration.file, (holding) =>
        holding.send<unknown>("textDocument/prepareCallHierarchy", {
          textDocument: textDocumentId(holding.openedAs),
          position,
        }),
      );
      const item = preparedItem(prepared, input.name, outside);
      if (!item.ok) return item;
      return {
        ok: true,
        value: {
          target: target.value,
          declaration,
          incoming: await session.request<unknown>("callHierarchy/incomingCalls", { item: item.value }),
        },
      };
    });
    if (!asked.ok) return errorResult(asked.error);
    const declaration = asked.value.declaration;
    if (declaration === undefined) {
      return errorResult(
        noIndexDeclarationText(TOOL, input.name, input.projectRoot, index, asked.value.target.capped),
      );
    }

    const entries = callerEntries(asked.value.incoming, input.name, outside);
    if (!entries.ok) return errorResult(entries.error);
    if (entries.value.length === 0 && index !== "quiescent") {
      return errorResult(emptyWhileNotQuiescent(input.name, index));
    }

    const payload = await callersAnswer(session, { projectRoot: input.projectRoot, roots, index, reading }, declaration, entries.value, budget);
    return successResult(payload, humanSummary(payload));
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}`);
  }
}

/**
 * The outline the rows in the subject's own file are named from, read transiently: a question that named no
 * file must not change what the session holds, and holding it would make the next unscoped question about the
 * same name answer from the opened files instead of the index.
 */
async function outlineOf(session: LspSession, file: string): Promise<readonly LspDocumentSymbol[]> {
  return (await session.documentSymbolTransient(file)) ?? [];
}

const TOOL_DESCRIPTION =
  "Find who calls a C++ function or method from clangd's call hierarchy - unlike grep, it separates calls " +
  "from mentions and tells overloads apart. Rows follow the declaration a call is written against, not the " +
  "run-time target (`indirect-dispatch-not-resolved`): a virtual call is listed under the base and under " +
  "every override, and a call through a function pointer or `std::function` is absent, with the place it " +
  "was bound listed instead. Counts are exact even when the listing is capped, and an empty listing comes " +
  "only from a settled index. " + CLANGD_DISK_CLAUSE;

export function registerCppFindCallers(server: McpServer, sessions: LspSessionManager) {
  server.registerTool(
    TOOL,
    {
      title: "Find who calls a C++ function or method",
      description: TOOL_DESCRIPTION,
      inputSchema: CppFindCallersInput.shape,
    },
    async (args) => runCppFindCallers(sessions, args as CppFindCallersInputType),
  );
}
