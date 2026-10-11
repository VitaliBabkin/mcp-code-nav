import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { textDocumentId } from "../../src/lsp/document-uri.js";
import { LspSession } from "../../src/lsp/session.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { clangdConfig } from "../../src/lsp/server-config.js";
import { CLANGD_SYMBOL_CAP_WATERMARK } from "../../src/tools/cpp-navigation-shared.js";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";

// clangd is optional on this host in exactly the way gopls is, so the suite skips rather than failing with
// the symptom it exists to detect. `MCP_CODE_NAV_CLANGD` overrides, as it does at runtime.
function isClangdAvailable(): boolean {
  try {
    execFileSync(process.env.MCP_CODE_NAV_CLANGD ?? "clangd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const itIfClangd = isClangdAvailable() ? it : it.skip;

/**
 * `cpp_find_symbol` without `file` has a place to look beyond the opened files: clangd's
 * project-wide symbol index. What that answer is made of is a fact about the binary, and the mocked suites
 * can only read rows this server wrote for itself — so the spelling of a row, the size at which clangd stops
 * returning them, and what a session that has parsed nothing yet answer are, are pinned here.
 *
 * 1-based lines as written below.
 */
const WIDGET_H = [
  "#pragma once", //                       1
  "", //                                  2
  "namespace gizmo {", //                  3
  "", //                                  4
  "/// Draws the frame.", //               5
  "class Widget {", //                     6
  "public:", //                            7
  "  /// The one entry point.", //         8
  "  int paint(int passes);", //           9
  "};", //                                10
  "", //                                 11
  "int paint(int passes);", //            12
  "", //                                 13
  "}  // namespace gizmo", //             14
  "", //                                 15
].join("\n");

/** The out-of-line definition, and a free function sharing the method's bare name. */
const WIDGET_CPP = [
  '#include "widget.h"', //                        1
  "", //                                         2
  "int gizmo::Widget::paint(int passes) {", //    3
  "  return passes;", //                          4
  "}", //                                         5
  "", //                                         6
  "int gizmo::paint(int passes) {", //            7
  "  return passes + 1;", //                      8
  "}", //                                         9
  "", //                                        10
].join("\n");

/** `count` classes, written into the header so one opened document puts all of them in front of the index. */
function bulkHeader(count: number): string {
  return ["#pragma once", "", ...Array.from({ length: count }, (_, index) => `class Bulk${index} {};`), ""].join("\n");
}

const sleep = async (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface SymbolRow {
  name?: string;
  kind?: number;
  containerName?: string;
  location?: { uri?: string; range?: { start?: { line?: number; character?: number } } };
}

const baseOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** `name|kind|in scope|file:line:column`, which is the whole of what a row claims. */
function rowText(root: string, raw: unknown): string {
  const row = raw as SymbolRow;
  const start = row.location?.range?.start;
  const file = baseOf((row.location?.uri ?? "").replace(`file:///${root.replace(/\\/g, "/").toLowerCase().replace(/^\//, "")}/`, "") || "");
  return `${row.name}|${row.kind}|${row.containerName ?? "-"}|${file}:${(start?.line ?? -1) + 1}:${start?.character ?? "-"}`;
}

const rowsFor = (root: string, result: unknown): string[] =>
  (result as readonly unknown[]).map((raw) => rowText(root, raw));

describe("clangd's project-wide symbol search, and the branch that reads it", () => {
  let tmp: string;
  let projectRoot: string;
  let header: string;
  let source: string;
  const managers: LspSessionManager[] = [];
  const sessions: LspSession[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-symb-"));
    projectRoot = join(tmp, "project");
    mkdirSync(projectRoot, { recursive: true });
    header = join(projectRoot, "widget.h");
    source = join(projectRoot, "widget.cpp");
    writeFileSync(header, WIDGET_H);
    writeFileSync(source, WIDGET_CPP);
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: "clang++ -std=c++17 -c widget.cpp -o widget.o", file: "widget.cpp" },
      ]),
    );
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    while (managers.length > 0) managers.pop()?.disposeAll();
    // The clangd child's cwd is the project root, so Windows keeps that handle locked briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        return;
      } catch {
        if (attempt >= 9) throw new Error(`could not remove ${tmp}`);
        await sleep(300);
      }
    }
  });

  function freshManager(): LspSessionManager {
    const manager = new LspSessionManager();
    managers.push(manager);
    return manager;
  }

  function bareSession(): LspSession {
    const session = new LspSession({ root: projectRoot, config: clangdConfig });
    sessions.push(session);
    return session;
  }

  /** Repeats a query until clangd answers something: an index that has not caught up is not an absence. */
  async function askUntilAnswered(session: LspSession, query: string, deadlineMs = 45_000): Promise<unknown> {
    const stopAt = Date.now() + deadlineMs;
    for (;;) {
      const result = await session.request<unknown>("workspace/symbol", { query });
      if ((Array.isArray(result) ? result.length : 0) > 0 || Date.now() > stopAt) return result;
      await sleep(400);
    }
  }

  itIfClangd("spells a row by the identifier alone, with its scope beside it, at the identifier's own span", async () => {
    const session = bareSession();
    await session.documentSymbol(header);

    const widget = await askUntilAnswered(session, "Widget");
    expect(rowsFor(projectRoot, widget)).toEqual(["Widget|5|gizmo|widget.h:6:6"]);

    // Which of a method's two locations the index answers is NOT stable: measured twice on this fixture, the
    // same query returned the definitions in `widget.cpp` (line 3 and line 7) and, on a run where only the
    // header had been parsed, the declarations in `widget.h` (line 9 and line 12). What is stable is the
    // shape: the bare identifier in `name`, its scope in `containerName`, and a range over the identifier.
    const members = await askUntilAnswered(session, "paint");
    const rows = members as readonly SymbolRow[];
    expect(rows.map((row) => `${row.name}|${row.kind}|${row.containerName ?? "-"}`).sort()).toEqual(
      ["paint|12|gizmo", "paint|6|gizmo::Widget"].sort(),
    );
    // Every row's range sits on the identifier it names, in the file it names — which is what lets this
    // server hover at `location.range.start` without ever asking about a keyword.
    for (const row of rows) {
      const file = row.location?.uri?.endsWith("widget.h") ? header : source;
      const start = row.location?.range?.start;
      const line = (start?.line ?? -1) + 1;
      const text = readFileSync(file, "utf-8").split("\n")[line - 1] ?? "";
      expect(text.slice(start?.character ?? 0, (start?.character ?? 0) + "paint".length)).toBe("paint");
    }

    // A qualified query is answered by the same row, alone: clangd's own matcher reads `Class::method`.
    const qualified = await askUntilAnswered(session, "Widget::paint");
    expect((qualified as readonly SymbolRow[]).map((row) => `${row.name}|${row.kind}|${row.containerName}`)).toEqual([
      "paint|6|gizmo::Widget",
    ]);
  }, 180_000);

  itIfClangd("hovers a row's own range start into the same text as the identifier it points at", async () => {
    const session = bareSession();
    await session.documentSymbol(header);
    const rows = (await askUntilAnswered(session, "Widget")) as readonly SymbolRow[];
    const start = rows[0]?.location?.range?.start;

    const atRow = await session.withTransientDocument(header, (holding) =>
      holding.send<unknown>("textDocument/hover", {
        textDocument: textDocumentId(holding.openedAs),
        position: { line: start?.line ?? 0, character: start?.character ?? 0 },
      }),
    );
    const atKeyword = await session.withTransientDocument(header, (holding) =>
      holding.send<unknown>("textDocument/hover", {
        textDocument: textDocumentId(holding.openedAs),
        position: { line: 5, character: 0 },
      }),
    );

    // Now measured at a row's position rather than an outline's: clangd
    // answers the SAME declaration text at the identifier and at the `class` keyword, and only `hover.range`
    // says which token it landed on. So asking at the row's own range start costs nothing here, and the range
    // it returns is the identifier's span — which is the position this server records.
    expect(atRow.contents).toEqual(atKeyword.contents);
    expect(atRow.range).toEqual({ start: { line: 5, character: 6 }, end: { line: 5, character: 12 } });
    expect(atKeyword.range).toEqual({ start: { line: 5, character: 0 }, end: { line: 5, character: 5 } });
    expect(JSON.stringify(atRow.contents)).toContain("class `Widget`");
  }, 180_000);

  itIfClangd("stops its symbol list at the count this server treats as its watermark", async () => {
    const bulk = join(tmp, "bulk");
    mkdirSync(bulk, { recursive: true });
    writeFileSync(join(bulk, "bulk.h"), bulkHeader(150));
    writeFileSync(join(bulk, "bulk.cpp"), '#include "bulk.h"\n');
    writeFileSync(
      join(bulk, "compile_commands.json"),
      JSON.stringify([
        { directory: bulk, command: "clang++ -std=c++17 -c bulk.cpp -o bulk.o", file: "bulk.cpp" },
      ]),
    );
    const session = new LspSession({ root: bulk, config: clangdConfig });
    sessions.push(session);

    // Measured, in this order: a session that has caused no parse yet answers NOTHING, and opening the
    // document is what puts its declarations in front of the index. The premise — the index exists
    // and asking it builds nothing — holds only once something has been parsed, so an empty answer from a
    // session like this one must never be read as "no such symbol". The tool's own branch is pinned below;
    // this is the raw fact it rests on.
    const cold = await session.request<unknown>("workspace/symbol", { query: "Bulk" });
    expect(cold, `a session that has opened nothing answered ${JSON.stringify(cold)}`).toEqual([]);

    await session.documentSymbol(join(bulk, "bulk.h"));
    const overflowing = await askUntilAnswered(session, "Bulk");
    const rows = overflowing as readonly unknown[];

    // 150 classes match the query and exactly `CLANGD_SYMBOL_CAP_WATERMARK` rows came back: the watermark
    // sits at clangd's own cap, so `listing-capped` fires on a truncated list rather than staying silent.
    expect(rows.length).toBe(CLANGD_SYMBOL_CAP_WATERMARK);
    // Every row is one of the fixture's classes, so the count is a truncation and not a different answer.
    expect(rows.every((raw) => (raw as SymbolRow).kind === 5 && (raw as SymbolRow).name?.startsWith("Bulk"))).toBe(true);

    // And clangd's search is not a substring search: the same 150 names answer a query that only occurs
    // inside them with nothing at all. This server's exact-name filter is therefore the only matcher a
    // caller can rely on, and a fuzzy near-match is not a row the tool ever sees.
    expect(await session.request("workspace/symbol", { query: "ulk" })).toEqual([]);
  }, 180_000);

  itIfClangd("answers a name that is in no opened file from the index, and says the index answered", async () => {
    const manager = freshManager();
    // The session is shown only the translation unit, whose outline holds the out-of-line definitions and
    // no class: `Widget` exists in this session's opened files nowhere, so only the index can supply it.
    await runCppFileSymbols(manager, { projectRoot, file: "widget.cpp", depth: 2, sourceRoots: [projectRoot] });

    const out = (await runCppFindSymbol(manager, { projectRoot, name: "Widget", sourceRoots: [projectRoot] })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: readonly { text?: string }[];
    };

    expect(out.isError, out.content[0]?.text ?? "").toBeFalsy();
    expect(out.structuredContent).toMatchObject({
      name: "gizmo::Widget",
      kind: "class",
      file: header,
      range: { startLine: 6 },
    });
    const scope = out.structuredContent?.scope as { projectRoot: string; index: Record<string, unknown>; limits: string[] };
    expect(scope.projectRoot).toBe(projectRoot);
    expect(scope.limits).toContain("compile-database-only");
    // Exactly one of the two drift keys, whatever this session's history happened to be.
    expect("staleFiles" in scope.index || "driftUnknown" in scope.index).toBe(true);
  }, 180_000);

  itIfClangd("never calls a name the index has not shown it an absence it does not have to qualify", async () => {
    const manager = freshManager();
    await runCppFileSymbols(manager, { projectRoot, file: "widget.cpp", depth: 2, sourceRoots: [projectRoot] });

    const out = (await runCppFindSymbol(manager, { projectRoot, name: "Gone", sourceRoots: [projectRoot] })) as {
      isError?: boolean;
      content: readonly { text?: string }[];
    };
    const text = out.content[0]?.text ?? "";

    expect(out.isError).toBe(true);
    expect(text).toContain('no declaration named "Gone" was found');
    // Only some silences may be read as absence, so the text states which of the two it was.
    const claimsAbsence = text.includes("The match is exact, not fuzzy");
    const refusesSilence = text.includes("is not reportable as an answer");
    expect(claimsAbsence || refusesSilence, text).toBe(true);
    if (refusesSilence) expect(text).toContain("Call again once indexing has settled");
  }, 180_000);
});
