import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir as readdirReal, readFile as readFileReal } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompileDbNotFoundError } from "../../src/clang-query/compile-db.js";
import {
  CMAKE_CACHE_MAX_BYTES,
  DB_HEAD_BYTES,
  describeMissingCompileDb,
  HINT_MAX_DEPTH,
  HINT_MAX_DIRS,
  HINT_MAX_MS,
  SIBLING_MAX_CANDIDATES,
  SIBLING_MAX_LISTINGS,
  type CompileDbHintDeps,
  type DirEntry,
  type ReaddirFn,
} from "../../src/clang-query/compile-db-hint.js";

// the CMake generator sentence and the sibling-build sentences after the missing-database text.

const DB = "compile_commands.json";
type ReadFile = NonNullable<CompileDbHintDeps["readFile"]>;

const headAt = (projectRoot: string): string => new CompileDbNotFoundError(projectRoot).message;

const searchedEverything = (root: string, listings: number): string =>
  `${headAt(root)}. No directory under it holds one (searched ${listings} directories to depth ${HINT_MAX_DEPTH}). ` +
  "projectRoot must be the directory that holds compile_commands.json, from a native build on this host.";

const stoppedAt = (bound: string): string =>
  ` The search stopped at its bound (${bound}), so it may have missed candidates.`;

const named = (...dirs: readonly string[]): string =>
  `. Directories under it that hold a compile_commands.json, nearest first: ${dirs
    .map((dir) => `"${dir}"`)
    .join(", ")}. Pass one of them as projectRoot.`;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh `<temp>/proj`: its parent is unique to the test, so no other temp directory can be a sibling. */
function makeRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "mcp-code-nav-hint13-"));
  tempDirs.push(base);
  const root = join(base, "proj");
  mkdirSync(root);
  return root;
}

const cacheAt = (root: string): string => join(root, "CMakeCache.txt");
const cacheOf = (...lines: readonly string[]): string => `${lines.join("\n")}\n`;

/** A `readFile` seam answering from a map and recording every path asked for. */
function files(contents: Readonly<Record<string, string>>, asked: string[] = []): ReadFile {
  return async (path: string): Promise<string | undefined> => {
    asked.push(path);
    return contents[path];
  };
}

const VS = "CMAKE_GENERATOR:INTERNAL=Visual Studio 18 2026";
const NINJA = "CMAKE_GENERATOR:INTERNAL=Ninja";

const generatorSentence = (generator: string): string =>
  ` This is a CMake build with the "${generator}" generator, which never writes compile_commands.json: ` +
  "configure a Ninja or Makefile build of it with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON and pass that build " +
  "directory as projectRoot.";

const NO_EXPORT =
  " This is a CMake build configured without CMAKE_EXPORT_COMPILE_COMMANDS=ON: reconfigure it with " +
  "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON to get one.";

describe("the named constants", () => {
  it("are the cache and head byte limits and the two sibling bounds", () => {
    expect({ CMAKE_CACHE_MAX_BYTES, DB_HEAD_BYTES, SIBLING_MAX_LISTINGS, SIBLING_MAX_CANDIDATES }).toEqual({
      CMAKE_CACHE_MAX_BYTES: 1_048_576,
      DB_HEAD_BYTES: 65_536,
      SIBLING_MAX_LISTINGS: 64,
      SIBLING_MAX_CANDIDATES: 3,
    });
  });
});

