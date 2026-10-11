import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { declarationKey } from "../../src/tools/go-navigation-shared.js";
import { goplsConfig } from "../../src/lsp/server-config.js";
import type { LspSessionManager } from "../../src/lsp/session-manager.js";
import {
  runGoFindSymbol,
  type DeclarationRow,
  type FindSymbolPayload,
  WORKSPACE_SYMBOL_CAP_WATERMARK,
} from "../../src/tools/go-find-symbol.js";
import {
  CALL_BUDGET_MS,
  disposeGoLiveManagers,
  freshManager,
  genericFile,
  hiddenFile,
  itIfGoplsAvailable,
  navRoot,
  payloadOf as okPayloadOf,
  removeTree,
  samePath,
  storageFile,
  subFile,
  textOf,
  usesFile,
} from "../helpers/go-live.js";

type Result = Awaited<ReturnType<typeof runGoFindSymbol>>;
type Payload = FindSymbolPayload;

const ROOT = resolve(navRoot);

/**
 * Every case here asks a whole module or one of its files, under the budget a cold package load needs.
 * `roots` is the declared boundary — for a file anchor the directory above it, which is also the module
 * the tool derives either way.
 */
function ask(manager: LspSessionManager, symbol: string, anchor: string, roots = [ROOT]): Promise<Result> {
  return runGoFindSymbol(manager, { sourceRoots: roots, symbol, anchor, timeBudgetMs: CALL_BUDGET_MS });
}

function askModule(manager: LspSessionManager, symbol: string, moduleRoot = navRoot): Promise<Result> {
  return ask(manager, symbol, moduleRoot, [resolve(moduleRoot)]);
}

function payloadOf(result: Result): Payload {
  return okPayloadOf(result, "go_find_symbol");
}

/** The rows of an answer, each checked against the invariant. */
function rowsOf(result: Result, asked: string): DeclarationRow[] {
  const rows = payloadOf(result).declarations;
  for (const row of rows) expect(declarationKey(row.name)).toBe(declarationKey(asked));
  return rows;
}

function inModule(rows: readonly DeclarationRow[]): DeclarationRow[] {
  return rows.filter((row) => !row.external);
}

function rowAt(rows: readonly DeclarationRow[], path: string): DeclarationRow | undefined {
  return rows.find((row) => samePath(row.file, path));
}

/** The 1-based line a fixture file declares `needle` on, so assertions track the fixture, not a snapshot. */
function lineOf(path: string, needle: string): number {
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer declares "${needle}" in ${path}`);
  return index + 1;
}

/** A module copy grown wide: 150 one-line declarations, all spelling `Bulk` plus three digits. */
function bulkModule(tmp: string): { readonly root: string; readonly file: string } {
  const root = join(tmp, "go-navigation");
  cpSync(navRoot, root, { recursive: true });
  const bulk = Array.from({ length: 150 }, (_unused, index) => {
    const name = `Bulk${String(index + 1).padStart(3, "0")}`;
    return `// ${name} is one of the bulk declarations that make this module's symbol list wide.\nfunc ${name}() int { return ${index + 1} }`;
  });
  const file = join(root, "bulk.go");
  writeFileSync(file, `package gonav\n\n${bulk.join("\n\n")}\n`);
  return { root, file };
}

afterEach(disposeGoLiveManagers);

/**
 * Live-binary suite for the `go_find_symbol` against a real `gopls` (excluded from
 * `npm test`, run via `npm run test:live`; see CONTRIBUTING.md). It exists for the
 * facts a mock cannot supply: that gopls fences the code block a declaration's signature arrives in, that
 * it answers a hover only about a document it holds — which is why the module-wide branch holds each row's
 * file open for the length of its hovers — how it spells a method in its own index (`Recv.Method`, with no
 * parentheses), and the size its `workspace/symbol` answer really stops at. Fixtures live under
 * `test/fixtures/go-navigation`; a module a test widens is a copy, never the fixture itself.
 */
