import { describe, expect, it } from "vitest";
import { withSummary } from "../src/mcp-response.js";
import { withSummary as reExported } from "../src/tools/ts-shared.js";

describe("withSummary", () => {
  it("puts the summary first, ahead of every key of the payload", () => {
    const wrapped = withSummary("the summary", { symbols: [], scope: {} });

    expect(Object.keys(wrapped)).toEqual(["summary", "symbols", "scope"]);
    expect(JSON.stringify(wrapped).startsWith('{"summary":"the summary"')).toBe(true);
  });

  it("is the one function the TypeScript tools re-export, so no import there changes", () => {
    expect(reExported).toBe(withSummary);
  });
});
