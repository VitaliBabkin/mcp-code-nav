import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import type { OutlineSymbol } from "../../src/clangd/outline.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runGoFileSymbols } from "../../src/tools/go-file-symbols.js";
import { lineOf as fixtureLineOf } from "../helpers/fixture-text.js";
import { itIfGoplsAvailable } from "../helpers/go-live.js";
import { payloadOf, resultView } from "../helpers/tool-result.js";

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "go-module");
const storageFile = join(moduleRoot, "storage.go");
/** The 1-based line the fixture declares `needle` on, so the assertions track the fixture, not a snapshot. */
const lineOf = (needle: string): number => fixtureLineOf(storageFile, needle);

function findByName(symbols: OutlineSymbol[], name: string): OutlineSymbol | undefined {
  for (const symbol of symbols) {
    if (symbol.name === name) return symbol;
    const nested = symbol.children ? findByName(symbol.children, name) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

async function outline(depth: number, timeBudgetMs: number) {
  // A new manager per call: every assertion below is about a session's FIRST call.
  const manager = new LspSessionManager();
  try {
    return await runGoFileSymbols(manager, {
      sourceRoots: [moduleRoot],
      file: storageFile,
      depth,
      timeBudgetMs,
    });
  } finally {
    manager.disposeAll();
  }
}

function symbolsOf(result: Awaited<ReturnType<typeof outline>>): OutlineSymbol[] {
  expect(
    resultView(result).isError,
    `go_file_symbols failed: ${result.content[0]?.text}`,
  ).toBeFalsy();
  return payloadOf(result).symbols;
}

/**
 * Live-binary regression for the claim about gopls: its
 * `documentSymbol` is serialised behind the initial package load yet is never premature or partial, so
 * the FIRST call of a fresh session must already answer completely — no warm-up retry, no cold-empty
 * state, no second chance. Mocked fakes cannot show this: a fake answers `documentSymbol` whenever the
 * test asks it to. Runs the real `gopls` against `test/fixtures/go-module` (excluded from `npm test`,
 * run via `npm run test:live`; see CONTRIBUTING.md).
 */
describe("go_file_symbols against a real gopls binary", () => {
  itIfGoplsAvailable(
    "names the interface, its methods, the struct satisfying it implicitly and that struct's method, on the first call",
    async () => {
      const symbols = symbolsOf(await outline(1, 180_000));

      const storage = findByName(symbols, "Storage");
      expect(
        storage,
        `expected a "Storage" interface in: ${JSON.stringify(symbols)}`,
      ).toMatchObject({
        kind: "interface",
        range: { startLine: lineOf("type Storage interface") },
      });
      expect(storage?.children?.some((child) => child.name === "Get")).toBe(true);

      expect(findByName(symbols, "MemoryStorage")?.kind).toBe("struct");
      const getter = symbols.find(
        (symbol) => symbol.kind === "method" && symbol.name.endsWith("Get"),
      );
      expect(
        getter,
        `expected a top-level method for Get in: ${JSON.stringify(symbols)}`,
      ).toBeDefined();
      expect(getter?.range.startLine).toBe(lineOf("func (m *MemoryStorage) Get"));
      expect(findByName(symbols, "Default")?.kind).toBe("function");
    },
    300_000,
  );

  itIfGoplsAvailable(
    "keeps depth plainly at the top level when depth is 0, on the first call of a fresh session",
    async () => {
      const symbols = symbolsOf(await outline(0, 180_000));
      const storage = findByName(symbols, "Storage");
      expect(storage).toBeDefined();
      expect(storage?.children).toBeUndefined();
      expect(
        symbols.some((symbol) => symbol.kind === "method" && symbol.name.endsWith("Get")),
      ).toBe(true);
    },
    300_000,
  );
});
