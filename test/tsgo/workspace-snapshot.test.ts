import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  takeWorkspaceSnapshot,
  walkWorkspace,
  workspaceSnapshotReason,
  workspaceWalkedPaths,
} from "../../src/tsgo/workspace-snapshot.js";

/**
 * The workspace walk reads the disk it is told about, exactly as `takeModuleSnapshot`'s
 * tests do, so every case builds a real tree under its own temp directory. Nothing about the walk can be
 * decided from outside it, which is also why the entry-bound case has to build the entries.
 */

/** A source file's body; the walk only ever stats it. */
const SOURCE = "export const x = 1;\n";

describe("walkWorkspace", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-wsnap-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Creates the directories `path` needs, writes `content` into it, and returns it. */
  function write(path: string, content: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  /** A manifest's text, so a config the walk seeds is one the graph can read. */
  const manifest = (body: unknown): string => JSON.stringify(body);

  /** The walk's result, or a failure that says the walk gave up rather than answering. */
  function walked(root: string): { readonly entries: Map<string, string>; readonly unresolved: readonly string[] } {
    const result = walkWorkspace(root);
    if (result === undefined) throw new Error("expected the workspace walk to complete");
    return result;
  }

  /** The walk's keys under `root`, spelled relative to it and sorted, so a case reads as a list of names. */
  function names(root: string, entries: Map<string, string>): string[] {
    const prefix = `${resolve(root)}${sep}`;
    return [...entries.keys()].map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path)).sort();
  }

  it("tracks every TS-family and JS-family source, a declaration file, and the three manifest names", () => {
    const root = tmp;
    write(join(root, "tsconfig.json"), manifest({}));
    write(join(root, "jsconfig.json"), manifest({}));
    write(join(root, "package.json"), manifest({ name: "ws" }));
    for (const name of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "types.d.ts"]) {
      write(join(root, name), SOURCE);
    }
    write(join(root, "src", "deep.ts"), SOURCE);

    expect(names(root, walked(root).entries)).toEqual(
      [
        "a.cjs",
        "a.cts",
        "a.js",
        "a.jsx",
        "a.mjs",
        "a.mts",
        "a.ts",
        "a.tsx",
        "jsconfig.json",
        "package.json",
        join("src", "deep.ts"),
        "tsconfig.json",
        "types.d.ts",
      ].sort(),
    );
    expect(walked(root).unresolved).toEqual([]);
  });

  it("keys each tracked file by its absolute path and values it with size|mtimeMs", () => {
    const root = tmp;
    write(join(root, "tsconfig.json"), manifest({}));
    const source = write(join(root, "a.ts"), SOURCE);

    const entries = walked(root).entries;
    for (const [path, stamp] of entries) {
      expect(path).toBe(resolve(path));
      const { size, mtimeMs } = statSync(path);
      expect(stamp).toBe(`${size}|${mtimeMs}`);
    }
    const { size, mtimeMs } = statSync(source);
    expect(entries.get(source)).toBe(`${size}|${mtimeMs}`);
  });

  it("tracks neither a .json that is not one of the manifest names nor anything under node_modules or a dot-prefixed directory", () => {
    const root = tmp;
    write(join(root, "tsconfig.json"), manifest({}));
    write(join(root, "package.json"), manifest({ name: "ws" }));
    write(join(root, "keep.ts"), SOURCE);
    write(join(root, "settings.json"), manifest({ editor: {} }));
    write(join(root, "notes.md"), "# not a source\n");
    write(join(root, "node_modules", "dep", "index.js"), SOURCE);
    write(join(root, "node_modules", "dep", "tsconfig.json"), manifest({}));
    write(join(root, ".git", "tsconfig.json"), manifest({}));
    write(join(root, ".hidden", "a.ts"), SOURCE);

    // A dependency's own config is neither a seed of the closure nor a file the workspace is made of.
    expect(names(root, walked(root).entries)).toEqual(["keep.ts", "package.json", "tsconfig.json"]);
    expect(takeWorkspaceSnapshot(root)).toBeInstanceOf(Map);
  });

  it("tracks a config reached only through extends, although no config filename rule would look at it", () => {
    const root = tmp;
    write(join(root, "tsconfig.json"), manifest({ extends: "./compiler-options.json" }));
    const options = write(join(root, "compiler-options.json"), manifest({ compilerOptions: { strict: true } }));

    expect(walked(root).entries.has(options)).toBe(true);
    expect(takeWorkspaceSnapshot(root)?.has(options)).toBe(true);
  });

  it("tracks a config reached only through a references path that names no tsconfig.json", () => {
    const root = tmp;
    write(join(root, "tsconfig.json"), manifest({ references: [{ path: "./configs/app.json" }] }));
    const member = write(join(root, "configs", "app.json"), manifest({ extends: "./base.json" }));
    const base = write(join(root, "configs", "base.json"), manifest({ compilerOptions: { target: "es2022" } }));
    write(join(root, "configs", "skipped.json"), manifest({ compilerOptions: { target: "es2022" } }));

    const entries = walked(root).entries;
    expect(entries.has(member)).toBe(true);
    // Reached through the member that `references` named: the transitive half of the same rule.
    expect(entries.has(base)).toBe(true);
    // A `.json` the closure does not reach is still not a workspace file.
    expect(entries.has(join(root, "configs", "skipped.json"))).toBe(false);
    expect(walked(root).unresolved).toEqual([]);
  });

  it("hands the entries it did see to its caller with the specs it could not follow, and gives no snapshot with them", () => {
    const root = tmp;
    const config = write(join(root, "tsconfig.json"), manifest({ extends: "./gone.json" }));
    const source = write(join(root, "a.ts"), SOURCE);

    const result = walked(root);
    expect(result.unresolved).toEqual([`extends resolves to nothing: "./gone.json" in "${config}"`]);
    expect(result.entries.has(config)).toBe(true);
    expect(result.entries.has(source)).toBe(true);
    expect(takeWorkspaceSnapshot(root)).toBeUndefined();
    expect(workspaceSnapshotReason(root)).toBe(
      `the config closure under "${resolve(root)}" is not provable: ` +
        `extends resolves to nothing: "./gone.json" in "${config}"`,
    );
    // The other half: the walk is a walk that also returns what it could not resolve, so the project
    // map is still built from the paths it DID see. Withholding the snapshot makes every call reload the
    // session; it does not make the workspace's projects unknown.
    expect([...(workspaceWalkedPaths(root) ?? [])].sort()).toEqual([config, source].sort());
  });

  it("hands out the paths of an unprovable walk only for as long as the closure stays unprovable", () => {
    const root = tmp;
    const config = write(join(root, "tsconfig.json"), manifest({ extends: "./gone.json" }));
    write(join(root, "a.ts"), SOURCE);

    walked(root);
    expect(workspaceWalkedPaths(root)).toBeDefined();

    // The spec is followed by a later edit: the snapshot is provable again, so the caller reads the session's
    // own baseline and there is nothing for this second hand-out to be for. A stale set left behind here would
    // be a path set the map could be built from after the walk that proved it had finished.
    write(config, manifest({ extends: "./here.json" }));
    write(join(root, "here.json"), manifest({ compilerOptions: {} }));
    walked(root);
    expect(takeWorkspaceSnapshot(root)).toBeInstanceOf(Map);
    expect(workspaceWalkedPaths(root)).toBeUndefined();

    // A root this walk never visited hands out nothing: the record belongs to the root it was taken for.
    const other = join(root, "other");
    mkdirSync(other, { recursive: true });
    write(join(other, "tsconfig.json"), manifest({ extends: "./gone.json" }));
    expect(workspaceWalkedPaths(other)).toBeUndefined();
  });

  it("counts the unresolved members beside the first one it names, in the singular where there is one", () => {
    const one = tmp;
    write(join(one, "tsconfig.json"), manifest({ extends: ["./gone-a.json", "./gone-b.json"] }));
    write(join(one, "a.ts"), SOURCE);

    expect(walked(one).unresolved).toHaveLength(2);
    expect(workspaceSnapshotReason(one)).toBe(
      `the config closure under "${resolve(one)}" is not provable: ` +
        `extends resolves to nothing: "./gone-a.json" in "${join(one, "tsconfig.json")}"` +
        ", and 1 other unresolved member",
    );

    const two = join(tmp, "two");
    write(join(two, "tsconfig.json"), manifest({ extends: ["./gone-a.json", "./gone-b.json", "./gone-c.json"] }));

    expect(walked(two).unresolved).toHaveLength(3);
    expect(workspaceSnapshotReason(two)).toBe(
      `the config closure under "${resolve(two)}" is not provable: ` +
        `extends resolves to nothing: "./gone-a.json" in "${join(two, "tsconfig.json")}"` +
        ", and 2 other unresolved members",
    );
    // One sentence per root, and the list of others does not leak between them.
    expect(workspaceSnapshotReason(one)).toContain(", and 1 other unresolved member");
  });

  it("keeps the reason it could not prove a closure with the root it belongs to", () => {
    const broken = tmp;
    const brokenConfig = write(join(broken, "tsconfig.json"), manifest({ extends: "./gone.json" }));
    const clean = join(broken, "clean");
    write(join(clean, "tsconfig.json"), manifest({}));
    write(join(clean, "a.ts"), SOURCE);
    const reasonForBroken =
      `the config closure under "${resolve(broken)}" is not provable: ` +
      `extends resolves to nothing: "./gone.json" in "${brokenConfig}"`;

    expect(walkWorkspace(broken)).toBeDefined();
    expect(workspaceSnapshotReason(broken)).toBe(reasonForBroken);

    expect(walkWorkspace(clean)).toBeDefined();
    expect(workspaceSnapshotReason(clean)).toBeUndefined();
    // The clean root proved its own closure and said nothing about the other one.
    expect(workspaceSnapshotReason(broken)).toBe(reasonForBroken);
    expect(takeWorkspaceSnapshot(clean)).toBeInstanceOf(Map);
    expect(takeWorkspaceSnapshot(broken)).toBeUndefined();
  });

  it("leaves the closure unprovable when extends names a directory that holds no tsconfig.json", () => {
    const root = tmp;
    const config = write(join(root, "tsconfig.json"), manifest({ extends: "./shared" }));
    // A directory means its `tsconfig.json`, and where the directory holds none the
    // spec resolves to nothing rather than to a path the snapshot would then track as unreadable
    //: the walk reports it unresolved and hands out no snapshot.
    mkdirSync(join(root, "shared"));
    const phantom = join(root, "shared", "tsconfig.json");

    const result = walked(root);
    expect(result.unresolved).toEqual([`extends resolves to nothing: "./shared" in "${config}"`]);
    expect(result.entries.has(phantom)).toBe(false);
    expect([...result.entries.values()].some((stamp) => stamp === "unreadable")).toBe(false);
    expect(takeWorkspaceSnapshot(root)).toBeUndefined();
    expect(workspaceSnapshotReason(root)).toBe(
      `the config closure under "${resolve(root)}" is not provable: ` +
        `extends resolves to nothing: "./shared" in "${config}"`,
    );
  });

  it("tracks the directory itself only as far as the sources in it, never as a closure member", () => {
    const root = tmp;
    write(join(root, "tsconfig.json"), manifest({ extends: "./shared" }));
    const inside = write(join(root, "shared", "options.json"), manifest({ compilerOptions: {} }));
    const source = write(join(root, "a.ts"), SOURCE);

    const entries = walked(root).entries;
    // `shared/options.json` is not what `./shared` means, so it is not in the closure either; the source is
    // tracked because every TS/JS file under the root is.
    expect(entries.has(inside)).toBe(false);
    expect(entries.has(source)).toBe(true);
    expect(entries.has(join(root, "shared", "tsconfig.json"))).toBe(false);
  });
});

describe("the workspace walk's entry bound", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-wsnap-big-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  }, 120_000);

  it("reports nothing at all when the tree holds more entries than the shared bound may claim", () => {
    // The bound is the walk's own `MAX_WALK_ENTRIES` (20 000) and is not adjustable from outside, so this
    // case builds past it: one claim per enumerated entry, tracked or not.
    const root = tmp;
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "./gone.json" }));
    // A completed walk with an unprovable closure leaves a path set behind for the project map to be built
    // from; an incomplete one must not, or a partial view of the tree becomes a project map claiming the root.
    expect(walkWorkspace(root)).toBeDefined();
    expect(workspaceWalkedPaths(root)).toBeDefined();
    for (let index = 0; index < 20_005; index++) writeFileSync(join(root, `filler${index}.txt`), "");

    expect(walkWorkspace(root)).toBeUndefined();
    expect(workspaceWalkedPaths(root)).toBeUndefined();
    expect(takeWorkspaceSnapshot(root)).toBeUndefined();
    expect(workspaceSnapshotReason(root)).toBe(
      `the workspace walk under "${resolve(root)}" did not complete within its 20000-entry bound`,
    );
  }, 300_000);
});
