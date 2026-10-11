import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const realpath = vi.hoisted(() => vi.fn<(path: string) => string>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const native = Object.assign((path: string) => realpath(path), { native: (path: string) => realpath(path) });
  return { ...actual, realpathSync: native };
});

const { PathEscapeError, resolveWithinAnyRoot } = await import("../../src/paths/resolve-safe-path.js");

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

const root = resolve(process.platform === "win32" ? "C:\\proj" : "/proj");
const file = resolve(root, "src", "a.cpp");

describe("resolveWithinAnyRoot when the real path cannot be established", () => {
  beforeEach(() => {
    realpath.mockReset();
  });

  it.each(["EACCES", "ELOOP", "EPERM", "EIO", "ENAMETOOLONG"])("denies the path on %s", (code) => {
    realpath.mockImplementation((path) => {
      if (path === file) throw errno(code);
      return path;
    });
    expect(() => resolveWithinAnyRoot([root], "src/a.cpp", () => true)).toThrow(PathEscapeError);
  });

  it("denies when an ancestor fails with a non-missing error after a missing leaf", () => {
    realpath.mockImplementation((path) => {
      if (path === file) throw errno("ENOENT");
      if (path === resolve(root, "src")) throw errno("EACCES");
      return path;
    });
    expect(() => resolveWithinAnyRoot([root], "src/a.cpp", () => true)).toThrow(PathEscapeError);
  });

  it("denies when the walk reaches the filesystem top without a real ancestor", () => {
    realpath.mockImplementation(() => {
      throw errno("ENOENT");
    });
    expect(() => resolveWithinAnyRoot([root], "src/a.cpp", () => true)).toThrow(PathEscapeError);
  });

  it("denies when the root's own real path cannot be established", () => {
    realpath.mockImplementation((path) => {
      if (path === root) throw errno("EACCES");
      return path;
    });
    expect(() => resolveWithinAnyRoot([root], "src/a.cpp", () => true)).toThrow(PathEscapeError);
  });

  it.each(["ENOENT", "ENOTDIR"])("still resolves a missing leaf (%s) under the real root", (code) => {
    realpath.mockImplementation((path) => {
      if (path === file) throw errno(code);
      return path;
    });
    expect(resolveWithinAnyRoot([root], "src/a.cpp", () => true).absolutePath).toBe(file);
  });
});
