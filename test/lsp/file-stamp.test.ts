import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileStamp } from "../../src/lsp/file-stamp.js";

describe("fileStamp", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-stamp-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is the file's size and mtime in one comparable string", () => {
    const file = join(tmp, "a.go");
    writeFileSync(file, "package a\n");
    const { size, mtimeMs } = statSync(file);
    expect(fileStamp(file)).toBe(`${size}|${mtimeMs}`);
  });

  it("moves when the file's content moves, which is all a staleness check needs", () => {
    const file = join(tmp, "a.go");
    writeFileSync(file, "package a\n");
    const before = fileStamp(file);
    appendFileSync(file, "// added\n");
    expect(fileStamp(file)).not.toBe(before);
  });

  it("is undefined for a path that cannot be stat'ed, which is neither a change nor a match", () => {
    expect(fileStamp(join(tmp, "absent.go"))).toBeUndefined();
  });
});
