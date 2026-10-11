import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AmbiguousRelativePathError,
  PathEscapeError,
  resolveSafePath,
  resolveWithinAnyRoot,
} from "../../src/paths/resolve-safe-path.js";

const projectRoot = process.platform === "win32" ? "C:\\build\\preset" : "/build/preset";
const sourceRoot = process.platform === "win32" ? "C:\\repo" : "/repo";

/** A stat seam that records what it was asked about, so "never stat'ed outside the roots" is assertable. */
function statSpy(existing: readonly string[]) {
  const calls: string[] = [];
  return {
    calls,
    exists: (path: string) => {
      calls.push(path);
      return existing.includes(path);
    },
  };
}

describe("resolveSafePath", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";

  it("resolves a relative path inside the root", () => {
    expect(resolveSafePath(root, "src/a.cpp")).toBe(join(root, "src", "a.cpp"));
  });

  it("resolves an absolute path already inside the root", () => {
    const abs = join(root, "src", "a.cpp");
    expect(resolveSafePath(root, abs)).toBe(abs);
  });

  it("rejects a relative path that escapes the root via ..", () => {
    expect(() => resolveSafePath(root, "../outside.cpp")).toThrow(PathEscapeError);
  });

  it("rejects an absolute path outside the root", () => {
    const outside = process.platform === "win32" ? "C:\\other\\file.cpp" : "/other/file.cpp";
    expect(() => resolveSafePath(root, outside)).toThrow(PathEscapeError);
  });

  it("accepts the root directory itself", () => {
    expect(resolveSafePath(root, root)).toBe(root);
  });
});

