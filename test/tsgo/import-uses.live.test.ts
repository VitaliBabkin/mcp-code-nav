import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runTsFindReferences, type TsFindReferencesPayload } from "../../src/tools/ts-find-references.js";
import { runTsFindSymbol } from "../../src/tools/ts-find-symbol.js";
import {
  CALL_BUDGET_MS,
  fixtures,
  itIfTsgoAvailable,
  payloadOf,
  textOf,
  tsFixtureRoot,
  type LiveResult,
} from "../helpers/tsgo-live.js";

/**
 * Live: an import specifier, a re-export specifier and a use are all
 * uses of a symbol, so the default `ts_find_references` answer holds all three and `includeDeclaration` decides
 * only the subject's own declaration; and the files no tsconfig project includes are pointed at by name rather
 * than sampled. The fixture is built so each site sits in its own file: `src/consumer.ts` imports and uses,
 * `src/keeper.ts` imports only, `src/barrel.ts` re-exports, and `test/outside.ts` — a file no `include` lists —
 * uses the subject and declares a name nothing else declares.
 */

const workspaceRoot = join(fixtures, "ts-import-uses");
const storeFile = join(workspaceRoot, "src", "store.ts");
const consumerFile = join(workspaceRoot, "src", "consumer.ts");
const keeperFile = join(workspaceRoot, "src", "keeper.ts");
const barrelFile = join(workspaceRoot, "src", "barrel.ts");
const outsideFile = join(workspaceRoot, "test", "outside.ts");

const managers: LspSessionManager[] = [];

function freshManager(): LspSessionManager {
  const manager = new LspSessionManager();
  managers.push(manager);
  return manager;
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.disposeAll();
});

function linesOf(file: string): string[] {
  return readFileSync(file, "utf-8").split(/\r?\n/);
}

/** The 1-based line a text sits on, or a failure naming the file that no longer carries it. */
function lineOf(file: string, needle: string): number {
  const index = linesOf(file).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`"${needle}" is no longer in ${file}`);
  return index + 1;
}

/** `path` under `root` in forward slashes; its own spelling when it is not under it at all. */
function under(root: string, path: string): string {
  const rel = relative(root, path);
  return rel.startsWith("..") ? path : rel.split(sep).join("/");
}

function references(manager: LspSessionManager, root: string, file: string, symbol: string, includeDeclaration: boolean): Promise<LiveResult> {
  return runTsFindReferences(manager, {
    sourceRoots: [root],
    file,
    symbol,
    includeDeclaration,
    timeBudgetMs: CALL_BUDGET_MS,
  });
}

function referencesOf(result: LiveResult): TsFindReferencesPayload {
  return payloadOf<TsFindReferencesPayload>(result, "ts_find_references");
}

/** Every kept row as `file:line`, sorted, so a listing can be compared without the server's ordering. */
function lineRows(root: string, answer: TsFindReferencesPayload): string[] {
  return answer.files
    .flatMap((group) => group.sites.map((site) => `${under(root, group.file)}:${site.line}`))
    .sort();
}

