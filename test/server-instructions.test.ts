import { describe, expect, it } from "vitest";
import { LANGUAGE_RULE, SERVER_INSTRUCTIONS } from "../src/server-instructions.js";
import { READ_ONLY_CLANGD_SENTENCE } from "../src/tools/shared.js";

/** A client harness was observed cutting the string near 2,048 chars, so the ceiling is the contract. */
const INSTRUCTIONS_CEILING = 2000;

const ALL_TOOLS = [
  "cpp_file_symbols",
  "cpp_find_symbol",
  "cpp_find_references",
  "cpp_find_callers",
  "cpp_find_derived_classes",
  "go_file_symbols",
  "go_find_symbol",
  "go_find_references",
  "go_find_callers",
  "go_find_implementations",
  "ts_file_symbols",
  "ts_find_symbol",
  "ts_find_references",
  "ts_find_callers",
  "ts_find_implementations",
];

describe("server instructions", () => {
  it("stays under the ceiling a truncating client enforces", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_CEILING);
  });

  it("leads with what a tool list cannot show, and keeps the routing map whole", () => {
    expect(SERVER_INSTRUCTIONS.startsWith(LANGUAGE_RULE)).toBe(true);
    for (const tool of ALL_TOOLS) expect(SERVER_INSTRUCTIONS).toContain(tool);
  });

  it("puts the routing before the per-language detail a truncated read loses first", () => {
    expect(SERVER_INSTRUCTIONS.indexOf("cpp_find_derived_classes - always")).toBeLessThan(
      SERVER_INSTRUCTIONS.indexOf("C++ tools run clangd"),
    );
    expect(SERVER_INSTRUCTIONS.indexOf("C++ tools run clangd")).toBeLessThan(
      SERVER_INSTRUCTIONS.indexOf("Go tools are read-only"),
    );
    expect(SERVER_INSTRUCTIONS.indexOf("Go tools are read-only")).toBeLessThan(
      SERVER_INSTRUCTIONS.indexOf("TS tools need the TypeScript 7 native server"),
    );
  });

  it("states the disk side effect in full, where every session reads it once", () => {
    expect(SERVER_INSTRUCTIONS).toContain(READ_ONLY_CLANGD_SENTENCE);
    expect(SERVER_INSTRUCTIONS).toContain(".cache/clangd");
    expect(SERVER_INSTRUCTIONS).toContain(".gitignore");
  });
});
