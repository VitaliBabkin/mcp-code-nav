import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateHeaders, isCppSourceFile, resolveHeaderCounterpart } from "../../src/symbols/header-fallback.js";

describe("isCppSourceFile", () => {
  it("recognizes .cpp/.cc/.cxx/.mm", () => {
    expect(isCppSourceFile("a.cpp")).toBe(true);
    expect(isCppSourceFile("a.cc")).toBe(true);
    expect(isCppSourceFile("a.cxx")).toBe(true);
    expect(isCppSourceFile("a.mm")).toBe(true);
  });

  it("rejects a header or other extension", () => {
    expect(isCppSourceFile("a.h")).toBe(false);
    expect(isCppSourceFile("a.hpp")).toBe(false);
    expect(isCppSourceFile("a.txt")).toBe(false);
  });
});

describe("candidateHeaders", () => {
  it("lists same-directory and sibling include/inc header candidates", () => {
    const cppFile = join("src", "widget.cpp");
    const candidates = candidateHeaders(cppFile);
    expect(candidates).toContain(join("src", "widget.h"));
    expect(candidates).toContain(join("src", "widget.hpp"));
    expect(candidates).toContain(join("src", "..", "include", "widget.h"));
    expect(candidates).toContain(join("src", "..", "inc", "widget.hpp"));
  });
});

describe("resolveHeaderCounterpart", () => {
  it("returns the first candidate that exists", () => {
    const cppFile = join("src", "widget.cpp");
    const existing = join("src", "widget.hpp");
    const exists = (p: string) => p === existing;
    expect(resolveHeaderCounterpart(cppFile, exists)).toBe(existing);
  });

  it("returns undefined when no candidate exists", () => {
    const cppFile = join("src", "widget.cpp");
    expect(resolveHeaderCounterpart(cppFile, () => false)).toBeUndefined();
  });
});
