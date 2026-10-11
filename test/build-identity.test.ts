import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_IDENTITY, unbundledIdentity } from "../src/build-identity.js";

describe("the unbundled build identity", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-identity-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is the package version marked unbundled when nothing injected an identity", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(BUILD_IDENTITY).toBe(`${version}+unbundled`);
  });

  it("falls back, without throwing, when the manifest is missing, malformed or has no version", () => {
    const missing = pathToFileURL(join(dir, "absent.json"));
    expect(unbundledIdentity(missing)).toBe("0.0.0+unknown");

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(unbundledIdentity(pathToFileURL(broken))).toBe("0.0.0+unknown");

    const noVersion = join(dir, "no-version.json");
    writeFileSync(noVersion, JSON.stringify({ name: "x" }));
    expect(unbundledIdentity(pathToFileURL(noVersion))).toBe("0.0.0+unknown");
  });

  it("reads the version of the manifest it is given", () => {
    const manifest = join(dir, "package.json");
    writeFileSync(manifest, JSON.stringify({ version: "2.3.4" }));
    expect(unbundledIdentity(pathToFileURL(manifest))).toBe("2.3.4+unbundled");
  });
});
