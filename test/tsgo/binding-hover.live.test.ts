import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { textDocumentId } from "../../src/lsp/document-uri.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import { readSymbolDescription } from "../../src/tools/navigation-limits.js";
import { CALL_BUDGET_MS, itIfTsgoAvailable, recordEvidence, requireTsgo, tsFixtureRoot } from "../helpers/tsgo-live.js";

/**
 * The pin, read before the binding rule is written: tsgo's hover classifies a
 * top-level outline entry as an import or export binding when its quick info opens with `(alias)`, which is the
 * checker's own answer rather than a lexical read of the import prelude. Every form the rule names is in the
 * fixture, each bound once, and each entry's raw signature is recorded beside it so the report quotes what the
 * server said rather than what this case asserted about it.
 *
 * The rule stands only if every binding's first signature line begins with `(alias)` and no plain declaration's
 * does. Where it does not, this case goes red with the recorded table and the alternative — a lexical classifier —
 * needs its own rule.
 */

const bindingsFile = join(tsFixtureRoot, "src", "bindings.ts");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The kind the rule reads: hover is asked for every top-level entry whose kind is `variable`. */
const VARIABLE_KIND = 13;

/**
 * Each import or re-export form, by the local name the fixture binds it with. A local
 * `export { counted }` list is not here: its outline entry shares the declaration's own name, so it is told apart
 * by its line (EXPORT_LIST_ENTRY) and `counted` stays in DECLARATIONS for the `const` on line 13.
 */
const BINDINGS = ["LABEL", "RENAMED", "makeTarget", "NS", "TargetShape", "TARGET", "RETHROWN"];

/** The one binding form naming a module with no file: recorded, and asked for nothing it may not answer. */
const UNRESOLVED_BINDING = "missing";

/** The `export { counted }` entry of the fixture: an export-list binding, hovered as `(alias)`. */
const EXPORT_LIST_ENTRY = { name: "counted", line: 14 };

/** Top-level declarations: a `const` with an inferred-literal type, a `let`, and a locally exported `const`. */
const DECLARATIONS = ["plain", "later", "counted"];

interface HoverRow {
  readonly name: string;
  readonly kind: number;
  readonly line: number;
  readonly signature: string | null;
  readonly firstLine: string;
  readonly alias: boolean;
}

/**
 * One file's raw outline and the hover answer for every top-level `variable` entry in it, asked on the process
 * that answered the outline — the document is already open there, which is what `didOpen` already makes true.
 */
async function readBindingsFile(): Promise<{ symbols: LspDocumentSymbol[]; rows: HoverRow[]; version: string }> {
  const binary = requireTsgo();
  const manager = new LspSessionManager();
  try {
    const session = manager.get(tsFixtureRoot, tsgoConfig(binary));
    const outline = await session.documentSymbol(bindingsFile);
    if (outline.state !== "ok") throw new Error(`tsgo answered "${outline.state}" for ${bindingsFile}`);
    const rows: HoverRow[] = [];
    for (const entry of outline.symbols) {
      const start = entry.selectionRange?.start;
      if (entry.kind !== VARIABLE_KIND || start === undefined) continue;
      const answered = await session.request<unknown>("textDocument/hover", {
        textDocument: textDocumentId(bindingsFile),
        position: { line: start.line, character: start.character },
      });
      const described = readSymbolDescription(answered);
      const signature = described.signature ?? null;
      rows.push({
        name: entry.name,
        kind: entry.kind,
        line: entry.range.start.line + 1,
        signature,
        firstLine: (signature ?? "").split("\n")[0] ?? "",
        alias: (signature ?? "").trimStart().startsWith("(alias)"),
      });
    }
    return { symbols: outline.symbols, rows, version: binary.version };
  } finally {
    manager.disposeAll();
  }
}

function variableNames(symbols: readonly LspDocumentSymbol[]): string[] {
  return symbols.filter((entry) => entry.kind === VARIABLE_KIND).map((entry) => entry.name);
}

describe("the hover answer that classifies a TypeScript binding", () => {
  itIfTsgoAvailable(
    "opens every import and re-export form with (alias), and no plain declaration does",
    async () => {
      const { symbols, rows, version } = await readBindingsFile();
      recordEvidence("ts-slice6b", "binding-hovers", {
        tsgo: version,
        fixture: relative(repoRoot, bindingsFile).split("\\").join("/"),
        topLevel: symbols.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          line: entry.range.start.line + 1,
          children: (entry.children ?? []).map((child) => child.name),
        })),
        hovers: rows,
      });
      const byName = new Map(rows.map((row) => [row.name, row]));

      // Every form the rule can classify has to arrive as a top-level `variable` entry, or the rule is being
      // read about a file that no longer holds it: that is a fixture defect, and it says so here.
      const variables = variableNames(symbols);
      expect(variables, JSON.stringify(variables)).toEqual(
        expect.arrayContaining([...BINDINGS, ...DECLARATIONS, UNRESOLVED_BINDING]),
      );

      // The discriminator, in both directions, for every entry that answered at all. The local `export { counted }`
      // list is a second outline entry under the declaration's own name, told apart from it by its line.
      for (const row of rows.filter((row) => row.signature !== null)) {
        expect(row.alias, `hover for ${row.name} (line ${row.line}) read ${JSON.stringify(row.firstLine)}`).toBe(
          BINDINGS.includes(row.name) || (row.name === EXPORT_LIST_ENTRY.name && row.line === EXPORT_LIST_ENTRY.line),
        );
      }

      // A declaration that answers no signature would silently become a binding; an unresolved import may
      // legitimately answer nothing, so only the declarations are demanded here.
      for (const name of DECLARATIONS) {
        expect(byName.get(name)?.signature, `${name} answered no readable signature`).not.toBeNull();
      }
      // Every named form but the unresolved one must answer, and answer as a binding: that is the set the rule
      // moves out of `symbols`, and a form missing from it is a new fork.
      for (const name of BINDINGS) {
        const row = byName.get(name);
        expect(row, `${name} is not in the outline`).toBeDefined();
        expect(row?.signature, `${name} answered no readable signature`).not.toBeNull();
        expect(row?.alias, `hover for ${name} read ${JSON.stringify(row?.firstLine)}`).toBe(true);
      }
    },
    CALL_BUDGET_MS,
  );
});
