import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectFingerprint } from "../../src/clang-query/project-fingerprint.js";
import {
  UNCOVERED_SOURCES_LIMIT,
  computeUncoveredSources,
  filterIgnoredSources,
  unlistedTranslationUnits,
  uncoveredSourcesBlock,
  type UncoveredSourceFacts,
  type UncoveredSourcesUnavailable,
} from "../../src/clang-query/uncovered-sources.js";

/** A walk that proves everything, field by field — each test breaks exactly one proof. */
function walk(proven: Partial<ProjectFingerprint> = {}): ProjectFingerprint {
  return {
    fingerprint: "0d0e0a0d",
    entriesScanned: 4,
    sourceTus: ["/repo/src/a.cpp"],
    walkIncomplete: false,
    unreachableSourceRoots: [],
    ...proven,
  };
}

function facts(overrides: Partial<UncoveredSourceFacts> = {}): UncoveredSourceFacts {
  return {
    roots: ["/build", "/repo"],
    walk: walk(),
    compileDbTus: ["/repo/src/a.cpp"],
    readIgnoredPaths: () => [],
    ...overrides,
  };
}

describe("computeUncoveredSources", () => {
  it("names the visited sources no database entry compiles", () => {
    const result = computeUncoveredSources(["/repo/a.cpp"], ["/repo/a.cpp", "/repo/b.cpp"]);
    expect(result).toEqual({ count: 1, files: ["/repo/b.cpp"] });
  });

  it("counts zero, and says so with an empty file list, when every source is compiled", () => {
    expect(computeUncoveredSources(["/repo/a.cpp"], ["/repo/a.cpp"])).toEqual({ count: 0, files: [] });
  });

  it("counts zero when there is nothing to claim about at all", () => {
    expect(computeUncoveredSources(["/repo/a.cpp"], [])).toEqual({ count: 0, files: [] });
    expect(computeUncoveredSources([], [])).toEqual({ count: 0, files: [] });
  });

  it("is indifferent to database entries the walk never reached", () => {
    const result = computeUncoveredSources(["/repo/a.cpp", "/elsewhere/x.cpp", "/vendor/y.cc"], ["/repo/a.cpp"]);
    expect(result).toEqual({ count: 0, files: [] });
  });

  it("resolves both sides, so a database spelling carrying . or .. still counts as compiled", () => {
    const absolute = resolve("src/a.cpp");
    expect(computeUncoveredSources(["./src/../src/a.cpp"], [absolute])).toEqual({ count: 0, files: [] });
    // A different file is still a different file, however both are spelled.
    expect(computeUncoveredSources(["./src/../src/a.cpp"], ["/repo/src/a.cpp"])).toEqual({
      count: 1,
      files: ["/repo/src/a.cpp"],
    });
  });

  it("folds case only where the platform folds it: win32 matches, a case-sensitive platform does not", () => {
    // A compile database need not spell a path the way the walk does. On win32 the difference is nothing;
    // on posix it is a different file, and calling it uncovered is correct there.
    const result = computeUncoveredSources(["/repo/a.cpp"], ["/REPO/A.CPP"]);
    expect(result.count).toBe(process.platform === "win32" ? 0 : 1);
  });

  it("counts one physical source spelled twice, in the first spelling it was given", () => {
    const result = computeUncoveredSources([], ["/REPO/A.CPP", "/repo/a.cpp"]);
    if (process.platform === "win32") expect(result).toEqual({ count: 1, files: ["/REPO/A.CPP"] });
    else expect(result).toEqual({ count: 2, files: ["/REPO/A.CPP", "/repo/a.cpp"] });
  });

  it("keeps `count` exact while `files` stops at the cap, in normalised-key order", () => {
    const sources = Array.from({ length: 25 }, (_, i) => `/repo/src/f${String(i).padStart(2, "0")}.cpp`);
    const result = computeUncoveredSources([], sources.reverse());
    expect(result.count).toBe(25);
    expect(result.files).toHaveLength(UNCOVERED_SOURCES_LIMIT);
    expect(result.files[0]).toBe("/repo/src/f00.cpp");
    expect(result.files.at(-1)).toBe("/repo/src/f19.cpp");
    // The cap is what the payload carries; a caller can tell a prefix from the count alone.
    expect(result.count).toBeGreaterThan(result.files.length);
  });

  it("takes the cap from the caller when it asks for one", () => {
    const result = computeUncoveredSources([], ["/repo/a.cpp", "/repo/b.cpp", "/repo/c.cpp"], 2);
    expect(result).toEqual({ count: 3, files: ["/repo/a.cpp", "/repo/b.cpp"] });
  });

  it("caps at 20 by default", () => {
    expect(UNCOVERED_SOURCES_LIMIT).toBe(20);
  });
});

