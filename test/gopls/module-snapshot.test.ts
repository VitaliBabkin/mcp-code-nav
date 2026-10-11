import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { takeModuleSnapshot } from "../../src/gopls/module-snapshot.js";
import { fileStamp } from "../../src/lsp/file-stamp.js";

// Creating a symlink needs a privilege Windows withholds by default, so the case that pins the walk not
// following one is skipped where it cannot be built rather than passing vacuously.
const symlinkProbe = mkdtempSync(join(tmpdir(), "mcp-code-nav-symprobe-"));
let symlinksWork = false;
try {
  const target = join(symlinkProbe, "target.go");
  writeFileSync(target, "package a\n");
  symlinkSync(target, join(symlinkProbe, "link.go"));
  mkdirSync(join(symlinkProbe, "realdir"));
  symlinkSync(join(symlinkProbe, "realdir"), join(symlinkProbe, "linkdir"), "dir");
  symlinksWork = true;
} catch {
  symlinksWork = false;
} finally {
  rmSync(symlinkProbe, { recursive: true, force: true });
}
const itIfSymlinks = symlinksWork ? it : it.skip;

describe("takeModuleSnapshot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-snap-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Creates a directory holding a `go.mod` and returns it, so paths below it read as one module. */
  function moduleAt(dir: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "go.mod"), "module example.com/fixture\n");
    return dir;
  }

  function write(path: string, content: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  function keysUnder(mod: string, snapshot: Map<string, string> | undefined): string[] {
    if (snapshot === undefined) throw new Error("expected a snapshot");
    const prefix = `${resolve(mod)}${sep}`;
    return Array.from(snapshot.keys(), (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path)).sort();
  }

  it("keys every tracked file by its absolute path and values it with size|mtimeMs", () => {
    const mod = moduleAt(join(tmp, "mod"));
    const aGo = write(join(mod, "a.go"), "package a\n");
    const bGo = write(join(mod, "sub", "b.go"), "package sub\n");
    write(join(mod, "readme.md"), "# not go\n");

    const snapshot = takeModuleSnapshot(mod);
    expect(keysUnder(mod, snapshot)).toEqual(["a.go", "go.mod", join("sub", "b.go")]);
    for (const [path, stamp] of snapshot ?? new Map()) {
      const { size, mtimeMs } = statSync(path);
      expect(stamp).toBe(`${size}|${mtimeMs}`);
    }
    expect(snapshot?.get(aGo)).toBe(fileStamp(aGo));
    expect(snapshot?.get(bGo)).toBe(fileStamp(bGo));
  });

  it("tracks go.mod and go.work but no other non-.go file", () => {
    const mod = moduleAt(join(tmp, "mod"));
    write(join(mod, "go.work"), "go 1.21\n");
    write(join(mod, "go.work.sum"), "h1:\n");
    write(join(mod, "main.go.tmp"), "package main\n");

    expect(keysUnder(mod, takeModuleSnapshot(mod))).toEqual(["go.mod", "go.work"]);
  });

  it("skips the directories that are not part of this module's graph", () => {
    const mod = moduleAt(join(tmp, "mod"));
    write(join(mod, "keep.go"), "package a\n");
    write(join(mod, "vendor", "dep.go"), "package dep\n");
    write(join(mod, "testdata", "sample.go"), "package sample\n");
    write(join(mod, "node_modules", "pkg", "index.go"), "package pkg\n");
    write(join(mod, "_scratch", "s.go"), "package s\n");
    write(join(mod, ".hidden", "h.go"), "package h\n");
    write(join(mod, "other", "go.mod"), "module example.com/other\n");
    write(join(mod, "other", "nested.go"), "package nested\n");

    expect(keysUnder(mod, takeModuleSnapshot(mod))).toEqual(["go.mod", "keep.go"]);
  });

  it("keeps a frontend tree beside the module from blowing the entry bound", () => {
    const mod = moduleAt(join(tmp, "mod"));
    write(join(mod, "a.go"), "package a\n");
    for (let index = 0; index < 50; index++) {
      write(join(mod, "node_modules", "pkg", `f${index}.js`), "// not go\n");
    }
    // Enumerating that tree would exceed a bound of 20 on its own; skipping it leaves two entries.
    expect(keysUnder(mod, takeModuleSnapshot(mod, { maxEntries: 20 }))).toEqual(["a.go", "go.mod"]);
  });

  it("still descends a directory named like a skip when it is the walk root", () => {
    // Only an entry reached THROUGH a parent is skipped, the same rule the C++ fingerprint walk holds.
    const mod = moduleAt(join(tmp, "vendor"));
    write(join(mod, "keep.go"), "package a\n");
    expect(keysUnder(mod, takeModuleSnapshot(mod))).toEqual(["go.mod", "keep.go"]);
  });

  itIfSymlinks("neither follows a symlinked directory nor reports a symlinked file", () => {
    const mod = moduleAt(join(tmp, "mod"));
    write(join(mod, "keep.go"), "package a\n");
    const outside = join(tmp, "outside");
    write(join(outside, "far.go"), "package far\n");
    symlinkSync(join(outside, "far.go"), join(mod, "link.go"));
    symlinkSync(outside, join(mod, "linkdir"), "dir");

    const names = [...(takeModuleSnapshot(mod)?.keys() ?? [])].map((path) => basename(path)).sort();
    expect(names).toEqual(["go.mod", "keep.go"]);
  });

  it("yields no snapshot when the walk exceeds its entry bound", () => {
    const mod = moduleAt(join(tmp, "mod"));
    write(join(mod, "a.go"), "package a\n");
    write(join(mod, "b.go"), "package b\n");
    expect(takeModuleSnapshot(mod)).toBeInstanceOf(Map);
    expect(takeModuleSnapshot(mod, { maxEntries: 2 })).toBeUndefined();
  });

  it("counts the bound over every entry enumerated, tracked or not", () => {
    const mod = moduleAt(join(tmp, "mod"));
    write(join(mod, "notes.txt"), "untracked\n");
    write(join(mod, "sub", "a.go"), "package sub\n");
    // Four entries in total (go.mod, notes.txt, sub/, sub/a.go), so a bound of three cannot finish.
    expect(takeModuleSnapshot(mod, { maxEntries: 3 })).toBeUndefined();
    expect(takeModuleSnapshot(mod, { maxEntries: 4 })).toBeInstanceOf(Map);
  });

  it("changes a file's value when its size changes, which is what the freshness diff keys on", () => {
    const mod = moduleAt(join(tmp, "mod"));
    const aGo = write(join(mod, "a.go"), "package a\n");
    const before = takeModuleSnapshot(mod);

    write(aGo, "package a // longer than before\n");
    const after = takeModuleSnapshot(mod);

    expect(before?.get(aGo)).not.toBe(after?.get(aGo));
    expect(before?.size).toBe(after?.size);
  });

  it("keys by the resolved absolute path it was handed, whatever spelling the caller used", () => {
    const mod = moduleAt(join(tmp, "mod"));
    write(join(mod, "a.go"), "package a\n");
    const keys = takeModuleSnapshot(mod)?.keys();
    for (const path of keys ?? []) {
      expect(path).toBe(resolve(path));
    }
  });
});
