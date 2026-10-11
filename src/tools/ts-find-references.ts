import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textDocumentId } from "../lsp/document-uri.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { errorResult, successResult } from "../mcp-response.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { inModuleFirst, type Located, type ReportedLocation, toReported } from "./lsp-locations.js";
import { type NamedSymbol, nameLocations } from "./location-naming.js";
import { renamedImportOf, subjectIdentity } from "./ts-alias-identity.js";
import { REFERENCE_FILES_LIMIT, REFERENCE_SITES_PER_FILE_LIMIT } from "./navigation-limits.js";
import { capsText } from "./navigation-text.js";
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
  withoutPositions,
  type TsNavigationScope,
  type TsQuery,
  type TsQueryDeps,
  type TsResolvedSymbol,
} from "./ts-navigation-shared.js";
import { type HumanSummary, TsSourceRootsSchema, timeBudgetSchema, withSummary } from "./ts-shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "ts_find_references";

/** One use-site as tsgo reported it. `column` is null only when the server sent no character. */
export type TsReferenceSite = {
  readonly line: number;
  readonly column: number | null;
  readonly in: string | null;
  readonly reason?: string;
};

/** One file's kept sites, before naming: `count` stays the exact number the server reported. */
type ReferenceGroup = {
  readonly file: string;
  readonly external: boolean;
  sites: ReportedLocation[];
};

export type TsReferenceFile = {
  readonly file: string;
  readonly external: boolean;
  readonly count: number;
  readonly sitesTruncated: number;
  readonly sites: TsReferenceSite[];
};

/**
 * `go_find_references`' payload over a TypeScript workspace: the same grouping, the same
 * exact counts and the same two caps, so a caller that reads both languages reads one shape and only `scope`
 * speaks a different boundary.
 */
export type TsFindReferencesPayload = {
  readonly resolved: TsResolvedSymbol;
  readonly totalReferences: number;
  readonly files: TsReferenceFile[];
  readonly filesTruncated: number;
  readonly scope: TsNavigationScope;
};

export const TsFindReferencesInput = z.object({
  sourceRoots: TsSourceRootsSchema,
  file: PathInput
    .describe("The file declaring the symbol: absolute, or relative to exactly one sourceRoots entry."),
  symbol: NameInput
    .describe(
      "Name as declared in `file`: top-level, or a dotted path through classes, interfaces, enums and " +
        "namespaces (`ExecDriver.run`, `Ns.Inner.x`).",
    ),
  includeDeclaration: z
    .boolean()
    .default(false)
    .describe("Also list the declaration itself. Import and re-export lines are always listed."),
  timeBudgetMs: timeBudgetSchema(60_000),
});

export type TsFindReferencesInputType = z.infer<typeof TsFindReferencesInput>;

/**
 * Locations grouped by the file they are in, in the order each file was first reported, with the in-workspace
 * files ahead of the external ones — so a cap on groups drops external rows first. One file with two Windows
 * spellings is one group.
 */
function groupByFile(locations: readonly ReportedLocation[]): readonly ReferenceGroup[] {
  const byKey = new Map<string, ReferenceGroup>();
  for (const location of locations) {
    const seen = byKey.get(location.key);
    if (seen === undefined) {
      byKey.set(location.key, { file: location.file, external: location.external, sites: [location] });
    } else {
      seen.sites.push(location);
    }
  }
  return inModuleFirst([...byKey.values()], (group) => group.external);
}

