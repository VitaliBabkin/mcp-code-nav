import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Replaces `statSync` for one test; `undefined` keeps the real call. */
const fsOverride = vi.hoisted(() => ({
  statSync: undefined as undefined | ((path: string) => unknown),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (path: string) =>
      fsOverride.statSync === undefined ? actual.statSync(path) : fsOverride.statSync(path),
  };
});

const { anchorKind } = await import("../../src/tools/go-shared.js");

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe("anchorKind", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-anchor-kind-"));
  });

  afterEach(() => {
    fsOverride.statSync = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads an existing file as a file and an existing directory as a directory", () => {
    const file = join(tmp, "a.go");
    writeFileSync(file, "package a\n");
    expect(anchorKind("go_find_symbol", file)).toEqual({ ok: true, value: "file" });
    expect(anchorKind("go_find_symbol", tmp)).toEqual({ ok: true, value: "directory" });
  });

  it("refuses a path that is neither a file nor a directory as input-invalid", () => {
    fsOverride.statSync = () => ({ isFile: () => false, isDirectory: () => false });
    expect(anchorKind("go_find_symbol", join(tmp, "device"))).toMatchObject({
      ok: false,
      reason: "input-invalid",
    });
  });

  it("reports a missing anchor as file-not-found, before any search", () => {
    expect(anchorKind("go_find_symbol", join(tmp, "gone.go"))).toMatchObject({
      ok: false,
      reason: "file-not-found",
    });
  });

  it("reports a stat failure other than a missing path as internal, naming its code", () => {
    fsOverride.statSync = () => {
      throw errno("EACCES");
    };
    const out = anchorKind("go_find_symbol", join(tmp, "locked.go"));
    expect(out).toMatchObject({ ok: false, reason: "internal" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("(EACCES)");
  });
});
