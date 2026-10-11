import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import type { ClangQueryExecFn } from "../../src/clang-query/find-derived-classes.js";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { classifyError } from "../../src/call-log/error-class.js";
import { fileUri } from "../../src/lsp/document-uri.js";
import type { LspProcess } from "../../src/lsp/process.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";
import { runCppFindCallers } from "../../src/tools/cpp-find-callers.js";
import { runCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";
import { runCppFindReferences } from "../../src/tools/cpp-find-references.js";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { noopServerHandlers, sessionsFor, symAt } from "../helpers/fake-clangd.js";
import { fakeServer, pathOfDocumentId } from "../helpers/fake-lsp.js";

// How each C++ handler applies the source-root rules: an omitted `sourceRoots` becomes the source tree the
// compile database names, every `scope` / `sweep` states it, and a path failure names the fix. clangd and
// clang-query are faked; the trees, the compile databases and the drift and fingerprint walks are real.

interface Result {
  readonly isError?: boolean;
  readonly content: readonly { readonly text?: string }[];
  readonly structuredContent?: unknown;
}

const textOf = (result: Result): string => result.content[0]?.text ?? "";
const structured = <T>(result: Result): T => {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as T;
};

/** `<base>/repo/{src,build/preset}` with a database naming `src`, and `<base>/other` beside the repository. */
interface Layout {
  readonly base: string;
  readonly repo: string;
  readonly src: string;
  readonly build: string;
  readonly widget: string;
  readonly helper: string;
  readonly other: string;
  readonly otherFile: string;
}

const layouts: string[] = [];

function makeLayout(database: "src" | "invalid" | "docker" = "src"): Layout {
  const base = mkdtempSync(join(tmpdir(), "mcp-code-nav-roots-"));
  layouts.push(base);
  const repo = join(base, "repo");
  const src = join(repo, "src");
  const build = join(repo, "build", "preset");
  const other = join(base, "other");
  for (const dir of [src, build, other]) mkdirSync(dir, { recursive: true });
  const widget = join(src, "widget.cpp");
  const helper = join(src, "helper.cpp");
  const otherFile = join(other, "x.cpp");
  writeFileSync(widget, "class Widget {\npublic:\n  int value();\n};\n");
  writeFileSync(helper, "int helper(Widget w) {\n  return w.value();\n}\n");
  writeFileSync(otherFile, "int x() { return 0; }\n");
  const entries = (dir: string, files: readonly string[]) =>
    files.map((file) => ({ directory: dir, command: `clang++ -c "${file}"`, file }));
  const databases = {
    src: JSON.stringify(entries(src, [widget, helper])),
    invalid: "{ not json",
    docker: JSON.stringify(entries("/docker-work/src", ["/docker-work/src/widget.cpp"])),
  };
  writeFileSync(join(build, "compile_commands.json"), databases[database]);
  return { base, repo, src, build, widget, helper, other, otherFile };
}

afterEach(() => {
  for (const dir of layouts.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const derivedBlock = (layout: Layout, tusOutsideRoots = 0) => ({
  origin: "derived",
  roots: [layout.repo],
  tusOutsideRoots,
});

describe("cpp_file_symbols", () => {
  const widgetOutline: LspDocumentSymbol[] = [
    { name: "Widget", kind: 5, range: { start: { line: 0 }, end: { line: 0 } } },
  ];

  function sessionsAnswering(outline: () => LspDocumentSymbol[] | null): LspSessionManager {
    const process: LspProcess = {
      connection: {
        sendRequest: vi.fn(async (method: string) => {
          if (method === "initialize") return {};
          if (method === "textDocument/documentSymbol") return outline();
          throw new Error(`unexpected request: ${method}`);
        }),
        sendNotification: vi.fn(async () => {}),
        ...noopServerHandlers(),
      } as unknown as LspProcess["connection"],
      isAlive: () => true,
      kill: () => {},
      spawnFailure: () => undefined,
    };
    return new LspSessionManager({ spawn: () => process, sleep: async () => {} });
  }

  const outline = { symbols: [{ name: "Widget", kind: "class", range: { startLine: 1, endLine: 1 } }] };

  it("outlines an absolute file in the source tree beside the build directory when sourceRoots is omitted", async () => {
    const layout = makeLayout();
    const sessions = sessionsAnswering(() => widgetOutline);

    const result = await runCppFileSymbols(sessions, { projectRoot: layout.build, file: layout.widget, depth: 1 } as never);

    expect(structured(result)).toEqual(outline);
  });

  it("resolves a relative path under the derived root", async () => {
    const layout = makeLayout();
    const sessions = sessionsAnswering(() => widgetOutline);

    const result = await runCppFileSymbols(sessions, { projectRoot: layout.build, file: "src/widget.cpp", depth: 1 } as never);

    expect(structured(result)).toEqual(outline);
  });

  it("refuses a file outside the derived root, naming it and the way out, still classed path-escape", async () => {
    const layout = makeLayout();
    const sessions = sessionsAnswering(() => widgetOutline);

    const result = await runCppFileSymbols(sessions, { projectRoot: layout.build, file: layout.otherFile, depth: 1 } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `cpp_file_symbols failed: path "${layout.otherFile}" escapes every declared root: "${layout.build}", ` +
        `"${layout.repo}" "${layout.repo}" was derived from compile_commands.json because sourceRoots was omitted; ` +
        "to read a file outside it, pass that file's source tree as sourceRoots.",
    );
    expect(classifyError(textOf(result)).errorClass).toBe("path-escape");
  });

  it("derives nothing from a declared list, and says so", async () => {
    const layout = makeLayout();
    const sessions = sessionsAnswering(() => widgetOutline);

    const result = await runCppFileSymbols(sessions, {
      projectRoot: layout.build,
      file: layout.widget,
      sourceRoots: [layout.other],
      depth: 1,
    } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `cpp_file_symbols failed: path "${layout.widget}" escapes every declared root: "${layout.build}", ` +
        `"${layout.other}" To read a file outside these roots, add its source tree to sourceRoots.`,
    );
  });

  it("outlines a file under projectRoot when the database is invalid JSON, with no derived root", async () => {
    const layout = makeLayout("invalid");
    const inside = join(layout.build, "a.cpp");
    writeFileSync(inside, "class Widget {};\n");
    const sessions = sessionsAnswering(() => widgetOutline);

    const result = await runCppFileSymbols(sessions, { projectRoot: layout.build, file: inside, depth: 1 } as never);

    expect(structured(result)).toEqual(outline);
  });

  it("suggests the source tree when only projectRoot was a root", async () => {
    const layout = makeLayout("invalid");
    const sessions = sessionsAnswering(() => widgetOutline);

    const result = await runCppFileSymbols(sessions, { projectRoot: layout.build, file: layout.widget, depth: 1 } as never);

    expect(textOf(result)).toBe(
      `cpp_file_symbols failed: path "${layout.widget}" escapes every declared root: "${layout.build}"` +
        " Only projectRoot was a root, and an out-of-tree build keeps its sources outside it: pass the source tree " +
        `as sourceRoots, e.g. sourceRoots: [${JSON.stringify(layout.repo)}].`,
    );
  });

  it("names the search boundary for a missing file when only projectRoot was a root", async () => {
    const layout = makeLayout("invalid");
    const sessions = sessionsAnswering(() => widgetOutline);

    const result = await runCppFileSymbols(sessions, { projectRoot: layout.build, file: "missing.cpp", depth: 1 } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cpp_file_symbols failed: ENOENT");
    expect(textOf(result).endsWith(
      " Only projectRoot was searched; if the file lives in a source tree outside it, pass that tree as sourceRoots.",
    )).toBe(true);
    expect(classifyError(textOf(result)).errorClass).toBe("file-not-found");
  });

  it("adds no such sentence for a missing file under a derived root", async () => {
    const layout = makeLayout();
    const sessions = sessionsAnswering(() => widgetOutline);

    const result = await runCppFileSymbols(sessions, { projectRoot: layout.build, file: "missing.cpp", depth: 1 } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Resolved \"missing.cpp\"");
    expect(textOf(result)).not.toContain("Only projectRoot was searched");
  });
});

/** A clangd answering every question the three index tools ask, over one repository. */
function clangdFor(layout: Layout) {
  const nameAt = (file: string, line: number, character: number, length: number) => ({
    uri: fileUri(file),
    range: { start: { line, character }, end: { line, character: character + length } },
  });
  const range = (startLine: number, endLine: number) => ({
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: 40 },
  });
  const helperItem = {
    name: "helper",
    kind: 12,
    uri: fileUri(layout.helper),
    range: range(0, 2),
    selectionRange: range(0, 0),
  };
  return fakeServer({
    refusesUnaddedDocuments: true,
    respond: (method, params) => {
      if (method === "initialize") return {};
      const file = pathOfDocumentId(params);
      if (method === "textDocument/documentSymbol") {
        if (file === layout.widget) {
          return [{ ...symAt("Widget", 5, 0, 6), range: range(0, 3), children: [symAt("value", 6, 2, 6)] }];
        }
        if (file === layout.helper) return [{ ...symAt("helper", 12, 0, 4), range: range(0, 2) }];
        return [symAt("x", 12, 0, 4)];
      }
      if (method === "textDocument/hover") return null;
      if (method === "workspace/symbol") {
        const query = (params as { query: string }).query;
        return query === "helper"
          ? [{ name: "helper", kind: 12, location: nameAt(layout.helper, 0, 4, 6) }]
          : [{ name: "Widget", kind: 5, location: nameAt(layout.widget, 0, 6, 6) }];
      }
      if (method === "textDocument/references") return [nameAt(layout.helper, 0, 13, 6)];
      if (method === "textDocument/prepareCallHierarchy") return [helperItem];
      if (method === "callHierarchy/incomingCalls") {
        return [{ from: { ...helperItem, name: "caller", range: range(1, 2), selectionRange: range(1, 1) }, fromRanges: [range(1, 1)] }];
      }
      throw new Error(`unexpected request: ${method}`);
    },
  });
}

interface Scope {
  readonly projectRoot: string;
  readonly sourceRoots: unknown;
  readonly index: unknown;
  readonly uncoveredSources?: { count: number; files: readonly string[] };
  readonly uncoveredSourcesUnavailable?: string;
  readonly limits: string[];
}

describe("cpp_find_symbol, the index branch", () => {
  it("states a derived root directly after projectRoot, and reads the declaration inside it as inside", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindSymbol(sessions, { projectRoot: layout.build, name: "Widget" } as never);
    const payload = structured<{ scope: Scope; descriptionUnavailable?: string }>(result);

    expect(Object.keys(payload.scope).slice(0, 3)).toEqual(["projectRoot", "sourceRoots", "index"]);
    expect(payload.scope.sourceRoots).toEqual(derivedBlock(layout));
    expect(payload.descriptionUnavailable ?? "").not.toContain("outside every declared source root");
  });

  it("states a declared list as declared, and derives nothing", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindSymbol(sessions, {
      projectRoot: layout.build,
      name: "Widget",
      sourceRoots: [layout.src],
    } as never);

    expect(structured<{ scope: Scope }>(result).scope.sourceRoots).toEqual({ origin: "declared", roots: [layout.src] });
  });

  it("states projectRoot alone, with the reason, when the database names no ancestor's sources", async () => {
    const layout = makeLayout("docker");
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindSymbol(sessions, { projectRoot: layout.build, name: "Widget" } as never);
    const payload = structured<{ scope: Scope; descriptionUnavailable?: string }>(result);

    expect(payload.scope.sourceRoots).toEqual({
      origin: "project-root-only",
      roots: [],
      reason: "no-ancestor-holds-sources",
    });
    expect(payload.descriptionUnavailable).toContain("outside every declared source root");
  });

  it("computes uncoveredSources from the derived root instead of reporting no-source-roots", async () => {
    const layout = makeLayout();
    writeFileSync(join(layout.src, "unlisted.cpp"), "int unlisted() { return 0; }\n");
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindSymbol(sessions, { projectRoot: layout.build, name: "Widget" } as never);
    const { scope } = structured<{ scope: Scope }>(result);

    expect(scope.uncoveredSourcesUnavailable).toBeUndefined();
    expect(scope.uncoveredSources?.files).toEqual([join(layout.src, "unlisted.cpp")]);
    expect(scope.limits).toContain("uncovered-sources-present");
  });

  it("answers a file in the source tree, which escaped projectRoot before", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindSymbol(sessions, {
      projectRoot: layout.build,
      name: "Widget",
      file: layout.widget,
    } as never);

    expect(structured<{ file: string }>(result).file).toBe(layout.widget);
  });

  it("names the way out when the file is outside the derived root", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindSymbol(sessions, {
      projectRoot: layout.build,
      name: "x",
      file: layout.otherFile,
    } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`"${layout.repo}" was derived from compile_commands.json`);
    expect(classifyError(textOf(result)).errorClass).toBe("path-escape");
  });

  it("names the search boundary for a missing file when only projectRoot was a root", async () => {
    const layout = makeLayout("invalid");
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindSymbol(sessions, {
      projectRoot: layout.build,
      name: "x",
      file: "missing.cpp",
    } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result).endsWith("pass that tree as sourceRoots.")).toBe(true);
    expect(textOf(result)).toContain("Only projectRoot was searched");
  });
});

