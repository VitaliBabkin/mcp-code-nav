import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { pathKey } from "../../src/paths/path-containment.js";
import { runTsFindImplementations, type TsFindImplementationsPayload } from "../../src/tools/ts-find-implementations.js";
import { runTsFindReferences, type TsFindReferencesPayload } from "../../src/tools/ts-find-references.js";
import { runTsFindSymbol, type TsFindSymbolPayload } from "../../src/tools/ts-find-symbol.js";
import { CALL_BUDGET_MS, fixtures, itIfTsgoAvailable, payloadOf, recordAnswer, textOf } from "../helpers/tsgo-live.js";

/**
 * Live against the real TypeScript 7 native server, over
 * `test/fixtures/ts-namespaces`: `namespace A.B { ... }` (one outline entry named `A.B`) and an interface merged
 * with a namespace of one name. The reference cases are what pin the position rule: asked at `B` inside the
 * dotted entry the answer holds the `B` qualifier sites, and asked at `A` the `A` ones - a position at the start
 * of the whole run would make both questions the same.
 */

const workspaceRoot = join(fixtures, "ts-namespaces");
const dottedFile = join(workspaceRoot, "src", "dotted.ts");
const useFile = join(workspaceRoot, "src", "use.ts");
const mergedFile = join(workspaceRoot, "src", "merged.ts");
const mergedUseFile = join(workspaceRoot, "src", "merged-use.ts");

const managers: LspSessionManager[] = [];

function freshManager(): LspSessionManager {
  const manager = new LspSessionManager();
  managers.push(manager);
  return manager;
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.disposeAll();
});

const linesOf = (file: string): string[] => readFileSync(file, "utf-8").split(/\r?\n/);

