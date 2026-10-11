import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type LspDocumentSymbol, symbolKindName, toOutline, type OutlineSymbol } from "../clangd/outline.js";
import type { LspSession } from "../lsp/session.js";
import type { LspSessionManager } from "../lsp/session-manager.js";
import { errorResult, successResult } from "../mcp-response.js";
import type { ResolvedPath } from "../paths/resolve-safe-path.js";
import { type Budget, withinBudget } from "./budget.js";
import { type DeclarationSource, describeRows } from "./declaration-description.js";
import { READ_CONCURRENCY } from "../tsgo/uncovered-mentions.js";
import type { SymbolDescription } from "./navigation-limits.js";
import { containerOf } from "./navigation-text.js";
import { PathInput } from "./input-limits.js";
import { resolutionNote } from "./shared.js";
import { CONTAINER_KINDS } from "./ts-addressing.js";
import { TsSourceRootsSchema, resolveTsTarget, timeBudgetSchema, type TsTargetDeps } from "./ts-shared.js";
import { messageOf } from "../error-message.js";

const TOOL = "ts_file_symbols";

/** The first call against a workspace waits for tsgo to load the projects it anchors, so the wait needs a ceiling. */
const DEFAULT_TIME_BUDGET_MS = 60_000;

/** tsgo reports an import or export binding under the kind of a `const` , so only hover can tell them apart. */
const VARIABLE_KIND = "variable";

/** An import or export binding the checker classified, in the order the file writes it. */
export type TsFileBinding = { readonly name: string; readonly line: number };

export type TsFileSymbolsPayload = {
  readonly symbols: OutlineSymbol[];
  readonly bindings: readonly TsFileBinding[];
  readonly bindingsUnverified?: string;
};

export const TsFileSymbolsInput = z.object({
  sourceRoots: TsSourceRootsSchema,
  file: PathInput
    .describe(
      "TypeScript or JavaScript file: absolute, or relative to exactly one sourceRoots entry.",
    ),
  depth: z
    .number()
    .int()
    .min(0)
    .max(1)
    .default(1)
    .describe("0: top-level entries only. 1 (default): also the members of classes, interfaces, enums and namespaces."),
  timeBudgetMs: timeBudgetSchema(DEFAULT_TIME_BUDGET_MS),
});

export type TsFileSymbolsInputType = z.infer<typeof TsFileSymbolsInput>;

/**
 * The outline with children kept only under the entries `symbol` can address through: a function's locals and an object literal's properties are not members.
 */
function withContainerChildren(symbols: readonly LspDocumentSymbol[]): LspDocumentSymbol[] {
  return symbols.map((entry) => {
    const { children, ...rest } = entry;
    if (children === undefined || !CONTAINER_KINDS.has(symbolKindName(entry.kind))) return rest;
    return { ...rest, children: withContainerChildren(children) };
  });
}

/** The hover's first-line mark of an alias symbol: every import, re-export and export-list binding opens with it. */
function isBindingSignature(signature: string): boolean {
  return signature.trimStart().startsWith("(alias)");
}

interface Classified {
  readonly declarations: LspDocumentSymbol[];
  readonly bindings: TsFileBinding[];
  readonly unverified: string[];
}

/** One top-level `variable` entry as a hover row: its own name is where the checker is asked. */
function hoverRow(entry: LspDocumentSymbol, file: string, workspaceRoot: string): DeclarationSource {
  const start = entry.selectionRange?.start;
  return {
    name: entry.name,
    kind: VARIABLE_KIND,
    file,
    line: entry.range.start.line + 1,
    container: containerOf(file, workspaceRoot),
    position: start === undefined ? null : { line: start.line, character: start.character },
    external: false,
  };
}

/**
 * Splits the top level into declarations and bindings by the type checker's own answer: one hover per entry of
 * kind `variable`, asked concurrently under the call's budget. An entry whose hover fails, times out or reads no
 * signature stays a declaration and is counted in `unverified` — never dropped on an answer nobody read.
 */