describe("cpp_find_references", () => {
  it("names a use in the derived tree instead of reporting it external, and states the root", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindReferences(sessions, { projectRoot: layout.build, name: "Widget" } as never);
    const payload = structured<{ files: { file: string; external: boolean }[]; scope: Scope }>(result);

    expect(payload.files).toEqual([expect.objectContaining({ file: layout.helper, external: false })]);
    expect(Object.keys(payload.scope).slice(0, 2)).toEqual(["projectRoot", "sourceRoots"]);
    expect(payload.scope.sourceRoots).toEqual(derivedBlock(layout));
    expect(payload.scope.uncoveredSourcesUnavailable).toBeUndefined();
  });

  it("names the derived root and the way out for a file beyond it, still classed path-escape", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindReferences(sessions, {
      projectRoot: layout.build,
      name: "x",
      file: layout.otherFile,
    } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`"${layout.repo}" was derived from compile_commands.json`);
    expect(classifyError(textOf(result)).errorClass).toBe("path-escape");
  });

  it("refuses a subject declared beyond projectRoot when only projectRoot is a root", async () => {
    const layout = makeLayout("docker");
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindReferences(sessions, { projectRoot: layout.build, name: "Widget" } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("outside every declared source root");
  });

  it("states a declared list as declared", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindReferences(sessions, {
      projectRoot: layout.build,
      name: "Widget",
      sourceRoots: [layout.src],
    } as never);

    expect(structured<{ scope: Scope }>(result).scope.sourceRoots).toEqual({ origin: "declared", roots: [layout.src] });
  });
});

