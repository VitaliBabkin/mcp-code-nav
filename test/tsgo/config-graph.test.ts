import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfigGraph, type ConfigGraph, type ConfigGraphDeps } from "../../src/tsgo/config-graph.js";

/**
 * The config closure, read through this module's own injection seam. Every case says
 * what the disk holds instead of building it, because what is under test is the resolution rule itself — a
 * directory means its `tsconfig.json`, a bare specifier means `node_modules` — and only an injected answer
 * shows which candidate the rule landed on.
 */

/** The workspace root the graph is told it is confined to. */
const ROOT = resolve("/workspace");
/** A tree that is not under `ROOT`, for a spec the graph must refuse to follow. */
const OUTSIDE = resolve("/outside");

const under = (...parts: string[]): string => join(ROOT, ...parts);
const outside = (...parts: string[]): string => join(OUTSIDE, ...parts);

/** The root config, the seed every case that names none other starts from. */
const ROOT_CONFIG = under("tsconfig.json");

/** The two fields a manifest carries that the graph reads; anything else is ignored. */
interface Manifest {
  readonly extends?: unknown;
  readonly references?: unknown;
}

interface DiskTable {
  /** Config files whose manifest this server can read; each is visited as a project. */
  readonly configs?: Record<string, Manifest>;
  /** Files that exist and yield no manifest this server can read. */
  readonly unreadable?: readonly string[];
  /** Directories: a spec naming one resolves to that directory's `tsconfig.json`. */
  readonly directories?: readonly string[];
  /** Any other existing file, such as an `extends` target or a bare specifier's package file. */
  readonly files?: readonly string[];
}

/** The graph of `seeds` over a disk the table describes, with every manifest read recorded in order. */
function graphOf(
  table: DiskTable,
  seeds: readonly string[],
  root: string = ROOT,
): { graph: ConfigGraph; reads: string[] } {
  const reads: string[] = [];
  const configs = table.configs ?? {};
  const files = new Set<string>([...Object.keys(configs), ...(table.unreadable ?? []), ...(table.files ?? [])]);
  const directories = new Set<string>(table.directories ?? []);
  const deps: ConfigGraphDeps = {
    readJson: (path) => {
      reads.push(path);
      return configs[path];
    },
    kindOf: (path) => (directories.has(path) ? "directory" : files.has(path) ? "file" : undefined),
  };
  return { graph: readConfigGraph(seeds, root, deps), reads };
}

/** `references: [{path}]` as a manifest spells it. */
const refs = (...paths: string[]): Manifest => ({ references: paths.map((path) => ({ path })) });

