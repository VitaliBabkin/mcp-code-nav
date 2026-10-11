import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listTranslationUnits } from "../../src/clang-query/compile-db.js";
import type { ClangQueryExecFn } from "../../src/clang-query/find-derived-classes.js";
import { SweepCache } from "../../src/clang-query/sweep-cache.js";
import { classifyError, CALL_ERROR_CLASSES } from "../../src/call-log/error-class.js";
import { clangdConfig, LanguageServerUnavailableError } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";
import { runCppFindCallers } from "../../src/tools/cpp-find-callers.js";
import { runCppFindDerivedClasses } from "../../src/tools/cpp-find-derived-classes.js";
import { runCppFindReferences } from "../../src/tools/cpp-find-references.js";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { runGoFileSymbols } from "../../src/tools/go-file-symbols.js";
import { fakeProcessByFile, sessionsFor, symAt } from "../helpers/fake-clangd.js";

type Answer = { isError?: boolean; content?: { text?: string }[] };

const tempDirs: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mcp-code-nav-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function textOf(answer: Answer): string {
  const [block] = answer.content ?? [];
  return block?.text ?? "";
}

/** The head `CompileDbNotFoundError.message` is, which every hinted variant keeps byte-identical. */
const headAt = (projectRoot: string): string => `compile_commands.json not found or unreadable at "${projectRoot}"`;

/** A C++ project root holding a compile database and whatever sources the case names. */
function cppRoot(files: Record<string, string> = { "a.cpp": "class Foo {};\n" }): string {
  const root = tempRoot("err-cpp");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  writeFileSync(join(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: "a.cpp" }]));
  return root;
}

/** The class the real producer's own text lands in. */
async function classOf(answer: Promise<Answer> | Answer): Promise<string> {
  return classifyError(textOf(await answer)).errorClass;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the closed set", () => {
  it("lists the classes, `other` last", () => {
    expect(CALL_ERROR_CLASSES).toEqual([
      "compile-db-missing",
      "compile-db-invalid",
      "input-invalid",
      "tool-unknown",
      "path-escape",
      "path-ambiguous",
      "path-ignored",
      "file-not-found",
      "symbol-not-found",
      "symbol-ambiguous",
      "symbol-kind-unsupported",
      "no-module",
      "server-unavailable",
      "not-ready",
      "budget-exceeded",
      "sweep-failed",
      "session-lost",
      "other",
    ]);
    expect(new Set(CALL_ERROR_CLASSES).size).toBe(CALL_ERROR_CLASSES.length);
  });

  it("answers `other` for a text this server has never said before", () => {
    expect(classifyError("something no producer in src/ emits").errorClass).toBe("other");
  });
});