describe("resolveWithinAnyRoot", () => {
  it("accepts an absolute path inside projectRoot and reports it as the matched root", () => {
    const file = join(projectRoot, "gen.cpp");
    const result = resolveWithinAnyRoot([projectRoot, sourceRoot], file);
    expect(result).toEqual({ absolutePath: file, matchedRoot: projectRoot, triedPaths: [file] });
  });

  it("accepts an absolute path inside a sourceRoots entry outside projectRoot", () => {
    const file = join(sourceRoot, "src", "widget.cpp");
    const result = resolveWithinAnyRoot([projectRoot, sourceRoot], file);
    expect(result).toEqual({ absolutePath: file, matchedRoot: sourceRoot, triedPaths: [file] });
  });

  it("rejects a path outside every declared root, naming all of them", () => {
    const outside = process.platform === "win32" ? "C:\\elsewhere\\file.cpp" : "/elsewhere/file.cpp";
    try {
      resolveWithinAnyRoot([projectRoot, sourceRoot], outside);
      expect.unreachable("expected PathEscapeError");
    } catch (e) {
      expect(e).toBeInstanceOf(PathEscapeError);
      expect((e as PathEscapeError).roots).toEqual([projectRoot, sourceRoot]);
      expect((e as PathEscapeError).message).toContain(projectRoot);
      expect((e as PathEscapeError).message).toContain(sourceRoot);
    }
  });

  it("tries roots in order, matching the first that contains the path", () => {
    const nestedSourceRoot = join(sourceRoot, "vendor");
    const file = join(nestedSourceRoot, "lib.h");
    // sourceRoot is a parent of nestedSourceRoot, so both "contain" the file — order picks sourceRoot first.
    const result = resolveWithinAnyRoot([projectRoot, sourceRoot, nestedSourceRoot], file);
    expect(result.matchedRoot).toBe(sourceRoot);
  });

  it("resolves a relative candidate that exists under exactly one root, whichever root that is", () => {
    // A repository-relative path in the out-of-tree layout lives under a sourceRoots entry, not under the
    // build directory projectRoot names.
    const candidate = "connector_core/include/adapter.h";
    const winner = resolve(sourceRoot, candidate);
    const stat = statSpy([winner]);
    const result = resolveWithinAnyRoot([projectRoot, sourceRoot], candidate, stat.exists);
    expect(result).toEqual({
      absolutePath: winner,
      matchedRoot: sourceRoot,
      triedPaths: [resolve(projectRoot, candidate), winner],
    });
  });

  it("errors instead of picking by root order when a relative candidate exists under several roots", () => {
    const candidates = [join(projectRoot, "widget.h"), join(sourceRoot, "widget.h")];
    const stat = statSpy(candidates);
    try {
      resolveWithinAnyRoot([projectRoot, sourceRoot], "widget.h", stat.exists);
      expect.unreachable("expected AmbiguousRelativePathError");
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousRelativePathError);
      expect((e as AmbiguousRelativePathError).candidates).toEqual(candidates);
      expect((e as AmbiguousRelativePathError).message).toContain(candidates[0] as string);
      expect((e as AmbiguousRelativePathError).message).toContain(candidates[1] as string);
      expect((e as AmbiguousRelativePathError).message).toContain("pass an absolute path");
    }
    expect(stat.calls).toEqual(candidates);
  });

  it("keeps the first contained candidate when a relative candidate exists under none, naming both tried", () => {
    const underProject = join(projectRoot, "missing.h");
    const stat = statSpy([]);
    const result = resolveWithinAnyRoot([projectRoot, sourceRoot], "missing.h", stat.exists);
    expect(result).toEqual({
      absolutePath: underProject,
      matchedRoot: projectRoot,
      triedPaths: [underProject, join(sourceRoot, "missing.h")],
    });
  });

  // The case-folding in the normalised key is win32-only because that is the only platform where the two
  // spellings below name one file; elsewhere they are two files and stay an ambiguity.
  it.skipIf(process.platform !== "win32")(
    "does not treat one file that two roots spell with different case as an ambiguity",
    () => {
      const result = resolveWithinAnyRoot([sourceRoot, sourceRoot.toUpperCase()], "a.h", () => true);
      expect(result.absolutePath).toBe(join(sourceRoot, "a.h"));
      expect(result.matchedRoot).toBe(sourceRoot);
      expect(result.triedPaths).toHaveLength(2);
    },
  );

  it("counts one root spelled two ways as one candidate, so it cannot be ambiguous against itself", () => {
    // Concatenated rather than joined on purpose: `join` normalises `..` away, so only `resolve` inside
    // the resolver can be what collapses this alias back onto `sourceRoot`.
    const alias = `${sourceRoot}${sep}vendor${sep}..`;
    expect(alias).not.toBe(sourceRoot);
    const stat = statSpy([join(sourceRoot, "a.h")]);
    const result = resolveWithinAnyRoot([sourceRoot, alias], "a.h", stat.exists);
    expect(result.triedPaths).toEqual([join(sourceRoot, "a.h")]);
    expect(result.matchedRoot).toBe(sourceRoot);
    expect(stat.calls).toEqual([]);
  });

  it("never stats an absolute candidate, whatever the roots", () => {
    const file = join(sourceRoot, "src", "a.cpp");
    const stat = statSpy([]);
    resolveWithinAnyRoot([projectRoot, sourceRoot], file, stat.exists);
    expect(stat.calls).toEqual([]);
  });

  it("never stats for a single-root caller, which is why resolveSafePath is unaffected", () => {
    const stat = statSpy([]);
    const result = resolveWithinAnyRoot([sourceRoot], "src/a.cpp", stat.exists);
    expect(result.absolutePath).toBe(join(sourceRoot, "src", "a.cpp"));
    expect(result.triedPaths).toEqual([join(sourceRoot, "src", "a.cpp")]);
    expect(stat.calls).toEqual([]);
  });

  it("resolves a .. candidate contained in a later root without statting the escaping spelling", () => {
    const candidate = "../repo/a.h";
    const winner = resolve(sourceRoot, candidate);
    const stat = statSpy([winner]);
    const result = resolveWithinAnyRoot([projectRoot, sourceRoot], candidate, stat.exists);
    expect(result).toEqual({
      absolutePath: winner,
      matchedRoot: sourceRoot,
      triedPaths: [resolve(projectRoot, candidate), winner],
    });
    expect(stat.calls).toEqual([]);
  });

  it("raises PathEscapeError, and stats nothing, for a .. candidate contained in no root", () => {
    const stat = statSpy([]);
    expect(() => resolveWithinAnyRoot([projectRoot, sourceRoot], "../../../outside.h", stat.exists)).toThrow(
      PathEscapeError,
    );
    expect(stat.calls).toEqual([]);
  });

  it("treats a name that only starts with two dots as an ordinary entry inside the root", () => {
    // `relative` answers "..hidden/x.cpp" for an in-root path; only a `..` segment is an escape.
    const candidate = join("..hidden", "x.cpp");
    const underSource = resolve(sourceRoot, candidate);
    const result = resolveWithinAnyRoot([sourceRoot], candidate, statSpy([underSource]).exists);
    expect(result.absolutePath).toBe(underSource);
    expect(result.matchedRoot).toBe(sourceRoot);
  });

  it("rejects a candidate that is the parent directory itself, which is a bare ..", () => {
    const stat = statSpy([]);
    expect(() => resolveWithinAnyRoot([sourceRoot], "..", stat.exists)).toThrow(PathEscapeError);
    expect(stat.calls).toEqual([]);
  });
});

