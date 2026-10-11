import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OutlineSymbol } from "../../src/clangd/outline.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runGoFileSymbols } from "../../src/tools/go-file-symbols.js";

// gopls is optional on this host in exactly the way clangd is, so the suite skips rather than failing
// with the symptom it is meant to detect. `MCP_CODE_NAV_GOPLS` overrides, as it does at runtime.
function isGoplsAvailable(): boolean {
  try {
    execFileSync(process.env.MCP_CODE_NAV_GOPLS ?? "gopls", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const itIfGoplsAvailable = isGoplsAvailable() ? it : it.skip;

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "go-module");
const storageFile = join(moduleRoot, "storage.go");
const sourceLines = readFileSync(storageFile, "utf-8").split(/\r?\n/);

/** The 1-based line the fixture declares `needle` on, so the assertions track the fixture, not a snapshot. */
function lineOf(needle: string): number {
  const index = sourceLines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer declares "${needle}"`);
  return index + 1;
}

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
  expect(result.isError, `go_file_symbols failed: ${result.content[0]?.text}`).toBeFalsy();
  return (result.structuredContent as { symbols: OutlineSymbol[] }).symbols;
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
      expect(storage, `expected a "Storage" interface in: ${JSON.stringify(symbols)}`).toMatchObject({
        kind: "interface",
        range: { startLine: lineOf("type Storage interface") },
      });
      expect(storage?.children?.some((child) => child.name === "Get")).toBe(true);

      expect(findByName(symbols, "MemoryStorage")?.kind).toBe("struct");
      const getter = symbols.find((symbol) => symbol.kind === "method" && symbol.name.endsWith("Get"));
      expect(getter, `expected a top-level method for Get in: ${JSON.stringify(symbols)}`).toBeDefined();
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
      expect(symbols.some((symbol) => symbol.kind === "method" && symbol.name.endsWith("Get"))).toBe(true);
    },
    300_000,
  );
});
