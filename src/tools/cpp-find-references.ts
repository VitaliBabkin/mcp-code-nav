import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LspDocumentSymbol } from "../clangd/outline.js";
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
  inModuleFirst,
  type Located,
  type ReportedLocation,
  toReported,
} from "./lsp-locations.js";
import {
  OUTSIDE_SOURCE_ROOTS_REASON,
  type NamedSymbol,
  nameLocations,
} from "./location-naming.js";
import {
  NAVIGATION_CEILING_MS,
  REFERENCE_FILES_LIMIT,
  REFERENCE_SITES_PER_FILE_LIMIT,
} from "./navigation-limits.js";
import { capsText, type Step } from "./navigation-text.js";
import { CppAddressShape } from "./cpp-navigation-shared.js";
import { CLANGD_DISK_CLAUSE } from "./shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "cpp_find_references";

/** One use-site as clangd reported it. `column` is null only when the server sent no character. */
export type CppReferenceSite = {
  readonly line: number;
  readonly column: number | null;
  readonly in: string | null;
  readonly reason?: string;
};

/** One file's group: `count` is every site in it, `sites` is what the caps kept. */
export type CppReferenceFile = {
  readonly file: string;
  readonly external: boolean;
  readonly count: number;
  readonly sitesTruncated: number;
  readonly sites: CppReferenceSite[];
};

export type CppFindReferencesPayload = {
  readonly resolved: Pick<CppDeclaration, "name" | "kind" | "file" | "line">;
  readonly totalReferences: number;
  readonly files: CppReferenceFile[];
  readonly filesTruncated: number;
  readonly scope: CppNavigationScope;
};

export const CppFindReferencesInput = z.object(CppAddressShape);

export type CppFindReferencesInputType = CppAddress;

/** The declaration's own name is what a reference query is about; without it there is no position to ask at. */
function noPositionText(declaration: CppDeclaration): string {
  return (
    `${TOOL} failed: clangd named no position for "${declaration.name}" in "${declaration.file}", so the ` +
    "query would have to be asked about a guessed location, which is the one input whose staleness is silent."
  );
}

/** The two empty cells: an answer that came back with nothing is only a fact about an idle index. */
function emptyWhileNotQuiescentText(name: string, state: IndexState, scopeText: string): string {
  const why =
    state === "building"
      ? "clangd was indexing while this call ran, so the shards this answer came from are incomplete"
      : "clangd never reported indexing progress to this session, so its index state is not known";
  return (
    `${TOOL} failed: no references to "${name}" were found ${scopeText}, and that is not reportable as an ` +
    `answer: ${why}. Call again once indexing has settled — a ` +
    "`quiescent` index that finds nothing answers as a scoped empty instead.`"
  );
}

/**
 * What the answer's window produced. `declaration` is absent only when the name resolved to nothing at all,
 * which the caller refuses with the index state the window just latched; `locations` is then unasked-for.
 */
type AskedReferences = {
  readonly target: CppTarget;
  readonly declaration?: CppDeclaration;
  readonly locations?: unknown;
};

type ReferenceGroup = {
  readonly file: string;
  readonly external: boolean;
  sites: ReportedLocation[];
};

/**
 * Grouped by the file a use is in, in the order each file was first reported, with the in-boundary files
 * ahead of the external ones so a cap on groups drops external rows first. One file with two Windows
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

function siteOf(named: Located & NamedSymbol): CppReferenceSite {
  const { location, name, reason } = named;
  return {
    line: location.rowLine,
    column: location.character === undefined ? null : location.character + 1,
    in: name,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The capped listing, with every exact count kept whatever the caps dropped. Naming happens after the caps. */
