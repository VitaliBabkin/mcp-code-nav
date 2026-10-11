import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/call-log/error-class.js";
import type { CppSourceRootsBlock } from "../../src/clang-query/derived-source-roots.js";
import { clangdConfig, LanguageServerUnavailableError } from "../../src/lsp/server-config.js";
import { AmbiguousRelativePathError, PathEscapeError } from "../../src/paths/resolve-safe-path.js";
import { fileNotFoundHint, IgnoredPathError, pathFixHint } from "../../src/tools/shared.js";

// the sentence appended after an unchanged head. Paths are built with `resolve`.

const at = (...segments: string[]): string => resolve("/", ...segments);

const rootOnly: CppSourceRootsBlock = { origin: "project-root-only", roots: [], reason: "compile-db-unlistable" };

const escape = (projectRoot: string, file: string): PathEscapeError => new PathEscapeError([projectRoot], file);

const SIGNPOST =
  " Only projectRoot was a root, and an out-of-tree build keeps its sources outside it: pass the source tree as " +
  "sourceRoots";

describe("pathFixHint, only projectRoot was a root", () => {
  const projectRoot = at("work", "repo", "build", "preset");

  it("suggests the deepest common ancestor of an absolute file, as a pasteable JSON array", () => {
    const file = at("work", "repo", "src", "a.cpp");

    expect(pathFixHint(escape(projectRoot, file), { projectRoot, file, sourceRoots: rootOnly })).toBe(
      `${SIGNPOST}, e.g. sourceRoots: [${JSON.stringify(at("work", "repo"))}].`,
    );
  });

  it("escapes a backslash path so the suggestion pastes into JSON", () => {
    const file = at("work", "repo", "src", "a.cpp");
    const hint = pathFixHint(escape(projectRoot, file), { projectRoot, file, sourceRoots: rootOnly });

    const pasted: unknown = JSON.parse(hint.slice(hint.indexOf("sourceRoots: [") + "sourceRoots: ".length, -1));

    expect(pasted).toEqual([at("work", "repo")]);
  });

  it("suggests the nearest common ancestor, which may itself be a build directory", () => {
    const file = at("work", "repo", "build", "other", "a.cpp");

    expect(pathFixHint(escape(projectRoot, file), { projectRoot, file, sourceRoots: rootOnly })).toBe(
      `${SIGNPOST}, e.g. sourceRoots: [${JSON.stringify(at("work", "repo", "build"))}].`,
    );
  });

  it("gives no suggestion beyond four levels above projectRoot", () => {
    const deep = at("a", "b", "c", "d", "e", "f", "g");
    const file = at("a", "b", "x.cpp");

    expect(pathFixHint(escape(deep, file), { projectRoot: deep, file, sourceRoots: rootOnly })).toBe(`${SIGNPOST}.`);
  });

  it("allows the fourth level and not the fifth", () => {
    const deep = at("a", "b", "c", "d", "e");
    const file = at("a", "x.cpp");

    expect(pathFixHint(escape(deep, file), { projectRoot: deep, file, sourceRoots: rootOnly })).toBe(
      `${SIGNPOST}, e.g. sourceRoots: [${JSON.stringify(at("a"))}].`,
    );
    const deeper = at("a", "b", "c", "d", "e", "f");
    expect(pathFixHint(escape(deeper, file), { projectRoot: deeper, file, sourceRoots: rootOnly })).toBe(`${SIGNPOST}.`);
  });

  it("never suggests a filesystem root", () => {
    const shallow = at("proj");
    const file = at("other", "x.cpp");

    expect(pathFixHint(escape(shallow, file), { projectRoot: shallow, file, sourceRoots: rootOnly })).toBe(`${SIGNPOST}.`);
  });

  it("gives no suggestion for a relative file", () => {
    expect(pathFixHint(escape(projectRoot, "../../src/a.cpp"), { projectRoot, file: "../../src/a.cpp", sourceRoots: rootOnly })).toBe(
      `${SIGNPOST}.`,
    );
  });
});