describe("readConfigGraph", () => {
  it("makes every config a references target names a project, transitively, in the order the walk reaches them", () => {
    const app = under("packages", "app", "tsconfig.json");
    const ui = under("packages", "ui", "tsconfig.json");
    const shared = under("packages", "shared", "tsconfig.json");
    const { graph } = graphOf(
      {
        configs: {
          [ROOT_CONFIG]: refs("./packages/app", "./packages/ui/tsconfig.json"),
          [app]: refs("../shared"),
          [ui]: {},
          [shared]: {},
        },
        directories: [under("packages", "app"), under("packages", "shared")],
      },
      [ROOT_CONFIG],
    );

    expect(graph.projects).toEqual([ROOT_CONFIG, app, shared, ui]);
    expect(graph.referenceOrder).toEqual([app, shared, ui]);
    expect(graph.closure).toEqual([ROOT_CONFIG, app, shared, ui]);
    expect(graph.unresolved).toEqual([]);
    expect(graph.unreadable).toEqual([]);
  });

  // The closure is transitive, and the chain tsconfig.json -> tsconfig.base.json ->
  // compiler-options.json is the shape a workspace actually uses: stopping one level short leaves the file at
  // the end untracked, so an edit to it neither pushes freshness nor invalidates the project map.
  it("follows `extends` through every inherited config, reading each one it reaches", () => {
    const base = under("tsconfig.base.json");
    const options = under("compiler-options.json");
    const { graph, reads } = graphOf(
      {
        configs: {
          [ROOT_CONFIG]: { extends: "./tsconfig.base.json" },
          [base]: { extends: "./compiler-options.json" },
          [options]: { compilerOptions: {} },
        },
      },
      [ROOT_CONFIG],
    );

    expect(graph.closure).toEqual([ROOT_CONFIG, base, options]);
    expect(graph.projects).toEqual([ROOT_CONFIG]);
    expect(reads).toEqual([ROOT_CONFIG, base, options]);
    expect(graph.unresolved).toEqual([]);
  });

  it("reports an inherited config's own unresolvable `extends`, naming the config that declared it", () => {
    const base = under("tsconfig.base.json");
    const { graph } = graphOf(
      {
        configs: {
          [ROOT_CONFIG]: { extends: "./tsconfig.base.json" },
          [base]: { extends: "./gone.json" },
        },
      },
      [ROOT_CONFIG],
    );

    expect(graph.unresolved).toEqual([`extends resolves to nothing: "./gone.json" in "${base}"`]);
    expect(graph.closure).toEqual([ROOT_CONFIG, base]);
  });

  it("resolves a `references` path that carries no leading ./ against the config that named it", () => {
    const app = under("configs", "app.json");
    const { graph } = graphOf({ configs: { [ROOT_CONFIG]: refs("configs/app.json"), [app]: {} } }, [ROOT_CONFIG]);

    // A reference names a path, never a package: `node_modules` has nothing to do with it, and treating it as
    // a specifier makes a valid reference unresolvable and the snapshot with it.
    expect(graph.projects).toEqual([ROOT_CONFIG, app]);
    expect(graph.referenceOrder).toEqual([app]);
    expect(graph.unresolved).toEqual([]);
  });

  it("records each config's own reference targets in the order that config lists them", () => {
    const app = under("packages", "app", "tsconfig.json");
    const ui = under("packages", "ui", "tsconfig.json");
    const shared = under("packages", "shared", "tsconfig.json");
    const { graph } = graphOf(
      {
        configs: {
          [ROOT_CONFIG]: refs("./packages/ui/tsconfig.json", "./packages/app"),
          [app]: refs("../shared"),
          [ui]: {},
          [shared]: {},
        },
        directories: [under("packages", "app"), under("packages", "shared")],
      },
      [ROOT_CONFIG],
    );

    // The listed order is the owner rule's search order, so it survives the depth-first walk's different one.
    expect(graph.referencesOf.get(ROOT_CONFIG)).toEqual([ui, app]);
    expect(graph.referencesOf.get(app)).toEqual([shared]);
    expect(graph.referenceOrder).toEqual([ui, app, shared]);
  });

  it("reads a references target that is a directory as that directory's tsconfig.json", () => {
    const target = under("configs", "app", "tsconfig.json");
    const { graph } = graphOf({ configs: { [ROOT_CONFIG]: refs("./configs/app"), [target]: {} }, directories: [under("configs", "app")] }, [ROOT_CONFIG]);

    expect(graph.projects).toEqual([ROOT_CONFIG, target]);
    expect(graph.referencesOf.get(ROOT_CONFIG)).toEqual([target]);
    expect(graph.unresolved).toEqual([]);
  });

  it("reads an extends target that is a directory as that directory's tsconfig.json", () => {
    const base = under("shared", "tsconfig.json");
    const { graph } = graphOf(
      { configs: { [ROOT_CONFIG]: { extends: "./shared" }, [base]: {} }, directories: [under("shared")] },
      [ROOT_CONFIG],
    );

    // A directory is only a closure member because a file sits in it under the one name the rule looks for.
    expect(graph.closure).toEqual([ROOT_CONFIG, base]);
    expect(graph.unresolved).toEqual([]);
  });

  it("takes an extends that names a directory holding no tsconfig.json as resolving to nothing, never a phantom file", () => {
    const phantom = under("shared", "tsconfig.json");
    const { graph } = graphOf(
      { configs: { [ROOT_CONFIG]: { extends: "./shared" } }, directories: [under("shared")] },
      [ROOT_CONFIG],
    );

    // A closure member has to be an existing file, so the spec
    // is unresolved and the path the directory WOULD have resolved to joins neither the closure nor the snapshot.
    expect(graph.unresolved).toEqual([`extends resolves to nothing: "./shared" in "${ROOT_CONFIG}"`]);
    expect(graph.closure).toEqual([ROOT_CONFIG]);
    expect(graph.closure).not.toContain(phantom);
    expect(graph.projects).toEqual([ROOT_CONFIG]);
    expect(graph.unreadable).toEqual([]);
  });

  it("takes a references target that is a directory holding no tsconfig.json the same way", () => {
    const phantom = under("configs", "app", "tsconfig.json");
    const { graph } = graphOf(
      { configs: { [ROOT_CONFIG]: refs("./configs/app") }, directories: [under("configs", "app")] },
      [ROOT_CONFIG],
    );

    // Not a project, not a reference edge, not a closure file: a project this server cannot name is a spec
    // that resolves to nothing, and the unprovable closure says so in those words.
    expect(graph.unresolved).toEqual([`references resolves to nothing: "./configs/app" in "${ROOT_CONFIG}"`]);
    expect(graph.projects).toEqual([ROOT_CONFIG]);
    expect(graph.referencesOf.get(ROOT_CONFIG)).toEqual([]);
    expect(graph.referenceOrder).toEqual([]);
    expect(graph.closure).not.toContain(phantom);
    expect(graph.unreadable).toEqual([]);
  });

  it("puts an extends target in the closure, never among the projects, whether it is one string or a list", () => {
    const app = under("packages", "app", "tsconfig.json");
    const options = under("compiler-options.json");
    const local = under("packages", "app", "local.json");
    const base = under("shared", "base.json");
    const { graph, reads } = graphOf(
      {
        configs: {
          [ROOT_CONFIG]: { extends: "./compiler-options.json", references: [{ path: "./packages/app/tsconfig.json" }] },
          [app]: { extends: ["./local.json", "../../shared/base.json"] },
          // Each inherited file is a config on disk, so the table holds its manifest: reading it is what lets
          // the chain below it be followed. An inherited file that yielded no manifest would make the closure
          // unprovable, which the case above this one pins.
          [options]: { compilerOptions: {} },
          [local]: { compilerOptions: {} },
          [base]: { compilerOptions: {} },
        },
      },
      [ROOT_CONFIG],
    );

    expect(graph.closure).toContain(options);
    expect(graph.closure).toContain(local);
    expect(graph.closure).toContain(base);
    // An options file configures a project without being one: no project, no reference entry — but each one it
    // names IS read, because the config below it in the chain is only knowable by reading the one above
    //.
    expect(graph.projects).toEqual([ROOT_CONFIG, app]);
    expect(graph.referencesOf.has(options)).toBe(false);
    expect(graph.referencesOf.has(local)).toBe(false);
    expect(reads).toContain(options);
    expect(reads).toContain(base);
    expect(graph.unresolved).toEqual([]);
  });

  it("appends .json to an extends or references name that carries no extension", () => {
    const options = under("compiler-options.json");
    const member = under("configs", "member.json");
    // The rule lands on `configs/member.json`, so that is the file the disk holds; naming it without the
    // extension is what the config says.
    const { graph } = graphOf(
      {
        configs: {
          [ROOT_CONFIG]: { extends: "./compiler-options", references: [{ path: "./configs/member" }] },
          [member]: {},
        },
        files: [options],
      },
      [ROOT_CONFIG],
    );

    expect(graph.closure).toContain(options);
    expect(graph.projects).toEqual([ROOT_CONFIG, member]);
    expect(graph.referencesOf.get(ROOT_CONFIG)).toEqual([member]);
  });

  it("resolves a relative target from the directory of the config that named it, not from the workspace root", () => {
    const app = under("packages", "app", "tsconfig.json");
    const base = under("shared", "base.json");
    const sibling = under("packages", "ui", "tsconfig.json");
    const { graph } = graphOf(
      {
        configs: {
          [app]: { extends: "../../shared/base.json", references: [{ path: "../ui/tsconfig.json" }] },
          [sibling]: {},
        },
        files: [base],
      },
      [app],
    );

    expect(graph.closure).toContain(base);
    expect(graph.projects).toEqual([app, sibling]);
  });

  it("takes an absolute target as written, in either field", () => {
    const base = under("configs", "base.json");
    const member = under("configs", "member.json");
    // Both specs are absolute and already carry `.json`, so the graph takes each path as written.
    const { graph } = graphOf(
      {
        configs: {
          [ROOT_CONFIG]: { extends: base, references: [{ path: member }] },
          [member]: {},
        },
        files: [base],
      },
      [ROOT_CONFIG],
    );

    expect(graph.closure).toContain(base);
    expect(graph.projects).toEqual([ROOT_CONFIG, member]);
  });

  it("resolves a bare specifier in the config's own node_modules before a hoisted copy above it", () => {
    const app = under("packages", "app", "tsconfig.json");
    const nested = under("packages", "app", "node_modules", "@example", "base", "tsconfig.json");
    const hoisted = under("node_modules", "@example", "base", "tsconfig.json");
    const { graph } = graphOf({ configs: { [app]: { extends: "@example/base" } }, files: [nested, hoisted] }, [app]);

    expect(graph.closure).toContain(nested);
    expect(graph.closure).not.toContain(hoisted);
  });

  it("walks up to an ancestor's node_modules when the config's own directory holds no such package", () => {
    const app = under("packages", "app", "tsconfig.json");
    const hoisted = under("node_modules", "@example", "strict.json");
    // A table that holds the file must also hold its manifest now that an inherited config is read: a file
    // that exists but yields no config is an unprovable closure, which is the other case's subject.
    const { graph } = graphOf(
      { configs: { [app]: { extends: "@example/strict" }, [hoisted]: { compilerOptions: {} } } },
      [app],
    );

    expect(graph.closure).toContain(hoisted);
    expect(graph.unresolved).toEqual([]);
  });

  it("takes node_modules/<spec> itself when that path is a file", () => {
    const plain = under("node_modules", "tsconfig-plain");
    const { graph } = graphOf({ configs: { [ROOT_CONFIG]: { extends: "tsconfig-plain" } }, files: [plain] }, [ROOT_CONFIG]);

    expect(graph.closure).toContain(plain);
  });

  it("reports an extends that resolves to nothing, naming the spec and the config that named it", () => {
    const { graph } = graphOf({ configs: { [ROOT_CONFIG]: { extends: "./gone.json" } } }, [ROOT_CONFIG]);

    expect(graph.unresolved).toEqual([`extends resolves to nothing: "./gone.json" in "${ROOT_CONFIG}"`]);
  });

  it("reports an extends that resolves outside the workspace root in different words, and does not track it", () => {
    const escape = outside("shared", "base.json");
    const { graph } = graphOf({ configs: { [ROOT_CONFIG]: { extends: escape } }, files: [escape] }, [ROOT_CONFIG]);

    expect(graph.unresolved).toEqual([`extends resolves outside the workspace: "${escape}" in "${ROOT_CONFIG}"`]);
    expect(graph.closure).not.toContain(escape);
  });

  it("names the config that named a reference target it cannot resolve", () => {
    const app = under("packages", "app", "tsconfig.json");
    const { graph } = graphOf({ configs: { [ROOT_CONFIG]: refs("./packages/app/tsconfig.json"), [app]: refs("./missing") } }, [ROOT_CONFIG]);

    expect(graph.unresolved).toEqual([`references resolves to nothing: "./missing" in "${app}"`]);
  });

  it("reports a reference target outside the workspace root and keeps it out of the projects and the closure", () => {
    const pkg = under("packages", "app", "tsconfig.json");
    const escape = outside("configs", "app", "tsconfig.json");
    const { graph } = graphOf(
      { configs: { [pkg]: refs("../../../outside/configs/app") }, directories: [outside("configs", "app")] },
      [pkg],
    );

    expect(graph.unresolved).toEqual([`references resolves outside the workspace: "../../../outside/configs/app" in "${pkg}"`]);
    expect(graph.projects).toEqual([pkg]);
    expect(graph.referencesOf.get(pkg)).toEqual([]);
    expect(graph.closure).not.toContain(escape);
    expect(graph.referenceOrder).toEqual([]);
  });

  it("reports a config it cannot read and follows no reference from it", () => {
    const member = under("packages", "member", "tsconfig.json");
    const beyond = under("packages", "beyond", "tsconfig.json");
    const { graph, reads } = graphOf(
      {
        configs: { [ROOT_CONFIG]: refs("./packages/member/tsconfig.json"), [beyond]: {} },
        unreadable: [member],
      },
      [ROOT_CONFIG],
    );

    expect(graph.unresolved).toEqual([`no config this server can read at "${member}"`]);
    // An unreadable config is reported as such, because the
    // project map turns each one into a failed project rather than leaving it a bare line in `unresolved`.
    expect(graph.unreadable).toEqual([member]);
    // The config is still one the walk found, so it is a project; what it contributes is nothing else.
    expect(graph.projects).toEqual([ROOT_CONFIG, member]);
    expect(graph.referencesOf.has(member)).toBe(false);
    expect(graph.closure).not.toContain(beyond);
    expect(reads).toEqual([ROOT_CONFIG, member]);
  });

  it("stops at a references cycle instead of spinning on it", () => {
    const app = under("packages", "app", "tsconfig.json");
    // `../../tsconfig.json` is the walk's own answer for a config in `packages/app` naming the root's -
    // one `..` lands on `packages/tsconfig.json`, which this fake holds nothing for.
    const { graph } = graphOf({ configs: { [ROOT_CONFIG]: refs("./packages/app/tsconfig.json"), [app]: refs("../../tsconfig.json") } }, [ROOT_CONFIG]);

    expect(graph.projects).toEqual([ROOT_CONFIG, app]);
    expect(graph.closure).toEqual([ROOT_CONFIG, app]);
    expect(graph.referencesOf.get(ROOT_CONFIG)).toEqual([app]);
    expect(graph.referencesOf.get(app)).toEqual([ROOT_CONFIG]);
    // The edge back to the seed is still named in the walk's order; it is the visit that is refused.
    expect(graph.referenceOrder).toEqual([app, ROOT_CONFIG]);
    expect(graph.unresolved).toEqual([]);
  });

  it("visits a config that two references name only once", () => {
    const app = under("packages", "app", "tsconfig.json");
    const ui = under("packages", "ui", "tsconfig.json");
    const shared = under("packages", "shared", "tsconfig.json");
    const { graph, reads } = graphOf(
      {
        configs: {
          [ROOT_CONFIG]: refs("./packages/app/tsconfig.json", "./packages/ui/tsconfig.json"),
          [app]: refs("../shared/tsconfig.json"),
          [ui]: refs("../shared/tsconfig.json"),
          [shared]: {},
        },
      },
      [ROOT_CONFIG],
    );

    expect(reads.filter((path) => path === shared)).toHaveLength(1);
    expect(graph.projects).toEqual([ROOT_CONFIG, app, shared, ui]);
    expect(graph.closure.filter((path) => path === shared)).toHaveLength(1);
    expect(graph.referenceOrder).toEqual([app, shared, ui, shared]);
  });

  it("reports the closure bound when the configs reach more files than one workspace may claim", () => {
    // The bound is the graph's own `CLOSURE_LIMIT` of 2 000 files, with no seam to lower it, so this is a
    // chain of `references` one config longer than the bound: each config adds exactly one closure file.
    const directory = under("closure");
    const configAt = (index: number): string => join(directory, `c${index}.json`);
    const configs: Record<string, Manifest> = {};
    for (let index = 0; index < 1_999; index++) configs[configAt(index)] = refs(`./c${index + 1}.json`);
    const { graph, reads } = graphOf({ configs, files: [configAt(1_999)] }, [configAt(0)]);

    expect(graph.unresolved).toEqual([`the config closure under "${ROOT}" exceeds 2000 files`]);
    expect(graph.closure).toHaveLength(2_000);
    expect(graph.projects).toHaveLength(1_999);
    expect(reads).toHaveLength(1_999);
    // The bound stopped the walk; nothing on it failed to read, so no config is owed a failed project.
    expect(graph.unreadable).toEqual([]);
  });
});
