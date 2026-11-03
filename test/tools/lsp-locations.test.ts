import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { toReported } from "../../src/tools/lsp-locations.js";

const TOOL = "go_find_references";
const SYMBOL = "Storage";
const file = resolve("mod", "storage.go");
const outside = () => false;

function location(line: number) {
  return {
    uri: pathToFileURL(file).toString(),
    range: { start: { line, character: 1 }, end: { line, character: 6 } },
  };
}

describe("toReported", () => {
  it("reads an absent answer as no locations at all", () => {
    expect(toReported("gopls", TOOL, null, outside, SYMBOL)).toEqual({ ok: true, value: [] });
  });

  it("reads one row per Location entry", () => {
    const out = toReported("gopls", TOOL, [location(3), location(7)], outside, SYMBOL);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.map((row) => row.line)).toEqual([3, 7]);
  });

  it("refuses an answer that is not a list, as unexpected-answer", () => {
    expect(toReported("gopls", TOOL, { nonsense: true }, outside, SYMBOL)).toMatchObject({
      ok: false,
      reason: "unexpected-answer",
    });
  });

  it("refuses the whole answer when one entry carries no readable location, naming that entry", () => {
    const out = toReported("gopls", TOOL, [location(3), { nonsense: true }], outside, SYMBOL);
    expect(out).toMatchObject({ ok: false, reason: "unexpected-answer" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("entry 2");
  });
});