describe("unlistedTranslationUnits", () => {
  it("keeps the caller's order and spelling, and drops what the database compiles", () => {
    expect(unlistedTranslationUnits(["/repo/z.cpp", "/repo/a.cpp", "/repo/b.cpp"], ["/repo/b.cpp"])).toEqual([
      "/repo/z.cpp",
      "/repo/a.cpp",
    ]);
  });

  it("reports one entry per physical file, so a named file spelled twice is not two blind spots", () => {
    const unlisted = unlistedTranslationUnits(["/repo/a.cpp", "/repo/A.CPP"], []);
    expect(unlisted).toHaveLength(process.platform === "win32" ? 1 : 2);
  });
});

describe("filterIgnoredSources", () => {
  it("keeps everything when no pattern is configured, without sharing the input array", () => {
    const sources = ["/repo/a.cpp", "/repo/b.cpp"];
    const kept = filterIgnoredSources(sources, ["/build", "/repo"], []);
    expect(kept).toEqual(sources);
    expect(kept).not.toBe(sources);
  });

  it("keys the matcher to the root that contains the source, not to roots[0]", () => {
    // "vendor/*" is written against /repo. Keyed to /build the relative path starts with ".." and the
    // pattern could never match, so a vendored source would be reported as a blind spot forever.
    const sources = ["/repo/vendor/x.cpp", "/repo/src/a.cpp"];
    expect(filterIgnoredSources(sources, ["/build", "/repo"], ["vendor/*"])).toEqual(["/repo/src/a.cpp"]);
  });

  it("keys a source under roots[0] to roots[0]", () => {
    const sources = ["/build/generated/a.cpp", "/build/src/b.cpp"];
    expect(filterIgnoredSources(sources, ["/build"], ["generated/*"])).toEqual(["/build/src/b.cpp"]);
  });

  it("matches case-sensitively, because isIgnoredPath does", () => {
    const sources = ["/repo/vendor/x.cpp"];
    expect(filterIgnoredSources(sources, ["/repo"], ["Vendor/*"])).toEqual(sources);
  });

  it("keeps a source it cannot place under any root rather than silently dropping it", () => {
    const sources = ["/elsewhere/x.cpp"];
    expect(filterIgnoredSources(sources, ["/build", "/repo"], ["**/*.cpp"])).toEqual(sources);
  });
});

