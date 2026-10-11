import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** References to documents, rounds and places that are not in this repository. */
const FORBIDDEN =
  /\bADR\b|docs\/adr|\bRuling\b|\bthe[ ]design\b|\bacceptance item\b|beat Go|\bthis workspace\b|vitali|\.ai\//i;

const TEXT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".go", ".h", ".hpp", ".cpp", ".txt"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);
const SCANNED_ROOTS = ["src", "test", "scripts", "docs", ".github"];
const SCANNED_TOP_LEVEL = /\.md$|^package\.json$/;

/** A match may be allowed only with a reason; the key is `<repo-relative path>` and the pattern is the allowed line. */
const ALLOWED: readonly { readonly file: string; readonly line: RegExp; readonly reason: string }[] = [
  {
    file: "package.json",
    line: /"author":/,
    reason: "the package author field names the publisher; it is the public name chosen for the release",
  },
  ...["package.json", "README.md", "WORKFLOW.md"].map((file) => ({
    file,
    line: /github\.com\/VitaliBabkin\/mcp-code-nav/,
    reason: "the public repository URL contains the publisher's account name",
  })),
];

function* textFiles(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(name) || name.startsWith("dist")) continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) yield* textFiles(path);
    else if (stats.size < 2_000_000 && TEXT_EXTENSIONS.has(name.slice(name.lastIndexOf(".")))) yield path;
  }
}

function scannedFiles(): string[] {
  const top = readdirSync(root).filter((name) => SCANNED_TOP_LEVEL.test(name)).map((name) => join(root, name));
  const trees = SCANNED_ROOTS.map((name) => join(root, name)).flatMap((dir) => {
    try {
      return [...textFiles(dir)];
    } catch {
      return [];
    }
  });
  return [...top, ...trees];
}

function violationsIn(file: string): string[] {
  const rel = relative(root, file).split("\\").join("/");
  if (rel === "test/no-internal-references.test.ts") return [];
  const found: string[] = [];
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (!FORBIDDEN.test(line)) return;
      if (ALLOWED.some((a) => a.file === rel && a.line.test(line))) return;
      found.push(`${rel}:${index + 1}: ${line.trim().slice(0, 120)}`);
    });
  return found;
}

describe("the published tree", () => {
  it("scans the trees it claims to", () => {
    expect(scannedFiles().length).toBeGreaterThan(100);
  });

  it("refers to no document, round or place outside this repository", () => {
    expect(scannedFiles().flatMap(violationsIn)).toEqual([]);
  });

  it("every allowance carries a reason", () => {
    expect(ALLOWED.every((a) => a.reason.length > 10)).toBe(true);
  });

  it("recognises a forbidden phrase", () => {
    expect(FORBIDDEN.test(["per the", "design"].join(" "))).toBe(true);
    expect(FORBIDDEN.test("nothing to see")).toBe(false);
  });
});
