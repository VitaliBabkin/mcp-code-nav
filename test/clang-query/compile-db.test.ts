import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompileDbInvalidError,
  CompileDbNotFoundError,
  listTranslationUnits,
} from "../../src/clang-query/compile-db.js";

describe("listTranslationUnits", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-db-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("throws CompileDbNotFoundError when compile_commands.json is absent", () => {
    expect(() => listTranslationUnits(projectRoot)).toThrow(CompileDbNotFoundError);
  });

  it("resolves file paths relative to each entry's directory and dedupes", () => {
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: "c++ -c", file: "a.cpp" },
        { directory: projectRoot, command: "c++ -c", file: "b.cpp" },
        { directory: projectRoot, command: "c++ -c", file: "a.cpp" },
      ]),
    );
    const tus = listTranslationUnits(projectRoot);
    expect(tus.sort()).toEqual(
      [resolve(projectRoot, "a.cpp"), resolve(projectRoot, "b.cpp")].sort(),
    );
  });

  it("throws CompileDbInvalidError on malformed JSON, keeping the database path in the message", () => {
    const dbPath = join(projectRoot, "compile_commands.json");
    writeFileSync(dbPath, "not json");
    expect(() => listTranslationUnits(projectRoot)).toThrow(CompileDbInvalidError);
    expect(() => listTranslationUnits(projectRoot)).toThrow(`${dbPath} is not valid JSON`);
  });

  it("throws CompileDbInvalidError on JSON that parses but is not a compile database", () => {
    const dbPath = join(projectRoot, "compile_commands.json");
    writeFileSync(dbPath, JSON.stringify({ entries: [] }));
    expect(() => listTranslationUnits(projectRoot)).toThrow(CompileDbInvalidError);
    expect(() => listTranslationUnits(projectRoot)).toThrow(
      `${dbPath} is not a compile database: `,
    );
  });

  // The shapes clangd 22.1.3 itself fails to load, each of which leaves it parsing on default flags.
  it.each([
    ["no command or arguments", { directory: ".", file: "a.cpp" }, 'missing key "command"'],
    ["an unknown key", { directory: ".", command: "c++", file: "a.cpp", extra: 1 }, "extra"],
    [
      "arguments that are a string",
      { directory: ".", arguments: "c++", file: "a.cpp" },
      "arguments",
    ],
  ])("refuses the whole file over an entry with %s", (_shape, entry, named) => {
    const good = { directory: ".", command: "c++", file: "b.cpp" };
    writeFileSync(join(projectRoot, "compile_commands.json"), JSON.stringify([good, entry]));
    const reading = (): string[] => listTranslationUnits(projectRoot);
    expect(reading).toThrow(CompileDbInvalidError);
    expect(reading).toThrow(named);
  });

  it.each([
    ["arguments", { directory: ".", arguments: ["c++"], file: "a.cpp" }],
    ["empty arguments", { directory: ".", arguments: [], file: "a.cpp" }],
    ["an output key", { directory: ".", command: "c++", file: "a.cpp", output: "a.o" }],
    ["a null output", { directory: ".", command: "c++", file: "a.cpp", output: null }],
  ])("reads an entry with %s", (_shape, entry) => {
    writeFileSync(join(projectRoot, "compile_commands.json"), JSON.stringify([entry]));
    expect(listTranslationUnits(projectRoot)).toEqual([resolve(".", "a.cpp")]);
  });

  it("reads a database that starts with a byte-order mark", () => {
    const entry = { directory: ".", command: "c++", file: "a.cpp" };
    writeFileSync(join(projectRoot, "compile_commands.json"), `FEFF${JSON.stringify([entry])}`);
    expect(listTranslationUnits(projectRoot)).toEqual([resolve(".", "a.cpp")]);
  });
});
