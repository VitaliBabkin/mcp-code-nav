import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkspaceRoot } from "../../src/tsgo/workspace-root.js";

/**
 * The root a tsgo answer covers: the npm workspace holding the file, not the nearest
 * `tsconfig.json`. This unit reads the disk by design, exactly as `findModuleRoot` does, so each case builds a
 * real tree under its own temp directory. The upward search runs to the volume root before the declared roots
 * are consulted, which is why no case may assume anything about a `package.json` or `pnpm-workspace.yaml` above
 * the OS temp directory — the same assumption the Go suite states about `go.mod`.
 */
describe("findWorkspaceRoot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-wsroot-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Creates `dir` with `files` (paths relative to it) inside, and returns `dir`. */
  function dirWithFiles(dir: string, files: Record<string, string>): string {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return dir;
  }

  const json = (body: Record<string, unknown>): string => JSON.stringify(body);

  /** The member package inside a root whose `package.json` is `rootManifest`, holding `src/index.ts`. */
  function memberUnder(rootDir: string, rootManifest: string, extraFiles: Record<string, string> = {}): string {
    const ws = dirWithFiles(join(tmp, rootDir), { "package.json": rootManifest, ...extraFiles });
    return dirWithFiles(join(ws, "packages", "app"), {
      "package.json": json({ name: "app" }),
      "src/index.ts": "export const x = 1\n",
    });
  }

  /** The workspace root holding `member` two levels up (`<ws>/packages/app`). */
  const workspaceOf = (member: string): string => dirname(dirname(member));

  it("roots a member package's file at the workspace that declares workspaces, not at the package", () => {
    const member = memberUnder("ws", json({ name: "root", workspaces: ["packages/*"] }));
    const ws = workspaceOf(member);

    expect(findWorkspaceRoot(join(member, "src", "index.ts"), [ws])).toEqual({
      kind: "found",
      workspaceRoot: resolve(ws),
      enclosingWorkspace: null,
    });
  });

  it("roots the same member at the workspace from a pnpm-workspace.yaml alone, with no workspaces field", () => {
    const member = memberUnder(
      "pnpm",
      json({ name: "root" }),
      { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n" },
    );
    const ws = workspaceOf(member);

    expect(findWorkspaceRoot(join(member, "src", "index.ts"), [ws])).toEqual({
      kind: "found",
      workspaceRoot: resolve(ws),
      enclosingWorkspace: null,
    });
  });

  it("counts a pnpm-workspace.yaml as a declarer whatever it holds, because only its existence is read", () => {
    const member = memberUnder("empty-pnpm", json({ name: "root" }), { "pnpm-workspace.yaml": "" });
    const ws = workspaceOf(member);

    expect(findWorkspaceRoot(join(member, "src", "index.ts"), [ws])).toMatchObject({
      kind: "found",
      workspaceRoot: resolve(ws),
    });
  });

  it("keeps the workspace the root when a wider ancestor is also declared", () => {
    const repo = dirWithFiles(join(tmp, "repo"), {});
    const ws = dirWithFiles(join(repo, "frontend"), {
      "package.json": json({ name: "frontend", workspaces: ["packages/*"] }),
    });
    const member = dirWithFiles(join(ws, "packages", "ui-kit"), {
      "package.json": json({ name: "ui-kit" }),
      "src/index.ts": "export const x = 1\n",
    });

    expect(findWorkspaceRoot(join(member, "src", "index.ts"), [repo])).toEqual({
      kind: "found",
      workspaceRoot: resolve(ws),
      enclosingWorkspace: null,
    });
  });

  it("takes the package that is itself the workspace root and holds the file, naming no enclosing workspace", () => {
    // The rule is strictly above the package: a directory that declares workspaces and holds the named file
    // itself is already the root, and naming it again would report a widening that spans nothing.
    const solo = dirWithFiles(join(tmp, "solo"), {
      "package.json": json({ name: "solo", workspaces: ["packages/*"] }),
      "index.ts": "export const x = 1\n",
    });

    expect(findWorkspaceRoot(join(solo, "index.ts"), [solo])).toEqual({
      kind: "found",
      workspaceRoot: resolve(solo),
      enclosingWorkspace: null,
    });
  });

  it("takes a package holding its own pnpm-workspace.yaml as the root, with no workspace above it", () => {
    const solo = dirWithFiles(join(tmp, "solo-pnpm"), {
      "package.json": json({ name: "solo" }),
      "pnpm-workspace.yaml": "packages:\n  - '*'\n",
      "index.ts": "export const x = 1\n",
    });

    expect(findWorkspaceRoot(join(solo, "index.ts"), [solo])).toEqual({
      kind: "found",
      workspaceRoot: resolve(solo),
      enclosingWorkspace: null,
    });
  });

  it("answers the workspace whatever tsconfig.json files sit in the package, which no part of this rule reads", () => {
    const member = memberUnder("configs", json({ name: "root", workspaces: ["packages/*"] }));
    dirWithFiles(member, { "tsconfig.json": "{}\n", "src/tsconfig.app.json": "{}\n" });
    const ws = workspaceOf(member);

    expect(findWorkspaceRoot(join(member, "src", "index.ts"), [ws])).toMatchObject({
      kind: "found",
      workspaceRoot: resolve(ws),
    });
  });

  it.each([
    ['{"workspaces":["packages/*"]}', "workspace"],
    ['{"workspaces":{"packages":["packages/*"]}}', "workspace"],
    ['{"workspaces":[]}', "package"],
    ['{"workspaces":{}}', "package"],
    ['{"workspaces":"packages/*"}', "package"],
    ['{"name":"no workspaces field"}', "package"],
    ["not json at all", "package"],
    ["[1,2]", "package"],
    ["null", "package"],
  ])(
    "a root package.json holding %s roots a member file at the %s",
    (rootManifest: string, which: string) => {
      const member = memberUnder("table", rootManifest);
      const ws = workspaceOf(member);
      const expectedRoot = which === "workspace" ? resolve(ws) : resolve(member);

      expect(findWorkspaceRoot(join(member, "src", "index.ts"), [ws])).toEqual({
        kind: "found",
        workspaceRoot: expectedRoot,
        enclosingWorkspace: null,
      });
    },
  );

  it("does not throw on an unparseable package.json above the package, and does not treat it as a declarer", () => {
    const member = dirWithFiles(join(tmp, "broken", "packages", "app"), {
      "package.json": json({ name: "app" }),
      "src/index.ts": "export const x = 1\n",
    });
    dirWithFiles(join(tmp, "broken"), { "package.json": "{ not json at all" });

    expect(findWorkspaceRoot(join(member, "src", "index.ts"), [member])).toEqual({
      kind: "found",
      workspaceRoot: resolve(member),
      enclosingWorkspace: null,
    });
  });

  it("still roots a file at the package whose own package.json it cannot parse, which only has to be there", () => {
    const broken = dirWithFiles(join(tmp, "own-broken"), {
      "package.json": "{ not json at all",
      "src/index.ts": "export const x = 1\n",
    });

    expect(findWorkspaceRoot(join(broken, "src", "index.ts"), [broken])).toEqual({
      kind: "found",
      workspaceRoot: resolve(broken),
      enclosingWorkspace: null,
    });
  });

  it("declines a workspace above the package that lies outside every declared root, and names it", () => {
    // `go.work`'s treatment applied to an npm link: the package is rooted, and the root
    // that was not spanned is reported rather than silently used.
    const member = memberUnder("outer", json({ name: "root", workspaces: ["packages/*"] }));
    const ws = workspaceOf(member);

    expect(findWorkspaceRoot(join(member, "src", "index.ts"), [member])).toEqual({
      kind: "found",
      workspaceRoot: resolve(member),
      enclosingWorkspace: resolve(ws),
    });
  });

  it("reports outside-roots for a file whose package lies outside every declared root, naming every root", () => {
    const loose = dirWithFiles(join(tmp, "loose"), {
      "package.json": json({ name: "loose" }),
      "src/index.ts": "export const x = 1\n",
    });
    const one = dirWithFiles(join(tmp, "one"), {});
    const two = dirWithFiles(join(tmp, "two"), {});

    expect(findWorkspaceRoot(join(loose, "src", "index.ts"), [one, two])).toEqual({
      kind: "outside-roots",
      workspaceRoot: resolve(loose),
      declaredRoots: [resolve(one), resolve(two)],
    });
  });

  it("reports the package, and not the workspace above it, when both lie outside every declared root", () => {
    const member = memberUnder("both-outside", json({ name: "root", workspaces: ["packages/*"] }));
    const declared = dirWithFiles(join(tmp, "declared"), { "package.json": json({ name: "declared" }) });

    expect(findWorkspaceRoot(join(member, "src", "index.ts"), [declared])).toEqual({
      kind: "outside-roots",
      workspaceRoot: resolve(member),
      declaredRoots: [resolve(declared)],
    });
  });

  it("reports not-in-package when no package.json exists up to the filesystem root", () => {
    const plain = dirWithFiles(join(tmp, "plain"), { "src/index.ts": "export const x = 1\n" });

    expect(findWorkspaceRoot(join(plain, "src", "index.ts"), [plain])).toEqual({
      kind: "not-in-package",
      searchedFrom: join(resolve(plain), "src"),
    });
  });

  it("reports not-in-package for a directory anchor, naming the directory itself", () => {
    const plain = dirWithFiles(join(tmp, "plain-dir"), { "a.ts": "export const x = 1\n" });

    expect(findWorkspaceRoot(plain, [plain], "directory")).toEqual({
      kind: "not-in-package",
      searchedFrom: resolve(plain),
    });
  });

  it("counts a directory anchor that holds the package.json itself as inside its package", () => {
    const pkg = dirWithFiles(join(tmp, "pkg"), {
      "package.json": json({ name: "pkg" }),
      "a.ts": "export const x = 1\n",
    });

    expect(findWorkspaceRoot(pkg, [pkg], "directory")).toEqual({
      kind: "found",
      workspaceRoot: resolve(pkg),
      enclosingWorkspace: null,
    });
  });

  it("searches upward from a directory anchor to the workspace that declares its package", () => {
    const member = memberUnder("ws-dir", json({ name: "root", workspaces: ["packages/*"] }));
    const ws = workspaceOf(member);

    expect(findWorkspaceRoot(member, [ws], "directory")).toEqual({
      kind: "found",
      workspaceRoot: resolve(ws),
      enclosingWorkspace: null,
    });
  });

  it("starts a file-shaped search one level up, which is why the workspace root needs the directory input", () => {
    // Same path, same roots, only the declared kind differs: read as a file, the directory's own
    // `package.json` is invisible because the search begins in its parent.
    const solo = dirWithFiles(join(tmp, "solo-shape"), {
      "package.json": json({ name: "solo", workspaces: ["packages/*"] }),
      "index.ts": "export const x = 1\n",
    });

    expect(findWorkspaceRoot(solo, [tmp])).toEqual({ kind: "not-in-package", searchedFrom: resolve(tmp) });
    expect(findWorkspaceRoot(solo, [solo], "directory").kind).toBe("found");
  });
});