describe("uncoveredSourcesBlock", () => {
  it("carries the set when every fact needed to prove it is in hand", () => {
    const block = uncoveredSourcesBlock(facts());
    expect(block).toEqual({ uncoveredSources: { count: 0, files: [] } });
    expect("uncoveredSourcesUnavailable" in block).toBe(false);
  });

  it("filters ignoredPaths before the difference, so a hidden source is neither counted nor named", () => {
    const block = uncoveredSourcesBlock(
      facts({
        walk: walk({ sourceTus: ["/repo/src/a.cpp", "/repo/vendor/x.cpp"] }),
        compileDbTus: ["/repo/src/a.cpp"],
        readIgnoredPaths: () => ["vendor/*"],
      }),
    );
    expect(block).toEqual({ uncoveredSources: { count: 0, files: [] } });
  });

  it("reads the project config only after the walk's own four proofs have held", () => {
    const refused: [ProjectFingerprint, UncoveredSourcesUnavailable][] = [
      [walk({ sourceTus: undefined }), "no-source-roots"],
      [walk({ fingerprint: undefined }), "walk-bounded"],
      [walk({ walkIncomplete: true }), "walk-incomplete"],
      [walk({ unreachableSourceRoots: ["/repo/build_tools/src"] }), "root-under-skipped-dir"],
    ];
    for (const [brokenWalk, reason] of refused) {
      let reads = 0;
      const block = uncoveredSourcesBlock(
        facts({ walk: brokenWalk, readIgnoredPaths: () => { reads++; return []; } }),
      );
      expect(block).toEqual({ uncoveredSourcesUnavailable: reason });
      expect(reads).toBe(0);
    }
    let reached = 0;
    uncoveredSourcesBlock(facts({ readIgnoredPaths: () => { reached++; return []; } }));
    // Once, and only once: the filter reads the patterns it was handed, not the disk.
    expect(reached).toBe(1);
  });

  it("walks the reasons in the declared order, one proof at a time", () => {
    let current = facts({
      walk: walk({
        fingerprint: undefined,
        sourceTus: undefined,
        walkIncomplete: true,
        unreachableSourceRoots: ["/repo/build_tools/src"],
      }),
      compileDbTus: undefined,
      readIgnoredPaths: () => undefined,
    });
    const unavailableReason = (): UncoveredSourcesUnavailable | undefined => {
      const block = uncoveredSourcesBlock(current);
      return "uncoveredSourcesUnavailable" in block ? block.uncoveredSourcesUnavailable : undefined;
    };

    expect(unavailableReason()).toBe("no-source-roots");
    current = { ...current, walk: { ...current.walk, sourceTus: ["/repo/src/a.cpp"] } };
    expect(unavailableReason()).toBe("walk-bounded");
    current = { ...current, walk: { ...current.walk, fingerprint: "0d0e0a0d" } };
    expect(unavailableReason()).toBe("walk-incomplete");
    current = { ...current, walk: { ...current.walk, walkIncomplete: false } };
    expect(unavailableReason()).toBe("root-under-skipped-dir");
    current = { ...current, walk: { ...current.walk, unreachableSourceRoots: [] } };
    expect(unavailableReason()).toBe("ignored-paths-unreadable");
    current = { ...current, readIgnoredPaths: () => [] };
    expect(unavailableReason()).toBe("compile-db-unlistable");
    current = { ...current, compileDbTus: ["/repo/src/a.cpp"] };
    expect(uncoveredSourcesBlock(current)).toEqual({ uncoveredSources: { count: 0, files: [] } });
  });

  it("prefers the honest reason over a confident zero when a root was deduped under a skipped directory", () => {
    // Everything the walk did reach is compiled, so the difference alone would say "count: 0" — which is
    // exactly the false zero this reason exists to refuse.
    const block = uncoveredSourcesBlock(
      facts({ walk: walk({ unreachableSourceRoots: ["/repo/build_tools/src"] }) }),
    );
    expect(block).toEqual({ uncoveredSourcesUnavailable: "root-under-skipped-dir" });
  });

  it("refuses to claim anything when the walk hit its entry bound, whatever else it collected", () => {
    const block = uncoveredSourcesBlock(
      facts({ walk: walk({ fingerprint: undefined, reason: "bounded", sourceTus: ["/repo/x.cpp"] }) }),
    );
    expect(block).toEqual({ uncoveredSourcesUnavailable: "walk-bounded" });
  });

  it("is a reason, not a zero, when no source root was declared", () => {
    const block = uncoveredSourcesBlock(facts({ walk: walk({ sourceTus: undefined }) }));
    expect(block).toEqual({ uncoveredSourcesUnavailable: "no-source-roots" });
  });
});