async function classifyTopLevel(
  session: LspSession,
  budget: Budget,
  file: string,
  workspaceRoot: string,
  symbols: readonly LspDocumentSymbol[],
): Promise<Classified> {
  const asked = symbols.filter((entry) => symbolKindName(entry.kind) === VARIABLE_KIND);
  const rows = asked.map((entry) => hoverRow(entry, file, workspaceRoot));
  // Hovers go out READ_CONCURRENCY at a time, so a generated file with thousands of top-level entries does not
  // queue them all on the workspace's shared session.
  const context = { session, budget, server: "tsgo", externalReason: "", stillProven: () => true };
  const described: (SymbolDescription | undefined)[] = [];
  for (let from = 0; from < rows.length; from += READ_CONCURRENCY) {
    const batch = await describeRows(context, rows.slice(from, from + READ_CONCURRENCY));
    described.push(...(batch ?? rows.slice(from, from + READ_CONCURRENCY).map(() => undefined)));
  }
  const verdicts = new Map<LspDocumentSymbol, string | undefined>();
  const unverified: string[] = [];
  for (const [index, entry] of asked.entries()) {
    const description = described?.[index];
    const signature = description?.signature;
    if (signature === undefined) {
      unverified.push(description?.descriptionUnavailable ?? "the hover answer carried no signature");
    }
    verdicts.set(entry, signature);
  }
  const declarations: LspDocumentSymbol[] = [];
  const bindings: TsFileBinding[] = [];
  for (const entry of symbols) {
    const signature = verdicts.get(entry);
    if (signature !== undefined && isBindingSignature(signature)) {
      bindings.push({ name: entry.name, line: entry.range.start.line + 1 });
    } else {
      declarations.push(entry);
    }
  }
  return { declarations, bindings, unverified };
}

function unverifiedText(reasons: readonly string[]): string {
  const [first] = reasons;
  const noun = reasons.length === 1 ? "entry" : "entries";
  return `${reasons.length} top-level variable ${noun} could not be checked: ${first}`;
}

export async function runTsFileSymbols(
  sessions: LspSessionManager,
  input: TsFileSymbolsInputType,
  deps: TsTargetDeps = {},
) {
  let resolution: ResolvedPath | undefined;
  try {
    const target = await resolveTsTarget(TOOL, sessions, input, "file", deps);
    if (!target.ok) return errorResult(target.error);
    const { file, workspaceRoot, budget, session } = target.value;
    resolution = target.value.resolution;

    const outline = await withinBudget(session.documentSymbol(file), budget);
    if (outline === undefined) {
      return errorResult(
        `${TOOL} failed: tsgo did not answer for "${file}" within its ${budget.ceilingMs} ms budget. ` +
          `The workspace at "${workspaceRoot}" may still be loading its projects; raise timeBudgetMs or ` +
          "call again, and do not read this as an empty file.",
      );
    }
    // tsgo's documentSymbol is syntactic and correct on the first call, so an empty outline is a real answer
    // about an empty file rather than a project that has not loaded.
    if (outline.state !== "ok") return successResult<TsFileSymbolsPayload>({ symbols: [], bindings: [] });
    const { declarations, bindings, unverified } = await classifyTopLevel(
      session,
      budget,
      file,
      workspaceRoot,
      outline.symbols,
    );
    const payload: TsFileSymbolsPayload = {
      symbols: toOutline(withContainerChildren(declarations), input.depth),
      bindings,
      ...(unverified.length === 0 ? {} : { bindingsUnverified: unverifiedText(unverified) }),
    };
    return successResult(payload);
  } catch (e) {
    return errorResult(`${TOOL} failed: ${messageOf(e)}${resolutionNote(input.file, resolution)}`);
  }
}

export function registerTsFileSymbols(server: McpServer, sessions: LspSessionManager) {
  server.registerTool(
    TOOL,
    {
      title: "Get TypeScript file structure",
      description:
        "Outline one TypeScript or JavaScript file via tsgo: types, classes, functions and their members; " +
        "imports and re-exports are listed apart, in `bindings`. Use it to see what a file declares before " +
        "reading it.",
      inputSchema: TsFileSymbolsInput.shape,
    },
    async (args) => runTsFileSymbols(sessions, args as TsFileSymbolsInputType),
  );
}
