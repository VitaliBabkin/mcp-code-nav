import { describe, expect, it } from "vitest";
import { CppFileSymbolsInput } from "../../src/tools/cpp-file-symbols.js";
import { CppFindDerivedClassesInput } from "../../src/tools/cpp-find-derived-classes.js";
import { CppFindSymbolInput } from "../../src/tools/cpp-find-symbol.js";
import { GoFindSymbolInput } from "../../src/tools/go-find-symbol.js";
import { GoFileSymbolsInput } from "../../src/tools/go-file-symbols.js";
import { TsFindCallersInput } from "../../src/tools/ts-find-callers.js";
import { TsFileSymbolsInput } from "../../src/tools/ts-file-symbols.js";

const root = process.platform === "win32" ? "C:\\proj" : "/proj";

describe("path and name limits at the schema boundary", () => {
  it("accepts a normal call for one tool per language", () => {
    expect(CppFileSymbolsInput.safeParse({ projectRoot: root, file: "a.cpp" }).success).toBe(true);
    expect(GoFileSymbolsInput.safeParse({ file: "a.go", sourceRoots: [root] }).success).toBe(true);
    expect(TsFileSymbolsInput.safeParse({ file: "a.ts", sourceRoots: [root] }).success).toBe(true);
    expect(TsFindCallersInput.safeParse({ file: "a.ts", symbol: "A.run", sourceRoots: [root] }).success).toBe(true);
  });

  it.each([
    ["C++", () => CppFileSymbolsInput.safeParse({ projectRoot: root, file: "a\0.cpp" })],
    ["Go", () => GoFileSymbolsInput.safeParse({ file: "a\0.go", sourceRoots: [root] })],
    ["TypeScript", () => TsFileSymbolsInput.safeParse({ file: "a\0.ts", sourceRoots: [root] })],
  ])("rejects a NUL in a %s file", (_language, parse) => {
    const result = parse();
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("NUL");
  });

  it.each([
    ["C++", () => CppFileSymbolsInput.safeParse({ projectRoot: root, file: "a".repeat(5000) })],
    ["Go", () => GoFileSymbolsInput.safeParse({ file: "a".repeat(5000), sourceRoots: [root] })],
    ["TypeScript", () => TsFileSymbolsInput.safeParse({ file: "a".repeat(5000), sourceRoots: [root] })],
  ])("rejects a 5000-character %s file", (_language, parse) => {
    expect(parse().success).toBe(false);
  });

  it("rejects an empty or oversize or NUL name", () => {
    expect(TsFindCallersInput.safeParse({ file: "a.ts", symbol: "", sourceRoots: [root] }).success).toBe(false);
    expect(TsFindCallersInput.safeParse({ file: "a.ts", symbol: "x".repeat(1025), sourceRoots: [root] }).success).toBe(false);
    expect(GoFindSymbolInput.safeParse({ symbol: "a\0b", anchor: root, sourceRoots: [root] }).success).toBe(false);
    expect(CppFindSymbolInput.safeParse({ projectRoot: root, name: "a\0b" }).success).toBe(false);
  });

  it("rejects 257 source roots and accepts 256", () => {
    const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `${root}${i}`);
    expect(TsFileSymbolsInput.safeParse({ file: "a.ts", sourceRoots: many(257) }).success).toBe(false);
    expect(TsFileSymbolsInput.safeParse({ file: "a.ts", sourceRoots: many(256) }).success).toBe(true);
    expect(CppFileSymbolsInput.safeParse({ projectRoot: root, file: "a.cpp", sourceRoots: many(257) }).success).toBe(false);
    expect(GoFileSymbolsInput.safeParse({ file: "a.go", sourceRoots: many(257) }).success).toBe(false);
  });

  it("bounds the derived-classes name and file list", () => {
    expect(CppFindDerivedClassesInput.safeParse({ projectRoot: root, qualifiedName: "ns::IFoo" }).success).toBe(true);
    expect(CppFindDerivedClassesInput.safeParse({ projectRoot: root, qualifiedName: "a".repeat(1025) }).success).toBe(false);
    expect(
      CppFindDerivedClassesInput.safeParse({ projectRoot: root, qualifiedName: "A", files: ["a\0.cpp"] }).success,
    ).toBe(false);
  });
});