describe("ts_find_references keeps the specifier sites by default", () => {
  itIfTsgoAvailable(
    "lists the import line, the re-export line and the use, and names no declaration until the caller asks",
    async () => {
      const manager = freshManager();
      const defaultAnswer = referencesOf(await references(manager, workspaceRoot, storeFile, "Store", false));

      expect(defaultAnswer.resolved).toMatchObject({ name: "Store", kind: "class", file: storeFile });
      // The three shapes the default answer must hold: a plain import, an import that is never used, and a
      // barrel re-export — each is a use of the class, and none may be lost.
      expect(lineRows(workspaceRoot, defaultAnswer)).toEqual(
        [
          `${under(workspaceRoot, consumerFile)}:${lineOf(consumerFile, "import { Store }")}`,
          `${under(workspaceRoot, consumerFile)}:${lineOf(consumerFile, "export function consume(store: Store)")}`,
          `${under(workspaceRoot, keeperFile)}:${lineOf(keeperFile, "import { Store }")}`,
          `${under(workspaceRoot, barrelFile)}:${lineOf(barrelFile, "export { Store }")}`,
        ].sort(),
      );
      expect(defaultAnswer.totalReferences).toBe(4);
      expect(lineRows(workspaceRoot, defaultAnswer).some((row) => row.startsWith("src/store.ts:"))).toBe(false);

      const declared = referencesOf(await references(manager, workspaceRoot, storeFile, "Store", true));
      expect(lineRows(workspaceRoot, declared)).toEqual(
        [...lineRows(workspaceRoot, defaultAnswer), `${under(workspaceRoot, storeFile)}:${lineOf(storeFile, "export class Store")}`].sort(),
      );
      expect(declared.totalReferences).toBe(defaultAnswer.totalReferences + 1);
    },
    CALL_BUDGET_MS * 2,
  );
});

/**
 * Live: a subject addressed through an import binding answers exactly as the
 * same subject addressed at its declaring file - the import line a row, the declaration the one `includeDeclaration`
 * controls. Renamed imports and imports through a barrel re-export are the two shapes whose `definition` could land
 * somewhere other than the class.
 */
describe("a subject addressed through an import binding", () => {
  const aliasRoot = join(fixtures, "ts-import-alias");
  const aliasStore = join(aliasRoot, "src", "store.ts");

  async function rowsFor(file: string, symbol: string, includeDeclaration: boolean, root = workspaceRoot): Promise<string[]> {
    const answer = referencesOf(await references(freshManager(), root, file, symbol, includeDeclaration));
    expect(answer.totalReferences).toBe(lineRows(root, answer).length);
    return lineRows(root, answer);
  }

  itIfTsgoAvailable(
    "answers from consumer.ts exactly as from store.ts, with the import line listed and the declaration absent",
    async () => {
      const fromDeclaration = await rowsFor(storeFile, "Store", false);
      const fromImport = await rowsFor(consumerFile, "Store", false);

      expect(fromImport).toEqual(fromDeclaration);
      expect(fromImport).toContain(`src/consumer.ts:${lineOf(consumerFile, "import { Store }")}`);
      expect(fromImport.some((row) => row.startsWith("src/store.ts:"))).toBe(false);

      const withDeclaration = await rowsFor(consumerFile, "Store", true);
      expect(withDeclaration).toEqual([...fromImport, `src/store.ts:${lineOf(storeFile, "export class Store")}`].sort());
      expect(withDeclaration).toEqual(await rowsFor(storeFile, "Store", true));
    },
    CALL_BUDGET_MS * 3,
  );

  itIfTsgoAvailable(
    "answers an import through a barrel exactly as from the declaring file, and a renamed import with its import line kept",
    async () => {
      const renamed = join(aliasRoot, "src", "renamed.ts");
      const viaBarrel = join(aliasRoot, "src", "via-barrel.ts");
      const fromDeclaration = await rowsFor(aliasStore, "Store", false, aliasRoot);

      const fromRenamed = await rowsFor(renamed, "S", false, aliasRoot);
      const fromBarrel = await rowsFor(viaBarrel, "Store", false, aliasRoot);
      console.info(
        `alias subjects on ts-import-alias: declaring ${JSON.stringify(fromDeclaration)}; ` +
          `renamed ${JSON.stringify(fromRenamed)}; barrel ${JSON.stringify(fromBarrel)}`,
      );

      expect(fromBarrel).toEqual(fromDeclaration);
      // tsgo scopes the references of a renamed binding (`S`) to the binding's own sites, so its answer is the
      // alias's uses and not the class's: what the rule fixes is that the import line is a row and the
      // declaration is not, and that the flag changes nothing here because the declaration is not in that set.
      expect(fromRenamed).toEqual(await rowsFor(renamed, "S", true, aliasRoot));

      // The scoped answer says so, and names where the full set is asked for.
      const scoped = await references(freshManager(), aliasRoot, renamed, "S", false);
      const storeLine = lineOf(aliasStore, "export class Store");
      const stated = referencesOf(scoped).resolved.renamedImportOf;
      // The server's own spelling of the path (drive-letter case) is what is published, so compare the place.
      expect({ ...stated, file: stated?.file.toLowerCase() }).toEqual({
        module: false,
        reExport: false,
        symbol: "Store",
        file: aliasStore.toLowerCase(),
        line: storeLine,
      });
      expect(textOf(scoped).toLowerCase()).toContain(
        `"s" is a renamed import of store (${aliasStore}:${storeLine}) - this lists the local name's uses only; ask for store in ${aliasStore} for every use`.toLowerCase(),
      );
      // An import that is not renamed carries no such field.
      const named = await references(freshManager(), aliasRoot, join(aliasRoot, "src", "via-barrel.ts"), "Store", false);
      expect(referencesOf(named).resolved).not.toHaveProperty("renamedImportOf");
      expect(fromDeclaration.some((row) => row.startsWith("src/store.ts:"))).toBe(false);
      expect(fromRenamed).toContain(`src/renamed.ts:${lineOf(renamed, "import { Store as S }")}`);
      expect(fromBarrel).toContain(`src/via-barrel.ts:${lineOf(viaBarrel, "import { Store }")}`);
    },
    CALL_BUDGET_MS * 4,
  );
});

