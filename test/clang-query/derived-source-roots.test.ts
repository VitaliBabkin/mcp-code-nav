import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundedAncestors,
  cppSourceRoots,
  deriveSourceRoot,
  SOURCE_ROOT_MAX_ASCENT,
  type SourceRootDerivation,
} from "../../src/clang-query/derived-source-roots.js";

// Paths are built with `resolve`, so every case holds on the platform's own separators and on
// the current drive; nothing here touches the disk.

const at = (...segments: string[]): string => resolve("/", ...segments);

const derived = (root: string, tusOutsideRoots = 0): SourceRootDerivation => ({
  kind: "derived",
  root,
  tusOutsideRoots,
});
const none = (reason: "compile-db-unlistable" | "sources-under-project-root" | "no-ancestor-holds-sources") =>
  ({ kind: "none", reason }) as const;

describe("the ascent bound", () => {
  it("is four levels", () => {
    expect(SOURCE_ROOT_MAX_ASCENT).toBe(4);
  });
});

describe("deriveSourceRoot", () => {
  it("lands on the repository for the usual out-of-tree layout, repo/build/preset", () => {
    const projectRoot = at("work", "repo", "build", "preset");

    expect(deriveSourceRoot(projectRoot, [at("work", "repo", "src", "a.cpp")])).toEqual(derived(at("work", "repo")));
  });

  it("passes over `out` and `build` ancestors: out/build/x64-Debug gives the repository, at level 3", () => {
    const projectRoot = at("work", "repo", "out", "build", "x64-Debug");

    expect(deriveSourceRoot(projectRoot, [at("work", "repo", "src", "a.cpp")])).toEqual(derived(at("work", "repo")));
  });

  it("passes over `.claude`: .claude/worktrees/v2/build/p gives v2", () => {
    const projectRoot = at("work", "repo", ".claude", "worktrees", "v2", "build", "p");

    expect(deriveSourceRoot(projectRoot, [at("work", "repo", ".claude", "worktrees", "v2", "src", "a.cpp")])).toEqual(
      derived(at("work", "repo", ".claude", "worktrees", "v2")),
    );
  });

  it("never lands on a build directory that holds a TU: repo/build/_deps/x.cpp beside repo/src/y.cpp gives repo", () => {
    const projectRoot = at("work", "repo", "build", "preset");
    const tus = [at("work", "repo", "build", "_deps", "x.cpp"), at("work", "repo", "src", "y.cpp")];

    expect(deriveSourceRoot(projectRoot, tus)).toEqual(derived(at("work", "repo")));
  });

  it("lands on the broader non-skipped ancestor when the only outside TU sits under a skip-named one", () => {
    const projectRoot = at("work", "repo", "out", "build", "p");

    // `build` and `out` both hold the TU, and both are passed over: the walk goes on to `repo`.
    expect(deriveSourceRoot(projectRoot, [at("work", "repo", "out", "gen", "x.cpp")])).toEqual(
      derived(at("work", "repo")),
    );
  });

  it("accepts a shared parent as the root when the database compiles only a sibling directory", () => {
    const projectRoot = at("tmp", "a", "build");

    // Within the four levels and holding a TU, so `tmp` is a derived root: that is intended, not a defect.
    expect(deriveSourceRoot(projectRoot, [at("tmp", "b", "src", "x.cpp")])).toEqual(derived(at("tmp")));
  });

  it("is not a failure when every TU is under projectRoot (an in-source build)", () => {
    const projectRoot = at("work", "repo");

    expect(deriveSourceRoot(projectRoot, [at("work", "repo", "src", "a.cpp")])).toEqual(
      none("sources-under-project-root"),
    );
  });

  it("is not a failure for an empty database", () => {
    expect(deriveSourceRoot(at("work", "repo", "build"), [])).toEqual(none("sources-under-project-root"));
  });

  it("finds nothing for a Docker-style database whose paths sit under no ancestor", () => {
    const projectRoot = at("work", "repo", "build", "linux-gcc-release");

    expect(deriveSourceRoot(projectRoot, [at("docker-work", "src", "a.cpp")])).toEqual(
      none("no-ancestor-holds-sources"),
    );
  });

  it("finds nothing for a TU only at the fifth level up", () => {
    const projectRoot = at("a", "b", "c", "d", "e", "f");
    // Levels: e (1), d (2), c (3), b (4); `a` is level 5 and holds the TU, `b` does not.
    const tus = [at("a", "x", "t.cpp")];

    expect(deriveSourceRoot(projectRoot, tus)).toEqual(none("no-ancestor-holds-sources"));
    expect(deriveSourceRoot(at("a", "b", "c", "d", "e"), tus)).toEqual(derived(at("a")));
  });

  it("never yields a filesystem root, for a projectRoot one level below it", () => {
    const projectRoot = at("proj");

    expect(deriveSourceRoot(projectRoot, [at("elsewhere", "a.cpp")])).toEqual(none("no-ancestor-holds-sources"));
  });

  it("never yields a filesystem root, even when the ascent would reach it inside four levels", () => {
    const projectRoot = at("a", "build");

    expect(deriveSourceRoot(projectRoot, [at("z", "a.cpp")])).toEqual(none("no-ancestor-holds-sources"));
  });

  it("names one root only: a sibling repository's TU does not widen it and is counted", () => {
    const projectRoot = at("work", "repo", "build", "preset");
    const tus = [at("work", "repo", "src", "a.cpp"), at("work", "base-lib", "src", "b.cpp")];

    expect(deriveSourceRoot(projectRoot, tus)).toEqual(derived(at("work", "repo"), 1));
  });

  it("counts every TU the root does not hold, not only the first", () => {
    const projectRoot = at("work", "repo", "build");
    const tus = [at("work", "repo", "a.cpp"), at("work", "x", "b.cpp"), at("work", "y", "c.cpp")];

    expect(deriveSourceRoot(projectRoot, tus)).toEqual(derived(at("work", "repo"), 2));
  });

  it("does not count the TUs under projectRoot as outside", () => {
    const projectRoot = at("work", "repo", "build");
    const tus = [at("work", "repo", "build", "gen.cpp"), at("work", "repo", "src", "a.cpp")];

    expect(deriveSourceRoot(projectRoot, tus)).toEqual(derived(at("work", "repo")));
  });

  it.skipIf(process.platform !== "win32")("contains win32 spellings that differ only in case", () => {
    const projectRoot = at("Work", "Repo", "build", "preset");

    expect(deriveSourceRoot(projectRoot, [at("work", "repo", "SRC", "a.cpp")])).toEqual(derived(at("Work", "Repo")));
  });

  it("answers compile-db-unlistable when the TU list is unavailable", () => {
    expect(deriveSourceRoot(at("work", "repo", "build"), undefined)).toEqual(none("compile-db-unlistable"));
  });
});

