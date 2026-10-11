import { describe, expect, it } from "vitest";
import { isBuildDirName } from "../../src/paths/cpp-sources.js";

describe("isBuildDirName", () => {
  it("names the directories of a build tree, case-sensitively", () => {
    for (const name of ["build", "build-x", "build_debug", "cmake-build-debug", "out"]) {
      expect(isBuildDirName(name), name).toBe(true);
    }
    for (const name of ["Build", "OUT", "outer", "src", "linux-gcc-release", ".git", "rebuild"]) {
      expect(isBuildDirName(name), name).toBe(false);
    }
  });
});
