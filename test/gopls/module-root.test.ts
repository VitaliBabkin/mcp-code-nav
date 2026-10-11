import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findModuleRoot } from "../../src/gopls/module-root.js";

/**
 * The upward search deliberately runs to the volume root before the boundary is consulted, so these
 * cases assume only what the go tool itself would assume: no `go.mod` above the OS temp directory.
 */
describe("findModuleRoot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-mroot-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Creates `dir` with `files` (paths relative to it) inside, and returns `dir`. */
  function dirWithFiles(dir: string, files: Record<string, string>): string {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return dir;
  }

  it("finds the go.mod above the file and reports the module root, with no go.work in effect", () => {
    const mod = dirWithFiles(join(tmp, "mod"), { "go.mod": "module example.com/mod\n", "a.go": "package a\n" });
    expect(findModuleRoot(join(mod, "a.go"), [mod])).toEqual({
      kind: "found",
      moduleRoot: resolve(mod),
      goWork: null,
    });
  });

  it("accepts a declared root that is an ancestor of the module", () => {
    const repo = dirWithFiles(join(tmp, "repo"), { "go.mod": "module example.com/repo\n" });
    const pkg = dirWithFiles(join(repo, "pkg"), { "a.go": "package a\n" });
    expect(findModuleRoot(join(pkg, "a.go"), [repo]).kind).toBe("found");
  });

  it("takes the NEAREST go.mod, so a nested module roots its own files", () => {
    const inner = dirWithFiles(join(tmp, "mod", "inner"), {
      "go.mod": "module example.com/mod/inner\n",
      "b.go": "package b\n",
    });
    dirWithFiles(join(tmp, "mod"), { "go.mod": "module example.com/mod\n", "a.go": "package a\n" });
    const outcome = findModuleRoot(join(inner, "b.go"), [inner]);
    expect(outcome).toMatchObject({ kind: "found", moduleRoot: resolve(inner) });
  });

  it("reports outside-roots when the module sits above every declared root, naming both", () => {
    // The file is inside the boundary; the go.mod that governs it is not. The two outcomes stay
    // distinct only because the search runs out to the filesystem root first.
    const parent = dirWithFiles(join(tmp, "parent"), { "go.mod": "module example.com/parent\n" });
    const pkg = dirWithFiles(join(parent, "pkg"), { "a.go": "package a\n" });
    expect(findModuleRoot(join(pkg, "a.go"), [pkg])).toEqual({
      kind: "outside-roots",
      moduleRoot: resolve(parent),
      declaredRoots: [resolve(pkg)],
    });
  });

  it("reports outside-roots for a module in a sibling directory the caller never declared", () => {
    const other = dirWithFiles(join(tmp, "other"), { "go.mod": "module example.com/other\n", "a.go": "package a\n" });
    const declared = dirWithFiles(join(tmp, "declared"), { "go.mod": "module example.com/declared\n" });
    const outcome = findModuleRoot(join(other, "a.go"), [declared]);
    expect(outcome.kind).toBe("outside-roots");
    // `resolveWithinAnyRoot` rejects such a file before this function is reached; the outcome still
    // carries the module it found so the error text can name it.
    if (outcome.kind !== "outside-roots") throw new Error("expected outside-roots");
    expect(outcome.declaredRoots).toEqual([resolve(declared)]);
  });

  it("reports not-in-module when no go.mod exists up to the filesystem root", () => {
    const plain = dirWithFiles(join(tmp, "plain"), { "a.go": "package a\n" });
    expect(findModuleRoot(join(plain, "a.go"), [plain])).toEqual({
      kind: "not-in-module",
      searchedFrom: resolve(plain),
    });
  });

  it("reports the nearest go.work above the module, which GOWORK=off keeps out of the answer", () => {
    const ws = dirWithFiles(join(tmp, "ws"), { "go.work": "go 1.21\n" });
    const mod = dirWithFiles(join(ws, "mod"), { "go.mod": "module example.com/ws/mod\n", "a.go": "package a\n" });
    expect(findModuleRoot(join(mod, "a.go"), [ws])).toMatchObject({
      kind: "found",
      moduleRoot: resolve(mod),
      goWork: join(ws, "go.work"),
    });
  });

  it("reports a go.work sitting in the module directory itself", () => {
    const mod = dirWithFiles(join(tmp, "modself"), {
      "go.mod": "module example.com/modself\n",
      "go.work": "go 1.21\n",
      "a.go": "package a\n",
    });
    expect(findModuleRoot(join(mod, "a.go"), [mod])).toMatchObject({ kind: "found", goWork: join(mod, "go.work") });
  });

  it("finds the go.mod IN a directory anchor, which is the whole point of the directory input", () => {
    const mod = dirWithFiles(join(tmp, "mod"), { "go.mod": "module example.com/mod\n", "a.go": "package a\n" });
    expect(findModuleRoot(mod, [mod], "directory")).toEqual({ kind: "found", moduleRoot: resolve(mod), goWork: null });
  });

  it("searches upward from a directory anchor too, so a package directory roots at its module", () => {
    const repo = dirWithFiles(join(tmp, "repo"), { "go.mod": "module example.com/repo\n" });
    const pkg = dirWithFiles(join(repo, "pkg", "deep"), { "a.go": "package a\n" });
    expect(findModuleRoot(pkg, [repo], "directory")).toMatchObject({ kind: "found", moduleRoot: resolve(repo) });
  });

  it("takes the NEAREST go.mod for a directory anchor, so a nested module roots itself", () => {
    const inner = dirWithFiles(join(tmp, "mod", "inner"), { "go.mod": "module example.com/mod/inner\n" });
    dirWithFiles(join(tmp, "mod"), { "go.mod": "module example.com/mod\n" });
    expect(findModuleRoot(inner, [inner], "directory")).toMatchObject({ kind: "found", moduleRoot: resolve(inner) });
  });

  it("reports outside-roots for a directory whose own go.mod sits above every declared root", () => {
    const parent = dirWithFiles(join(tmp, "parent"), { "go.mod": "module example.com/parent\n" });
    const pkg = dirWithFiles(join(parent, "pkg"), { "a.go": "package a\n" });
    expect(findModuleRoot(pkg, [pkg], "directory")).toEqual({
      kind: "outside-roots",
      moduleRoot: resolve(parent),
      declaredRoots: [resolve(pkg)],
    });
  });

  it("reports not-in-module for a directory with no go.mod, naming the directory itself", () => {
    const plain = dirWithFiles(join(tmp, "plain"), { "a.go": "package a\n" });
    expect(findModuleRoot(plain, [plain], "directory")).toEqual({ kind: "not-in-module", searchedFrom: resolve(plain) });
  });

  it("starts a file-shaped search one level UP, which is why the module root needs the directory input", () => {
    // Same path, same roots, only the declared kind differs: read as a file, the module root's own `go.mod`
    // is invisible because the search begins in its parent, and the caller would be told the directory is
    // in no module at all.
    const mod = dirWithFiles(join(tmp, "mod"), { "go.mod": "module example.com/mod\n", "a.go": "package a\n" });
    expect(findModuleRoot(mod, [tmp])).toEqual({ kind: "not-in-module", searchedFrom: resolve(tmp) });
    expect(findModuleRoot(mod, [mod], "directory").kind).toBe("found");
  });
});