describe("cpp_find_callers", () => {
  it("names a caller in the derived tree and states the root directly after projectRoot", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindCallers(sessions, { projectRoot: layout.build, name: "helper" } as never);
    const payload = structured<{ callers: { file: string; external: boolean }[]; scope: Scope }>(result);

    expect(payload.callers).toEqual([expect.objectContaining({ file: layout.helper, external: false })]);
    expect(Object.keys(payload.scope).slice(0, 2)).toEqual(["projectRoot", "sourceRoots"]);
    expect(payload.scope.sourceRoots).toEqual(derivedBlock(layout));
  });

  it("names the derived root and the way out for a file beyond it, still classed path-escape", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindCallers(sessions, {
      projectRoot: layout.build,
      name: "x",
      file: layout.otherFile,
    } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`"${layout.repo}" was derived from compile_commands.json`);
    expect(classifyError(textOf(result)).errorClass).toBe("path-escape");
  });

  it("states a declared list as declared", async () => {
    const layout = makeLayout();
    const sessions = sessionsFor(clangdFor(layout).process);

    const result = await runCppFindCallers(sessions, {
      projectRoot: layout.build,
      name: "helper",
      sourceRoots: [layout.src],
    } as never);

    expect(structured<{ scope: Scope }>(result).scope.sourceRoots).toEqual({ origin: "declared", roots: [layout.src] });
  });
});

