import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";
import { CLANGD_SYMBOL_CAP_WATERMARK } from "../../src/tools/cpp-navigation-shared.js";
import type { LspSessionManager } from "../../src/lsp/session-manager.js";
import { fakeProcessByFile, fakeProcessByFileAndIndex, sessionsFor, sym, symAt } from "../helpers/fake-clangd.js";
import { fakeServer, pathOfDocumentId, uriOf, type FakeServer } from "../helpers/fake-lsp.js";
import { fileUri } from "../../src/lsp/document-uri.js";

/**
 * One `SymbolInformation` row as a real clangd spells it (pinned in
 * `test/clangd/workspace-symbol.live.test.ts`): the bare identifier in `name`, the declaration's own scope in
 * `containerName`, and a `location.range` that is the identifier's span rather than the declaration's line.
 */
function symbolRow(
  name: string,
  kind: number,
  file: string,
  line: number,
  character: number,
  container?: string,
) {
  return {
    name,
    kind,
    ...(container === undefined ? {} : { containerName: container }),
    location: {
      uri: fileUri(file),
      range: { start: { line, character }, end: { line, character: character + name.length } },
    },
  };
}


describe("runCppFindSymbol", () => {
  let projectRoot: string;
  let cppFile: string;
  let headerFile: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fs-"));
    cppFile = join(projectRoot, "widget.cpp");
    headerFile = join(projectRoot, "widget.h");
    writeFileSync(cppFile, "#include \"widget.h\"\nvoid Widget::method() {}\n");
    writeFileSync(headerFile, "class Widget { void method(); };\n");
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, file: "widget.cpp" }]),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns a unique match found directly in the given file", async () => {
    const sessions = sessionsFor(fakeProcessByFile((file) => (file === cppFile ? [sym("method", 12)] : [])));
    // Warm the session first so the direct query below is a confident (not cold) result.
    await runCppFileSymbols(sessions, { projectRoot, file: "widget.cpp", depth: 1 });
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "method", file: "widget.cpp" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ name: "method", kind: "function", file: cppFile });
  });

  it("falls back to the declaring header when the .cpp file has no direct match", async () => {
    const sessions = sessionsFor(
      fakeProcessByFile((file) => {
        if (file === headerFile) return [sym("Widget", 5), sym("method", 6)];
        return [];
      }),
    );
    // Warm the session via the header first.
    await runCppFileSymbols(sessions, { projectRoot, file: "widget.h", depth: 1 });
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "method", file: "widget.cpp" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ name: "method", kind: "method", file: headerFile });
  });

  it("reports ambiguity when a bare name matches more than one candidate", async () => {
    const sessions = sessionsFor(
      fakeProcessByFile((file) => (file === cppFile ? [sym("method", 12), sym("method", 12)] : [])),
    );
    await runCppFileSymbols(sessions, { projectRoot, file: "widget.cpp", depth: 1 });
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "method", file: "widget.cpp" });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("ambiguous");
  });

  it("reports no match when neither the file nor its header counterpart has the symbol", async () => {
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    await runCppFileSymbols(sessions, { projectRoot, file: "widget.cpp", depth: 1 });
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "doesNotExist", file: "widget.cpp" });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("no symbol");
  });

  it("asks clangd's index when no file is given and the session has opened nothing", async () => {
    const sessions = sessionsFor(
      fakeProcessByFileAndIndex(
        () => [],
        () => [symbolRow("Widget", 5, headerFile, 4, 6, "gizmo")],
      ),
    );
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "Widget" });

    expect(out.isError, out.content[0]?.text ?? "").toBeFalsy();
    expect(out.structuredContent).toMatchObject({ name: "gizmo::Widget", kind: "class", file: headerFile });
    // The refusal is gone. An unscoped question whose opened outlines say nothing is asked of the
    // index clangd already keeps, and the answer then states the boundary it came from.
    expect(out.content[0]?.text).not.toContain("no `file` given");
  });

  it("searches previously-opened files when no file is given", async () => {
    const sessions = sessionsFor(fakeProcessByFile((file) => (file === cppFile ? [sym("method", 12)] : [])));
    await runCppFileSymbols(sessions, { projectRoot, file: "widget.cpp", depth: 1 });
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "method" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ file: cppFile });
  });

  it("rejects a file that escapes projectRoot", async () => {
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "method", file: "../outside.cpp" });
    expect(out.isError).toBe(true);
  });

  it("defaults an unqualified class/constructor ambiguity to the class", async () => {
    const sessions = sessionsFor(
      fakeProcessByFile((file) => (file === headerFile ? [sym("Widget", 5), sym("Widget", 9)] : [])),
    );
    await runCppFileSymbols(sessions, { projectRoot, file: "widget.h", depth: 1 });
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "Widget", file: "widget.h" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ name: "Widget", kind: "class" });
  });

  it("selects the constructor explicitly via the kind filter", async () => {
    const sessions = sessionsFor(
      fakeProcessByFile((file) => (file === headerFile ? [sym("Widget", 5), sym("Widget", 9)] : [])),
    );
    await runCppFileSymbols(sessions, { projectRoot, file: "widget.h", depth: 1 });
    const out = await runCppFindSymbol(sessions, {
      projectRoot,
      name: "Widget",
      file: "widget.h",
      kind: "constructor",
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ name: "Widget", kind: "constructor" });
  });
});