describe("the generator sentence", () => {
  it("names a Visual Studio generator after variant 2's body, whatever the export switch says", async () => {
    const root = makeRoot();
    const readFile = files({ [cacheAt(root)]: cacheOf("CMAKE_EXPORT_COMPILE_COMMANDS:BOOL=ON", VS) });

    await expect(describeMissingCompileDb(root, { readFile })).resolves.toBe(
      searchedEverything(root, 1) + generatorSentence("Visual Studio 18 2026"),
    );
  });

  it("names Xcode", async () => {
    const root = makeRoot();
    const readFile = files({ [cacheAt(root)]: cacheOf("CMAKE_GENERATOR:INTERNAL=Xcode") });

    await expect(describeMissingCompileDb(root, { readFile })).resolves.toBe(
      searchedEverything(root, 1) + generatorSentence("Xcode"),
    );
  });

  it("names a missing export switch for any other generator, absent, OFF or empty", async () => {
    const root = makeRoot();
    const switchLine = "CMAKE_EXPORT_COMPILE_COMMANDS:BOOL";
    const cases = [[NINJA], [NINJA, `${switchLine}=OFF`], [NINJA, `${switchLine}=`]];
    for (const lines of cases) {
      const readFile = files({ [cacheAt(root)]: cacheOf(...lines) });
      await expect(describeMissingCompileDb(root, { readFile }), lines.join("|")).resolves.toBe(
        searchedEverything(root, 1) + NO_EXPORT,
      );
    }
  });

  it("adds nothing when the export switch is a CMake truth value, in any case", async () => {
    const root = makeRoot();
    for (const value of ["ON", "1", "YES", "TRUE", "Y", "on", "True", "yes"]) {
      const readFile = files({ [cacheAt(root)]: cacheOf(NINJA, `CMAKE_EXPORT_COMPILE_COMMANDS:BOOL=${value}`) });
      await expect(describeMissingCompileDb(root, { readFile }), value).resolves.toBe(searchedEverything(root, 1));
    }
  });

  it("reads lines ended by CRLF", async () => {
    const root = makeRoot();
    const readFile = files({ [cacheAt(root)]: "CMAKE_GENERATOR:INTERNAL=Xcode\r\n" });

    await expect(describeMissingCompileDb(root, { readFile })).resolves.toBe(
      searchedEverything(root, 1) + generatorSentence("Xcode"),
    );
  });

  it("adds nothing for a missing, generator-less or throwing cache", async () => {
    const root = makeRoot();
    const cases: readonly ReadFile[] = [
      files({}),
      files({ [cacheAt(root)]: "# nothing useful\nFOO:BOOL=ON\n" }),
      async () => {
        throw new Error("EIO");
      },
    ];
    for (const readFile of cases) {
      await expect(describeMissingCompileDb(root, { readFile })).resolves.toBe(searchedEverything(root, 1));
    }
  });

  it("asks for one byte past the 1 MiB bound and adds nothing for a cache over it", async () => {
    const root = makeRoot();
    const asked: number[] = [];
    const oversized: ReadFile = async (_path, maxBytes) => {
      asked.push(maxBytes);
      return `${VS}\n${"#".repeat(CMAKE_CACHE_MAX_BYTES)}`;
    };
    const atBound: ReadFile = async () => `${VS}\n${"#".repeat(CMAKE_CACHE_MAX_BYTES - VS.length - 1)}`;

    await expect(describeMissingCompileDb(root, { readFile: oversized })).resolves.toBe(searchedEverything(root, 1));
    expect(asked).toEqual([CMAKE_CACHE_MAX_BYTES + 1]);
    await expect(describeMissingCompileDb(root, { readFile: atBound })).resolves.toBe(
      searchedEverything(root, 1) + generatorSentence("Visual Studio 18 2026"),
    );
  });

  it("follows variants 1 and 5, and is never read for variants 3 and 4", async () => {
    const withCandidate = makeRoot();
    mkdirSync(join(withCandidate, "build"));
    writeFileSync(join(withCandidate, "build", DB), "[]");
    const unreadable = makeRoot();
    mkdirSync(join(unreadable, DB));
    const absent = join(makeRoot(), "gone");
    const refused = makeRoot();
    const asked: string[] = [];
    const readFile = files(
      Object.fromEntries([withCandidate, unreadable, absent, refused].map((root) => [cacheAt(root), cacheOf(VS)])),
      asked,
    );
    const refusing: ReaddirFn = async (dir) => {
      if (dir === refused) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return readdirReal(dir, { withFileTypes: true });
    };

    await expect(describeMissingCompileDb(withCandidate, { readFile })).resolves.toBe(
      `${headAt(withCandidate)}${named(join(withCandidate, "build"))}${generatorSentence("Visual Studio 18 2026")}`,
    );
    await expect(describeMissingCompileDb(unreadable, { readFile })).resolves.toBe(
      `${headAt(unreadable)}. The file is present but could not be read.`,
    );
    await expect(describeMissingCompileDb(absent, { readFile })).resolves.toBe(
      `${headAt(absent)}. That directory does not exist.`,
    );
    await expect(describeMissingCompileDb(refused, { readFile, readdir: refusing })).resolves.toBe(
      `${headAt(refused)}. That directory's own listing could not be read (EACCES), so nothing below it was searched.` +
        generatorSentence("Visual Studio 18 2026"),
    );
    expect(asked).toEqual([cacheAt(withCandidate), cacheAt(refused)]);
  });

  it("goes after the bound sentence", async () => {
    const root = makeRoot();
    const readFile = files({ [cacheAt(root)]: cacheOf(VS) });
    const wide: ReaddirFn = async () =>
      Array.from({ length: 13 }, (_unused, index) => ({
        name: `d${index}`,
        isFile: () => false,
        isDirectory: () => true,
      }));

    await expect(describeMissingCompileDb(root, { readFile, readdir: wide, now: () => 0 })).resolves.toBe(
      searchedEverything(root, HINT_MAX_DIRS) +
        stoppedAt(`${HINT_MAX_DIRS} directories`) +
        generatorSentence("Visual Studio 18 2026"),
    );
  });
});

