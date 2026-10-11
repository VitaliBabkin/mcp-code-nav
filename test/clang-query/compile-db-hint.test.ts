import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompileDbNotFoundError } from "../../src/clang-query/compile-db.js";
import {
  describeMissingCompileDb,
  HINT_MAX_CANDIDATES,
  HINT_MAX_DEPTH,
  HINT_MAX_DIRS,
  HINT_MAX_MS,
  type DirEntry,
  type ReaddirFn,
} from "../../src/clang-query/compile-db-hint.js";

const DB = "compile_commands.json";
const headAt = (projectRoot: string): string => new CompileDbNotFoundError(projectRoot).message;

/** Variant 2, spelled out — the count of listings is the only part that varies. */
const searchedEverything = (root: string, listings: number): string =>
  `${headAt(root)}. No directory under it holds one (searched ${listings} directories to depth ${HINT_MAX_DEPTH}). ` +
  "projectRoot must be the directory that holds compile_commands.json, from a native build on this host.";

const named = (...dirs: readonly string[]): string =>
  `. Directories under it that hold a compile_commands.json, nearest first: ${dirs
    .map((dir) => `"${dir}"`)
    .join(", ")}. Pass one of them as projectRoot.`;

const stoppedAt = (bound: string): string =>
  ` The search stopped at its bound (${bound}), so it may have missed candidates.`;

/** The clock is shared with the sibling search, so a downward search that spent it ends the sibling one at once. */
const siblingsOutOfTime = ` The sibling search stopped at its bound (${HINT_MAX_MS} ms), so it may have missed candidates.`;

/** Symlinks need a privilege Windows does not always grant, so that case skips rather than fails on it. */
const itIfSymlink = canSymlink() ? it : it.skip;

const tempDirs: string[] = [];

function makeTree(relativeDirs: readonly string[] = []): string {
  // A root of its own under a unique base: the sibling search lists the parent, which must not be the shared temp directory.
  const base = mkdtempSync(join(tmpdir(), "mcp-code-nav-hint-"));
  tempDirs.push(base);
  const root = join(base, "root");
  mkdirSync(root);
  for (const dir of relativeDirs) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

/** `root/<relative>/<DB>`, which is what makes `<relative>` a candidate. Returns that directory. */
function putDb(root: string, relative: string): string {
  const dir = join(root, relative);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, DB), "[]");
  return dir;
}

interface Shape {
  readonly dirs?: readonly string[];
  readonly db?: boolean;
  /** Whether that database entry reports as a file; a directory wearing the name reports `false`. */
  readonly dbIsFile?: boolean;
  /** A linked entry: neither file nor directory, which is how a `Dirent` reports a symlink. */
  readonly linked?: boolean;
}

/** A synthetic listing per path, recording every directory the walk actually opened. */
function fakeTree(shape: Readonly<Record<string, Shape>>, reads: string[]): ReaddirFn {
  return async (dir: string): Promise<readonly DirEntry[]> => {
    reads.push(dir);
    const entry = shape[dir];
    if (entry === undefined) return [];
    const listing: DirEntry[] = (entry.dirs ?? []).map((name) => ({
      name,
      isFile: () => false,
      isDirectory: () => true,
    }));
    if (entry.db === true) {
      listing.push({ name: DB, isFile: () => entry.dbIsFile !== false, isDirectory: () => false });
    }
    if (entry.linked === true) {
      listing.push({ name: "linked", isFile: () => false, isDirectory: () => false });
    }
    return listing;
  };
}

/** Symlinks need a privilege Windows does not always grant, so that case skips rather than fails on it. */
function canSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "mcp-code-nav-hint-sym-"));
  try {
    mkdirSync(join(probe, "target"));
    symlinkSync(join(probe, "target"), join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the named constants", () => {
  it("are the depth, the two bounds, and the number of candidates the text lists", () => {
    expect({ HINT_MAX_DEPTH, HINT_MAX_DIRS, HINT_MAX_MS, HINT_MAX_CANDIDATES }).toEqual({
      HINT_MAX_DEPTH: 3,
      HINT_MAX_DIRS: 2000,
      HINT_MAX_MS: 1000,
      HINT_MAX_CANDIDATES: 3,
    });
  });
});