describe("what the C++ tools emit, read from the handler that emits it", () => {
  it("compile-db-missing, for every hint variant, each read from the handler that emits it", async () => {
    // Under a parent of its own: the sibling search lists that parent, which must not be the shared temp directory.
    const empty = join(tempRoot("err-nodb"), "root");
    mkdirSync(empty);
    const repo = tempRoot("err-nodb-build");
    mkdirSync(join(repo, "build"), { recursive: true });
    writeFileSync(join(repo, "build", "compile_commands.json"), "[]");
    const unreadable = tempRoot("err-nodb-dir");
    mkdirSync(join(unreadable, "compile_commands.json"));
    const absent = join(empty, "renamed-away");
    const notADirectory = join(repo, "a-file");
    writeFileSync(notADirectory, "class NotADirectory {};\n");
    const sessions = new LspSessionManager({ sleep: async () => {} });
    const sweep = { cache: new SweepCache() };

    const cases: readonly { readonly variant: string; readonly root: string; readonly prefix: string; readonly text: string }[] = [
      {
        variant: "none",
        root: empty,
        prefix: "cpp_find_symbol failed: ",
        text: textOf(await runCppFindSymbol(sessions, { projectRoot: empty, name: "Foo" })),
      },
      {
        variant: "root absent",
        root: absent,
        prefix: "cpp_find_references failed: ",
        text: textOf(await runCppFindReferences(sessions, { projectRoot: absent, name: "Foo" })),
      },
      {
        variant: "candidates",
        root: repo,
        prefix: "cpp_find_symbol failed: ",
        text: textOf(await runCppFindSymbol(sessions, { projectRoot: repo, name: "Foo" })),
      },
      {
        variant: "present but unreadable",
        root: unreadable,
        prefix: "cpp_find_callers failed: ",
        text: textOf(await runCppFindCallers(sessions, { projectRoot: unreadable, name: "Foo" })),
      },
      {
        variant: "candidates, the sweep",
        root: repo,
        prefix: "cpp_find_derived_classes failed: ",
        text: textOf(await runCppFindDerivedClasses(sweep, { projectRoot: repo, qualifiedName: "Base" })),
      },
      {
        variant: "present but unreadable, the sweep",
        root: unreadable,
        prefix: "cpp_find_derived_classes failed: ",
        text: textOf(await runCppFindDerivedClasses(sweep, { projectRoot: unreadable, qualifiedName: "Base" })),
      },
      {
        variant: "root could not be listed",
        root: notADirectory,
        prefix: "cpp_find_callers failed: ",
        text: textOf(await runCppFindCallers(sessions, { projectRoot: notADirectory, name: "Foo" })),
      },
    ];

    for (const one of cases) {
      const tail = one.text.slice(one.prefix.length + headAt(one.root).length);
      expect(classifyError(one.text).errorClass, `${one.variant}: ${one.text}`).toBe("compile-db-missing");
      // The head stays byte-identical and is a verbatim prefix of every variant, with or without the tool's
      // own name in front of it — which is what the anchor matches on, and what a consumer matching the head
      // still matches.
      expect(one.text.startsWith(one.prefix + headAt(one.root)), `${one.variant}: ${one.text}`).toBe(true);
      expect(tail.startsWith(". "), `${one.variant}: ${one.text}`).toBe(true);
    }
    // The four variants, plus the one text a search that could not read the root is allowed to state.
    expect(new Set(cases.map((one) => one.text.slice(one.prefix.length))).size).toBe(5);

    // The sweep's prefix plus the head is 86 characters, so the folded `errorHead` of that refusal is cut at
    // its 80-char bound. The class comes from the whole text, which is why the cut costs the table nothing.
    expect(classifyError(cases[4]!.text).errorHead).toHaveLength(80);

    expect(cases[0]!.text).toBe(
      `${cases[0]!.prefix}${headAt(empty)}. No directory under it holds one (searched 1 directories to depth 3). ` +
        "projectRoot must be the directory that holds compile_commands.json, from a native build on this host.",
    );
    expect(cases[1]!.text).toBe(`${cases[1]!.prefix}${headAt(absent)}. That directory does not exist.`);
    expect(cases[2]!.text).toBe(
      `${cases[2]!.prefix}${headAt(repo)}. Directories under it that hold a compile_commands.json, ` +
        `nearest first: "${join(repo, "build")}". Pass one of them as projectRoot.`,
    );
    expect(cases[3]!.text).toBe(`${cases[3]!.prefix}${headAt(unreadable)}. The file is present but could not be read.`);
    expect(cases[6]!.text.startsWith(`${cases[6]!.prefix}${headAt(notADirectory)}. That directory's own listing could not be read (`)).toBe(true);
    // Which errno said so is platform-specific; what the text must never do is claim nothing holds one. The
    // sibling `build` beside the file holds a database naming no directory of this host.
    expect(
      cases[6]!.text.endsWith(
        "), so nothing below it was searched. Skipped 1 sibling compile_commands.json naming paths that do not exist on this host.",
      ),
    ).toBe(true);
    expect(cases[6]!.text).not.toContain("No directory under it holds one");
  });

  it("compile-db-invalid, from the reader that parses the database, keeps no path in its head", () => {
    const root = cppRoot();
    writeFileSync(join(root, "compile_commands.json"), "{ not json");

    const message = (() => {
      try {
        return listTranslationUnits(root) && "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(classifyError(message).errorClass).toBe("compile-db-invalid");
    expect(classifyError(message).errorHead).toBe("… is not valid JSON");
  });

  it("path-escape, from the resolver that refuses it before any disk access", async () => {
    const root = cppRoot();
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const out = runCppFileSymbols(sessions, { projectRoot: root, file: "../outside.cpp", depth: 1 });

    await expect(classOf(out)).resolves.toBe("path-escape");
  });

  it("path-ambiguous, from the same resolver when two roots hold the file", async () => {
    const root = cppRoot({ "a.cpp": "class Foo {};\n", "dup.cpp": "class Here {};\n" });
    const other = tempRoot("err-ambig");
    writeFileSync(join(other, "dup.cpp"), "class There {};\n");

    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const out = runCppFileSymbols(sessions, {
      projectRoot: root,
      file: "dup.cpp",
      sourceRoots: [other],
      depth: 1,
    });

    await expect(classOf(out)).resolves.toBe("path-ambiguous");
  });

  it("path-ignored, from the config check that runs before the file is opened", async () => {
    const root = cppRoot();
    writeFileSync(join(root, "mcp-code-nav.config.json"), JSON.stringify({ ignoredPaths: ["a.cpp"] }));
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const out = runCppFileSymbols(sessions, { projectRoot: root, file: "a.cpp", depth: 1 });

    await expect(classOf(out)).resolves.toBe("path-ignored");
  });

  it("file-not-found, from the read a missing file actually fails", async () => {
    const root = cppRoot();
    const sessions = sessionsFor(fakeProcessByFile(() => [symAt("Foo", 5, 0, 6)]));
    const out = runCppFileSymbols(sessions, { projectRoot: root, file: "missing.cpp", depth: 1 });

    await expect(classOf(out)).resolves.toBe("file-not-found");
  });

  it("not-ready, from the cold empty clangd has not earned the right to call an answer", async () => {
    const root = cppRoot();
    const sessions = sessionsFor(fakeProcessByFile(() => []));
    const out = runCppFileSymbols(sessions, { projectRoot: root, file: "a.cpp", depth: 1 });

    await expect(classOf(out)).resolves.toBe("not-ready");
    expect(classifyError(textOf(await out)).errorHead).toContain("produced no symbols while");
  });

  it("symbol-not-found, from the outline search that came up empty", async () => {
    const root = cppRoot();
    const sessions = sessionsFor(fakeProcessByFile(() => [symAt("Foo", 5, 0, 6)]));
    const out = runCppFindSymbol(sessions, { projectRoot: root, name: "Bar", file: join(root, "a.cpp") });

    await expect(classOf(out)).resolves.toBe("symbol-not-found");
  });

  it("symbol-ambiguous, from the same search that found two of them", async () => {
    const root = cppRoot();
    const sessions = sessionsFor(fakeProcessByFile(() => [symAt("Foo", 5, 0, 6), symAt("Foo", 5, 9, 6)]));
    const out = runCppFindSymbol(sessions, { projectRoot: root, name: "Foo", file: join(root, "a.cpp") });

    await expect(classOf(out)).resolves.toBe("symbol-ambiguous");
  });

  it("symbol-kind-unsupported, from the caller query that refused a thing nobody calls", async () => {
    const root = cppRoot();
    const sessions = sessionsFor(fakeProcessByFile(() => [symAt("counter", 13, 0, 6)]));
    const out = runCppFindCallers(sessions, {
      projectRoot: root,
      name: "counter",
      file: join(root, "a.cpp"),
      sourceRoots: [root],
    });

    await expect(classOf(out)).resolves.toBe("symbol-kind-unsupported");
  });

  it("`other`, for a project config this server could not read, which no class claims yet", async () => {
    const root = cppRoot();
    writeFileSync(join(root, "mcp-code-nav.config.json"), "{ not json");
    const sessions = sessionsFor(fakeProcessByFile(() => [symAt("Foo", 5, 0, 6)]));
    const out = await runCppFileSymbols(sessions, { projectRoot: root, file: "a.cpp", depth: 1 });

    const classified = classifyError(textOf(out));
    expect(classified.errorClass).toBe("other");
    expect(classified.errorHead).toContain("is not valid JSON");
    expect(classified.errorHead).not.toContain(root);
    expect(classified.errorHead.startsWith("cpp_file_symbols failed: …")).toBe(true);
  });
});

describe("what the sweep emits, from the clang-query seam", () => {
  function sweepRoot(files: readonly string[]): string {
    const root = tempRoot("err-sweep");
    for (const name of files) writeFileSync(join(root, name), "class Base {};\n");
    writeFileSync(
      join(root, "compile_commands.json"),
      JSON.stringify(files.map((name) => ({ directory: root, file: name }))),
    );
    return root;
  }

  it("sweep-failed, when every translation unit failed the same way", async () => {
    const root = sweepRoot(["a.cpp"]);
    const failing: ClangQueryExecFn = async () => ({ exitCode: 1, stdout: "", stderr: "error: no such matcher" });
    const out = runCppFindDerivedClasses({ exec: failing, cache: new SweepCache() }, { projectRoot: root, qualifiedName: "Base" });

    await expect(classOf(out)).resolves.toBe("sweep-failed");
  });

  it("budget-exceeded, as the partial answer the ceiling leaves a still-running sweep with", async () => {
    const root = sweepRoot(["a.cpp", "b.cpp"]);
    const slow: ClangQueryExecFn = async () => {
      await new Promise((done) => setTimeout(done, 250));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const out = await runCppFindDerivedClasses(
      { exec: slow, cache: new SweepCache() },
      { projectRoot: root, qualifiedName: "Base", timeBudgetMs: 25 },
    );

    expect(out.isError).toBe(true);
    expect(out.structuredContent).toBeDefined();
    await expect(classOf(out)).resolves.toBe("budget-exceeded");
  }, 15_000);
});

describe("what the Go tools and a dead server emit", () => {
  it("no-module, from the walk that found no go.mod above the file", async () => {
    const root = tempRoot("err-nomod");
    const file = join(root, "a.go");
    writeFileSync(file, "package main\n");
    const sessions = new LspSessionManager({ sleep: async () => {} });
    const out = runGoFileSymbols(sessions, { sourceRoots: [root], file, depth: 1, timeBudgetMs: 60_000 });

    await expect(classOf(out)).resolves.toBe("no-module");
  });

  it("server-unavailable, from the error the spawn itself raises, wrapped or bare", () => {
    const failure = new LanguageServerUnavailableError(
      { config: clangdConfig, attempted: "clangd", fromOverride: false },
      { code: "ENOENT" },
    );

    expect(classifyError(failure.message).errorClass).toBe("server-unavailable");
    expect(classifyError(`cpp_file_symbols failed: ${failure.message}`).errorClass).toBe("server-unavailable");
  });

  it("session-lost, for both the dead child and the one that was replaced mid-query", () => {
    // `liveProcess` states the first and `restartedText` the second; a mocked call that answers at all has
    // to keep its child alive, so neither text is reachable from a handler the way the others above are.
    expect(classifyError("gopls has no live process to notify").errorClass).toBe("session-lost");
    expect(
      classifyError(
        'go_find_callers failed: gopls restarted during the query about "Store" in the module "D:\\mod", ' +
          "so the answer came from a process whose initial workspace load has not been proven.",
      ).errorClass,
    ).toBe("session-lost");
  });
});

describe("the table's order is what keeps the more specific cause", () => {
  it("says not-ready, not symbol-not-found, for an empty the server will not stand behind", () => {
    const refusal =
      'cpp_find_symbol failed: no declaration named "Foo" was found in clangd\'s index for "D:\\build", ' +
      "and that is not reportable as an answer: clangd was indexing while this call ran.";
    expect(classifyError(refusal).errorClass).toBe("not-ready");
  });

  it("says not-ready, not budget-exceeded, for a workspace load that never finished", () => {
    expect(
      classifyError(
        'go_find_references failed: gopls never reported the initial workspace load of the module "D:\\mod" ' +
          "as finished within this call's 60000 ms budget, so a type-aware answer cannot be proven complete.",
      ).errorClass,
    ).toBe("not-ready");
  });

  it("says compile-db-missing, not a bare not-found, for a database that is not there", () => {
    expect(
      classifyError('cpp_file_symbols failed: compile_commands.json not found or unreadable at "D:\\repo"').errorClass,
    ).toBe("compile-db-missing");
  });

  it("says server-unavailable, not tool-unknown, for a binary that is not on PATH", () => {
    expect(classifyError('Cannot start clangd: "clangd" on PATH was not found (ENOENT)').errorClass).toBe(
      "server-unavailable",
    );
    expect(classifyError("Tool cpp_nothing not found").errorClass).toBe("tool-unknown");
  });

  it("folds a quoted path or name and every digit run out of the head", () => {
    expect(classifyError('cpp_find_symbol failed: no symbol "Widget" found in "D:\\src\\a.cpp".').errorHead).toBe(
      'cpp_find_symbol failed: no symbol "…" found in "…".',
    );
    expect(
      classifyError("cpp_find_derived_classes swept 3/9 translation units within its 5000 ms ceiling").errorHead,
    ).toBe("cpp_find_derived_classes swept #/# translation units within its # ms ceiling");
  });

  it("folds an unquoted absolute path too, and leaves a bare name alone", () => {
    expect(classifyError("cpp_file_symbols failed: D:\\tmp\\build\\compile_commands.json is not valid JSON").errorHead).toBe(
      "cpp_file_symbols failed: … is not valid JSON",
    );
    expect(classifyError("gopls looked in D:/mod/storage/store.go and answered nothing").errorHead).toBe(
      "gopls looked in … and answered nothing",
    );
    expect(classifyError("read /tmp/build/x/a.cpp after 3 attempts").errorHead).toBe("read … after # attempts");
    // The tool name in the SDK's own text is the fact worth grouping by, and a single slash is not a path.
    expect(classifyError("MCP error -32602: Tool cpp_find_symbols not found").errorHead).toBe(
      "MCP error -#: Tool cpp_find_symbols not found",
    );
    expect(classifyError("path /a is one segment").errorHead).toBe("path /a is one segment");
    // A slash inside a word is prose, not a rooted path: `and/or/other` must not fold to `and…`.
    expect(classifyError("matched and/or/other rows").errorHead).toBe("matched and/or/other rows");
    expect(classifyError("compared a/b/c/d/e/f/g with h/i/j/k/l/m").errorHead).toBe(
      "compared a/b/c/d/e/f/g with h/i/j/k/l/m",
    );
  });

  it("folds a slash-heavy token without hanging on it", () => {
    const heavy = `${"/".repeat(4000)}x`;

    expect(classifyError(heavy).errorHead.length).toBeLessThanOrEqual(80);
    expect(classifyError(`${heavy} ${heavy} ${heavy} is not valid JSON`).errorHead.length).toBeLessThanOrEqual(80);
  });

  it("keeps the head to 80 characters and survives an empty text", () => {
    expect(classifyError(`${"x".repeat(500)} failed after 42 ms`).errorHead).toHaveLength(80);
    expect(classifyError("").errorHead).toBe("");
    expect(classifyError("").errorClass).toBe("other");
  });
});