interface BuildTree {
  readonly base: string;
  readonly parent: string;
  readonly root: string;
  readonly at: (name: string) => string;
}

/** `<base>/build/preset` as `projectRoot`, so its siblings sit inside a build-named parent. */
function buildTree(siblings: Readonly<Record<string, string | undefined>> = {}): BuildTree {
  const base = mkdtempSync(join(tmpdir(), "mcp-code-nav-hint13-"));
  tempDirs.push(base);
  const parent = join(base, "build");
  const root = join(parent, "preset");
  mkdirSync(root, { recursive: true });
  const tree: BuildTree = { base, parent, root, at: (name) => join(parent, name) };
  for (const [name, db] of Object.entries(siblings)) putSibling(tree.at(name), db);
  return tree;
}

function putSibling(dir: string, db: string | undefined): void {
  mkdirSync(dir, { recursive: true });
  if (db !== undefined) writeFileSync(join(dir, DB), db);
}

const nativeDb = (directory: string): string => `[{"directory": ${JSON.stringify(directory)}, "file": "a.cpp"}]`;

const nativeSentence = (...dirs: readonly string[]): string =>
  ` Sibling build directories that hold one from this host: ${dirs.map((dir) => `"${dir}"`).join(", ")}. ` +
  "Pass one of them as projectRoot if it is the build you meant.";
const skippedSentence = (count: number): string =>
  ` Skipped ${count} sibling compile_commands.json naming paths that do not exist on this host.`;
const siblingsStoppedAt = (bound: string): string =>
  ` The sibling search stopped at its bound (${bound}), so it may have missed candidates.`;