describe("the four variants", () => {
  it("each start with the byte-identical head, and no two are the same text", async () => {
    const candidatesRoot = makeTree();
    const build = putDb(candidatesRoot, "build");
    const emptyRoot = makeTree(["src"]);
    const absentRoot = join(emptyRoot, "renamed-away");
    const unreadableRoot = makeTree();
    mkdirSync(join(unreadableRoot, DB));

    const roots = [candidatesRoot, emptyRoot, absentRoot, unreadableRoot];
    const texts = await Promise.all(roots.map((root) => describeMissingCompileDb(root)));

    for (const [index, root] of roots.entries()) {
      const text = texts[index] as string;
      expect(text.startsWith(headAt(root)), `variant ${index + 1}: ${text}`).toBe(true);
      expect(text.slice(headAt(root).length), `variant ${index + 1}`).not.toBe("");
    }
    expect(new Set(texts.map((text, index) => text.slice(headAt(roots[index] as string).length))).size).toBe(4);

    expect(texts[0]).toBe(`${headAt(candidatesRoot)}${named(build)}`);
    expect(texts[2]).toBe(`${headAt(absentRoot)}. That directory does not exist.`);
    expect(texts[3]).toBe(`${headAt(unreadableRoot)}. The file is present but could not be read.`);
  });

  it("reads no listing for an absent root or a database that is present but unreadable", async () => {
    const root = makeTree();
    const absent = join(root, "never-created");
    const unreadable = makeTree();
    mkdirSync(join(unreadable, DB));
    const readdir = vi.fn(fakeTree({}, []));

    // An absent root has no listing of its own; the sibling search lists its parent, and nothing deeper.
    await expect(describeMissingCompileDb(absent, { readdir })).resolves.toBe(
      `${headAt(absent)}. That directory does not exist.`,
    );
    expect(readdir.mock.calls.map(([dir]) => dir)).toEqual([root]);
    readdir.mockClear();
    await expect(describeMissingCompileDb(unreadable, { readdir })).resolves.toBe(
      `${headAt(unreadable)}. The file is present but could not be read.`,
    );
    expect(readdir).not.toHaveBeenCalled();
  });
});

describe("the search", () => {
  it("names a build directory one level down", async () => {
    const root = makeTree(["src"]);
    const build = putDb(root, "build");

    await expect(describeMissingCompileDb(root)).resolves.toBe(`${headAt(root)}${named(build)}`);
  });

  it("names one three levels down", async () => {
    const root = makeTree();
    const deep = putDb(root, join("native", "out", "Release"));

    await expect(describeMissingCompileDb(root)).resolves.toBe(`${headAt(root)}${named(deep)}`);
  });

  it("never lists a directory four levels down", async () => {
    const root = makeTree();
    putDb(root, join("a", "b", "c", "d"));

    // root, a, b and c are listed; `d` is a depth-4 directory, which is beyond the contract's reach.
    await expect(describeMissingCompileDb(root)).resolves.toBe(searchedEverything(root, 4));
  });

  it("takes the nearest candidates first, then lexical order within one depth", async () => {
    const root = makeTree();
    const deep = putDb(root, join("aaa", "bbb"));
    const near = putDb(root, "zzz");
    const nearer = putDb(root, "yyy");
    putDb(root, join("mmm", "nnn"));

    // Breadth-first, each level read in lexical order: `yyy` and `zzz` (depth 1) precede the lexically
    // smaller `aaa/bbb` (depth 2), and the third candidate ends the search before `mmm/nnn` is reached.
    const text = await describeMissingCompileDb(root);

    expect(text).toBe(`${headAt(root)}${named(nearer, near, deep)}`);
    expect(text).not.toContain(join(root, "mmm"));
  });

  it("lists at most three candidates, nearest first", async () => {
    const root = makeTree();
    const first = putDb(root, "alpha");
    const second = putDb(root, "bravo");
    const third = putDb(root, "charlie");
    putDb(root, "delta");

    await expect(describeMissingCompileDb(root)).resolves.toBe(`${headAt(root)}${named(first, second, third)}`);
  });

  it("skips every directory the contract names, and counts only the root", async () => {
    const skipped = [".git", ".claude", "node_modules", ".cache", ".vs", ".idea", "vcpkg_installed"];
    const root = makeTree(skipped);
    for (const dir of skipped) writeFileSync(join(root, dir, DB), "[]");

    await expect(describeMissingCompileDb(root)).resolves.toBe(searchedEverything(root, 1));
  });

  it("does NOT skip build, out or cmake-build, unlike the fingerprint walk", async () => {
    const root = makeTree();
    const build = putDb(root, join("out", "build"));
    const cmake = putDb(root, "cmake-build");
    const plain = putDb(root, "build");

    await expect(describeMissingCompileDb(root)).resolves.toBe(`${headAt(root)}${named(plain, cmake, build)}`);
  });

  itIfSymlink("never follows a symlinked directory, so a database behind one stays unnamed", async () => {
    const root = makeTree();
    const outside = makeTree();
    putDb(outside, "build");
    symlinkSync(outside, join(root, "link"), "dir");

    await expect(describeMissingCompileDb(root)).resolves.toBe(searchedEverything(root, 1));
  });

  it("reports a linked entry as neither a candidate nor a directory to enter", async () => {
    const root = makeTree();
    const reads: string[] = [];
    const readdir = fakeTree({ [root]: { linked: true }, [join(root, "linked")]: { db: true } }, reads);

    await expect(describeMissingCompileDb(root, { readdir })).resolves.toBe(searchedEverything(root, 1));
    expect(reads.filter((dir) => dir.startsWith(root))).toEqual([root]);
  });

  it("ignores a compile_commands.json that is a directory rather than a file", async () => {
    const root = makeTree();
    const readdir = fakeTree({ [root]: { dirs: ["build"] }, [join(root, "build")]: { db: true, dbIsFile: false } }, []);

    await expect(describeMissingCompileDb(root, { readdir })).resolves.toBe(searchedEverything(root, 2));
  });

  it("ignores a name that differs from the database only by case, because clangd reads the exact one", async () => {
    const root = makeTree(["build"]);
    writeFileSync(join(root, "build", "Compile_Commands.json"), "[]");

    await expect(describeMissingCompileDb(root)).resolves.toBe(searchedEverything(root, 2));
  });
});