describe("runCppFindSymbol with sourceRoots (out-of-tree build layout)", () => {
  let buildRoot: string;
  let sourceRoot: string;
  let sourceCppFile: string;

  beforeEach(() => {
    buildRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fs-build-"));
    sourceRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fs-src-"));
    sourceCppFile = join(sourceRoot, "widget.cpp");
    writeFileSync(sourceCppFile, "class Widget { void method(); };\n");
    writeFileSync(
      join(buildRoot, "compile_commands.json"),
      JSON.stringify([{ directory: sourceRoot, file: "widget.cpp" }]),
    );
  });

  afterEach(() => {
    rmSync(buildRoot, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("finds a symbol in a file resolved under a declared sourceRoots entry", async () => {
    const sessions = sessionsFor(fakeProcessByFile((file) => (file === sourceCppFile ? [sym("method", 6)] : [])));
    const out = await runCppFindSymbol(sessions, {
      projectRoot: buildRoot,
      name: "method",
      file: sourceCppFile,
      sourceRoots: [sourceRoot],
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ name: "method", file: sourceCppFile });
  });

  it("still rejects a file outside every declared root, naming all of them", async () => {
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const elsewhere = mkdtempSync(join(tmpdir(), "mcp-code-nav-fs-elsewhere-"));
    try {
      const out = await runCppFindSymbol(sessions, {
        projectRoot: buildRoot,
        name: "method",
        file: join(elsewhere, "x.cpp"),
        sourceRoots: [sourceRoot],
      });
      expect(out.isError).toBe(true);
      expect(out.content[0]?.text).toContain(buildRoot);
      expect(out.content[0]?.text).toContain(sourceRoot);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("matches an ignoredPaths pattern computed relative to the sourceRoots entry that actually contained the file", async () => {
    writeFileSync(join(buildRoot, "mcp-code-nav.config.json"), JSON.stringify({ ignoredPaths: ["widget.cpp"] }));
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const out = await runCppFindSymbol(sessions, {
      projectRoot: buildRoot,
      name: "method",
      file: sourceCppFile,
      sourceRoots: [sourceRoot],
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("ignoredPaths");
  });
});

/** One answer's payload, as far as these cases care: the location plus what the hover said. */
type SymbolPayload = {
  name: string;
  kind: string;
  file: string;
  range: { startLine: number; endLine: number };
  signature?: string;
  documentation?: string;
  descriptionUnavailable?: string;
};

/** clangd's own shape for a declaration: the signature in a fenced block, the doc comment as prose. */
function hoverOf(signature: string, documentation: string): unknown {
  return { contents: { kind: "markdown", value: "```cpp\n" + signature + "\n```\n\n" + documentation } };
}

describe("runCppFindSymbol's description of the declaration it found", () => {
  let projectRoot: string;
  let cppFile: string;
  let headerFile: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-fs-hover-"));
    cppFile = join(projectRoot, "widget.cpp");
    headerFile = join(projectRoot, "widget.h");
    writeFileSync(cppFile, '#include "widget.h"\nvoid Widget::method() {}\n');
    writeFileSync(headerFile, "class Widget {\n  void method();\n};\n");
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([{ directory: projectRoot, command: "clang++ -c widget.cpp", file: "widget.cpp" }]),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** A clangd that answers both questions per file, and records every request the session sent. */
  function clangd(answering: (method: string, file: string | undefined, params: unknown) => unknown) {
    const server = fakeServer({ respond: (method, params) => answering(method, pathOfDocumentId(params), params) });
    return { server, sessions: sessionsFor(server.process) };
  }

  const payload = (result: { structuredContent?: unknown }): SymbolPayload =>
    result.structuredContent as SymbolPayload;

  const methodsAsked = (server: ReturnType<typeof fakeServer>): string[] => server.requests.map(([method]) => method);

  it("asks about the name and not the keyword: the hover position is selectionRange.start", async () => {
    // `class Widget` on 0-based line 4: the range starts at the keyword (column 0), the name at column 6.
    const widget = symAt("Widget", 5, 4, 6);
    const { server, sessions } = clangd((method, file) =>
      method === "textDocument/documentSymbol" && file === headerFile ? [widget] : [],
    );
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "Widget", file: "widget.h" });

    const hover = server.requests.find(([method]) => method === "textDocument/hover");
    expect(hover?.[1]).toMatchObject({ textDocument: { uri: uriOf(headerFile) }, position: { line: 4, character: 6 } });
    expect(hover?.[1]).not.toMatchObject({ position: { character: 0 } });
  });

  it("returns the signature from the code block and the documentation from the prose beside it", async () => {
    const { sessions } = clangd((method, file) =>
      method === "textDocument/documentSymbol" && file === headerFile
        ? [symAt("Widget", 5, 4, 6)]
        : hoverOf("class Widget", "Draws the frame."));
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "Widget", file: "widget.h" });

    expect(out.isError).toBeFalsy();
    const found = payload(out);
    expect(found).toMatchObject({ name: "Widget", kind: "class", file: headerFile, range: { startLine: 5, endLine: 6 } });
    expect(found.signature).toBe("class Widget");
    expect(found.documentation).toBe("Draws the frame.");
    expect(found.descriptionUnavailable).toBeUndefined();
  });

  it("never guesses a position: an entry that named none keeps its location and says why it has no description", async () => {
    const { server, sessions } = clangd((method, file) =>
      method === "textDocument/documentSymbol" && file === headerFile ? [sym("Widget", 5)] : hoverOf("x", "y"));
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "Widget", file: "widget.h" });

    expect(out.isError).toBeFalsy();
    const found = payload(out);
    expect(found.name).toBe("Widget");
    expect(found.signature).toBeUndefined();
    expect(found.descriptionUnavailable).toMatch(/clangd named no position for "Widget" in/);
    expect(found.descriptionUnavailable).toMatch(/guessed location/);
    expect(methodsAsked(server)).not.toContain("textDocument/hover");
  });

  it("a hover clangd refuses costs the description, never the answer", async () => {
    const { sessions } = clangd((method, file) => {
      if (method === "textDocument/documentSymbol") return file === headerFile ? [symAt("Widget", 5, 4, 6)] : [];
      if (method === "textDocument/hover") throw new Error("clangd exploded");
      return {};
    });
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "Widget", file: "widget.h" });

    expect(out.isError).toBeFalsy();
    const found = payload(out);
    expect(found.file).toBe(headerFile);
    expect(found.signature).toBeUndefined();
    expect(found.descriptionUnavailable).toBe("clangd refused the hover: clangd exploded");
  });

  it("a hover that answers nothing this server can read names what arrived", async () => {
    const { sessions } = clangd((method, file) =>
      method === "textDocument/documentSymbol" && file === headerFile ? [symAt("Widget", 5, 4, 6)] : null);
    const found = payload(await runCppFindSymbol(sessions, { projectRoot, name: "Widget", file: "widget.h" }));

    expect(found.name).toBe("Widget");
    expect(found.descriptionUnavailable).toMatch(/the hover answer carried nothing/);
  });

  it("a hover with no code block is documentation and never a guessed signature", async () => {
    // What clangd answers when its client has not said it reads markdown: the declaration, its layout info
    // and the doc comment in one string, with nothing in it saying which part is the signature.
    const { sessions } = clangd((method, file) => {
      if (method === "textDocument/documentSymbol") return file === headerFile ? [symAt("Widget", 5, 4, 6)] : [];
      return { contents: { kind: "plaintext", value: "class Widget\n\nSize: 1 byte, alignment 1 byte" } };
    });
    const found = payload(await runCppFindSymbol(sessions, { projectRoot, name: "Widget", file: "widget.h" }));

    expect(found.signature).toBeUndefined();
    expect(found.documentation).toBe("class Widget\n\nSize: 1 byte, alignment 1 byte");
    expect(found.descriptionUnavailable).toBeUndefined();
  });

  it("describes the declaring header when the .cpp file's own outline has no match", async () => {
    const { server, sessions } = clangd((method, file) => {
      if (method !== "textDocument/documentSymbol") return hoverOf("void method()", "Draws nothing.");
      if (file !== headerFile) return [];
      return [{ ...symAt("Widget", 5, 0, 6), children: [symAt("method", 6, 1, 8)] }];
    });
    // Warming on the header is also what makes the .cpp read answer "empty" and not "cold-empty", which
    // is the difference between falling back to the header and failing on the file it was asked about.
    await runCppFileSymbols(sessions, { projectRoot, file: "widget.h", depth: 1 });
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "Widget::method", file: "widget.cpp" });

    expect(out.isError).toBeFalsy();
    const found = payload(out);
    expect(found.file).toBe(headerFile);
    expect(found.signature).toBe("void method()");
    const hover = server.requests.find(([requestMethod]) => requestMethod === "textDocument/hover");
    expect(hover?.[1]).toMatchObject({ textDocument: { uri: uriOf(headerFile) }, position: { line: 1, character: 8 } });
  });

  it("describes what the unscoped branch found among the opened files", async () => {
    const { sessions } = clangd((method, file) => {
      if (method !== "textDocument/documentSymbol") return hoverOf("void Widget::method()", "Called by the test.");
      return file === cppFile ? [symAt("method", 6, 1, 13)] : [];
    });
    await runCppFileSymbols(sessions, { projectRoot, file: "widget.cpp", depth: 1 });
    const found = payload(await runCppFindSymbol(sessions, { projectRoot, name: "method" }));

    expect(found.file).toBe(cppFile);
    expect(found.signature).toBe("void Widget::method()");
  });

  it("holds nothing new open and closes nothing it already held", async () => {
    const { server, sessions } = clangd((method, file) =>
      method === "textDocument/documentSymbol" && file === headerFile ? [symAt("Widget", 5, 4, 6)] : hoverOf("class Widget", "Docs."));
    await runCppFindSymbol(sessions, { projectRoot, name: "Widget", file: "widget.h" });

    const opened = server.notifications.filter(([method]) => method === "textDocument/didOpen");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.[1]).toMatchObject({ textDocument: { uri: uriOf(headerFile), languageId: "cpp" } });
    expect(methodsAsked(server)).toContain("textDocument/hover");
    expect(server.notifications.map(([method]) => method)).not.toContain("textDocument/didClose");
  });

  it("asks no hover for an ambiguity it refuses to resolve", async () => {
    const { server, sessions } = clangd((method, file) =>
      method === "textDocument/documentSymbol" && file === headerFile
        ? [symAt("method", 6, 1, 8), symAt("method", 6, 8, 8)]
        : hoverOf("void method()", "Two of them."));
    const out = await runCppFindSymbol(sessions, { projectRoot, name: "method", file: "widget.h" });

    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("ambiguous");
    expect(methodsAsked(server)).not.toContain("textDocument/hover");
  });
});

