import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collapseLineBreaks } from "../helpers/markdown.js";
import { flattenOutline } from "../../src/clangd/outline.js";
import { textDocumentId } from "../../src/lsp/document-uri.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { LspSession } from "../../src/lsp/session.js";
import { clangdConfig } from "../../src/lsp/server-config.js";
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
 * 1-based lines: `///` doc comment on 3, `class Widget {` on 4, the method's doc comment on 6,
 * `void paint(int passes);` on 7, and an undocumented `class Bare {};` on 10.
 */
const HEADER = [
  "namespace gizmo {",
  "",
  "/// Draws the frame and keeps its geometry.",
  "class Widget {",
  "public:",
  "  /// The one entry point.",
  "  void paint(int passes);",
  "};",
  "",
  "class Bare {};",
  "",
  "}  // namespace gizmo",
  "",
].join("\n");

/** The out-of-line definition, which clangd reports as one entry named by its full qualified text. */
const SOURCE = '#include "widget.h"\n\nvoid gizmo::Widget::paint(int passes) {\n  (void)passes;\n}\n';

interface HoverPayload {
  name: string;
  kind: string;
  file: string;
  range: { startLine: number; endLine: number };
  signature?: string;
  documentation?: string;
  descriptionUnavailable?: string;
}

const textOf = (result: { content: readonly { text?: string }[] }): string => result.content[0]?.text ?? "";

const payloadOf = (result: { structuredContent?: unknown; isError?: boolean }): HoverPayload => {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as HoverPayload;
};

/**
 * Live-binary suite for what `cpp_find_symbol` says a declaration IS, read from a real
 * clangd's `textDocument/hover` at the position a real outline named for the declaration's own identifier.
 * None of this is reachable from a hand-written `DocumentSymbol` tree — whether clangd answers a hover at
 * all, what format it answers in, how it spells an out-of-line definition, and which column it will
 * resolve are facts about the binary, not about this server's reading of them.
 */