describe("resolveWithinAnyRoot with the real stat", () => {
  let buildDir: string;
  let sourceDir: string;

  beforeEach(() => {
    buildDir = mkdtempSync(join(tmpdir(), "mcp-code-nav-res-build-"));
    sourceDir = mkdtempSync(join(tmpdir(), "mcp-code-nav-res-src-"));
  });

  afterEach(() => {
    rmSync(buildDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("resolves a repository-relative candidate under the source root, not the build root", () => {
    const file = join(sourceDir, "connector_core", "include", "adapter.h");
    mkdirSync(join(sourceDir, "connector_core", "include"), { recursive: true });
    writeFileSync(file, "#pragma once\n");
    const result = resolveWithinAnyRoot([buildDir, sourceDir], join("connector_core", "include", "adapter.h"));
    expect(result.absolutePath).toBe(file);
    expect(result.matchedRoot).toBe(sourceDir);
  });

  it("does not count a directory at the candidate path as existing", () => {
    const file = join(sourceDir, "widget.h");
    writeFileSync(file, "class Widget {};\n");
    mkdirSync(join(buildDir, "widget.h"));
    const result = resolveWithinAnyRoot([buildDir, sourceDir], "widget.h");
    expect(result.absolutePath).toBe(file);
    expect(result.matchedRoot).toBe(sourceDir);
  });

  it("reports an ambiguity when two roots both hold the file", () => {
    writeFileSync(join(buildDir, "widget.h"), "#pragma once\n");
    writeFileSync(join(sourceDir, "widget.h"), "#pragma once\n");
    expect(() => resolveWithinAnyRoot([buildDir, sourceDir], "widget.h")).toThrow(AmbiguousRelativePathError);
  });
});

/** Links `at` to `target`; a junction on win32 (needs no privilege), a directory symlink elsewhere. */
function tryLinkDirectory(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  }
}

describe("resolveWithinAnyRoot and links", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "mcp-code-nav-link-root-")));
    outside = realpathSync.native(mkdtempSync(join(tmpdir(), "mcp-code-nav-link-out-")));
    writeFileSync(join(outside, "secret.cpp"), "int secret;\n");
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "ok.cpp"), "int ok;\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a path that goes through a link to a directory outside every root", (ctx) => {
    if (!tryLinkDirectory(outside, join(root, "linkdir"))) ctx.skip();
    try {
      resolveWithinAnyRoot([root], "linkdir/secret.cpp");
      expect.unreachable("expected PathEscapeError");
    } catch (e) {
      expect(e).toBeInstanceOf(PathEscapeError);
      expect((e as PathEscapeError).message).toContain("escapes every declared root");
      expect((e as PathEscapeError).message).toContain("resolves through a link");
      expect((e as PathEscapeError).realPath).toBe(join(outside, "secret.cpp"));
    }
  });

  it("accepts a link whose target is another directory inside the root", (ctx) => {
    if (!tryLinkDirectory(join(root, "real"), join(root, "alias"))) ctx.skip();
    expect(resolveWithinAnyRoot([root], "alias/ok.cpp").absolutePath).toBe(join(root, "alias", "ok.cpp"));
  });

  it("accepts a link whose target is declared as a second root", (ctx) => {
    if (!tryLinkDirectory(outside, join(root, "linkdir"))) ctx.skip();
    const result = resolveWithinAnyRoot([root, outside], "linkdir/secret.cpp");
    expect(result.absolutePath).toBe(join(root, "linkdir", "secret.cpp"));
  });

  it("leaves a missing file under the root to fail later as a missing file", () => {
    const result = resolveWithinAnyRoot([root], "nowhere/missing.cpp");
    expect(result.absolutePath).toBe(join(root, "nowhere", "missing.cpp"));
  });
});