describe("cpp_find_derived_classes", () => {
  const clean: ClangQueryExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const run = (input: Record<string, unknown>, exec: ClangQueryExecFn = clean) =>
    runCppFindDerivedClasses({ exec, cache: new SweepCache() }, { qualifiedName: "Base", ...input } as never);

  interface Sweep {
    readonly cache: string;
    readonly sourceRoots: unknown;
    readonly uncoveredSources?: { count: number; files: readonly string[] };
    readonly uncoveredSourcesUnavailable?: string;
  }
  const sweepOf = (result: Result): Sweep => structured<{ sweep: Sweep }>(result).sweep;

  it("states the derived root in sweep, directly before the blind-spot key, and computes it", async () => {
    const layout = makeLayout();
    writeFileSync(join(layout.src, "unlisted.cpp"), "class Unlisted {};\n");

    const sweep = sweepOf(await run({ projectRoot: layout.build }));

    expect(sweep.sourceRoots).toEqual(derivedBlock(layout));
    const keys = Object.keys(sweep);
    expect(keys[keys.indexOf("sourceRoots") + 1]).toBe("uncoveredSources");
    expect(sweep.uncoveredSources?.files).toEqual([join(layout.src, "unlisted.cpp")]);
  });

  it("fingerprints the derived root: a source edit there changes the cache key", async () => {
    const layout = makeLayout();
    const cache = new SweepCache();
    const runCached = () =>
      runCppFindDerivedClasses({ exec: clean, cache }, { qualifiedName: "Base", projectRoot: layout.build } as never);
    expect(sweepOf(await runCached()).cache).toBe("miss");
    expect(sweepOf(await runCached()).cache).toBe("hit");

    writeFileSync(layout.widget, "class Widget { int changed; };\n");

    expect(sweepOf(await runCached()).cache).toBe("miss");
  });

  it("states projectRoot alone, with the reason, for a database no ancestor's sources match", async () => {
    const layout = makeLayout("docker");

    const sweep = sweepOf(await run({ projectRoot: layout.build }));

    expect(sweep.sourceRoots).toEqual({
      origin: "project-root-only",
      roots: [],
      reason: "no-ancestor-holds-sources",
    });
    expect(sweep.uncoveredSourcesUnavailable).toBe("no-source-roots");
    const keys = Object.keys(sweep);
    expect(keys[keys.indexOf("sourceRoots") + 1]).toBe("uncoveredSourcesUnavailable");
  });

  it("states a declared list as declared", async () => {
    const layout = makeLayout();

    const sweep = sweepOf(await run({ projectRoot: layout.build, sourceRoots: [layout.src] }));

    expect(sweep.sourceRoots).toEqual({ origin: "declared", roots: [layout.src] });
  });

  it("resolves a relative `files` entry under the derived root", async () => {
    const layout = makeLayout();
    const seen: string[] = [];
    const exec: ClangQueryExecFn = async (args) => {
      seen.push(args[2] as string);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await run({ projectRoot: layout.build, files: ["src/widget.cpp"] }, exec);

    expect(seen).toEqual([layout.widget]);
    expect(sweepOf(result).sourceRoots).toEqual(derivedBlock(layout));
  });

  it("sweeps a scoped call over an invalid-JSON database, deriving no root", async () => {
    const layout = makeLayout("invalid");
    const inside = join(layout.build, "a.cpp");
    writeFileSync(inside, "class A {};\n");

    const sweep = sweepOf(await run({ projectRoot: layout.build, files: [inside] }));

    expect(sweep.sourceRoots).toEqual({ origin: "project-root-only", roots: [], reason: "compile-db-unlistable" });
  });

  it("names the derived root and the way out for a `files` entry beyond it", async () => {
    const layout = makeLayout();

    const result = await run({ projectRoot: layout.build, files: [layout.otherFile] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `cpp_find_derived_classes failed: path "${layout.otherFile}" escapes every declared root: ` +
        `"${layout.build}", "${layout.repo}" "${layout.repo}" was derived from compile_commands.json because ` +
        "sourceRoots was omitted; to read a file outside it, pass that file's source tree as sourceRoots.",
    );
  });

  it("suggests the source tree when the database could not be listed and the file is beyond projectRoot", async () => {
    const layout = makeLayout("invalid");

    const result = await run({ projectRoot: layout.build, files: [layout.widget] });

    expect(textOf(result).endsWith(`pass the source tree as sourceRoots, e.g. sourceRoots: [${JSON.stringify(layout.repo)}].`)).toBe(true);
    expect(classifyError(textOf(result)).errorClass).toBe("path-escape");
  });

  it("keeps the unscoped call's failure on an invalid database", async () => {
    const layout = makeLayout("invalid");

    const result = await run({ projectRoot: layout.build });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is not valid JSON");
  });
});
