import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LspDocumentSymbol, OutlineSymbol } from "../../src/clangd/outline.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import { runTsFileSymbols, type TsFileSymbolsPayload } from "../../src/tools/ts-file-symbols.js";
import {
  CALL_BUDGET_MS,
  itIfTsgoAvailable,
  payloadOf,
  requireTsgo,
  textOf,
  tsFixtureRoot,
  tsgoProcessLog,
  type TsgoProcessLog,
} from "../helpers/tsgo-live.js";

/**
 * `ts_file_symbols` against the real server: what one `documentSymbol` answer looks like for a file no client
 * document was ever opened for, how `depth` reads against a tree that nests every local, and the two spans a
 * symbol's identity depends on. Import and export bindings are classified by the checker's own hover answer
 * and published apart from the declarations, so the outline a caller reads
 * as "what this file declares" holds declarations only. Assertions track the fixture's own text, never a
 * recorded snapshot.
 */

const storageFile = join(tsFixtureRoot, "src", "storage.ts");
const bindingsFile = join(tsFixtureRoot, "src", "bindings.ts");
const collideFile = join(tsFixtureRoot, "src", "collide.ts");
const viewFile = join(tsFixtureRoot, "src", "view.tsx");
const widgetFile = join(tsFixtureRoot, "src", "widget.jsx");
const legacyFile = join(tsFixtureRoot, "src", "legacy.js");
const emptyFile = join(tsFixtureRoot, "src", "empty.ts");
const outsideFile = join(tsFixtureRoot, "test", "outside.ts");

function linesOf(file: string): string[] {
  return readFileSync(file, "utf-8").split(/\r?\n/);
}