describe("pathFixHint, a derived or declared root", () => {
  const projectRoot = at("work", "repo", "build", "preset");
  const file = at("elsewhere", "a.cpp");
  const derived: CppSourceRootsBlock = { origin: "derived", roots: [at("work", "repo")], tusOutsideRoots: 0 };

  it("names the derived root and the way out", () => {
    expect(pathFixHint(escape(projectRoot, file), { projectRoot, file, sourceRoots: derived })).toBe(
      ` "${at("work", "repo")}" was derived from compile_commands.json because sourceRoots was omitted; to read a ` +
        "file outside it, pass that file's source tree as sourceRoots.",
    );
  });

  it("asks a declaring caller to add the tree", () => {
    const declared: CppSourceRootsBlock = { origin: "declared", roots: [at("work", "repo")] };

    expect(pathFixHint(escape(projectRoot, file), { projectRoot, file, sourceRoots: declared })).toBe(
      " To read a file outside these roots, add its source tree to sourceRoots.",
    );
  });
});

describe("pathFixHint, the other path errors", () => {
  const ctx = { projectRoot: at("r"), file: "a.cpp", sourceRoots: rootOnly };

  it("adds nothing for an ambiguous or an ignored path", () => {
    expect(pathFixHint(new AmbiguousRelativePathError("a.cpp", [at("r", "a.cpp"), at("s", "a.cpp")]), ctx)).toBe("");
    expect(pathFixHint(new IgnoredPathError(at("r", "a.cpp")), ctx)).toBe("");
  });
});

describe("the classifier still reads the head", () => {
  const projectRoot = at("work", "repo", "build", "preset");
  const file = at("work", "repo", "src", "a.cpp");
  const error = escape(projectRoot, file);
  const blocks: readonly CppSourceRootsBlock[] = [
    rootOnly,
    { origin: "derived", roots: [at("work", "repo")], tusOutsideRoots: 0 },
    { origin: "declared", roots: [at("work", "repo")] },
  ];

  it.each(blocks.map((block) => [block.origin, block] as const))("path-escape with %s roots", (_origin, block) => {
    const text = `cpp_file_symbols failed: ${error.message}${pathFixHint(error, { projectRoot, file, sourceRoots: block })}`;

    expect(classifyError(text).errorClass).toBe("path-escape");
  });

  it("file-not-found with the ENOENT sentence", () => {
    const text = `cpp_file_symbols failed: ENOENT: no such file or directory, open '${file}'${fileNotFoundHint(
      Object.assign(new Error("x"), { code: "ENOENT" }),
      rootOnly,
    )}`;

    expect(classifyError(text).errorClass).toBe("file-not-found");
  });
});

describe("fileNotFoundHint", () => {
  const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });

  it("names the search boundary when only projectRoot was a root", () => {
    expect(fileNotFoundHint(enoent, rootOnly)).toBe(
      " Only projectRoot was searched; if the file lives in a source tree outside it, pass that tree as sourceRoots.",
    );
  });

  it("adds nothing for a derived or declared root, whose resolution note already names the tried paths", () => {
    expect(fileNotFoundHint(enoent, { origin: "derived", roots: [at("r")], tusOutsideRoots: 0 })).toBe("");
    expect(fileNotFoundHint(enoent, { origin: "declared", roots: [at("r")] })).toBe("");
  });

  it("adds nothing for a language server that is not on PATH, which is not a missing file", () => {
    const attempt = { attempted: "clangd", fromOverride: false, config: clangdConfig };
    const missingBinary = new LanguageServerUnavailableError(attempt, { code: "ENOENT" });

    expect(missingBinary.code).toBe("ENOENT");
    expect(fileNotFoundHint(missingBinary, rootOnly)).toBe("");
  });

  it("adds nothing for any other error", () => {
    expect(fileNotFoundHint(Object.assign(new Error("x"), { code: "EACCES" }), rootOnly)).toBe("");
    expect(fileNotFoundHint(new Error("ENOENT in the message only"), rootOnly)).toBe("");
    expect(fileNotFoundHint("ENOENT", rootOnly)).toBe("");
    expect(fileNotFoundHint(undefined, rootOnly)).toBe("");
  });
});
