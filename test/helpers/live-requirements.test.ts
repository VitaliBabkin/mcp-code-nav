import { describe, expect, it } from "vitest";
import { describeTools, missingRequired, parseRequired } from "./live-requirements.js";

const found = { clangd: true, "clang-query": false, gopls: true, tsgo: false };

describe("parseRequired", () => {
  it("requires nothing when the variable is unset or blank", () => {
    expect(parseRequired(undefined)).toEqual({ required: [], invalid: [] });
    expect(parseRequired("  ")).toEqual({ required: [], invalid: [] });
  });

  it("requires every tool for `all`", () => {
    expect(parseRequired("all").required).toEqual(["clangd", "clang-query", "gopls", "tsgo"]);
  });

  it("reads a comma-separated list and reports names it does not know", () => {
    expect(parseRequired("gopls, tsgo,rustc")).toEqual({ required: ["gopls", "tsgo"], invalid: ["rustc"] });
  });
});

describe("missingRequired", () => {
  it("lists the required tools that were not found", () => {
    expect(missingRequired(["clangd", "clang-query", "tsgo"], found)).toEqual(["clang-query", "tsgo"]);
    expect(missingRequired([], found)).toEqual([]);
  });
});

describe("describeTools", () => {
  it("states every tool and marks the missing ones", () => {
    const text = describeTools(found);
    expect(text).toContain("clangd: found");
    expect(text).toContain("clang-query: NOT FOUND");
    expect(text).toContain("tsgo: NOT FOUND");
  });
});