describe("boundedAncestors", () => {
  it("lists the ancestors nearest first, every level counted, and never a filesystem root", () => {
    expect(boundedAncestors(at("a", "b", "c", "d", "e", "f"))).toEqual([
      at("a", "b", "c", "d", "e"),
      at("a", "b", "c", "d"),
      at("a", "b", "c"),
      at("a", "b"),
    ]);
    expect(boundedAncestors(at("a", "b"))).toEqual([at("a")]);
    expect(boundedAncestors(at("a"))).toEqual([]);
  });
});

describe("cppSourceRoots", () => {
  const unreachable = (): SourceRootDerivation => {
    throw new Error("a declared list derives nothing");
  };

  it("takes a non-empty declared list as given and derives nothing", () => {
    expect(cppSourceRoots([at("one"), at("two")], unreachable)).toEqual({
      origin: "declared",
      roots: [at("one"), at("two")],
    });
  });

  it("reports a derived root with the count of TUs it did not hold", () => {
    expect(cppSourceRoots([], () => derived(at("repo"), 2))).toEqual({
      origin: "derived",
      roots: [at("repo")],
      tusOutsideRoots: 2,
    });
  });

  it("reports projectRoot alone, with the reason, when nothing was derived", () => {
    expect(cppSourceRoots([], () => none("no-ancestor-holds-sources"))).toEqual({
      origin: "project-root-only",
      roots: [],
      reason: "no-ancestor-holds-sources",
    });
  });
});
