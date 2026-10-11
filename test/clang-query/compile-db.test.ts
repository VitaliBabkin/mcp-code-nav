import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompileDbNotFoundError, listTranslationUnits } from "../../src/clang-query/compile-db.js";

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
        { directory: projectRoot, file: "a.cpp" },
        { directory: projectRoot, file: "b.cpp" },
        { directory: projectRoot, file: "a.cpp" },
      ]),
    );
    const tus = listTranslationUnits(projectRoot);
    expect(tus.sort()).toEqual([resolve(projectRoot, "a.cpp"), resolve(projectRoot, "b.cpp")].sort());
  });

  it("throws on malformed JSON", () => {
    writeFileSync(join(projectRoot, "compile_commands.json"), "not json");
    expect(() => listTranslationUnits(projectRoot)).toThrow();
  });
});