/** The 1-based line a fixture text is on, or a failure naming the fixture that no longer carries it. */
function lineOf(file: string, needle: string): number {
  const index = linesOf(file).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer declares "${needle}" in ${file}`);
  return index + 1;
}

/** A binding row: the name the file binds, and the line its own entry starts on. */
type BindingRow = TsFileSymbolsPayload["bindings"][number];

/** Outlines `file` with one fresh process, and keeps what that process said on the wire. */
async function outlineOf(
  file: string,
  depth: number,
): Promise<{ symbols: OutlineSymbol[]; bindings: BindingRow[]; payload: TsFileSymbolsPayload; log: TsgoProcessLog }> {
  const log = tsgoProcessLog();
  const manager = new LspSessionManager({ spawn: log.spawn });
  try {
    const out = await runTsFileSymbols(
      manager,
      { sourceRoots: [tsFixtureRoot], file, depth, timeBudgetMs: CALL_BUDGET_MS },
    );
    if (out.isError) throw new Error(`ts_file_symbols failed: ${textOf(out)}`);
    const payload = payloadOf<TsFileSymbolsPayload>(out, "ts_file_symbols");
    return { symbols: payload.symbols, bindings: payload.bindings, payload, log };
  } finally {
    manager.disposeAll();
  }
}

function named(symbols: readonly OutlineSymbol[], name: string): OutlineSymbol | undefined {
  return symbols.find((symbol) => symbol.name === name);
}

function bound(bindings: readonly BindingRow[], name: string): BindingRow | undefined {
  return bindings.find((binding) => binding.name === name);
}

/** The raw `documentSymbol` entries for a fixture, which is where `selectionRange` still exists. */
async function rawSymbols(file: string): Promise<{ symbols: LspDocumentSymbol[]; log: TsgoProcessLog }> {
  const log = tsgoProcessLog();
  const manager = new LspSessionManager({ spawn: log.spawn });
  try {
    const session = manager.get(tsFixtureRoot, tsgoConfig(requireTsgo()));
    const outline = await session.documentSymbol(file);
    if (outline.state !== "ok") throw new Error(`the server answered "${outline.state}" for ${file}`);
    return { symbols: outline.symbols, log };
  } finally {
    manager.disposeAll();
  }
}

/** The text between a member's declaration start and its own identifier — the modifier span, read on one line. */
function modifierSpan(symbol: LspDocumentSymbol, lines: string[]): string {
  const start = symbol.range.start;
  const identifier = symbol.selectionRange?.start;
  if (identifier === undefined || start.character === undefined || identifier.line !== start.line) return "";
  return lines[start.line]?.slice(start.character, identifier.character) ?? "";
}

describe("ts_file_symbols against the real tsgo", () => {
  itIfTsgoAvailable("outlines a file the server has never been given, on the first call of a fresh process", async () => {
    const { symbols, bindings, log } = await outlineOf(storageFile, 0);

    // The import binding is not a declaration the file makes, so it is not in `symbols`.
    expect(symbols.map((symbol) => symbol.name)).toEqual(["RunFn", "Reader", "FileStorage", "compose"]);
    expect(named(symbols, "FileStorage")).toMatchObject({
      kind: "class",
      range: { startLine: lineOf(storageFile, "export class FileStorage") },
    });
    expect(bindings).toEqual([{ name: "LABEL", line: lineOf(storageFile, 'import { LABEL } from "./label.js";') }]);
    // The proof shape for a syntactic answer: the document was opened on the process that answered.
    expect(log.opened).toEqual([{ file: storageFile, languageId: "typescript" }]);
  }, CALL_BUDGET_MS);

  itIfTsgoAvailable("depth 1 lists the members of a container kind, and nothing a symbol cannot address", async () => {
    const { symbols } = await outlineOf(storageFile, 1);

    const storage = named(symbols, "FileStorage");
    expect(named(storage?.children ?? [], "read")).toMatchObject({ kind: "method" });
    // A container kind's members stay: an interface's member is addressable as `Reader.read`.
    expect(named(named(symbols, "Reader")?.children ?? [], "read")).toMatchObject({ kind: "method" });
    // A function's locals and an object literal's properties are not addressable as `symbol`, so they are not
    // listed as its members: the members the outline shows are the ones a caller can ask about.
    const compose = named(symbols, "compose");
    expect(compose?.children).toBeUndefined();
  }, CALL_BUDGET_MS);

  itIfTsgoAvailable("publishes a type alias as the kind tsgo reports for it, which is Class", async () => {
    const { symbols } = await outlineOf(storageFile, 0);

    // the measured server behaviour: a type alias arrives as kind 5, and it is published as reported, never
    // re-derived — so `RunFn` reads as a class to whoever asked.
    expect(named(symbols, "RunFn")).toMatchObject({ kind: "class" });
  }, CALL_BUDGET_MS);

  itIfTsgoAvailable("moves an import binding out of the declarations and into `bindings`, on the hover answer", async () => {
    const { symbols, bindings, payload } = await outlineOf(storageFile, 0);

    expect(named(symbols, "LABEL")).toBeUndefined();
    expect(bound(bindings, "LABEL")).toMatchObject({
      line: lineOf(storageFile, 'import { LABEL } from "./label.js";'),
    });
    // A binding carries no kind at all: kind is never re-derived, and the only honest kind for one is none.
    expect(Object.keys(bindings[0] ?? {})).toEqual(["name", "line"]);
    expect(payload).not.toHaveProperty("bindingsUnverified");
  }, CALL_BUDGET_MS);

  itIfTsgoAvailable(
    "classifies every import and re-export form apart, and keeps a plain declaration in the outline",
    async () => {
      const { symbols, bindings, payload } = await outlineOf(bindingsFile, 1);

      // The forms, read off the fixture's own lines: a named, renamed, default, namespace,
      // type-only and multi-line import, an unresolved one, and a `export { a } from` re-export.
      // Every binding, in source order, with the line its own entry starts on; the `export { counted }` list
      // entry shares its name with the `const` on line 13, which is a declaration and stays in `symbols`.
      expect(bindings).toEqual([
        { name: "LABEL", line: lineOf(bindingsFile, 'import { LABEL } from') },
        { name: "RENAMED", line: lineOf(bindingsFile, "import { LABEL as RENAMED }") },
        { name: "makeTarget", line: lineOf(bindingsFile, "import makeTarget") },
        { name: "NS", line: lineOf(bindingsFile, "import * as NS") },
        { name: "TargetShape", line: lineOf(bindingsFile, "import type { TargetShape }") },
        { name: "TARGET", line: lineOf(bindingsFile, "  TARGET,") },
        { name: "RETHROWN", line: lineOf(bindingsFile, "export { LABEL as RETHROWN }") },
        { name: "counted", line: lineOf(bindingsFile, "export { counted }") },
      ]);
      expect(named(symbols, "counted")).toMatchObject({ range: { startLine: lineOf(bindingsFile, "const counted = 0") } });
      // The checker prefixes an alias symbol's quick info with `(alias)`, which is what separates a binding from
      // a `const` of the same kind; `counted` is exported by a local `export { }` list and declared here.
      expect(symbols.map((symbol) => symbol.name)).toEqual(
        expect.arrayContaining(["plain", "later", "counted", "read"]),
      );
      for (const name of ["LABEL", "RENAMED", "makeTarget", "NS", "TARGET", "RETHROWN"]) {
        expect(named(symbols, name), `${name} is still listed as a declaration`).toBeUndefined();
      }
      // Each binding row carries the line its own entry starts on, read from the fixture.
      expect(bound(bindings, "RENAMED")?.line).toBe(lineOf(bindingsFile, "import { LABEL as RENAMED }"));
      expect(bound(bindings, "RETHROWN")?.line).toBe(lineOf(bindingsFile, "export { LABEL as RETHROWN }"));
      // An import that resolves to no module has no symbol to classify: its hover answers nothing, so it stays
      // among the declarations and the payload says exactly that one entry could not be checked.
      expect(named(symbols, "missing")).toMatchObject({ kind: "variable" });
      expect(payload.bindingsUnverified).toMatch(/^1 top-level variable entry could not be checked: /);

      // A class's members stay at depth 1; `read` is a function and its locals are not listed.
      const shape = symbols.find((symbol) => symbol.name === "read");
      expect(shape?.kind).toBe("function");
      expect(shape?.children).toBeUndefined();
    },
    CALL_BUDGET_MS,
  );

  itIfTsgoAvailable("opens each extension under the languageId that decides how the file is parsed", async () => {
    const seen: { file: string; languageId: string }[] = [];
    const outlines: OutlineSymbol[][] = [];
    for (const file of [storageFile, viewFile, legacyFile, widgetFile]) {
      const { symbols, log } = await outlineOf(file, 1);
      seen.push(...log.opened);
      outlines.push(symbols);
    }

    expect(seen).toEqual([
      { file: storageFile, languageId: "typescript" },
      { file: viewFile, languageId: "typescriptreact" },
      { file: legacyFile, languageId: "javascript" },
      { file: widgetFile, languageId: "javascriptreact" },
    ]);
    expect(named(outlines[1] ?? [], "header")).toMatchObject({ kind: "function" });
    expect(named(outlines[2] ?? [], "legacy")).toMatchObject({ kind: "function" });
    expect(named(outlines[3] ?? [], "render")).toMatchObject({ kind: "function" });
  }, CALL_BUDGET_MS);

  itIfTsgoAvailable("answers an empty file with an empty outline, not with a cold one", async () => {
    const { symbols } = await outlineOf(emptyFile, 1);

    expect(symbols).toEqual([]);
  }, CALL_BUDGET_MS);

  itIfTsgoAvailable("outlines a source no tsconfig include lists, on the project inferred for it", async () => {
    const { symbols, log } = await outlineOf(outsideFile, 0);

    expect(named(symbols, "OUTSIDE_INCLUDE")).toMatchObject({ kind: "variable" });
    expect(log.opened).toEqual([{ file: outsideFile, languageId: "typescript" }]);
  }, CALL_BUDGET_MS);

  itIfTsgoAvailable("puts a member's modifiers inside its range, which is what tells a static from an instance", async () => {
    const { symbols } = await rawSymbols(collideFile);
    const lines = linesOf(collideFile);
    const collide = symbols.find((symbol) => symbol.name === "Collide");
    const runs = (collide?.children ?? []).filter((child) => child.name === "run");

    // Static-ness is read from the text between `range.start` and `selectionRange.start`, so the two
    // entries sharing the key `run` have to differ exactly there.
    expect(runs).toHaveLength(2);
    const spans = runs.map((run) => modifierSpan(run, lines));
    console.info(`run modifier spans: ${JSON.stringify(spans)}`);
    expect(spans.filter((span) => span.includes("static"))).toHaveLength(1);
    expect(spans.filter((span) => !span.includes("static"))).toHaveLength(1);

    const labels = (collide?.children ?? []).filter((child) => child.name === "label");
    const labelSpans = labels.map((label) => modifierSpan(label, lines));
    console.info(`label modifier spans: ${JSON.stringify(labelSpans)}`);
    expect(labelSpans).toHaveLength(2);
    expect(labelSpans.some((span) => span.includes("get"))).toBe(true);
    expect(labelSpans.some((span) => span.includes("set"))).toBe(true);

    // A value beside a type that does not merge with it: one key, two symbols, and the kinds say which is which.
    const widgets = symbols.filter((symbol) => symbol.name === "Widget");
    console.info(`Widget entries: ${JSON.stringify(widgets.map((w) => ({ kind: w.kind, line: w.range.start.line })))}`);
    expect(widgets).toHaveLength(2);
    expect(mergedKinds(widgets)).toEqual(["interface", "variable"]);
    const merged = symbols.filter((symbol) => symbol.name === "Mergeable");
    console.info(`Mergeable declared twice reads as ${merged.length} entries of kinds ${JSON.stringify(mergedKinds(merged))}`);
    expect(merged).toHaveLength(2);
  }, CALL_BUDGET_MS);
});

function mergedKinds(symbols: readonly LspDocumentSymbol[]): string[] {
  const KIND_NAMES: Record<number, string> = { 11: "interface", 13: "variable" };
  return symbols.map((symbol) => KIND_NAMES[symbol.kind] ?? `unknown(${symbol.kind})`).sort();
}