describe("cpp_find_symbol's hover description against a real clangd binary", () => {
  let projectRoot: string;
  let headerFile: string;
  let sourceFile: string;
  const managers: LspSessionManager[] = [];
  const sessions: LspSession[] = [];

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-hover-live-"));
    headerFile = join(projectRoot, "widget.h");
    sourceFile = join(projectRoot, "widget.cpp");
    writeFileSync(headerFile, HEADER);
    writeFileSync(sourceFile, SOURCE);
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
    // The clangd child's cwd is the project root, so Windows keeps the directory handle locked briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
        return;
      } catch {
        if (attempt >= 9) throw new Error(`could not remove ${projectRoot}`);
        await new Promise((done) => setTimeout(done, 300));
      }
    }
  });

  function freshManager(): LspSessionManager {
    const manager = new LspSessionManager();
    managers.push(manager);
    return manager;
  }

  /** A session with no tool in front of it, for the requests only these cases need to make directly. */
  function bareSession(): LspSession {
    const session = new LspSession({ root: projectRoot, config: clangdConfig });
    sessions.push(session);
    return session;
  }

  /** clangd's answer at one position, exactly as it arrives. */
  async function rawHover(session: LspSession, file: string, line: number, character: number): Promise<unknown> {
    await session.documentSymbol(file);
    return session.request<unknown>("textDocument/hover", {
      textDocument: textDocumentId(file),
      position: { line, character },
    });
  }

  const outlineOf = async (session: LspSession, file: string) => {
    const result = await session.documentSymbol(file);
    return result.state === "ok" ? flattenOutline(result.symbols) : [];
  };

  itIfClangd("describes a class declared in a header the compile database names no entry for", async () => {
    const found = payloadOf(await runCppFindSymbol(freshManager(), { projectRoot, name: "Widget", file: "widget.h" }));

    expect(found).toMatchObject({ name: "gizmo::Widget", kind: "class", file: headerFile, range: { startLine: 4 } });
    // Verbatim, because the shape is the finding: clangd renders a class's own declaration as a markdown
    // HEADING (`### class `Widget``) and keeps only its in-context rendering in a fenced block, so the code
    // block this server reads as the signature is that rendering and the prose beside it carries clangd's
    // own layout line. Nothing here is reordered or guessed to make the answer read tidier.
    expect(found.signature).toBe("// In namespace gizmo\nclass Widget {}");
    // Line breaks are collapsed on both sides: clangd 18 separates the parts with a hard break, later releases with a blank line.
    expect(collapseLineBreaks(found.documentation)).toBe(
      collapseLineBreaks(
        "### class `Widget`\n\n---\nSize: 1 byte, alignment 1 byte\n\nDraws the frame and keeps its geometry.\n\n---",
      ),
    );
    expect(found.descriptionUnavailable).toBeUndefined();
  }, 30_000);

  itIfClangd("reads the signature out of the code block and leaves no fence in the documentation", async () => {
    const session = bareSession();
    const answer = (await rawHover(session, headerFile, 3, 6)) as {
      contents: { kind: string; value: string };
    };

    expect(answer.contents.kind).toBe("markdown");
    const found = payloadOf(await runCppFindSymbol(freshManager(), { projectRoot, name: "Widget", file: "widget.h" }));
    expect(found.signature).not.toContain("```");
    expect(found.documentation).not.toContain("```");
  }, 30_000);

  itIfClangd("gives a declaration nobody documented a signature, and invents no doc comment for it", async () => {
    const found = payloadOf(await runCppFindSymbol(freshManager(), { projectRoot, name: "Bare", file: "widget.h" }));

    expect(found).toMatchObject({ name: "gizmo::Bare", kind: "class", file: headerFile, range: { startLine: 10 } });
    expect(found.signature).toContain("class Bare");
    expect(found.descriptionUnavailable).toBeUndefined();
    // clangd's own hover carries a layout line for a class, so a declaration with no doc comment still has
    // prose beside its code block. What must not appear is a fence leaking into the prose.
    expect(found.documentation ?? "").not.toContain("```");
  }, 30_000);

  itIfClangd("describes a method declared inside the class, at its own name", async () => {
    const found = payloadOf(
      await runCppFindSymbol(freshManager(), { projectRoot, name: "Widget::paint", file: "widget.h" }),
    );

    expect(found).toMatchObject({ name: "gizmo::Widget::paint", kind: "method", file: headerFile, range: { startLine: 7 } });
    expect(found.signature).toContain("paint(int passes)");
    expect(found.documentation).toContain("The one entry point.");
    expect(found.descriptionUnavailable).toBeUndefined();
  }, 30_000);

  itIfClangd("carries the identifier's own position out of a real outline, for an out-of-line definition", async () => {
    const session = bareSession();
    const outline = await outlineOf(session, sourceFile);
    const definition = outline[0];
    const answer = (await rawHover(session, sourceFile, 2, 20)) as { contents: { value: string } };

    // clangd reports an out-of-line definition as ONE top-level entry whose single name segment already
    // holds the qualified text, and its `selectionRange` is the `paint` identifier inside that text —
    // 0-based line 2, character 20 — not the `void` keyword at column 0 that `range` starts on.
    expect(outline).toEqual([
      {
        qualifiedPath: ["gizmo::Widget::paint"],
        name: "gizmo::Widget::paint",
        kind: "method",
        range: { startLine: 3, endLine: 5 },
        namePosition: { line: 2, character: 20 },
      },
    ]);
    expect(definition?.name).toBe("gizmo::Widget::paint");
    expect(answer.contents.value).toContain("paint(int passes)");
  }, 30_000);

  itIfClangd("resolves a name spelled either way to the declaring header, and describes that", async () => {
    // Neither spelling reaches the definition row above: the matcher compares `::`-split query segments
    // against outline path segments, and the definition's single segment contains `::`, so it matches no
    // query. What the caller gets is the requirements's answer — the declaring header — described
    // from the header's own identifier.
    const bare = payloadOf(await runCppFindSymbol(freshManager(), { projectRoot, name: "paint", file: "widget.cpp" }));
    const qualified = payloadOf(
      await runCppFindSymbol(freshManager(), { projectRoot, name: "gizmo::Widget::paint", file: "widget.cpp" }),
    );

    for (const found of [bare, qualified]) {
      expect(found).toMatchObject({ name: "gizmo::Widget::paint", kind: "method", file: headerFile, range: { startLine: 7 } });
      expect(found.signature).toContain("paint(int passes)");
      expect(found.descriptionUnavailable).toBeUndefined();
    }
  }, 30_000);

  itIfClangd("describes what the unscoped branch found among the files the session opened", async () => {
    const manager = freshManager();
    await runCppFileSymbols(manager, { projectRoot, file: "widget.h", depth: 1 });
    const found = payloadOf(await runCppFindSymbol(manager, { projectRoot, name: "Widget" }));

    expect(found).toMatchObject({ name: "gizmo::Widget", kind: "class", file: headerFile });
    expect(found.signature).toContain("class Widget");
    expect(found.descriptionUnavailable).toBeUndefined();
  }, 30_000);

  itIfClangd("asks about a keyword or an identifier alike, and says which token it resolved", async () => {
    const session = bareSession();
    const identifier = (await rawHover(session, headerFile, 3, 6)) as { contents: unknown; range: unknown };
    const keyword = (await rawHover(session, headerFile, 3, 0)) as { contents: unknown; range: unknown };

    // Unlike gopls, which answers `no identifier found` one column off the name, clangd resolves the
    // enclosing declaration from either column and answers the same text; the token it landed on is what
    // `hover.range` reports. The rule to ask at the identifier still holds — it is what the answer is
    // about, and it is the position that stays right for a server that does check.
    expect(keyword.contents).toEqual(identifier.contents);
    expect(identifier.range).toEqual({ start: { line: 3, character: 6 }, end: { line: 3, character: 12 } });
    expect(keyword.range).toEqual({ start: { line: 3, character: 0 }, end: { line: 3, character: 5 } });
  }, 30_000);

  itIfClangd("cannot be asked about a document the client never opened, which is why the read holds it", async () => {
    const session = bareSession();
    expect(session.getOpenedFiles()).toEqual([]);

    await expect(
      session.request<unknown>("textDocument/hover", {
        textDocument: textDocumentId(headerFile),
        position: { line: 3, character: 6 },
      }),
    ).rejects.toThrow(/trying to get AST for non-added document/);

    // The tool's own route holds the document by reading its outline first, so the hover it sends has a
    // buffer to answer from and the answer above is a description of what it does not have to work around.
    const found = payloadOf(await runCppFindSymbol(freshManager(), { projectRoot, name: "Widget", file: "widget.h" }));
    expect(found.signature).toContain("class Widget");
  }, 30_000);
});
