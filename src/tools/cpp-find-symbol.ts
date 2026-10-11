import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { clangdConfig } from "../lsp/server-config.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import type { IndexDriftReading } from "../paths/index-drift.js";
import type { IndexState, LspSession } from "../lsp/session.js";
import { errorResult, successResult } from "../mcp-response.js";
import { textDocumentId } from "../lsp/document-uri.js";
import { readSymbolDescription, type SymbolDescription } from "./navigation-limits.js";
import {
  CppAddressShape,
  compileDbTus,
  cppNavigationScope,
  cppQuestionDeclaration,
  indexBlock,
  missingCompileDbHint,
  noIndexDeclarationText,
  outsideEveryRoot,
  resolveCppDeclaration,
  resolveCppSourceRoots,
  type CppAddress,
  type CppDeclaration,
  type CppNavigationScope,
  type CppTarget,
} from "./cpp-navigation-shared.js";
import type { CppSourceRootsBlock } from "../clang-query/derived-source-roots.js";
import type { Step } from "./navigation-text.js";
import type { BoundaryTest } from "./lsp-locations.js";
import { CLANGD_DISK_CLAUSE } from "./shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "cpp_find_symbol";

export const CppFindSymbolInput = z.object(CppAddressShape);

export type CppFindSymbolInputType = CppAddress;

/** Where one declaration is, what clangd says it is, and — when the index answered — what it could not see. */
export type CppFindSymbolPayload = {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly range: { startLine: number; endLine: number };
  readonly scope?: CppNavigationScope;
} & SymbolDescription;

/** Why a declaration carries no description: no server answer named the position of its own identifier. */
function noPositionReason(declaration: CppDeclaration): string {
  return (
    `clangd named no position for "${declaration.name}" in "${declaration.file}", so the hover that would ` +
    "describe it would be asked about a guessed location."
  );
}

/** Why the description step got no answer at all: the server refused the request it was given. */
function refusedHoverReason(error: unknown): string {
  return `clangd refused the hover: ${(error as Error).message}`;
}

/**
 * The reason a declaration reached by the index carries no description: its file is outside every root the
 * caller declared, and this server does not open files outside the boundary to describe a location it is
 * already reporting. The location stands; the description does not.
 */
const OUTSIDE_BOUNDARY_REASON =
  "its file is outside every declared source root, so this server did not open it to describe the declaration";

/**
 * What the declaration IS, read from clangd's `textDocument/hover` at the position the server named the
 * declaration's own identifier at — the outline's `selectionRange`, or a symbol row's `location.range`, both
 * of which a real clangd measures over the identifier rather than the keyword. The file is held by the
 * transient window the read runs in, and the request goes through it so that it names the spelling the
 * server saw; a document already held stays held. Nothing here depends on the answer: hover that says nothing
 * this server can read, or is refused, yields `descriptionUnavailable` naming why rather than costing the
 * caller its location.
 */
async function describeDeclaration(
  session: LspSession,
  declaration: CppDeclaration,
  outside: BoundaryTest,
): Promise<SymbolDescription> {
  if (declaration.namePosition === undefined) return { descriptionUnavailable: noPositionReason(declaration) };
  if (outside(declaration.file)) return { descriptionUnavailable: OUTSIDE_BOUNDARY_REASON };
  try {
    const hover = await session.withTransientDocument(declaration.file, (asking) =>
      asking.send<unknown>("textDocument/hover", { textDocument: textDocumentId(asking.openedAs), position: declaration.namePosition }),
    );
    return readSymbolDescription(hover);
  } catch (e) {
    return { descriptionUnavailable: refusedHoverReason(e) };
  }
}

/** The answer: where the declaration is, and what the server says it is. */
async function toResult(
  session: LspSession,
  declaration: CppDeclaration,
  outside: BoundaryTest,
): Promise<Omit<CppFindSymbolPayload, "scope">> {
  return {
    name: declaration.name,
    kind: declaration.kind,
    file: declaration.file,
    range: declaration.range,
    ...(await describeDeclaration(session, declaration, outside)),
  };
}