function siteOf(named: Located & NamedSymbol): TsReferenceSite {
  const { location, name, reason } = named;
  return {
    line: location.rowLine,
    column: location.character === undefined ? null : location.character + 1,
    in: name,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * The capped listing: at most `REFERENCE_FILES_LIMIT` groups, each carrying at most
 * `REFERENCE_SITES_PER_FILE_LIMIT` sites, with every exact `count` kept whatever the caps dropped. Naming
 * happens after the caps, so a wide symbol costs a bounded number of outline reads rather than one per file.
 */
async function buildListing(
  query: TsQuery,
  groups: readonly ReferenceGroup[],
): Promise<{ files: TsReferenceFile[]; filesTruncated: number; sitesTruncated: number }> {
  const kept = groups.slice(0, REFERENCE_FILES_LIMIT).map((group) => ({
    group,
    listed: group.sites.slice(0, REFERENCE_SITES_PER_FILE_LIMIT),
  }));
  const named = await nameLocations(
    query.session,
    kept.flatMap(({ listed }) => listed.map((location) => ({ location }))),
    query.file,
    query.symbols,
    query.budget,
    OUTSIDE_WORKSPACE_REASON,
    false,
    tsRowSpeller(),
  );
  let cursor = 0;
  const files = kept.map(({ group, listed }) => {
    const sites = named.slice(cursor, cursor + listed.length).map(siteOf);
    cursor += listed.length;
    return {
      file: group.file,
      external: group.external,
      count: group.sites.length,
      sitesTruncated: group.sites.length - listed.length,
      sites,
    };
  });
  const sitesTruncated = files.reduce((total, group) => total + group.sitesTruncated, 0);
  return { files, filesTruncated: groups.length - kept.length, sitesTruncated };
}

function fileText(group: TsReferenceFile): string {
  const where = group.external ? "outside the workspace" : "in the workspace";
  const tail = group.sitesTruncated > 0 ? `, ${group.sitesTruncated} site(s) not listed` : "";
  return `  ${group.file} - ${group.count} reference(s) ${where}${tail}`;
}

function siteText(site: TsReferenceSite): string {
  const column = site.column === null ? "" : `:${site.column}`;
  return `    ${site.line}${column} in ${site.in ?? "<unnamed>"}${site.reason ? ` - ${site.reason}` : ""}`;
}

/** The same JSON, phrased once for a reader who will not parse it. */
function humanSummary(payload: TsFindReferencesPayload): HumanSummary {
  const { resolved, totalReferences, files, filesTruncated, scope } = payload;
  const sites = files.reduce((total, group) => total + group.sitesTruncated, 0);
  const listing = files.map((group) => [fileText(group), ...group.sites.map(siteText)].join("\n")).join("\n");
  const tail = capsText([
    filesTruncated > 0
      ? `${filesTruncated} file group(s) dropped by the ${REFERENCE_FILES_LIMIT}-file cap`
      : undefined,
    sites > 0 ? `${sites} site(s) dropped by the ${REFERENCE_SITES_PER_FILE_LIMIT}-sites-per-file cap` : undefined,
  ]);
  const head =
    `References to ${resolved.kind} "${resolved.name}" (${resolved.file}:${resolved.line})${tsScopeText(scope)} ` +
    `- ${totalReferences} reference(s) across ${files.length + filesTruncated} file(s)${tail}` +
    `${renamedText(resolved)}.`;
  return summarised(head, scope, `limits: ${scope.limits.join(", ")}${listing === "" ? "" : `\n${listing}`}`);
}

/** The sentence that says a renamed import's listing is the local name's, and where the full set is asked for. */
function renamedText(resolved: TsResolvedSymbol): string {
  const of = resolved.renamedImportOf;
  if (of === undefined) return "";
  const where = `${of.file}:${of.line}`;
  const local = `"${resolved.name}"`;
  const binding = of.reExport ? "re-export" : "import";
  if (of.module) {
    return `; ${local} names the whole module ${of.file}, not one declaration - this lists the local name's uses only; for every use of a member, ask for that member in ${of.file}`;
  }
  return of.symbol === null
    ? `; ${local} is a renamed ${binding} of the declaration at ${where} - this lists the local name's uses only; ask for the declaration at ${where} for every use`
    : `; ${local} is a renamed ${binding} of ${of.symbol} (${where}) - this lists the local name's uses only; ask for ${of.symbol} in ${of.file} for every use`;
}

export async function runTsFindReferences(
  sessions: LspSessionManager,
  input: TsFindReferencesInputType,
  deps: TsQueryDeps = {},
) {
  let resolution: ResolvedPath | undefined;
  try {
    const opened = await openTsQuery(TOOL, sessions, input, deps, (resolved) => {
      resolution = resolved;
    });
    if (!opened.ok) return errorResult(opened.error);
    const query = opened.value;
    // tsgo is always asked with `includeDeclaration: true`: with false it drops every location it flags as a
    // definition in any group of the search, which is import and re-export specifiers as well as the subject's
    // own declaration. The caller's flag then decides one thing, by the
    // position identity, taken from `subjectIdentity` (the definition target for an import binding).
    const params = {
      textDocument: textDocumentId(query.file),
      position: query.subject.position,
      context: { includeDeclaration: true },
    };
    const answered = await tsTypeAwareRequest(
      TOOL,
      query,
      input.symbol,
      "textDocument/references",
      params,
      `answer the query for "${input.symbol}"`,
    );
    if (!answered.ok) return errorResult(answered.error);
    const locations = toReported("tsgo", TOOL, answered.value, tsFileExternal(query.workspaceRoot), input.symbol);
    if (!locations.ok) return errorResult(locations.error);
    // Before the grouping, the caps and the naming, so every count says what the listing holds.
    const identity = await subjectIdentity(TOOL, query, input.symbol);
    const kept = input.includeDeclaration ? locations.value : withoutPositions(locations.value, identity.own);
    const renamed = await renamedImportOf(query, identity, locations.value);

    const { files, filesTruncated, sitesTruncated } = await buildListing(query, groupByFile(kept));
    const scope = await tsNavigationScope(
      query,
      {
        capped: filesTruncated > 0 || sitesTruncated > 0,
        // tsgo answers a method's uses including the interface member it satisfies, the way gopls does .
        correspondingMethods: query.subject.kind === "method",
      },
      mentionNameOf(input.symbol),
    );
    const payload: TsFindReferencesPayload = {
      resolved: renamed === undefined ? query.resolved : { ...query.resolved, renamedImportOf: renamed },
      totalReferences: kept.length,
      files,
      filesTruncated,
      scope,
    };
    const { summary, text } = humanSummary(payload);
    return successResult(withSummary(summary, payload), text);
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.file, resolution)}`);
  }
}

const TOOL_DESCRIPTION =
  "Find every use of a TypeScript symbol from tsgo's type checker - unlike grep, it tells real uses from " +
  "comments, strings and same-named identifiers. Counts are exact even when the listing is capped. For a " +
  "method it also lists uses of the interface method it satisfies. Files no tsconfig includes are not " +
  "searched: if `scope.uncoveredSources.mentioning` lists any, the answer is incomplete until you grep them. " +
  "An empty listing is a real answer.";

export function registerTsFindReferences(
  server: McpServer,
  sessions: LspSessionManager,
  deps: TsQueryDeps = {},
) {
  server.registerTool(
    TOOL,
    {
      title: "Find every use of a TypeScript symbol",
      description: TOOL_DESCRIPTION,
      inputSchema: TsFindReferencesInput.shape,
    },
    async (args) => runTsFindReferences(sessions, args as TsFindReferencesInputType, deps),
  );
}