/** The 1-based line holding `needle`, or a failure naming the fixture that lost it. */
function lineOf(file: string, needle: string): number {
  const index = linesOf(file).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer holds "${needle}" in ${file}`);
  return index + 1;
}

/** The 1-based column of `token` in the line holding `line`, so an expected site is read from the fixture's text. */
function columnOf(file: string, line: string, token: string): number {
  const text = linesOf(file).find((candidate) => candidate.includes(line));
  if (text === undefined) throw new Error(`the fixture no longer holds "${line}" in ${file}`);
  return text.indexOf(token, text.indexOf(line)) + 1;
}

function symbolAnswer(manager: LspSessionManager, symbol: string, anchor: string) {
  return runTsFindSymbol(manager, { sourceRoots: [workspaceRoot], symbol, anchor, timeBudgetMs: CALL_BUDGET_MS });
}

function referencesAnswer(manager: LspSessionManager, file: string, symbol: string) {
  return runTsFindReferences(manager, {
    sourceRoots: [workspaceRoot],
    file,
    symbol,
    includeDeclaration: false,
    timeBudgetMs: CALL_BUDGET_MS,
  });
}

/** `file:line:column` of every listed site, in the order the answer carries them. */
function sitesOf(answer: TsFindReferencesPayload): string[] {
  return answer.files.flatMap((group) =>
    group.sites.map((site) => `${pathKey(group.file).split(/[\\/]/).pop()}:${site.line}:${site.column}`),
  );
}

describe("a dotted namespace declaration is addressable", () => {
  itIfTsgoAvailable(
    "ts_find_symbol finds A.B.f and P.Q.R.x by file anchor and by directory anchor",
    async () => {
      const manager = freshManager();
      for (const [symbol, needle, kind] of [
        ["A.B.f", "export function f", "function"],
        ["P.Q.R.x", "export const x", "variable"],
      ] as const) {
        const byFile = payloadOf<TsFindSymbolPayload>(await symbolAnswer(manager, symbol, dottedFile), "ts_find_symbol");
        recordAnswer(`dotted-symbol-file-${symbol}`, byFile);
        expect(byFile.declarations.map((row) => [row.name, row.kind, row.line]), symbol).toEqual([
          [symbol, kind, lineOf(dottedFile, needle)],
        ]);

        const byDirectory = payloadOf<TsFindSymbolPayload>(await symbolAnswer(manager, symbol, workspaceRoot), "ts_find_symbol");
        recordAnswer(`dotted-symbol-dir-${symbol}`, byDirectory);
        expect(byDirectory.declarations.map((row) => [row.name, row.kind, row.line]), symbol).toEqual([
          [symbol, kind, lineOf(dottedFile, needle)],
        ]);
        expect(byDirectory.declarations[0]).not.toHaveProperty("pathUnverified");
      }
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "ts_find_symbol addresses the namespace itself at the identifier the last segment names",
    async () => {
      const manager = freshManager();
      const whole = payloadOf<TsFindSymbolPayload>(await symbolAnswer(manager, "A.B", dottedFile), "ts_find_symbol");
      recordAnswer("dotted-symbol-file-A.B", whole);
      expect(whole.declarations.map((row) => [row.name, row.kind, row.line])).toEqual([["A.B", "namespace", 1]]);
      const prefix = payloadOf<TsFindSymbolPayload>(await symbolAnswer(manager, "A", dottedFile), "ts_find_symbol");
      recordAnswer("dotted-symbol-file-A", prefix);
      expect(prefix.declarations.map((row) => [row.name, row.kind, row.line])).toEqual([["A", "namespace", 1]]);
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "ts_find_symbol finds the prefixes A, A.B and P.Q by directory anchor, because tsgo indexes every segment",
    async () => {
      const manager = freshManager();
      for (const [symbol, needle] of [
        ["A", "export namespace A.B"],
        ["A.B", "export namespace A.B"],
        ["P.Q", "export namespace P.Q.R"],
      ] as const) {
        const answer = payloadOf<TsFindSymbolPayload>(await symbolAnswer(manager, symbol, workspaceRoot), "ts_find_symbol");
        recordAnswer(`dotted-symbol-dir-prefix-${symbol}`, answer);
        expect(answer.declarations.map((row) => [row.name, row.kind, row.line]), symbol).toEqual([
          [symbol, "namespace", lineOf(dottedFile, needle)],
        ]);
        expect(answer.declarations[0], symbol).not.toHaveProperty("pathUnverified");
      }
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "ts_find_references(A.B.f) lists the use, and A.B and A list their own qualifier sites (the position pin)",
    async () => {
      const manager = freshManager();
      const useLine = "export const n = A.B.f();";
      const member = payloadOf<TsFindReferencesPayload>(await referencesAnswer(manager, dottedFile, "A.B.f"), "ts_find_references");
      recordAnswer("dotted-refs-A.B.f", member);
      expect(sitesOf(member)).toEqual([`use.ts:${lineOf(useFile, useLine)}:${columnOf(useFile, useLine, "f(")}`]);

      const second = payloadOf<TsFindReferencesPayload>(await referencesAnswer(manager, dottedFile, "A.B"), "ts_find_references");
      recordAnswer("dotted-refs-A.B", second);
      // Asked at `B`: the `B` qualifier in `A.B.f()` and nothing that names only `A`.
      expect(sitesOf(second), JSON.stringify(second.files)).toEqual([
        `use.ts:${lineOf(useFile, useLine)}:${columnOf(useFile, useLine, "B.")}`,
      ]);

      const first = payloadOf<TsFindReferencesPayload>(await referencesAnswer(manager, dottedFile, "A"), "ts_find_references");
      recordAnswer("dotted-refs-A", first);
      expect(sitesOf(first), JSON.stringify(first.files)).toContain(
        `use.ts:${lineOf(useFile, useLine)}:${columnOf(useFile, useLine, "A.")}`,
      );
      expect(sitesOf(first)).not.toContain(`use.ts:${lineOf(useFile, useLine)}:${columnOf(useFile, useLine, "B.")}`);
    },
    CALL_BUDGET_MS + 30_000,
  );
});

describe("an interface beside a namespace of one name", () => {
  itIfTsgoAvailable(
    "the two meanings answer separately, which decides the rule: type I holds the type use, namespace I the qualifier use",
    async () => {
      const manager = freshManager();
      const typeUse = "export const v: I";
      const qualifierUse = "export const y = I.x;";

      const asType = payloadOf<TsFindReferencesPayload>(await referencesAnswer(manager, mergedFile, "type I"), "ts_find_references");
      recordAnswer("merged-refs-type-I", asType);
      const asNamespace = payloadOf<TsFindReferencesPayload>(
        await referencesAnswer(manager, mergedFile, "namespace I"),
        "ts_find_references",
      );
      recordAnswer("merged-refs-namespace-I", asNamespace);

      const typeSite = `merged-use.ts:${lineOf(mergedUseFile, typeUse)}:${columnOf(mergedUseFile, typeUse, "I")}`;
      const qualifierSite = `merged-use.ts:${lineOf(mergedUseFile, qualifierUse)}:${columnOf(mergedUseFile, qualifierUse, "I.")}`;
      const summary = `type I -> ${JSON.stringify(sitesOf(asType))}; namespace I -> ${JSON.stringify(sitesOf(asNamespace))}`;
      expect(sitesOf(asType), summary).toContain(typeSite);
      expect(sitesOf(asNamespace), summary).toContain(qualifierSite);
      // The branch ruled in advance: each answer holds only its own use.
      expect(sitesOf(asType), summary).not.toContain(qualifierSite);
      expect(sitesOf(asNamespace), summary).not.toContain(typeSite);
      expect(asType.resolved.kind).toBe("interface");
      expect(asNamespace.resolved.kind).toBe("namespace");
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "the bare key is refused with both spellings, ts_find_implementations asks the interface, and ts_find_symbol lists both",
    async () => {
      const manager = freshManager();
      const bare = await referencesAnswer(manager, mergedFile, "I");
      expect(bare.isError, textOf(bare)).toBe(true);
      expect(textOf(bare)).toContain("type I (interface)");
      expect(textOf(bare)).toContain("namespace I (namespace)");

      const implementations = payloadOf<TsFindImplementationsPayload>(
        await runTsFindImplementations(manager, {
          sourceRoots: [workspaceRoot],
          file: mergedFile,
          symbol: "I",
          timeBudgetMs: CALL_BUDGET_MS,
        }),
        "ts_find_implementations",
      );
      expect(implementations.resolved.kind).toBe("interface");

      const rows = payloadOf<TsFindSymbolPayload>(await symbolAnswer(manager, "I", workspaceRoot), "ts_find_symbol");
      expect(rows.declarations.map((row) => row.kind).sort()).toEqual(["interface", "namespace"]);
    },
    CALL_BUDGET_MS + 30_000,
  );
});