function indexScope(
  input: CppFindSymbolInputType,
  roots: { readonly block: CppSourceRootsBlock; readonly tus: readonly string[] | undefined },
  state: IndexState,
  reading: IndexDriftReading,
  capped: boolean,
): CppNavigationScope {
  return cppNavigationScope({
    projectRoot: input.projectRoot,
    sourceRootsBlock: roots.block,
    index: indexBlock(state, reading.verdict),
    account: reading.account,
    compileDbTus: roots.tus ?? compileDbTus(input.projectRoot),
    capped,
    // A declaration question states no dispatch property at all.
    indirectDispatch: false,
  });
}

export async function runCppFindSymbol(sessions: LspSessionManager, raw: CppFindSymbolInputType) {
  try {
    const missingDb = await missingCompileDbHint(raw.projectRoot);
    if (missingDb !== undefined) return errorResult(`${TOOL} failed: ${missingDb}`);

    // The roots this call's containment uses, stated once: a declared list as given, otherwise the source tree
    // derived from the database, and "none" already means "projectRoot alone".
    const roots = resolveCppSourceRoots(raw.projectRoot, raw.sourceRoots);
    const input: CppFindSymbolInputType = { ...raw, sourceRoots: [...roots.block.roots] };
    const session = sessions.get(input.projectRoot, clangdConfig);
    const outside = outsideEveryRoot(input.projectRoot, input.sourceRoots);
    const resolved = await resolveCppDeclaration(TOOL, session, input, roots.block);
    if (!resolved.ok) return errorResult(resolved.error);
    if ("declaration" in resolved.value) {
      return successResult(await toResult(session, resolved.value.declaration, outside));
    }

    // The opened outlines answered nothing, so clangd's own index is asked. That query is the
    // index-backed part of this answer, so it is the whole window the stated index state covers; the drift
    // walk and its push go first, because that push is how clangd hears about the disk at all.
    const reading = await session.indexDriftReading(input.sourceRoots);
    const { value: target, index } = await session.withIndexWindow(async (): Promise<Step<CppTarget>> =>
      cppQuestionDeclaration(TOOL, input, resolved.value, (query) =>
        session.request<unknown>("workspace/symbol", { query }),
      ));
    if (!target.ok) return errorResult(target.error);
    if (target.value.declaration === undefined) {
      return errorResult(
        noIndexDeclarationText(TOOL, input.name, input.projectRoot, index, target.value.capped),
      );
    }
    const payload: CppFindSymbolPayload = {
      ...(await toResult(session, target.value.declaration, outside)),
      // Its presence is the signal that the index answered: a `file` answer, or one from an opened outline,
      // involves no index and carries no boundary block to read.
      scope: indexScope(input, roots, index, reading, target.value.capped),
    };
    return successResult(payload);
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}`);
  }
}

const TOOL_DESCRIPTION =
  "Find where a C++ class, function or method is declared, with its signature and doc comment as clangd's " +
  "hover renders them, verbatim. It answers one declaration: a name matching several fails and lists them " +
  "(go_find_symbol lists all). An answer from clangd's index carries `scope`; its location may be the " +
  "header or an out-of-line definition, not stably one of them (pass `file` for the header), and its " +
  "`range` covers only the identifier. There `listing-capped` means clangd's ranked list was full, so " +
  "another declaration of the name may be missing. " +
  CLANGD_DISK_CLAUSE;

export function registerCppFindSymbol(server: McpServer, sessions: LspSessionManager) {
  server.registerTool(
    TOOL,
    {
      title: "Find a C++ symbol",
      description: TOOL_DESCRIPTION,
      inputSchema: CppFindSymbolInput.shape,
    },
    async (args) => runCppFindSymbol(sessions, args as CppFindSymbolInputType),
  );
}