describe("its bounds", () => {
  it("reads at most 2000 directories and names that bound", async () => {
    const root = makeTree();
    const reads: string[] = [];
    // Thirteen levels deep enough to pass 2000 listings at depth 3, so only the bound can end the walk.
    const wide: ReaddirFn = async (dir: string): Promise<readonly DirEntry[]> => {
      reads.push(dir);
      return Array.from({ length: 13 }, (_unused, index) => ({
        name: `d${index}`,
        isFile: () => false,
        isDirectory: () => true,
      }));
    };

    const text = await describeMissingCompileDb(root, { readdir: wide, now: () => 0 });

    expect(reads.filter((dir) => dir.startsWith(root))).toHaveLength(HINT_MAX_DIRS);
    expect(text).toBe(searchedEverything(root, HINT_MAX_DIRS) + stoppedAt(`${HINT_MAX_DIRS} directories`));
  });

  it("stops at its millisecond bound and names that bound instead", async () => {
    const root = makeTree();
    const reads: string[] = [];
    const chain = {
      [root]: { dirs: ["a"] },
      [join(root, "a")]: { dirs: ["b"] },
      [join(root, "a", "b")]: { dirs: ["c"] },
      [join(root, "a", "b", "c")]: { db: true },
    };
    // Every reading of the clock advances it 400 ms, so the third check passes the 1000 ms bound.
    let ticks = 0;

    const text = await describeMissingCompileDb(root, { readdir: fakeTree(chain, reads), now: () => ticks++ * 400 });

    expect(reads.filter((dir) => dir.startsWith(root))).toEqual([root, join(root, "a")]);
    expect(text).toBe(searchedEverything(root, 2) + stoppedAt(`${HINT_MAX_MS} ms`) + siblingsOutOfTime);
  });

  it("appends no bound sentence when a search filled its three candidates inside them", async () => {
    const root = makeTree();
    for (const dir of ["a", "b", "c", "d"]) putDb(root, dir);

    await expect(describeMissingCompileDb(root, { now: () => 0 })).resolves.toMatch(/Pass one of them as projectRoot\.$/);
  });

  it("appends no bound sentence to a search that ran out of tree inside them", async () => {
    const root = makeTree();
    const build = putDb(root, "build");
    let ticks = 0;

    await expect(describeMissingCompileDb(root, { now: () => ticks++ * 400 })).resolves.toBe(
      `${headAt(root)}${named(build)}`,
    );
  });
});

