import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tsWorkspaceRootErrorText } from "../../src/tools/ts-shared.js";
import type { TsgoBinaryDeps } from "../../src/tsgo/binary.js";
import type { WorkspaceRootOutcome } from "../../src/tsgo/workspace-root.js";

type OutsideRoots = Extract<WorkspaceRootOutcome, { kind: "outside-roots" }>;
type NotInPackage = Extract<WorkspaceRootOutcome, { kind: "not-in-package" }>;

/** The package the file belongs to, and the two roots the caller declared instead of it. */
const OUTSIDE: OutsideRoots = {
  kind: "outside-roots",
  workspaceRoot: "C:/repo/packages/ui-kit",
  declaredRoots: ["C:/repo/apps/cli", "C:/other/repo"],
};

const FILE = "C:/repo/packages/ui-kit/src/index.ts";

/** `cachedTsgoBinary` holds one module-level answer, so each caching test needs a fresh copy of the module. */
async function freshCachedBinary() {
  vi.resetModules();
  return (await import("../../src/tools/ts-shared.js")).cachedTsgoBinary;
}

const NPM_GLOBAL = "C:/fake/npm-global";

/** Paths are built with `join`, because that is what the locator itself answers with. */
const TYPESCRIPT_DIR = join(NPM_GLOBAL, "typescript");
const NATIVE_DIR = join(TYPESCRIPT_DIR, "node_modules", "@typescript", "typescript-win32-x64");
const EXECUTABLE = join(NATIVE_DIR, "lib", "tsc.exe");

/** A global tree with a `typescript@7` package and its platform executable; `asks` counts every `npm` run. */
function installedDeps(asks: { npm: number }): Partial<TsgoBinaryDeps> {
  return {
    platform: "win32",
    arch: "x64",
    override: "",
    exec: async () => {
      asks.npm += 1;
      return { stdout: `${NPM_GLOBAL}\n`, stderr: "", exitCode: 0 };
    },
    readJson: (path) => {
      if (path === join(TYPESCRIPT_DIR, "package.json")) return { name: "typescript", version: "7.0.2" };
      if (path === join(NATIVE_DIR, "package.json")) return { name: "@typescript/typescript-win32-x64" };
      return undefined;
    },
    exists: (path) => path === NPM_GLOBAL || path === EXECUTABLE,
  };
}

/** The same `npm root -g` answer with no readable `typescript/package.json` under it: every search misses. */
function missingInstallDeps(asks: { npm: number }): Partial<TsgoBinaryDeps> {
  return {
    platform: "win32",
    arch: "x64",
    override: "",
    exec: async () => {
      asks.npm += 1;
      return { stdout: `${NPM_GLOBAL}\n`, stderr: "", exitCode: 0 };
    },
    readJson: () => undefined,
    exists: (path) => path === NPM_GLOBAL,
  };
}

describe("tsWorkspaceRootErrorText", () => {
  it("names the package, the file and every declared root when the package lies outside the boundary", () => {
    expect(tsWorkspaceRootErrorText("ts_file_symbols", OUTSIDE, FILE)).toBe(
      'ts_file_symbols failed: "C:/repo/packages/ui-kit/src/index.ts" belongs to the npm package ' +
        '"C:/repo/packages/ui-kit" (its nearest package.json), which is outside every declared ' +
        'sourceRoots entry: "C:/repo/apps/cli", "C:/other/repo". Add that package\'s directory to ' +
        "sourceRoots - this server will not root tsgo outside the boundary you declared.",
    );
  });

  it("names the directory the search started from when no package.json exists above the file", () => {
    const outcome: NotInPackage = { kind: "not-in-package", searchedFrom: "C:/Users/dev/scratch" };
    expect(tsWorkspaceRootErrorText("ts_find_references", outcome, "C:/Users/dev/scratch/a.ts")).toBe(
      'ts_find_references failed: "C:/Users/dev/scratch/a.ts" is not inside an npm package - no package.json ' +
        'exists in "C:/Users/dev/scratch" or any parent directory up to the filesystem root. tsgo answers ' +
        "for the workspace holding a file; name one inside a package.",
    );
  });
});

describe("cachedTsgoBinary", () => {
  it("asks again after a miss, because a search that failed once is not a fact about the host", async () => {
    const cached = await freshCachedBinary();
    const asks = { npm: 0 };
    const first = await cached(missingInstallDeps(asks));
    const second = await cached(missingInstallDeps(asks));
    expect("unavailable" in first).toBe(true);
    expect("unavailable" in second).toBe(true);
    expect(asks.npm).toBe(2);
  });

  it("keeps the answer once it has found the server, so the next call does not ask `npm` again", async () => {
    const cached = await freshCachedBinary();
    const asks = { npm: 0 };
    const first = await cached(installedDeps(asks));
    const secondAsks = { npm: 0 };
    const second = await cached(installedDeps(secondAsks));
    expect(first).toEqual({ binary: { executable: EXECUTABLE, version: "7.0.2", source: "global" } });
    expect(second).toEqual(first);
    expect(asks.npm).toBe(1);
    expect(secondAsks.npm).toBe(0);
  });
});
