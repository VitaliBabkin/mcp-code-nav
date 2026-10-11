import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LspDocumentSymbol } from "../clangd/outline.js";
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
  environmentText,
  freshnessText,
  type GoNavigationScope,
  navigationScope,
  openGoQuery,
  type ResolvedSymbol,
  typeAwareRequest,
} from "./go-navigation-shared.js";
import {
  inModuleFirst,
  type Located,
  outsideRoot,
  type ReportedLocation,
  toReported,
} from "./lsp-locations.js";
import { OUTSIDE_MODULE_REASON, type NamedSymbol, nameLocations } from "./location-naming.js";
import { acceptAnyDeclaration, capsText } from "./navigation-text.js";
import { REFERENCE_FILES_LIMIT, REFERENCE_SITES_PER_FILE_LIMIT } from "./navigation-limits.js";
import { messageOf } from "../error-message.js";

const TOOL = "go_find_references";

/** One use-site as reported by gopls. `column` is null only when the server sent no character. */
export type ReferenceSite = {
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

export type ReferenceFile = {
  readonly file: string;
  readonly external: boolean;
  readonly count: number;
  readonly sitesTruncated: number;
  readonly sites: ReferenceSite[];
};

export type FindReferencesPayload = {
  readonly resolved: ResolvedSymbol;
  readonly totalReferences: number;
  readonly files: ReferenceFile[];
  readonly filesTruncated: number;
  readonly scope: GoNavigationScope;
};

export const GoFindReferencesInput = z.object({
  sourceRoots: GoSourceRootsSchema,
  file: GoDeclaringFileSchema,
  symbol: NameInput
    .describe(
      "Exact name as declared at the top level of `file`; a method takes its receiver (`Concrete.Get` or " +
        "`(*Concrete).Get`), and a bare `Get` means the package-level `Get`.",
    ),
  includeDeclaration: z
    .boolean()
    .default(false)
    .describe("Also count and list the symbol's own declaration. Default false."),
  timeBudgetMs: timeBudgetSchema(60_000),
});

export type GoFindReferencesInputType = z.infer<typeof GoFindReferencesInput>;

export interface GoFindReferencesDeps {
  /**
   * Seam for the `go` subprocesses that state the port this answer was computed under; a test injects one
   * so the default suite never runs a Go toolchain (see CONTRIBUTING.md).
   */
  exec?: GoExecFn;
}

/**
 * Locations grouped by the file they are in, in the order each file was first reported, with the in-module
 * files ahead of the external ones — so a cap on groups drops external rows first. One file with two
 * Windows spellings is one group.
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

function siteOf(named: Located & NamedSymbol): ReferenceSite {
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
  session: LspSession,
  groups: readonly ReferenceGroup[],
  queriedFile: string,
  queriedOutline: readonly LspDocumentSymbol[],
  budget: Budget,
): Promise<{ files: ReferenceFile[]; filesTruncated: number; sitesTruncated: number }> {
  const kept = groups.slice(0, REFERENCE_FILES_LIMIT).map((group) => ({
    group,
    listed: group.sites.slice(0, REFERENCE_SITES_PER_FILE_LIMIT),
  }));
  const named = await nameLocations(
    session,
    kept.flatMap(({ listed }) => listed.map((location) => ({ location }))),
    queriedFile,
    queriedOutline,
    budget,
    OUTSIDE_MODULE_REASON,
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

function fileText(group: ReferenceFile): string {
  const where = group.external ? "outside the module" : "in the module";
  const tail = group.sitesTruncated > 0 ? `, ${group.sitesTruncated} site(s) not listed` : "";
  return `  ${group.file} - ${group.count} reference(s) ${where}${tail}`;
}

function siteText(site: ReferenceSite): string {
  const column = site.column === null ? "" : `:${site.column}`;
  return `    ${site.line}${column} in ${site.in ?? "<unnamed>"}${site.reason ? ` - ${site.reason}` : ""}`;
}

/** The same JSON, phrased once for a reader who will not parse it. */
function humanSummary(payload: FindReferencesPayload): string {
  const { resolved, totalReferences, files, filesTruncated, scope } = payload;
  const sites = files.reduce((total, group) => total + group.sitesTruncated, 0);
  const listing = files.map((group) => [fileText(group), ...group.sites.map(siteText)].join("\n")).join("\n");
  const tail = capsText([
    filesTruncated > 0 ? `${filesTruncated} file group(s) dropped by the ${REFERENCE_FILES_LIMIT}-file cap` : undefined,
    sites > 0 ? `${sites} site(s) dropped by the ${REFERENCE_SITES_PER_FILE_LIMIT}-sites-per-file cap` : undefined,
  ]);
  const head =
    `References to ${resolved.kind} "${resolved.name}" (${resolved.file}:${resolved.line}) in module ` +
    `"${scope.moduleRoot}"${environmentText(scope)} - ${totalReferences} reference(s) across ` +
    `${files.length + filesTruncated} file(s), visibility: ${scope.visibility}, ` +
    `freshness: ${freshnessText(scope.freshness)}${tail}.`;
  return `${head}\nlimits: ${scope.limits.join(", ")}${listing === "" ? "" : `\n${listing}`}`;
}

export async function runGoFindReferences(
  sessions: LspSessionManager,
  input: GoFindReferencesInputType,
  deps: GoFindReferencesDeps = {},
) {
  let resolution: ResolvedPath | undefined;
  try {
    const opened = await openGoQuery(TOOL, sessions, input, deps, acceptAnyDeclaration, (resolved) => {
      resolution = resolved;
    });
    if (!opened.ok) return errorResult(opened.error);
    const query = opened.value;
    const { file, moduleRoot, budget, session, symbols, picked } = query;

    const params = {
      textDocument: textDocumentId(file),
      position: picked.position,
      context: { includeDeclaration: input.includeDeclaration },
    };
    const answered = await typeAwareRequest(
      TOOL,
      query,
      input.symbol,
      "textDocument/references",
      params,
      `answer the query for "${input.symbol}"`,
    );
    if (!answered.ok) return errorResult(answered.error);
    const locations = toReported("gopls", TOOL, answered.value, outsideRoot(moduleRoot), input.symbol);
    if (!locations.ok) return errorResult(locations.error);

    const { files, filesTruncated, sitesTruncated } = await buildListing(
      session,
      groupByFile(locations.value),
      file,
      symbols,
      budget,
    );
    const scope = await navigationScope(query, "references", filesTruncated > 0 || sitesTruncated > 0);
    const payload: FindReferencesPayload = {
      resolved: picked.resolved,
      totalReferences: locations.value.length,
      files,
      filesTruncated,
      scope,
    };
    return successResult(payload, humanSummary(payload));
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.file, resolution)}`);
  }
}

const TOOL_DESCRIPTION =
  "Find every use of a Go symbol from gopls's type checker - unlike grep, it tells real uses from " +
  "comments, strings and same-named identifiers. Counts are exact even when the listing is capped. For a " +
  "method it also lists uses of the interface method it satisfies, so it over-reports rather than miss one. " +
  "An empty listing is a real answer, returned only once the module has loaded.";

export function registerGoFindReferences(
  server: McpServer,
  sessions: LspSessionManager,
  deps: GoFindReferencesDeps = {},
) {
  server.registerTool(
    TOOL,
    {
      title: "Find every use of a Go symbol",
      description: TOOL_DESCRIPTION,
      inputSchema: GoFindReferencesInput.shape,
    },
    async (args) => runGoFindReferences(sessions, args as GoFindReferencesInputType, deps),
  );
}