describe("a listing that cannot be read", () => {
  it("is a hole in the search, not a failure of the hint", async () => {
    const root = makeTree();
    const shape = { [root]: { dirs: ["locked", "build"] }, [join(root, "build")]: { db: true } };
    const honest = fakeTree(shape, []);
    const partly: ReaddirFn = async (dir: string) => {
      if (dir === join(root, "locked")) throw new Error("EACCES: permission denied, opendir");
      return honest(dir);
    };

    await expect(describeMissingCompileDb(root, { readdir: partly })).resolves.toBe(
      `${headAt(root)}${named(join(root, "build"))}`,
    );
  });

  it("counts only the listings it actually read", async () => {
    const root = makeTree();
    const honest = fakeTree({ [root]: { dirs: ["locked", "open"] }, [join(root, "open")]: {} }, []);
    const partly: ReaddirFn = async (dir: string) => {
      if (dir === join(root, "locked")) throw new Error("EACCES: permission denied, opendir");
      return honest(dir);
    };

    // Three listings were attempted, two answered: only the two that answered may be claimed as searched.
    await expect(describeMissingCompileDb(root, { readdir: partly })).resolves.toBe(searchedEverything(root, 2));
  });

  it("does not claim no directory holds one when the root's own listing failed", async () => {
    const root = makeTree();

    await expect(
      describeMissingCompileDb(root, {
        readdir: async () => {
          throw Object.assign(new Error("permission denied, scandir"), { code: "EACCES" });
        },
      }),
    ).resolves.toBe(`${headAt(root)}. That directory's own listing could not be read (EACCES), ` + "so nothing below it was searched.");
  });

  it("names the errno of a projectRoot that is not a directory at all", async () => {
    const notADirectory = join(makeTree(), "a-file");
    writeFileSync(notADirectory, "");

    const text = await describeMissingCompileDb(notADirectory);

    expect(text.startsWith(`${headAt(notADirectory)}. That directory's own listing could not be read (`)).toBe(true);
    expect(text.endsWith("), so nothing below it was searched.")).toBe(true);
  });

  it("never names projectRoot itself, whose own database is variant 4's case", async () => {
    const root = makeTree();
    const readdir = fakeTree({ [root]: { db: true } }, []);

    await expect(describeMissingCompileDb(root, { readdir })).resolves.toBe(searchedEverything(root, 1));
  });
});

describe("its bound while a listing is running", () => {
  it("fires at exactly 1000 ms, not after it", async () => {
    const root = makeTree();
    const reads: string[] = [];
    const chain = { [root]: { dirs: ["build"] }, [join(root, "build")]: { db: true } };
    let ticks = 0;

    // 0, 500, 1000: the second listing's remaining budget is exactly zero, so the candidate below it is
    // never reached. A bound tested with `>` rather than `>=` would read `build` and name it instead.
    const text = await describeMissingCompileDb(root, { readdir: fakeTree(chain, reads), now: () => ticks++ * 500 });

    expect(reads.filter((dir) => dir.startsWith(root))).toEqual([root]);
    expect(text).toBe(searchedEverything(root, 1) + stoppedAt(`${HINT_MAX_MS} ms`) + siblingsOutOfTime);
  });

  it("walks away from a listing that never answers, inside the bound it states", async () => {
    const root = makeTree();
    const startedAt = Date.now();
    let ticks = 0;

    const text = await describeMissingCompileDb(root, {
      readdir: () => new Promise(() => {}),
      now: () => (ticks++ === 0 ? 0 : HINT_MAX_MS - 1),
    });

    expect(text).toBe(
      `${headAt(root)}. That directory's own listing could not be read (the ${HINT_MAX_MS} ms bound), ` +
        "so nothing below it was searched." +
        siblingsOutOfTime,
    );
    expect(Date.now() - startedAt).toBeLessThan(HINT_MAX_MS);
  });

  it("cuts a hung subdirectory listing at the bound and counts only what it read", async () => {
    const root = makeTree();
    let ticks = 0;
    const slowChild: ReaddirFn = async (dir: string) =>
      dir === root ? [{ name: "slow", isFile: () => false, isDirectory: () => true }] : new Promise(() => {});

    const text = await describeMissingCompileDb(root, { readdir: slowChild, now: () => ticks++ * 300 });

    expect(text).toBe(searchedEverything(root, 1) + stoppedAt(`${HINT_MAX_MS} ms`) + siblingsOutOfTime);
  }, 20_000);
});

