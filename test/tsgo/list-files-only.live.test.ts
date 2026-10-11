import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  itIfTsgoAvailable,
  listFilesOnly,
  requireTsgo,
  stampsOf,
  tsgoAvailable,
  tsFixtureRoot,
} from "../helpers/tsgo-live.js";

/**
 * `--listFilesOnly` is supported by 7.0.2 and its output has the shape the
 * project map is built from — one path per line, absolute, and a failure that says so. This measures the flag
 * itself rather than a unit that consumes it.
 */

const packageConfig = join(tsFixtureRoot, "tsconfig.json");
const baseConfig = join(tsFixtureRoot, "tsconfig.base.json");
const brokenConfig = join(tsFixtureRoot, "tsconfig.broken.json");

/** Path spelling compared the way the map will compare it: separators normalised, case folded. */
function key(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function endingWith(lines: readonly string[], suffix: string): string[] {
  return lines.filter((line) => key(line).endsWith(suffix));
}

function containing(lines: readonly string[], part: string): string[] {
  return lines.filter((line) => key(line).includes(part));
}

function underRoot(lines: readonly string[], root: string): string[] {
  const inside = `${key(root)}/`;
  return lines.filter((line) => key(line).startsWith(inside));
}

function report(name: string, listing: Awaited<ReturnType<typeof listFilesOnly>>): void {
  console.info(
    `${name}: exit ${String(listing.exitCode)} spawn ${String(listing.spawnCode)} in ${listing.ms} ms, ` +
      `${listing.lines.length} line(s), first ${JSON.stringify(listing.lines.slice(0, 3))}`,
  );
  if (listing.stderr.trim() !== "") console.info(`  stderr: ${JSON.stringify(listing.stderr.trim().slice(0, 400))}`);
}

describe("--listFilesOnly on TypeScript 7 native", () => {
  itIfTsgoAvailable("lists a project's files one per line, absolute, with no header and no numbering", async () => {
    const before = stampsOf([packageConfig]);
    const listing = await listFilesOnly(requireTsgo(), packageConfig);
    report(packageConfig, listing);

    expect(listing.exitCode).toBe(0);
    expect(listing.lines.length).toBeGreaterThan(0);
    expect(listing.lines.filter((line) => !isAbsolute(line))).toEqual([]);
    expect(listing.lines.filter((line) => /^Files \(\d+\)$/.test(line.trim()))).toEqual([]);
    expect(endingWith(listing.lines, "/src/storage.ts")).toHaveLength(1);
    expect(endingWith(listing.lines, "/src/label.ts")).toHaveLength(1);
    // The `include` bound is the compiler's own: a source outside it is not in the listing at all.
    expect(endingWith(listing.lines, "/test/outside.ts")).toEqual([]);
    // `allowJs` is the compiler's own bound too: the JS siblings the package config admits are in it.
    expect(endingWith(listing.lines, "/src/widget.jsx")).toHaveLength(1);
    expect(endingWith(listing.lines, "/src/legacy.js")).toHaveLength(1);
    // Lib files come from the compiler's own directory, outside any workspace, which is why membership is
    // filtered to the root before it is read.
    expect(listing.lines.length - underRoot(listing.lines, tsFixtureRoot).length).toBeGreaterThan(0);
    expect(stampsOf([packageConfig])).toEqual(before);
  });

  itIfTsgoAvailable("lists what a config with no include and no files of its own claims, which is the tree", async () => {
    const listing = await listFilesOnly(requireTsgo(), baseConfig);
    report(baseConfig, listing);

    expect(listing.exitCode).toBe(0);
    // An `extends`-only manifest is not a project, but the compiler still answers for everything below it —
    // including the source the package config's `include` leaves out, and the JS the base does not allow.
    expect(endingWith(listing.lines, "/test/outside.ts")).toHaveLength(1);
    expect(endingWith(listing.lines, "/src/legacy.js")).toEqual([]);
  });

  itIfTsgoAvailable("fails a listing whose config does not resolve, naming what it could not read", async () => {
    const listing = await listFilesOnly(requireTsgo(), brokenConfig);
    report(brokenConfig, listing);

    const printed = `${listing.stdout}\n${listing.stderr}`;
    // A listing counts as failed on either signal, and which one this build gives is the fact reported:
    // the exit code, and the stream the sentence landed on.
    console.info(
      `  failed by ${listing.exitCode === 0 ? "output, not the exit code" : "the exit code"}; ` +
        `the sentence is on ${listing.stderr.trim() === "" ? "stdout" : "stderr"}; ` +
        `lines it printed: ${JSON.stringify(listing.lines.slice(0, 5))}`,
    );
    expect(listing.exitCode !== 0 || /error/i.test(printed), "the listing neither failed nor said why").toBe(true);
    expect(printed.toLowerCase()).toContain("no-such-base.json");
  });
});
