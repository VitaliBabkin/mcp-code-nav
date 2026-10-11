import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clangdConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { toOutline, type OutlineSymbol } from "../../src/clangd/outline.js";

function findByName(symbols: OutlineSymbol[], name: string): OutlineSymbol | undefined {
  for (const s of symbols) {
    if (s.name === name) return s;
    if (s.children) {
      const found = findByName(s.children, name);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Live-binary regression for the namespace/depth-budget bug: every mocked `toOutline` test hand-
 * writes its own `DocumentSymbol` tree, which never proves clangd actually nests a namespace-
 * wrapped class the way the fix assumes. Spawns the real `clangd` binary (excluded from `npm test`,
 * run via `npm run test:live`; see CONTRIBUTING.md).
 */
describe("cpp_file_symbols outline against a real clangd binary", () => {
  let projectRoot: string;
  let session: LspSession;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-outline-live-"));
    writeFileSync(
      join(projectRoot, "widget.h"),
      [
        "namespace gizmo {",
        "namespace connector {",
        "class Widget {",
        "public:",
        "  void bar();",
        "};",
        "} // namespace connector",
        "} // namespace gizmo",
        "",
      ].join("\n"),
    );
    writeFileSync(join(projectRoot, "widget.cpp"), '#include "widget.h"\n');
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: "clang++ -std=c++17 -c widget.cpp -o widget.o", file: "widget.cpp" },
      ]),
    );
    session = new LspSession({ root: projectRoot, config: clangdConfig });
  });

  afterEach(async () => {
    // Guards the case where beforeEach threw before `session` was assigned (e.g. mkdtempSync
    // failed) — dispose() is synchronous, so no await is needed here.
    session?.dispose();
    // `child.kill()` doesn't wait for the process to actually exit — on Windows, `projectRoot` is
    // the clangd child's cwd, so the OS keeps it handle-locked for a moment after dispose() returns.
    // rmSync's own built-in maxRetries doesn't cover this (the lock is on the directory itself, not
    // a file inside it), so retry with a real event-loop delay to let the process actually exit.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
        return;
      } catch (e) {
        if (attempt >= 9) throw e;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  });

  it(
    "at the default depth, reaches through nested namespaces to the class and its immediate member",
    async () => {
      const file = join(projectRoot, "widget.h");
      // The cold/warm split means the first response on a fresh clangd process
      // may legitimately need one retry before the index is confirmed warm.
      let result = await session.documentSymbol(file);
      if (result.state !== "ok") {
        result = await session.documentSymbol(file);
      }
      expect(result.state).toBe("ok");
      if (result.state !== "ok") return;

      const outline = toOutline(result.symbols, 1);
      const widget = findByName(outline, "Widget");
      expect(widget, `expected a "Widget" class in the outline, got: ${JSON.stringify(outline)}`).toMatchObject({
        name: "Widget",
        kind: "class",
      });
      expect(widget?.children?.some((c) => c.name === "bar" && c.kind === "method")).toBe(true);
    },
    30000,
  );
});