/**
 * Mocked suite for `cpp_find_symbol` without `file`, answered by clangd's project-wide symbol
 * index once the session's own opened outlines have said nothing. The rules these cases hold the code to are
 * that the branch is a superset rather than a replacement (the opened outlines still answer first, and a name
 * unique among them never reaches the index), that clangd's fuzzy rows are narrowed to exact name equality by
 * the same matcher a file's outline is narrowed by, that the promise is still one declaring location or a
 * refusal that lists every candidate, and that the answer says what its index could not see — `scope`, present
 * only when the index answered, whose presence is itself that signal.
 */
describe("cpp_find_symbol without `file`, answered by clangd's index", () => {
  let tmp: string;
  let buildDir: string;
  let sourceDir: string;
  let outsideDir: string;
  let header: string;
  let elsewhere: string;
  let rows: () => unknown;
  let server: FakeServer;
  let sessions: LspSessionManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-symb-unit-"));
    buildDir = join(tmp, "build");
    sourceDir = join(tmp, "src");
    outsideDir = join(tmp, "outside");
    mkdirSync(buildDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    header = join(sourceDir, "widget.h");
    elsewhere = join(outsideDir, "elsewhere.cpp");
    writeFileSync(header, "namespace gizmo {\nclass Widget {\npublic:\n  int paint(int passes);\n};\n}\n");
    writeFileSync(elsewhere, "int elsewhere() { return 0; }\n");
    writeFileSync(
      join(buildDir, "compile_commands.json"),
      JSON.stringify([{ directory: sourceDir, command: `clang++ -c "${header}"`, file: header }]),
    );
    rows = () => [symbolRow("Widget", 5, header, 1, 6, "gizmo")];
    start();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function clangd(): FakeServer {
    return fakeServer({
      respond: (method, params) => {
        if (method === "initialize") return {};
        if (method === "workspace/symbol") return rows();
        if (method === "textDocument/documentSymbol") {
          return pathOfDocumentId(params) === header ? [symAt("Widget", 5, 1, 6)] : [];
        }
        if (method === "textDocument/hover") {
          return { contents: { kind: "markdown", value: "```cpp\n// In namespace gizmo\nclass Widget {}\n```" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });
  }

  function start(): void {
    server = clangd();
    sessions = sessionsFor(server.process);
  }

  const asked = (name: string, extra: Record<string, unknown> = {}) =>
    runCppFindSymbol(sessions, {
      projectRoot: buildDir,
      name,
      sourceRoots: [sourceDir],
      ...extra,
    } as never);

  const text = (result: { content: readonly { text?: string }[] }): string => result.content[0]?.text ?? "";

  const payload = (result: { structuredContent?: unknown; isError?: boolean }): Record<string, unknown> => {
    expect(result.isError, text(result as never)).toBeFalsy();
    return result.structuredContent as Record<string, unknown>;
  };

  const scopeOf = (result: { structuredContent?: unknown; isError?: boolean }): Record<string, unknown> =>
    payload(result).scope as Record<string, unknown>;

  /** A round clangd began and settled, so an empty answer may honestly be reported as an absence. */
  async function settledRound(): Promise<void> {
    await asked("warm-up");
    await server.createProgress("idx");
    server.sendProgress("idx", { kind: "begin" });
    server.sendProgress("idx", { kind: "end" });
  }

  it("answers from the index and states the boundary the answer came from", async () => {
    const found = payload(await asked("Widget"));

    expect(found).toMatchObject({ name: "gizmo::Widget", kind: "class", file: header, range: { startLine: 2 } });
    // The row's `location.range.start` is the identifier's own position, so the description arrived and the
    // keyword was never asked about.
    expect(found.signature).toBe("// In namespace gizmo\nclass Widget {}");
    const scope = found.scope as { index: Record<string, unknown>; limits: string[] };
    expect(Object.keys(scope).sort()).toEqual(["index", "limits", "projectRoot", "sourceRoots", "uncoveredSources"]);
    expect(scope.index.driftUnknown).toMatch(/first index-backed answer over/);
    expect(scope.limits).toEqual([
      "compile-database-only",
      "index-state-unknown",
      "index-drift-unknown",
    ]);
  });

  it("keeps a name unique among the opened files an outline answer, with no index claim beside it", async () => {
    // The superset rule in both directions: the opened set still wins, so a name that is unique
    // there answers exactly as it did before the branch existed — even though the index also holds it.
    await runCppFileSymbols(sessions, { projectRoot: buildDir, file: header, depth: 1, sourceRoots: [sourceDir] } as never);
    rows = () => [symbolRow("Widget", 5, elsewhere, 0, 4)];

    const found = payload(await asked("Widget"));

    expect(found.file).toBe(header);
    expect(found.scope).toBeUndefined();
    expect(server.requests.some(([method]) => method === "workspace/symbol")).toBe(false);
  });

  it("narrows clangd's fuzzy rows to the exact name before any of them counts", async () => {
    rows = () => [
      symbolRow("WidgetFactory", 5, header, 1, 6, "gizmo"),
      symbolRow("Widget", 5, header, 1, 6, "gizmo"),
    ];

    const found = payload(await asked("Widget"));

    expect(found).toMatchObject({ name: "gizmo::Widget", kind: "class" });
  });

  it("reads a qualified query out of a row's own scope text", async () => {
    rows = () => [
      symbolRow("paint", 12, elsewhere, 0, 4),
      symbolRow("paint", 6, header, 3, 6, "gizmo::Widget"),
    ];

    const found = payload(await asked("Widget::paint"));

    // `paint` alone is ambiguous between the two rows, so this query only answers because the row's
    // `containerName` is part of the name the matcher compares.
    expect(found).toMatchObject({ name: "gizmo::Widget::paint", kind: "method", file: header, range: { startLine: 4 } });
  });

  it("keeps several exact rows the ambiguity refusal it always was, listing them", async () => {
    rows = () => [
      symbolRow("paint", 12, elsewhere, 0, 4),
      symbolRow("paint", 6, header, 3, 6, "gizmo::Widget"),
    ];

    const failed = await asked("paint");

    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("is ambiguous in clangd's index for");
    expect(text(failed)).toMatch(/gizmo::Widget::paint \(method\) at .*widget\.h:4/);
    // Widening what is searched is no licence to widen what is returned: no hover was asked, because no
    // declaration was chosen.
    expect(server.requests.some(([method]) => method === "textDocument/hover")).toBe(false);
  });

  it("refuses a row that names a place but not what kind of thing is there", async () => {
    // A kindless row is not a declaration with an unknown label: `cpp_find_symbol` promises a kind, `cpp_find_callers`
    // refuses by kind, and a row that cannot say what it is cannot be tested against either. It fails the way
    // an unreadable row does rather than arriving as a declaration of kind "?".
    rows = () => [
      { name: "Widget", location: { uri: fileUri(header), range: { start: { line: 1, character: 6 }, end: { line: 1, character: 12 } } } },
    ];

    const failed = await asked("Widget");

    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain('clangd answered the project-wide symbol search for "Widget" with entry 1');
    expect(text(failed)).toContain("possibly dropping a declaration");
    expect(text(failed)).not.toContain('"?"');
  });

  it("answers a quiescent index's silence as the exact-match refusal, naming what was searched", async () => {
    rows = () => [];
    await settledRound();

    const failed = await asked("Gone");

    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain(`no declaration named "Gone" was found in clangd's index for "${buildDir}"`);
    expect(text(failed)).toContain("The match is exact, not fuzzy");
    // A refusal carries no `scope`, so the boundary the silence rests on has to be in its words: the compile
    // database's, not the caller's declared roots — and a row found outside those roots is reported.
    expect(text(failed)).toContain("this project's `compile_commands.json` names");
    expect(text(failed)).toContain("holds declarations this call cannot see");
    expect(text(failed)).toContain("not bounded by your declared source roots");
    expect(text(failed)).not.toContain("not reportable");
  });

  it("refuses an empty index answer while clangd never reported any progress, and says that is why", async () => {
    rows = () => [];

    const failed = await asked("Gone");

    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("is not reportable as an answer");
    expect(text(failed)).toContain("never reported indexing progress to this session");
  });

  it("says a declaration may have been ranked out when the raw list reached this server's watermark", async () => {
    const noise = Array.from({ length: CLANGD_SYMBOL_CAP_WATERMARK }, (_, index) =>
      symbolRow(`Widget${index}`, 5, header, index, 6, "gizmo"),
    );
    rows = () => noise;
    await settledRound();

    const failed = await asked("Widget");

    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("may have been ranked out of it before the exact-name filter ran");
  });

  it("carries `listing-capped` beside an answer that came from a list at the watermark", async () => {
    const noise = Array.from({ length: CLANGD_SYMBOL_CAP_WATERMARK - 1 }, (_, index) =>
      symbolRow(`Widget${index}`, 5, header, index, 6, "gizmo"),
    );
    rows = () => [...noise, symbolRow("Widget", 5, header, 1, 6, "gizmo")];

    const found = scopeOf(await asked("Widget"));

    expect((found.limits as string[])).toContain("listing-capped");
  });

  it("reports a row outside every declared source root and does not open it to describe it", async () => {
    rows = () => [symbolRow("Widget", 5, elsewhere, 0, 4)];

    const found = payload(await asked("Widget"));

    expect(found).toMatchObject({ file: elsewhere, range: { startLine: 1 } });
    expect(found.descriptionUnavailable).toMatch(/outside every declared source root/);
    const opened = server.requests.filter(([method]) => method === "textDocument/hover");
    expect(opened).toEqual([]);
  });

  it("refuses an answer whose rows it cannot read rather than searching a shorter list", async () => {
    rows = () => [{ name: "Widget", kind: 5 }];

    const failed = await asked("Widget");

    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain('clangd answered the project-wide symbol search for "Widget" with entry 1');
    expect(text(failed)).toContain("possibly dropping a declaration");
  });

  it("asks nothing of the index when a `file` is given", async () => {
    const found = payload(await asked("Widget", { file: header }));

    expect(found.file).toBe(header);
    expect(found.scope).toBeUndefined();
    expect(server.requests.some(([method]) => method === "workspace/symbol")).toBe(false);
  });
});