/**
 * the statement for every binding form of the `ts-file-symbols` fixture that tsgo scopes to the local
 * name. The module binding is answered at line 0, character 0 of the target, where nothing is declared.
 */
describe("what a scoped binding says it stands for", () => {
  const bindingsFile = join(tsFixtureRoot, "src", "bindings.ts");
  const targetFile = join(tsFixtureRoot, "src", "bindings-target.ts");
  const labelFile = join(tsFixtureRoot, "src", "label.ts");

  async function stated(symbol: string) {
    const result = await references(freshManager(), tsFixtureRoot, bindingsFile, symbol, false);
    return { result, of: referencesOf(result).resolved.renamedImportOf };
  }

  const lower = (path: string | undefined): string | undefined => path?.toLowerCase();

  itIfTsgoAvailable(
    "names the module, not targetDefault, for a namespace import",
    async () => {
      const { result, of } = await stated("NS");
      expect(of).toMatchObject({ symbol: null, module: true, reExport: false, line: 1 });
      expect(lower(of?.file)).toBe(targetFile.toLowerCase());
      expect(textOf(result).toLowerCase()).toContain(
        `"ns" names the whole module ${targetFile}, not one declaration - this lists the local name's uses only; for every use of a member, ask for that member in ${targetFile}`.toLowerCase(),
      );
      expect(textOf(result)).not.toContain("targetDefault");
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "spells a default import as the function it binds, as an import",
    async () => {
      const { result, of } = await stated("makeTarget");
      expect(of).toMatchObject({ symbol: "targetDefault", module: false, reExport: false });
      expect(lower(of?.file)).toBe(targetFile.toLowerCase());
      expect(textOf(result)).toContain(`"makeTarget" is a renamed import of targetDefault (`);
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "spells a re-export's target; tsgo's alias hover shows no export clause, so it is worded as an import",
    async () => {
      const { result, of } = await stated("RETHROWN");
      expect(of).toMatchObject({ symbol: "LABEL", module: false });
      expect(lower(of?.file)).toBe(labelFile.toLowerCase());
      // tsgo 7.0.2's hover for `export { LABEL as RETHROWN } from` is the alias line alone, so `reExport` stays
      // false and the wording says "import".
      expect(of?.reExport).toBe(false);
      expect(textOf(result)).toContain(`"RETHROWN" is a renamed import of LABEL (`);
    },
    CALL_BUDGET_MS * 2,
  );
});

describe("the uncovered files that mention the name", () => {
  itIfTsgoAvailable(
    "points at the file no tsconfig includes that holds the name in its text, and keeps it out of the rows",
    async () => {
      const manager = freshManager();
      const result = await references(manager, workspaceRoot, storeFile, "Store", false);
      const answer = referencesOf(result);
      const scope = answer.scope;
      if (!("uncoveredSources" in scope)) throw new Error(`no uncovered block: ${JSON.stringify(scope)}`);
      const uncovered = scope.uncoveredSources;

      expect(uncovered.count).toBe(1);
      expect(uncovered.directories).toEqual([{ directory: "test", count: 1 }]);
      expect(uncovered.directoriesTruncated).toBe(0);
      expect(uncovered.namedFileUncovered).toBe(false);
      // The file is absent from the listing — no project loads it — and present as a text pointer instead.
      expect(lineRows(workspaceRoot, answer).some((row) => row.startsWith("test/outside.ts:"))).toBe(false);
      expect(uncovered.mentioning.name).toBe("Store");
      expect(uncovered.mentioning.count).toBe(1);
      expect(uncovered.mentioning.unchecked).toBe(0);
      expect(uncovered.mentioning.files).toHaveLength(1);
      expect(under(workspaceRoot, uncovered.mentioning.files[0]?.file ?? "")).toBe("test/outside.ts");
      expect(uncovered.mentioning.files[0]?.matchingLines).toBeGreaterThanOrEqual(1);
      expect(uncovered.mentioning.filesTruncated).toBe(0);
      expect(answer.scope.limits).toContain("uncovered-sources-present");
      // No `listing-capped`: the block partitions the set beside an exact count, and a reader told the listing
      // was capped would go looking for dropped rows instead of for the files the clause names.
      expect(answer.scope.limits).not.toContain("listing-capped");

      const summary = textOf(result);
      expect(summary).toContain("were not searched");
      expect(summary.split("\n")[1]).toMatch(/^INCOMPLETE: 1 file\(s\) no tsconfig project includes were not searched/);
      expect(summary).toContain(" matching line");
      expect(summary).toContain(uncovered.mentioning.files[0]?.file ?? "");
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "appends the same clause to a no-match refusal, for a declaration that lives only in an uncovered file",
    async () => {
      const manager = freshManager();
      const byDirectory = await runTsFindSymbol(manager, {
        sourceRoots: [workspaceRoot],
        symbol: "ONLY_OUTSIDE",
        anchor: workspaceRoot,
        timeBudgetMs: CALL_BUDGET_MS,
      });
      expect(byDirectory.isError, textOf(byDirectory)).toBe(true);
      expect(textOf(byDirectory)).toContain("no declaration named");
      expect(textOf(byDirectory)).toContain("were not searched");
      expect(textOf(byDirectory)).toContain("\nINCOMPLETE: ");
      expect(textOf(byDirectory)).toContain(join(workspaceRoot, "test", "outside.ts"));

      // A FILE anchor refuses the same way: the clause is about the ground the workspace search could not see,
      // and it is appended wherever the refusal says a name was not found.
      const byFile = await runTsFindSymbol(manager, {
        sourceRoots: [workspaceRoot],
        symbol: "ONLY_OUTSIDE",
        anchor: consumerFile,
        timeBudgetMs: CALL_BUDGET_MS,
      });
      expect(byFile.isError, textOf(byFile)).toBe(true);
      expect(textOf(byFile)).toContain("\nINCOMPLETE: ");
      expect(textOf(byFile)).toContain(join(workspaceRoot, "test", "outside.ts"));

      // The scan changes no row and no count: the successful listing still holds no uncovered site.
      const listed = referencesOf(await references(manager, workspaceRoot, storeFile, "Store", false));
      expect(listed.files.some((group) => /outside\.ts$/.test(group.file))).toBe(false);
    },
    CALL_BUDGET_MS * 3,
  );
});
