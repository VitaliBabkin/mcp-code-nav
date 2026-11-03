import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IGNORED_PATH_LIMITS,
  isIgnoredPath,
  loadIgnoredPaths,
  readIgnoredPatterns,
} from "../../src/config/ignored-paths.js";

const countStars = (pattern: string): number => pattern.split("*").length - 1;

describe("loadIgnoredPaths", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cfg-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns an empty array when the config file is absent", () => {
    expect(loadIgnoredPaths(projectRoot)).toEqual([]);
  });

  it("reads ignoredPaths from mcp-code-nav.config.json", () => {
    writeFileSync(
      join(projectRoot, "mcp-code-nav.config.json"),
      JSON.stringify({ ignoredPaths: ["third_party/**", "gen/*.cpp"] }),
    );
    expect(loadIgnoredPaths(projectRoot)).toEqual(["third_party/**", "gen/*.cpp"]);
  });

  it("throws on malformed JSON", () => {
    writeFileSync(join(projectRoot, "mcp-code-nav.config.json"), "{ not json");
    expect(() => loadIgnoredPaths(projectRoot)).toThrow();
  });

  it("throws when ignoredPaths is present but the wrong type", () => {
    writeFileSync(
      join(projectRoot, "mcp-code-nav.config.json"),
      JSON.stringify({ ignoredPaths: "not-an-array" }),
    );
    expect(() => loadIgnoredPaths(projectRoot)).toThrow();
  });

  const writeConfig = (ignoredPaths: unknown): void =>
    writeFileSync(join(projectRoot, "mcp-code-nav.config.json"), JSON.stringify({ ignoredPaths }));

  it("rejects a pattern with too many wildcards", () => {
    writeConfig(["**/" + "*a".repeat(12) + "b"]);
    expect(() => loadIgnoredPaths(projectRoot)).toThrow(/at most 6 '\*'/);
  });

  it("rejects numeric and alphabetic brace ranges and too many braces", () => {
    writeConfig(["{1..99999}.cpp"]);
    expect(() => loadIgnoredPaths(projectRoot)).toThrow(/range inside braces/);
    writeConfig(["{a,b}".repeat(3)]);
    expect(() => loadIgnoredPaths(projectRoot)).toThrow(/at most 2 '\{'/);
  });

  it("rejects too many extglob groups, NUL, empty and oversize patterns", () => {
    writeConfig(["+(a)+(b)+(c)"]);
    expect(() => loadIgnoredPaths(projectRoot)).toThrow(/at most 2 '\('/);
    writeConfig(["a\0b"]);
    expect(() => loadIgnoredPaths(projectRoot)).toThrow(/NUL/);
    writeConfig([""]);
    expect(() => loadIgnoredPaths(projectRoot)).toThrow();
    writeConfig(["a".repeat(201)]);
    expect(() => loadIgnoredPaths(projectRoot)).toThrow();
  });

  it("rejects more than 100 patterns and accepts exactly 100", () => {
    writeConfig(Array.from({ length: 101 }, (_, i) => `d${i}/**`));
    expect(() => loadIgnoredPaths(projectRoot)).toThrow();
    writeConfig(Array.from({ length: 100 }, (_, i) => `d${i}/**`));
    expect(loadIgnoredPaths(projectRoot)).toHaveLength(100);
  });

  it("returns undefined from readIgnoredPatterns for a rejected file", () => {
    writeConfig(["{1..99999}.cpp"]);
    expect(readIgnoredPatterns(projectRoot)).toBeUndefined();
  });
});

describe("accepted patterns", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";

  it("keeps the common patterns working", () => {
    const patterns = [
      "**/build/**",
      "**/*.generated.*",
      "third_party/**",
      "**/node_modules/**",
      "src/{a,b}/*.cpp",
    ];
    const projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cfg-"));
    try {
      writeFileSync(
        join(projectRoot, "mcp-code-nav.config.json"),
        JSON.stringify({ ignoredPaths: patterns }),
      );
      expect(loadIgnoredPaths(projectRoot)).toEqual(patterns);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
    expect(isIgnoredPath(root, join(root, "x", "build", "y.cpp"), ["**/build/**"])).toBe(true);
    expect(isIgnoredPath(root, join(root, "x", "a.generated.h"), ["**/*.generated.*"])).toBe(true);
    expect(isIgnoredPath(root, join(root, "src", "a", "z.cpp"), ["src/{a,b}/*.cpp"])).toBe(true);
    expect(
      isIgnoredPath(root, join(root, "a", "node_modules", "p", "i.js"), ["**/node_modules/**"]),
    ).toBe(true);
  });

  describe("the worst pattern the limits accept, on a long name that cannot match", () => {
    const { maxStars } = IGNORED_PATH_LIMITS;
    const MATCH_CEILING_MS = 500;
    const worstPatterns: [pattern: string, nameLength: number][] = [
      ["*a".repeat(maxStars - 1) + "*b", 120],
      ["**/" + "*a".repeat(maxStars - 3) + "*b", 250],
    ];

    it.each(worstPatterns)("is accepted by the config limits: %s", (pattern) => {
      const projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-cfg-"));
      try {
        writeFileSync(
          join(projectRoot, "mcp-code-nav.config.json"),
          JSON.stringify({ ignoredPaths: [pattern] }),
        );
        expect(loadIgnoredPaths(projectRoot)).toEqual([pattern]);
        expect(countStars(pattern)).toBe(maxStars);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it.each(worstPatterns)(
      "answers within the ceiling and as not ignored: %s",
      (pattern, nameLength) => {
        const file = join(root, "a".repeat(nameLength) + ".h");
        const started = performance.now();
        const ignored = isIgnoredPath(root, file, [pattern]);
        const elapsedMs = performance.now() - started;

        expect(ignored).toBe(false);
        expect(elapsedMs).toBeLessThan(MATCH_CEILING_MS);
      },
    );
  });

  describe("negated extglob", () => {
    it("ignores a file whose name merely starts with the negated name", () => {
      expect(isIgnoredPath(root, join(root, "x", "a.generated.h"), ["x/!(a)*"])).toBe(true);
    });

    it("ignores every sibling except the negated name itself", () => {
      expect(isIgnoredPath(root, join(root, "x", "b"), ["x/!(a)"])).toBe(true);
      expect(isIgnoredPath(root, join(root, "x", "a"), ["x/!(a)"])).toBe(false);
    });
  });
});

describe("isIgnoredPath", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";

  it("returns false when there are no patterns", () => {
    expect(isIgnoredPath(root, join(root, "a.cpp"), [])).toBe(false);
  });

  it("matches a glob pattern against the path relative to the root", () => {
    const file = join(root, "third_party", "lib", "x.cpp");
    expect(isIgnoredPath(root, file, ["third_party/**"])).toBe(true);
  });

  it("does not match an unrelated file", () => {
    const file = join(root, "src", "x.cpp");
    expect(isIgnoredPath(root, file, ["third_party/**"])).toBe(false);
  });
});
