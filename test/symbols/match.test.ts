import { describe, expect, it } from "vitest";
import { matchSymbols, splitQualifiedName } from "../../src/symbols/match.js";
import type { FlatSymbol } from "../../src/clangd/outline.js";

function flat(qualifiedPath: string[], kind: string): FlatSymbol {
  return { qualifiedPath, name: qualifiedPath[qualifiedPath.length - 1] as string, kind, range: { startLine: 1, endLine: 2 } };
}

describe("splitQualifiedName", () => {
  it("splits on ::", () => {
    expect(splitQualifiedName("ns::Class::method")).toEqual(["ns", "Class", "method"]);
  });

  it("treats a bare name as a single segment", () => {
    expect(splitQualifiedName("method")).toEqual(["method"]);
  });
});

describe("matchSymbols", () => {
  it("matches a bare name regardless of nesting depth", () => {
    const symbols = [flat(["ns", "Class", "method"], "method"), flat(["Other"], "class")];
    expect(matchSymbols(symbols, { name: "method" })).toEqual([symbols[0]]);
  });

  it("matches a qualified name against the symbol's trailing path segments", () => {
    const symbols = [flat(["outer", "ns", "Class", "method"], "method"), flat(["ns", "Other", "method"], "method")];
    expect(matchSymbols(symbols, { name: "Class::method" })).toEqual([symbols[0]]);
  });

  it("does not match when the qualified path is longer than the symbol's own path", () => {
    const symbols = [flat(["method"], "method")];
    expect(matchSymbols(symbols, { name: "Class::method" })).toEqual([]);
  });

  it("applies an explicit kind filter", () => {
    const symbols = [flat(["Foo"], "class"), flat(["Foo"], "constructor")];
    expect(matchSymbols(symbols, { name: "Foo", kind: "constructor" })).toEqual([symbols[1]]);
  });

  it("defaults a bare name matching both a class and its constructor to the class", () => {
    const symbols = [flat(["Foo"], "class"), flat(["Foo"], "constructor"), flat(["Foo"], "constructor")];
    expect(matchSymbols(symbols, { name: "Foo" })).toEqual([symbols[0]]);
  });

  it("does not apply the class/constructor default when other kinds are also present", () => {
    const symbols = [flat(["Foo"], "class"), flat(["Foo"], "constructor"), flat(["Foo"], "function")];
    expect(matchSymbols(symbols, { name: "Foo" })).toEqual(symbols);
  });
});