describe("the sibling search", () => {
  it("offers a host-native sibling and counts the foreign ones, in that order after variant 2's body", async () => {
    const tree = buildTree();
    putSibling(tree.at("a"), nativeDb(tree.base));
    putSibling(tree.at("b"), nativeDb("/work/src"));
    putSibling(tree.at("c"), '[{"file": "a.cpp"}]');
    putSibling(tree.at("d"), '[{"directory": "bad\\q"}]');

    await expect(describeMissingCompileDb(tree.root)).resolves.toBe(
      searchedEverything(tree.root, 1) + nativeSentence(tree.at("a")) + skippedSentence(3),
    );
  });

  it("treats a relative, missing, file-valued or unreadable head as foreign", async () => {
    const tree = buildTree();
    const aFile = join(tree.base, "a-file.txt");
    writeFileSync(aFile, "");
    putSibling(tree.at("a"), nativeDb("relative/dir"));
    putSibling(tree.at("b"), nativeDb(join(tree.base, "no-such-dir")));
    putSibling(tree.at("c"), nativeDb(aFile));
    putSibling(tree.at("d"), nativeDb(tree.base));
    const unreadable = join(tree.at("d"), DB);
    const mixed: ReadFile = async (path, maxBytes) =>
      path === unreadable ? undefined : (await readFileReal(path, "utf8")).slice(0, maxBytes);

    await expect(describeMissingCompileDb(tree.root, { readFile: mixed })).resolves.toBe(
      searchedEverything(tree.root, 1) + skippedSentence(4),
    );
  });

  it("reads only the head of a database, decoding an escaped Windows path", async () => {
    const tree = buildTree();
    const asked: number[] = [];
    putSibling(tree.at("a"), "x");
    const readFile: ReadFile = async (path, maxBytes) => {
      if (path.endsWith(DB)) asked.push(maxBytes);
      return `[{"directory": ${JSON.stringify(tree.base)}`;
    };

    await expect(describeMissingCompileDb(tree.root, { readFile })).resolves.toBe(
      searchedEverything(tree.root, 1) + nativeSentence(tree.at("a")),
    );
    expect(asked).toEqual([DB_HEAD_BYTES]);
  });

  it("runs in variant 3, beside an absent projectRoot", async () => {
    const tree = buildTree({ a: nativeDb(tmpdir()) });
    const absent = tree.at("gone");

    await expect(describeMissingCompileDb(absent)).resolves.toBe(
      `${headAt(absent)}. That directory does not exist.${nativeSentence(tree.at("a"))}`,
    );
  });

  it("runs in variant 5, after the generator sentence", async () => {
    const tree = buildTree({ a: nativeDb(tmpdir()) });
    const refusing: ReaddirFn = async (dir) => {
      if (dir === tree.root) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return readdirReal(dir, { withFileTypes: true });
    };
    const readFile: ReadFile = async (path) =>
      path === cacheAt(tree.root) ? cacheOf(NINJA) : `[{"directory": ${JSON.stringify(tmpdir())}}]`;

    await expect(describeMissingCompileDb(tree.root, { readdir: refusing, readFile })).resolves.toBe(
      `${headAt(tree.root)}. That directory's own listing could not be read (EACCES), ` +
        "so nothing below it was searched." +
        NO_EXPORT +
        nativeSentence(tree.at("a")),
    );
  });

  it("is not run for variant 1, nor variant 4", async () => {
    const tree = buildTree({ a: nativeDb(tmpdir()) });
    putSibling(join(tree.root, "inner"), "[]");
    const readdir = vi.fn<ReaddirFn>((dir) => readdirReal(dir, { withFileTypes: true }));

    await expect(describeMissingCompileDb(tree.root, { readdir })).resolves.toBe(
      `${headAt(tree.root)}${named(join(tree.root, "inner"))}`,
    );
    expect(readdir.mock.calls.every(([dir]) => dir.startsWith(tree.root))).toBe(true);

    const unreadable = buildTree({ a: nativeDb(tmpdir()) });
    mkdirSync(join(unreadable.root, DB));
    readdir.mockClear();
    await expect(describeMissingCompileDb(unreadable.root, { readdir })).resolves.toBe(
      `${headAt(unreadable.root)}. The file is present but could not be read.`,
    );
    expect(readdir).not.toHaveBeenCalled();
  });

  it("offers a neighbour of a repository-root projectRoot only if it is build-named", async () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-code-nav-hint13-"));
    tempDirs.push(base);
    const repo = join(base, "repo");
    mkdirSync(repo);
    for (const name of ["other-project", "build-x", "out", "cmake-build-debug"]) {
      putSibling(join(base, name), nativeDb(base));
    }

    await expect(describeMissingCompileDb(repo)).resolves.toBe(
      searchedEverything(repo, 1) +
        nativeSentence(join(base, "build-x"), join(base, "cmake-build-debug"), join(base, "out")),
    );
  });

  it("offers every sibling when the parent is itself build-named", async () => {
    const tree = buildTree({ linux: nativeDb(tmpdir()) });

    await expect(describeMissingCompileDb(tree.root)).resolves.toBe(
      searchedEverything(tree.root, 1) + nativeSentence(tree.at("linux")),
    );
  });

  it("skips projectRoot's own name, the skipped names, links and files, and a sibling without a database", async () => {
    const tree = buildTree();
    const reads: string[] = [];
    const entry = (name: string, kind: "dir" | "file" | "link"): DirEntry => ({
      name,
      isFile: () => kind === "file",
      isDirectory: () => kind === "dir",
    });
    const readdir: ReaddirFn = async (dir) => {
      reads.push(dir);
      return dir === tree.parent
        ? [
            entry("preset", "dir"),
            entry(".git", "dir"),
            entry("node_modules", "dir"),
            entry("linked", "link"),
            entry("plain", "dir"),
            entry("file", "file"),
          ]
        : [];
    };

    await expect(describeMissingCompileDb(tree.root, { readdir })).resolves.toBe(searchedEverything(tree.root, 1));
    expect(reads).toEqual([tree.root, tree.parent, tree.at("plain")]);
  });

  it("stops at three native candidates, in lexical order, and names no bound", async () => {
    const tree = buildTree();
    for (const name of ["d", "b", "a", "c"]) putSibling(tree.at(name), nativeDb(tree.base));

    await expect(describeMissingCompileDb(tree.root)).resolves.toBe(
      searchedEverything(tree.root, 1) + nativeSentence(tree.at("a"), tree.at("b"), tree.at("c")),
    );
  });
});

