import { describe, expect, it } from "vitest";
import { formatIdentity } from "../../scripts/build-identity.js";

describe("formatIdentity", () => {
  it("drops the distance counter on the tagged commit itself", () => {
    expect(formatIdentity("v0.3.1-0-g1a2b3c4")).toBe("0.3.1+g1a2b3c4");
  });

  it("keeps the distance for commits after the tag", () => {
    expect(formatIdentity("v0.3.0-5-g1a2b3c4")).toBe("0.3.0+5.g1a2b3c4");
  });

  it("carries -dirty over from the tagged commit", () => {
    expect(formatIdentity("v0.3.1-0-g1a2b3c4-dirty")).toBe("0.3.1+g1a2b3c4-dirty");
  });

  it("carries -dirty over from a commit after the tag", () => {
    expect(formatIdentity("v0.3.0-5-g1a2b3c4-dirty")).toBe("0.3.0+5.g1a2b3c4-dirty");
  });

  it("keeps a sha longer than the default abbreviation", () => {
    expect(formatIdentity("v1.4.0-12-g1a2b3c4d5e6f7a8b")).toBe("1.4.0+12.g1a2b3c4d5e6f7a8b");
  });

  it.each([
    ["", "empty output"],
    ["0.3.0", "a bare version, which says nothing about the commit"],
    ["v0.3-2-g1a2b3c4", "a tag that is not three-part"],
    ["v0.3.0-g1a2b3c4", "no distance"],
    ["refs/tags/v0.3.0-0-g1a2b3c4", "a ref path rather than a tag name"],
    ["v0.3.0-0-g1a2b3c4-dirty-not", "a tail that is not the dirty marker"],
    ["v0.3.0-0-g1a2b3c4 extra", "trailing noise"],
  ])("refuses %o (%s) naming what it was given", (output) => {
    expect(() => formatIdentity(output)).toThrow(`"${output}"`);
  });
});
