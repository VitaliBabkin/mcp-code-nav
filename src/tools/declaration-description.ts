// What one declaration row says about itself: the signature and documentation read from the server's hover at
// the declaration's own name. Shared by the Go and TypeScript declaration listings, which differ only in what
// they call the server, what boundary an external row lies outside, and how they tell that the process that
// proved readiness is still the one answering.

import { textDocumentId } from "../lsp/document-uri.js";
import type { LspSession, TransientAsking } from "../lsp/session.js";
import { pathKey } from "../paths/path-containment.js";
import { type Budget, withinBudget } from "./budget.js";
import type { Position } from "./lsp-locations.js";
import { readSymbolDescription, type SymbolDescription } from "./navigation-limits.js";
import { messageOf } from "../error-message.js";

/**
 * One declaration the answer will report, and where its own name is. `position` is the identifier's own
 * span as the answer named it — `selectionRange` in an outline entry, `location.range` in a symbol-index
 * entry — and is `null` only when the answer named no such position, which costs that row its description
 * and never its place in the list. `container` is the directory `containerOf` names and is `null` exactly
 * when `external` is true, because a path outside the root has no directory relative to it; `external` is the
 * boundary flag, and an external row is never asked for a hover.
 */
export interface DeclarationSource {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly container: string | null;
  readonly position: Position | null;
  readonly external: boolean;
}

/** What differs between the listings that describe their rows this way. */
export interface DescriptionContext {
  readonly session: LspSession;
  readonly budget: Budget;
  /** The server's name, as a row's reason spells it (`gopls`, `tsgo`). */
  readonly server: string;
  /** Why a row outside the root carries no description: reading it would cross the declared boundary. */
  readonly externalReason: string;
  /** Whether the process the rows were described by is still the one whose readiness was proved. */
  readonly stillProven: () => boolean;
}

/** Why a row carries no description when no server answer named the position of its own identifier. */
function noPositionReason(server: string, declaration: DeclarationSource): string {
  return (
    `${server} named no position for "${declaration.name}" in "${declaration.file}", so the hover that would ` +
    "describe it would be asked about a guessed location."
  );
}

function hoverBudgetReason(budget: Budget): string {
  return `its hover never arrived inside this call's ${budget.ceilingMs} ms budget`;
}

/** Why a group of rows carries no description at all: the server would not hold their file open. */
function unopenableReason(error: unknown): string {
  return `its file could not be held open to ask: ${(error as Error).message}`;
}

/**
 * Whether this row can be asked about at all, and the position to ask at when it can. An external row is
 * never read — that is the boundary, not an optimisation — and a row whose answer named no position for the
 * declaration's own identifier is never asked about a guessed one.
 */
type RowPlan = { readonly reason: string } | { readonly position: Position };

function planRow(context: DescriptionContext, declaration: DeclarationSource): RowPlan {
  if (declaration.external) return { reason: context.externalReason };
  if (declaration.position === null) return { reason: noPositionReason(context.server, declaration) };
  return { position: declaration.position };
}

/** Rows of one file, asked while that one file is held open. */
interface HoverGroup {
  readonly key: string;
  readonly file: string;
  readonly rows: Array<{ readonly declaration: DeclarationSource; readonly position: Position }>;
}

/**
 * The rows that can be described, grouped by the file each is in. A server answers `hover` about a document
 * it holds, and a workspace-wide search names files this client never opened, so the file is opened for the
 * length of its rows' hovers and closed again — the transient rule for outlining a reported
 * location, applied to the description read: nothing joins the session's opened set, and the answer's rows
 * decide which files are touched at all.
 */
function hoverGroups(
  context: DescriptionContext,
  declarations: readonly DeclarationSource[],
  described: Map<DeclarationSource, SymbolDescription>,
): HoverGroup[] {
  const groups: HoverGroup[] = [];
  for (const declaration of declarations) {
    const plan = planRow(context, declaration);
    if ("reason" in plan) {
      described.set(declaration, { descriptionUnavailable: plan.reason });
      continue;
    }
    const key = pathKey(declaration.file);
    const existing = groups.find((group) => group.key === key);
    if (existing === undefined) groups.push({ key, file: declaration.file, rows: [{ declaration, position: plan.position }] });
    else existing.rows.push({ declaration, position: plan.position });
  }
  return groups;
}

async function describeHover(
  context: DescriptionContext,
  asking: TransientAsking,
  declaration: DeclarationSource,
  position: Position,
  described: Map<DeclarationSource, SymbolDescription>,
): Promise<void> {
  const params = { textDocument: textDocumentId(asking.openedAs), position };
  const answered = await withinBudget(
    asking
      .send<unknown>("textDocument/hover", params)
      .catch((e: unknown) => ({ hoverFailure: messageOf(e) })),
    context.budget,
  );
  if (answered === undefined) described.set(declaration, { descriptionUnavailable: hoverBudgetReason(context.budget) });
  else if (typeof answered === "object" && answered !== null && "hoverFailure" in answered) {
    described.set(declaration, {
      descriptionUnavailable: `${context.server} refused the hover: ${(answered as { hoverFailure: string }).hoverFailure}`,
    });
  } else described.set(declaration, readSymbolDescription(answered));
}

/**
 * One file's rows, described while the session holds that file, and each recorded as it settles so a hover
 * that never arrived still leaves its row with a reason rather than losing the rows that did answer.
 */
async function describeGroup(
  context: DescriptionContext,
  group: HoverGroup,
  described: Map<DeclarationSource, SymbolDescription>,
): Promise<void> {
  try {
    await context.session.withTransientDocument(group.file, (asking) =>
      Promise.all(group.rows.map((row) => describeHover(context, asking, row.declaration, row.position, described))),
    );
  } catch (e) {
    for (const row of group.rows) {
      if (!described.has(row.declaration)) described.set(row.declaration, { descriptionUnavailable: unopenableReason(e) });
    }
  }
}

/**
 * The descriptions of every row, read concurrently across files and bounded by the call's remaining budget,
 * or `undefined` when the process that proved readiness is no longer the one answering: rows described by a
 * replacement are refused as a whole, because none of them can then be said to share one graph.
 */
export async function describeRows(
  context: DescriptionContext,
  declarations: readonly DeclarationSource[],
): Promise<SymbolDescription[] | undefined> {
  const described = new Map<DeclarationSource, SymbolDescription>();
  await Promise.all(hoverGroups(context, declarations, described).map((group) => describeGroup(context, group, described)));
  if (!context.stillProven()) return undefined;
  return declarations.map(
    (declaration) => described.get(declaration) ?? { descriptionUnavailable: "this server read no hover answer for this row" },
  );
}