async function buildListing(
  session: LspSession,
  groups: readonly ReferenceGroup[],
  queriedFile: string,
  queriedOutline: readonly LspDocumentSymbol[],
  budget: Budget,
): Promise<{ files: CppReferenceFile[]; filesTruncated: number; sitesTruncated: number }> {
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
    OUTSIDE_SOURCE_ROOTS_REASON,
    // A C++ use sits inside a member, so rows are named by the deepest enclosing declaration — the
    // spelling `cpp_find_symbol` publishes and a caller can hand straight back as `name`.
    true,
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

function fileText(group: CppReferenceFile): string {
  const where = group.external ? "outside every declared source root" : "inside them";
  const tail = group.sitesTruncated > 0 ? `, ${group.sitesTruncated} site(s) not listed` : "";
  return `  ${group.file} - ${group.count} reference(s) ${where}${tail}`;
}

function siteText(site: CppReferenceSite): string {
  const column = site.column === null ? "" : `:${site.column}`;
  return `    ${site.line}${column} in ${site.in ?? "<unnamed>"}${site.reason ? ` - ${site.reason}` : ""}`;
}

/** The same JSON, phrased once for a reader who will not parse it. */
function humanSummary(payload: CppFindReferencesPayload): string {
  const { resolved, totalReferences, files, filesTruncated, scope } = payload;
  const sites = files.reduce((total, group) => total + group.sitesTruncated, 0);
  const listing = files.map((group) => [fileText(group), ...group.sites.map(siteText)].join("\n")).join("\n");
  const tail = capsText([
    filesTruncated > 0 ? `${filesTruncated} file group(s) dropped by the ${REFERENCE_FILES_LIMIT}-file cap` : undefined,
    sites > 0 ? `${sites} site(s) dropped by the ${REFERENCE_SITES_PER_FILE_LIMIT}-sites-per-file cap` : undefined,
  ]);
  const head =
    `References to ${resolved.kind} "${resolved.name}" (${resolved.file}:${resolved.line}) in project ` +
    `"${scope.projectRoot}" - ${totalReferences} reference(s) across ${files.length + filesTruncated} ` +
    `file(s), index: ${scope.index.state}${tail}.`;
  return `${head}\nlimits: ${scope.limits.join(", ")}${listing === "" ? "" : `\n${listing}`}`;
}

function referencesPayload(
  context: CppAnswerContext,
  declaration: CppDeclaration,
  totalReferences: number,
  listing: { readonly files: CppReferenceFile[]; readonly filesTruncated: number; readonly sitesTruncated: number },
): CppFindReferencesPayload {
  const { files, filesTruncated, sitesTruncated } = listing;
  return {
    resolved: { name: declaration.name, kind: declaration.kind, file: declaration.file, line: declaration.line },
    totalReferences,
    files,
    filesTruncated,
    scope: cppAnswerScope(context, { capped: filesTruncated > 0 || sitesTruncated > 0, indirectDispatch: false }),
  };
}

export async function runCppFindReferences(sessions: LspSessionManager, raw: CppFindReferencesInputType) {
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

    // The drift push goes first: it is how clangd hears about the disk at all. The window is the answer's own
    // span, and when the declaration itself had to come from clangd's index the symbol query is part of that
    // one answer rather than a second span whose state nothing reports.
    const reading = await session.indexDriftReading(input.sourceRoots);
    const outside = outsideEveryRoot(input.projectRoot, input.sourceRoots);
    const { value: asked, index } = await session.withIndexWindow(async (): Promise<Step<AskedReferences>> => {
      const target = await cppQuestionDeclaration(TOOL, input, resolved.value, (query) =>
        session.request<unknown>("workspace/symbol", { query }),
      );
      if (!target.ok) return target;
      const declaration = target.value.declaration;
      if (declaration === undefined) return { ok: true, value: { target: target.value } };
      if (declaration.namePosition === undefined) return { ok: false, error: noPositionText(declaration) };
      // The index can place a declaration in a file this session has never opened, and clangd answers a
      // reference query from the AST of the document that declares the symbol. A file beyond the boundary is
      // reported and never opened, so this question has no answer to ask.
      if (outside(declaration.file)) return { ok: false, error: outsideSubjectText(TOOL, input.name, declaration) };
      const position = declaration.namePosition;
      const locations = await session.withTransientDocument(declaration.file, (holding) =>
        holding.send<unknown>("textDocument/references", {
          textDocument: textDocumentId(holding.openedAs),
          position,
          context: { includeDeclaration: false },
        }),
      );
      return { ok: true, value: { target: target.value, declaration, locations } };
    });
    if (!asked.ok) return errorResult(asked.error);
    const declaration = asked.value.declaration;
    if (declaration === undefined) {
      return errorResult(
        noIndexDeclarationText(TOOL, input.name, input.projectRoot, index, asked.value.target.capped),
      );
    }

    const locations = toReported("clangd", TOOL, asked.value.locations, outside, input.name);
    if (!locations.ok) return errorResult(locations.error);
    if (locations.value.length === 0 && index !== "quiescent") {
      return errorResult(emptyWhileNotQuiescentText(input.name, index, `from clangd's index`));
    }

    // The outline the rows in the subject's own file are named from, read transiently: a question that named
    // no file must not change what the session holds, and holding it would make the next unscoped question
    // about the same name answer from the opened files instead of the index.
    const queriedOutline = (await session.documentSymbolTransient(declaration.file)) ?? [];
    const { files, filesTruncated, sitesTruncated } = await buildListing(
      session,
      groupByFile(locations.value),
      declaration.file,
      queriedOutline,
      budget,
    );
    const payload = referencesPayload(
      { projectRoot: input.projectRoot, roots, index, reading },
      declaration,
      locations.value.length,
      { files, filesTruncated, sitesTruncated },
    );
    return successResult(payload, humanSummary(payload));
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}`);
  }
}

const TOOL_DESCRIPTION =
  "Find every use of a C++ symbol from clangd's index - unlike grep, it tells real uses from comments, " +
  "strings and same-named identifiers. The declaration itself is excluded, and counts are exact even when " +
  "the listing is capped. An empty listing comes only from a settled index. " + CLANGD_DISK_CLAUSE;

export function registerCppFindReferences(server: McpServer, sessions: LspSessionManager) {
  server.registerTool(
    TOOL,
    {
      title: "Find every use of a C++ symbol",
      description: TOOL_DESCRIPTION,
      inputSchema: CppFindReferencesInput.shape,
    },
    async (args) => runCppFindReferences(sessions, args as CppFindReferencesInputType),
  );
}
