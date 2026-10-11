import { describe, expect, it } from "vitest";
import { SweepCache, type TuOutcome } from "../../src/clang-query/sweep-cache.js";

const MATCH_OUTCOME: TuOutcome = {
  kind: "matches",
  matches: [{ className: "Derived", file: "/proj/derived.h", line: 3, column: 1, direct: false }],
};
const FAILED_OUTCOME: TuOutcome = { kind: "failed", error: "compile error" };

describe("SweepCache", () => {
  it("returns an empty map for a projectRoot it has never seen", () => {
    const cache = new SweepCache();
    expect(cache.lookup("/proj", "Base", "fp1").size).toBe(0);
  });

  it("returns a stored TU outcome under the fingerprint it was stored with", () => {
    const cache = new SweepCache();
    cache.store("/proj", "Base", "fp1", "/proj/a.cpp", MATCH_OUTCOME);
    expect(cache.lookup("/proj", "Base", "fp1").get("/proj/a.cpp")).toEqual(MATCH_OUTCOME);
  });

  it("resolves a relative projectRoot spelling onto the same entry as the absolute one", () => {
    const cache = new SweepCache();
    cache.store("/proj/../proj", "Base", "fp1", "/proj/a.cpp", MATCH_OUTCOME);
    expect(cache.lookup("/proj", "Base", "fp1").get("/proj/a.cpp")).toEqual(MATCH_OUTCOME);
  });

  it("keeps separate TU maps per qualifiedName under the same projectRoot and fingerprint", () => {
    const cache = new SweepCache();
    cache.store("/proj", "Base", "fp1", "/proj/a.cpp", MATCH_OUTCOME);
    cache.store("/proj", "Other", "fp1", "/proj/a.cpp", FAILED_OUTCOME);
    expect(cache.lookup("/proj", "Base", "fp1").get("/proj/a.cpp")).toEqual(MATCH_OUTCOME);
    expect(cache.lookup("/proj", "Other", "fp1").get("/proj/a.cpp")).toEqual(FAILED_OUTCOME);
  });

  it("keeps separate projects independent", () => {
    const cache = new SweepCache();
    cache.store("/proj-a", "Base", "fp1", "/proj-a/a.cpp", MATCH_OUTCOME);
    cache.store("/proj-b", "Base", "fp1", "/proj-b/a.cpp", FAILED_OUTCOME);
    expect(cache.lookup("/proj-a", "Base", "fp1").get("/proj-a/a.cpp")).toEqual(MATCH_OUTCOME);
    expect(cache.lookup("/proj-b", "Base", "fp1").get("/proj-b/a.cpp")).toEqual(FAILED_OUTCOME);
  });

  it("a fingerprint mismatch on lookup drops the WHOLE projectRoot entry, every qualifiedName included", () => {
    const cache = new SweepCache();
    cache.store("/proj", "Base", "fp1", "/proj/a.cpp", MATCH_OUTCOME);
    cache.store("/proj", "Other", "fp1", "/proj/a.cpp", FAILED_OUTCOME);

    expect(cache.lookup("/proj", "Base", "fp2").size).toBe(0);
    // The mismatched lookup above already evicted the project entry — "Other" under the OLD
    // fingerprint is gone too, even though this lookup never asked about "Other".
    expect(cache.lookup("/proj", "Other", "fp1").size).toBe(0);
  });

  it("store() under a new fingerprint starts a fresh projectRoot entry, discarding stale data for other queries", () => {
    const cache = new SweepCache();
    cache.store("/proj", "Base", "fp1", "/proj/a.cpp", MATCH_OUTCOME);
    cache.store("/proj", "Other", "fp1", "/proj/a.cpp", FAILED_OUTCOME);

    cache.store("/proj", "Base", "fp2", "/proj/b.cpp", MATCH_OUTCOME);
    expect(cache.lookup("/proj", "Other", "fp2").size).toBe(0);
    expect(cache.lookup("/proj", "Base", "fp2").get("/proj/b.cpp")).toEqual(MATCH_OUTCOME);
  });

  it("clear() drops every project", () => {
    const cache = new SweepCache();
    cache.store("/proj", "Base", "fp1", "/proj/a.cpp", MATCH_OUTCOME);
    cache.clear();
    expect(cache.lookup("/proj", "Base", "fp1").size).toBe(0);
  });
});
