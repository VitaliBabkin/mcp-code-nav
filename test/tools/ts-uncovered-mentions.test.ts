// The text scan over the sources no tsconfig project includes: which
// uncovered files hold the subject's name as a whole identifier, and which could not be read. A mention is a
// pointer for a text search, never a row: nothing here counts as a use, and every file the scan could not read
// is reported as unchecked rather than skipped.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathKey } from "../../src/paths/path-containment.js";
import { budgetOf } from "../../src/tools/budget.js";
import {
  scanMentions,
  UNCOVERED_MENTION_FILE_BYTES,
  UNCOVERED_MENTION_TOTAL_BYTES,
} from "../../src/tsgo/uncovered-mentions.js";
import type { TsUncoveredMention } from "../../src/tools/ts-navigation-shared.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-mentions-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Writes one uncovered source and returns its path. */
function write(name: string, body: string): string {
  const path = join(tmp, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf-8");
  return path;
}

const WHOLE_BUDGET = budgetOf(60_000);

async function scan(files: readonly string[], name = "Store"): Promise<{ hits: TsUncoveredMention[]; unchecked: number }> {
  return await scanMentions(files, name, WHOLE_BUDGET);
}

describe("scanMentions' whole-identifier test", () => {
  it("counts the lines holding the name as a whole identifier, and needs no boundary character beside it", async () => {
    const path = write(
      "holds.ts",
      [
        "const a = new Store();", // hit: followed by (
        "const b = Store.method;", // hit: followed by .
        "const _Store = 1;", // no: preceded by _, an identifier character
        "const d = Storehouse;", // no: followed by an identifier character
        "const e = ExecutiveStore;", // no: preceded by an identifier character
        "const f = $Store;", // no: $ is an identifier character
        "const g = Store$1;", // no: $ is an identifier character
        "const h = store;", // no: the name is case-sensitive
        'import { Store } from "./store.js";', // hit: inside a specifier list
        'const note = "Store in a string counts";', // hit: this is text, and says so
        "// Store in a comment counts too", // hit
      ].join("\n"),
    );

    const { hits, unchecked } = await scan([path]);
    expect(unchecked).toBe(0);
    expect(hits).toEqual([{ file: path, matchingLines: 5 }]);
  });

  it("reads the name as text, so a regular-expression character in it cannot widen the match", async () => {
    const path = write("dotted.ts", ["const a = new Driver.run();", "const b = Driverrun();"].join("\n"));

    const { hits } = await scan([path], "Driver.run");
    expect(hits).toEqual([{ file: path, matchingLines: 1 }]);
  });

  it("writes no hit for a file that never names the subject, and no hit for an empty file", async () => {
    const silent = write("silent.ts", "export const other = 1;\n");
    const empty = write("empty.ts", "");

    const { hits } = await scan([silent, empty]);
    expect(hits).toEqual([]);
  });
});

describe("scanMentions' ordering and exactness", () => {
  it("orders hits by line count descending, then by path, and keeps every file that holds one", async () => {
    const wide = write("a-wide.ts", Array.from({ length: 4 }, (_unused, index) => `new Store(${index});`).join("\n"));
    const narrow = write("b-narrow.ts", "new Store(1);\n");
    const wider = write("c-wider.ts", Array.from({ length: 6 }, (_unused, index) => `new Store(${index});`).join("\n"));

    const { hits } = await scan([wide, narrow, wider]);
    expect(hits.map((hit) => hit.matchingLines)).toEqual([6, 4, 1]);
  });

  it("lists every hit, however many there are — the cap belongs to the block that publishes them", async () => {
    const paths = Array.from({ length: 25 }, (_unused, index) =>
      write(`many/u${String(index).padStart(2, "0")}.ts`, "new Store();\n"),
    );

    const { hits, unchecked } = await scan(paths);
    expect(hits).toHaveLength(25);
    expect(unchecked).toBe(0);
    expect(hits.map((hit) => hit.file)).toEqual(paths);
  });
});

describe("scanMentions' byte caps and budget", () => {
  it("counts a file over the per-file ceiling as unchecked without reading it", async () => {
    const big = write("big.ts", "x".repeat(UNCOVERED_MENTION_FILE_BYTES + 1));
    const small = write("small.ts", "new Store();\n");

    const { hits, unchecked } = await scan([big, small]);
    expect(unchecked).toBe(1);
    expect(hits).toEqual([{ file: small, matchingLines: 1 }]);
  });

  it("counts a file it cannot read as unchecked and keeps going with the ones it can", async () => {
    const missing = join(tmp, "gone.ts");
    const readable = write("readable.ts", "new Store();\n");

    const { hits, unchecked } = await scan([missing, readable]);
    expect(unchecked).toBe(1);
    expect(hits).toEqual([{ file: readable, matchingLines: 1 }]);
  });

  it("counts every file after the call's total reaches the ceiling as unchecked", async () => {
    // Each file sits one byte under the per-file ceiling, so all of them are readable and the total is what
    // stops the scan: 32 of them leave the total 32 bytes short of the ceiling, so a 33rd is read and crosses
    // it, and the three behind it are named as unchecked rather than quietly skipped.
    const size = UNCOVERED_MENTION_FILE_BYTES - 1;
    const filler = "x".repeat(size);
    const paths = Array.from({ length: 36 }, (_unused, index) => write(`t${String(index).padStart(2, "0")}.ts`, filler));
    const read = Math.ceil(UNCOVERED_MENTION_TOTAL_BYTES / size);

    const { hits, unchecked } = await scan(paths);
    expect(hits).toEqual([]);
    expect(read).toBe(33);
    expect(unchecked).toBe(paths.length - read);
  }, 120_000);

  it("leaves the whole set unchecked when the budget is already spent, and answers instead of failing", async () => {
    const paths = [write("one.ts", "new Store();\n"), write("two.ts", "new Store();\n")];

    const spent = await scanMentions(paths, "Store", budgetOf(0));
    expect(spent).toEqual({ hits: [], unchecked: 2 });
  });
});

describe("scanMentions' remaining edges", () => {
  it("counts a file whose size reads but whose content does not as unchecked, and keeps going", async () => {
    const directory = join(tmp, "dir.ts");
    mkdirSync(directory, { recursive: true });
    const readable = write("readable.ts", "new Store();\n");

    const { hits, unchecked } = await scan([directory, readable]);
    expect(unchecked).toBe(1);
    expect(hits).toEqual([{ file: readable, matchingLines: 1 }]);
  });

  it("leaves the files it had chosen but not started unchecked when the budget runs out mid-scan", async () => {
    const paths = Array.from({ length: 100 }, (_unused, index) =>
      write(`b${String(index).padStart(3, "0")}.ts`, "new Store();\n"),
    );
    // Sizing the set asks the budget once up front, once for its timer and once per file; the reads then ask once
    // for the timer and once per file started. The budget goes at the 50th file the reads would start.
    const asked = { count: 0 };
    const budget = {
      ceilingMs: 60_000,
      remainingMs: () => {
        asked.count += 1;
        return asked.count > 102 + 1 + 50 ? 0 : 60_000;
      },
    };

    const { hits, unchecked } = await scanMentions(paths, "Store", budget);
    expect(hits.length + unchecked).toBe(paths.length);
    expect(hits.length).toBeGreaterThan(0);
    expect(unchecked).toBeGreaterThan(0);
  });

  it("breaks an equal line count by the files' normalised key, the order the uncovered set itself keeps", async () => {
    const upper = write("B-file.ts", "new Store();\n");
    const lower = write("a-file.ts", "new Store();\n");

    const { hits } = await scan([upper, lower]);
    expect(hits.map((hit) => hit.file)).toEqual([upper, lower].sort((left, right) => (pathKey(left) < pathKey(right) ? -1 : 1)));
  });

  it("is no search at all for an empty name", async () => {
    const path = write("any.ts", "new Store();\n");

    expect(await scan([path], "")).toEqual({ hits: [], unchecked: 1 });
  });
});