describe("the sibling bounds", () => {
  const siblingNames = (count: number): readonly DirEntry[] =>
    Array.from({ length: count }, (_unused, index) => ({
      name: `s${String(index).padStart(2, "0")}`,
      isFile: () => false,
      isDirectory: () => true,
    }));

  it("lists at most 64 sibling directories and names that bound", async () => {
    const tree = buildTree();
    const reads: string[] = [];
    const readdir: ReaddirFn = async (dir) => {
      reads.push(dir);
      return dir === tree.parent ? siblingNames(70) : [];
    };

    const text = await describeMissingCompileDb(tree.root, { readdir, now: () => 0 });

    expect(reads.filter((dir) => dir !== tree.root && dir !== tree.parent)).toHaveLength(SIBLING_MAX_LISTINGS);
    expect(text).toBe(searchedEverything(tree.root, 1) + siblingsStoppedAt("64 directories"));
  });

  it("names no bound for exactly 64 siblings", async () => {
    const tree = buildTree();
    const readdir: ReaddirFn = async (dir) => (dir === tree.parent ? siblingNames(SIBLING_MAX_LISTINGS) : []);

    await expect(describeMissingCompileDb(tree.root, { readdir, now: () => 0 })).resolves.toBe(
      searchedEverything(tree.root, 1),
    );
  });

  it("shares the clock with the downward search and names the millisecond bound", async () => {
    const tree = buildTree({ a: nativeDb(tmpdir()), b: nativeDb(tmpdir()) });
    // Reads: startedAt, the root listing's budget, the parent's, the first sibling's, then it has spent the second.
    const readings = [0, 0, 400, 500, 1000];
    let index = 0;

    const text = await describeMissingCompileDb(tree.root, { now: () => readings[index++] ?? 1000 });

    expect(text).toBe(searchedEverything(tree.root, 1) + siblingsStoppedAt(`${HINT_MAX_MS} ms`));
  });

  it("walks away from a head read that never answers, inside the bound it states", async () => {
    const tree = buildTree({ a: nativeDb(tmpdir()) });
    const readings = [0, 0, 0, 0, HINT_MAX_MS - 5];
    let index = 0;
    const startedAt = Date.now();

    const text = await describeMissingCompileDb(tree.root, {
      now: () => readings[index++] ?? HINT_MAX_MS - 5,
      readFile: (path) => (path.endsWith(DB) ? new Promise(() => {}) : Promise.resolve(undefined)),
    });

    expect(text).toBe(searchedEverything(tree.root, 1) + siblingsStoppedAt(`${HINT_MAX_MS} ms`));
    expect(Date.now() - startedAt).toBeLessThan(HINT_MAX_MS);
  });

  it("adds nothing when the parent's own listing fails", async () => {
    const tree = buildTree({ a: nativeDb(tmpdir()) });
    const readdir: ReaddirFn = async (dir) => {
      if (dir === tree.parent) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return readdirReal(dir, { withFileTypes: true });
    };

    await expect(describeMissingCompileDb(tree.root, { readdir })).resolves.toBe(searchedEverything(tree.root, 1));
  });

  it("skips a sibling whose own listing fails and still offers the next", async () => {
    const tree = buildTree({ a: nativeDb(tmpdir()), b: nativeDb(tmpdir()) });
    const readdir: ReaddirFn = async (dir) => {
      if (dir === tree.at("a")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return readdirReal(dir, { withFileTypes: true });
    };

    await expect(describeMissingCompileDb(tree.root, { readdir })).resolves.toBe(
      searchedEverything(tree.root, 1) + nativeSentence(tree.at("b")),
    );
  });
});

describe("the real file reader behind the seam", () => {
  it("reads only the head of a database larger than the bound", async () => {
    const tree = buildTree();
    const early = nativeDb(tree.base) + " ".repeat(DB_HEAD_BYTES * 2);
    const late = " ".repeat(DB_HEAD_BYTES + 10) + nativeDb(tree.base);
    putSibling(tree.at("early"), early);
    putSibling(tree.at("late"), late);

    // The late database's first "directory" lies past the head, so only the early one is host-native.
    await expect(describeMissingCompileDb(tree.root)).resolves.toBe(
      searchedEverything(tree.root, 1) + nativeSentence(tree.at("early")) + skippedSentence(1),
    );
  });

  it("reads a real CMakeCache.txt, and ignores a directory wearing its name", async () => {
    const root = makeRoot();
    writeFileSync(cacheAt(root), cacheOf(VS));
    const other = makeRoot();
    mkdirSync(cacheAt(other));

    await expect(describeMissingCompileDb(root)).resolves.toBe(
      searchedEverything(root, 1) + generatorSentence("Visual Studio 18 2026"),
    );
    await expect(describeMissingCompileDb(other)).resolves.toBe(searchedEverything(other, 2));
  });
});

describe("the generator read", () => {
  it("gives the generator read its own bound when the downward search spent the clock", async () => {
    const root = makeRoot();
    let spent = false;
    const now = (): number => (spent ? HINT_MAX_MS : 0);
    const readdir: ReaddirFn = async () => {
      spent = true;
      return [];
    };
    const startedAt = Date.now();

    const text = await describeMissingCompileDb(root, {
      now,
      readdir,
      readFile: () => new Promise(() => {}),
    });

    expect(text).toBe(searchedEverything(root, 1) + siblingsStoppedAt(`${HINT_MAX_MS} ms`));
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(HINT_MAX_MS - 50);
  }, 10_000);
});