describe("go_find_symbol against a real gopls binary", () => {
  itIfGoplsAvailable(
    "answers a file anchor from that file's outline, with the signature and doc read from a real hover",
    async () => {
      const result = await ask(freshManager(), "Store", usesFile);
      expect(result.isError, textOf(result)).toBeFalsy();
      const payload = payloadOf(result);
      const [row] = payload.declarations;

      expect(payload.scope.lookup).toBe("document-symbol");
      expect(payload.scope.limits).toEqual(["one-module", "one-file", "one-port"]);
      expect(samePath(payload.scope.moduleRoot, ROOT)).toBe(true);
      expect(rowsOf(result, "Store")).toHaveLength(1);
      expect(row).toMatchObject({
        name: "Store",
        kind: "struct",
        line: lineOf(usesFile, "type Store struct"),
        container: ".",
        visibility: "exported",
        external: false,
      });
      expect(samePath(String(row?.file), usesFile)).toBe(true);
      expect(String(row?.signature)).toMatch(/^type Store struct\b/);
      expect(String(row?.documentation)).toMatch(/holds values under normalised keys/);
      expect(row?.descriptionUnavailable).toBeUndefined();
    },
    600_000,
  );

  itIfGoplsAvailable(
    "describes a declaration whose file this session never opened, asked through the module anchor",
    async () => {
      // gopls answers `hover` about a document it holds and says nothing about one it does not, so the
      // module-wide branch holds each row's file open for the length of that row's hover: the signature
      // arriving here is the proof that it does. A common name is also answered by gopls's fuzzy search at
      // the size of its own list, which is what `listing-capped` says of the rows beside it.
      const result = await askModule(freshManager(), "Store");
      expect(result.isError, textOf(result)).toBeFalsy();
      const payload = payloadOf(result);

      expect(payload.scope.lookup).toBe("workspace-symbol");
      expect(payload.scope.limits).toContain("one-module");
      expect(payload.scope.limits).toContain("one-port");
      expect(payload.scope.limits).toContain("listing-capped");
      const inside = inModule(rowsOf(result, "Store"));
      expect(inside).toHaveLength(1);
      const [row] = inside;
      expect(row).toMatchObject({ name: "Store", container: ".", visibility: "exported", external: false });
      expect(samePath(String(row?.file), usesFile)).toBe(true);
      expect(String(row?.signature)).toMatch(/^type Store struct\b/);
      expect(row?.descriptionUnavailable).toBeUndefined();
    },
    600_000,
  );

  itIfGoplsAvailable("names a package-private helper by its own file's directory", async () => {
    const result = await askModule(freshManager(), "normaliseKey");
    expect(result.isError, textOf(result)).toBeFalsy();
    const rows = rowsOf(result, "normaliseKey");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "normaliseKey",
      kind: "function",
      container: ".",
      visibility: "package-private",
      external: false,
    });
    expect(samePath(String(rows[0]?.file), storageFile)).toBe(true);
    // The proof the hover was asked at the position gopls's own range named — the identifier's span, not a
    // guessed one: an answer with a signature and no `descriptionUnavailable` can only come from there.
    expect(rows[0]?.descriptionUnavailable).toBeUndefined();
    expect(String(rows[0]?.signature)).toMatch(/^func normaliseKey\(key string\) string$/);
  }, 600_000);

  itIfGoplsAvailable(
    "resolves a method under both receiver spellings to one declaration, in the spelling gopls indexes",
    async () => {
      const manager = freshManager();

      const punctuated = payloadOf(await askModule(manager, "(*Memory).Read"));
      const dotted = payloadOf(await askModule(manager, "Memory.Read"));
      const [read] = punctuated.declarations;

      expect(punctuated.declarations).toHaveLength(1);
      expect(dotted.declarations).toEqual(punctuated.declarations);
      expect(read).toMatchObject({
        name: "Memory.Read",
        kind: "method",
        container: ".",
        visibility: "exported",
        external: false,
      });
      expect(samePath(String(read?.file), storageFile)).toBe(true);
      // The row carries gopls's own dotted spelling, and its visibility comes from the method part of it;
      // `(*Memory).Read` asked by the caller is the same declaration, which the equality above records.
      expect(String(read?.signature)).toMatch(/func \(m \*Memory\) Read\(id string\) \(\[\]byte, error\)/);
      // The method member `Read` is a common name, so gopls's fuzzy list reaches its cap and the answer says so.
      expect(punctuated.scope.limits).toEqual(["one-module", "one-port", "listing-capped"]);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "answers a name declared in two packages of the module with two rows, each in its own container",
    async () => {
      const rows = rowsOf(await askModule(freshManager(), "LoadValue"), "LoadValue");

      expect(rows).toHaveLength(2);
      const atRoot = rowAt(rows, genericFile);
      const inSub = rowAt(rows, subFile);
      expect(atRoot).toMatchObject({ container: ".", external: false, name: "LoadValue", kind: "function" });
      expect(inSub).toMatchObject({ container: "sub", external: false, name: "LoadValue", kind: "function" });
      expect(String(atRoot?.signature)).toMatch(/func LoadValue\(c \*Cache\[string, int\]\) int/);
      expect(String(inSub?.signature)).toMatch(/func LoadValue\(\) int/);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "bounds a file answer to the one file named in the anchor, and says so when the name is not there",
    async () => {
      const manager = freshManager();

      const found = payloadOf(await ask(manager, "Reader", storageFile));
      expect(found.scope.limits).toContain("one-file");
      expect(found.declarations[0]).toMatchObject({ name: "Reader", kind: "interface", container: "." });

      const absent = await ask(manager, "Trim", storageFile);
      expect(absent.isError).toBe(true);
      expect(textOf(absent)).toContain("was found in the top-level declarations of");
      expect(textOf(absent)).toContain("The match is exact, not fuzzy");

      // The name is in the module, so the directory anchor answers it: the file answer's boundary was the
      // search's own scope, not a failure to look.
      const moduleRows = rowsOf(await askModule(manager, "Trim"), "Trim");
      const inside = inModule(moduleRows);
      expect(inside).toHaveLength(1);
      expect(inside[0]).toMatchObject({ name: "Trim", container: "." });
      expect(samePath(String(inside[0]?.file), usesFile)).toBe(true);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "reports a row it cannot read as outside the module, beside the one it can",
    async () => {
      const rows = rowsOf(await askModule(freshManager(), "Trim"), "Trim");
      const outside = rows.filter((row) => row.external);

      expect(outside.length).toBeGreaterThan(0);
      for (const row of outside) {
        expect(row.container).toBeNull();
        expect(row.signature).toBeUndefined();
        expect(row.documentation).toBeUndefined();
        expect(row.descriptionUnavailable).toBe("outside the module root; not read");
      }
    },
    600_000,
  );

  itIfGoplsAvailable("finds an exported method of an unexported type by either spelling", async () => {
    const manager = freshManager();

    const rows = rowsOf(await askModule(manager, "(*hidden).Ping"), "(*hidden).Ping");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "hidden.Ping", visibility: "exported", container: ".", external: false });
    expect(samePath(String(rows[0]?.file), hiddenFile)).toBe(true);

    const dotted = payloadOf(await askModule(manager, "hidden.Ping"));
    expect(dotted.declarations).toEqual(rows);
  }, 600_000);

  itIfGoplsAvailable(
    "asks a widened module for one exact name and reports no cap on the answer it found",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-gosym-"));
      const module = bulkModule(tmp);
      const manager = freshManager();
      try {
        const result = await askModule(manager, "Bulk001", module.root);
        expect(result.isError, textOf(result)).toBeFalsy();
        const payload = payloadOf(result);

        expect(payload.scope.lookup).toBe("workspace-symbol");
        expect(payload.scope.limits).toEqual(["one-module", "one-port"]);
        expect(payload.declarations).toHaveLength(1);
        expect(payload.declarations[0]).toMatchObject({ name: "Bulk001", container: ".", external: false });
        expect(String(payload.declarations[0]?.signature)).toMatch(/func Bulk001\(\) int/);
      } finally {
        manager.disposeAll();
        await removeTree(tmp);
      }
    },
    900_000,
  );

  itIfGoplsAvailable(
    "gopls's own symbol list stops at the count this server treats as its watermark",
    async () => {
      // The executable pin of `WORKSPACE_SYMBOL_CAP_WATERMARK`. Two queries that each match all 150 of the
      // widened module's `Bulk` declarations are asked of one warmed session: equal counts are the cap's
      // signature, and the number is gopls's, not this server's choice. A count that is not the watermark
      // means the constant is wrong — this test names the numbers it saw rather than bending to them.
      //
      // `awaitWorkspaceReady` waits for a proof only a started child can send, so the child is reached
      // first the way the tool reaches it: one transient outline read of a file in the module.
      const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-gosymbulk-"));
      const module = bulkModule(tmp);
      const manager = freshManager();
      try {
        const session = manager.get(module.root, goplsConfig);
        await session.documentSymbolTransient(module.file);
        await session.refreshModuleSnapshot();
        expect(await session.awaitWorkspaceReady(CALL_BUDGET_MS)).toBe("ready");

        const counts: number[] = [];
        for (const query of ["bl", "uk"]) {
          const entries = await session.request<unknown[]>("workspace/symbol", { query });
          expect(Array.isArray(entries), `gopls answered "${query}" with ${typeof entries}`).toBe(true);
          counts.push(entries.length);
        }
        const [first, second] = counts;
        expect(first, `two overflowing queries returned ${first} and ${second}`).toBe(second);
        expect(
          first,
          `gopls stopped at ${first} entries while WORKSPACE_SYMBOL_CAP_WATERMARK is ${WORKSPACE_SYMBOL_CAP_WATERMARK}`,
        ).toBe(WORKSPACE_SYMBOL_CAP_WATERMARK);
      } finally {
        manager.disposeAll();
        await removeTree(tmp);
      }
    },
    900_000,
  );
});
