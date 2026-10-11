import { readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { escapesRoot } from "../paths/path-containment.js";

/**
 * The config closure: every file a set of configs reaches through `references` and
 * `extends`, resolved by the compiler's own rules rather than by a filename pattern, so a project named
 * `configs/member.json` and an options file named `compiler-options.json` are tracked although neither is
 * called `tsconfig.json`. Freshness depends on this: an edit to a config reached only through `extends`
 * changes what the compiler loads, and a walk that keyed on filenames alone would report the disk unchanged.
 *
 * A closure is only worth having if it is complete, so anything this rule cannot resolve - a dangling
 * `extends`, a config that is not JSONC this server can read, a member outside the workspace - is reported
 * as unresolved rather than dropped: an incomplete closure proves nothing, and the caller reloads.
 */

/** How many closure members one workspace may contribute before this server stops claiming to know them all. */
const CLOSURE_LIMIT = 2_000;

/** A config file's manifest, restricted to the four fields that decide what a project is. */
interface ConfigManifest {
  readonly extends?: unknown;
  readonly references?: unknown;
}

export interface ConfigGraphDeps {
  /** A file's parsed manifest, or `undefined` when it cannot be read or parsed. */
  readJson: (path: string) => ConfigManifest | undefined;
  /** Whether a path exists, and whether it is a directory (a directory means its `tsconfig.json`). */
  kindOf: (path: string) => "file" | "directory" | undefined;
}

/**
 * The graph one set of seed configs reaches. `projects` is what a project map is built from - the seeds plus
 * every config their `references` name, transitively - and `closure` is what freshness watches, which is
 * wider: it holds the `extends` files too, which configure a project without being one.
 */
export interface ConfigGraph {
  readonly projects: readonly string[];
  readonly closure: readonly string[];
  /** In the order a depth-first walk of `references` reaches them. */
  readonly referenceOrder: readonly string[];
  /** Each config's own reference targets, in the order it lists them — the owner rule's search order. */
  readonly referencesOf: ReadonlyMap<string, readonly string[]>;
  /**
   * The configs a spec named that this server could not read at all. They stay projects (the language service
   * will still try to load them), and the map reports each one as a failed project for that reason rather than leaving it a bare entry in `unresolved`.
   */
  readonly unreadable: readonly string[];
  readonly unresolved: readonly string[];
}

/** The reason an unreadable config is a failed project, stated once so both readers say the same thing. */
export function unreadableConfigReason(config: string): string {
  return `no config this server can read at "${config}"`;
}

const defaultDeps: ConfigGraphDeps = {
  readJson: (path) => {
    try {
      const parsed: unknown = parse(readFileSync(path, "utf-8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as ConfigManifest)
        : undefined;
    } catch {
      return undefined;
    }
  },
  kindOf: (path) => {
    const found = statSync(path, { throwIfNoEntry: false });
    if (found === undefined) return undefined;
    return found.isDirectory() ? "directory" : found.isFile() ? "file" : undefined;
  },
};

/** The fields `extends` carries: one string, or a list of them; anything else names nothing to read. */
function extendsSpecs(manifest: ConfigManifest): string[] {
  const value = manifest.extends;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/** `references: [{path}]` — the only field that adds a project without naming one. */
function referenceSpecs(manifest: ConfigManifest): string[] {
  const value = manifest.references;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "object" && item !== null ? (item as { path?: unknown }).path : undefined))
    .filter((path): path is string => typeof path === "string" && path !== "");
}

/**
 * A candidate path as the compiler would land on it: a directory means its `tsconfig.json`, a bare name its
 * `.json`. A closure member has to be a file that exists: a
 * directory holding no `tsconfig.json` resolves to NOTHING rather than to a phantom path the snapshot would
 * then track as unreadable, and a member that resolves to nothing leaves the closure unprovable.
 */
function asConfigFile(path: string, deps: ConfigGraphDeps): string | undefined {
  const kind = deps.kindOf(path);
  if (kind === "directory") {
    const inside = join(path, "tsconfig.json");
    return deps.kindOf(inside) === "file" ? inside : undefined;
  }
  if (kind === "file") return path;
  // `./configs/app` names `./configs/app.json`; the extension is added only when nothing is there without it.
  if (extname(path) === "") return deps.kindOf(`${path}.json`) === "file" ? `${path}.json` : undefined;
  return undefined;
}

/** A relative or absolute `extends`/`references` target, in the directory of the config that named it. */
function resolveRelative(fromConfig: string, spec: string): string {
  const base = dirname(fromConfig);
  return isAbsolute(spec) ? resolve(spec) : resolve(base, spec);
}

/** How one spec ended: a path to follow, a spec that leaves the workspace, or one that lands nowhere. */
type Spec = { readonly path: string } | { readonly outside: true } | { readonly nothing: true };

/**
 * A bare `extends` specifier, resolved the way node resolves a package: `node_modules/<spec>`,
 * `<spec>.json`, or `<spec>/tsconfig.json`, in the config's own directory and every ancestor of it. The walk
 * stops at the workspace boundary instead of stat'ing above it: a copy outside the declared roots is not this
 * server's to look for, so a specifier with no hit inside answers as nothing.
 */
function resolveSpecifier(fromConfig: string, spec: string, root: string, deps: ConfigGraphDeps): Spec {
  let directory = dirname(fromConfig);
  for (;;) {
    const modules = join(directory, "node_modules");
    for (const candidate of [join(modules, spec), `${join(modules, spec)}.json`, join(modules, spec, "tsconfig.json")]) {
      if (!withinRoot(candidate, root)) continue;
      const found = asConfigFile(candidate, deps);
      if (found !== undefined && deps.kindOf(found) === "file") return { path: found };
    }
    const parent = dirname(directory);
    if (parent === directory || !withinRoot(parent, root)) return { nothing: true };
    directory = parent;
  }
}

/**
 * One spec, in either spelling, resolved against the config that named it. That it lands outside the
 * workspace is decided from the spelling ALONE, before anything is stat'ed there: "outside the workspace"
 * and "resolves to nothing" are different facts for the caller, and stat'ing across the boundary to find out
 * which one it was would be reading outside the roots this server was given.
 */
function resolveSpec(fromConfig: string, spec: string, root: string, deps: ConfigGraphDeps): Spec {
  if (!(spec.startsWith(".") || isAbsolute(spec))) return resolveSpecifier(fromConfig, spec, root, deps);
  return resolvePathSpec(fromConfig, spec, root, deps);
}

/**
 * A path-typed spec — every `references` target, and an `extends` that spells itself as a path — resolved
 * against the directory of the config that named it. A `references` path is a path and nothing else:
 * `configs/app.json` names the file beside the declaring config, not a package to look for under
 * `node_modules`, and sending it through the specifier rule made valid references unresolvable and the
 * snapshot built from them unprovable.
 */
function resolvePathSpec(fromConfig: string, spec: string, root: string, deps: ConfigGraphDeps): Spec {
  const syntactic = resolveRelative(fromConfig, spec);
  if (!withinRoot(syntactic, root)) return { outside: true };
  const found = asConfigFile(syntactic, deps);
  if (found === undefined) return { nothing: true };
  return withinRoot(found, root) ? { path: found } : { outside: true };
}

/** A `references` target: always the declaring config's own directory to resolve from, never a specifier. */
function resolveReference(fromConfig: string, spec: string, root: string, deps: ConfigGraphDeps): Spec {
  return resolvePathSpec(fromConfig, spec, root, deps);
}

function withinRoot(path: string, root: string): boolean {
  return !escapesRoot(root, path);
}

/** What one `readConfigGraph` call accumulates while it walks. */
interface GraphState {
  readonly root: string;
  readonly deps: ConfigGraphDeps;
  readonly closure: Set<string>;
  readonly unresolved: string[];
  readonly projects: string[];
  readonly referenceOrder: string[];
  readonly referencesOf: Map<string, string[]>;
  readonly unreadable: string[];
  readonly queued: Set<string>;
  readonly inherited: Set<string>;
}

function report(state: GraphState, fromConfig: string, spec: string, why: string): void {
  state.unresolved.push(`${why}: "${spec}" in "${fromConfig}"`);
}

/** Every `extends` spec of `config`, each one followed into the closure or reported against `config`. */
function followExtends(state: GraphState, config: string, manifest: ConfigManifest): void {
  for (const spec of extendsSpecs(manifest)) {
    const target = resolveSpec(config, spec, state.root, state.deps);
    if ("outside" in target) report(state, config, spec, "extends resolves outside the workspace");
    else if ("nothing" in target) report(state, config, spec, "extends resolves to nothing");
    else inheritFrom(state, target.path, config);
  }
}

/**
 * The chain of configs one inherits its options from. Each is read, so the one below it can be followed —
 * The closure is transitive, and stopping at the first level leaves the file at the
 * end of a `tsconfig.json -> tsconfig.base.json -> compiler-options.json` chain untracked, an edit to it
 * neither pushed nor seen as a change to the map. Reading an inherited config does not make it a project:
 * only the seeds and what `references` names are projects.
 */
function inheritFrom(state: GraphState, config: string, declaring: string): void {
  if (state.inherited.has(config)) return;
  state.inherited.add(config);
  state.closure.add(config);
  const manifest = state.deps.readJson(config);
  if (manifest === undefined) {
    state.unresolved.push(`${unreadableConfigReason(config)}, inherited from "${declaring}"`);
    return;
  }
  followExtends(state, config, manifest);
}

/** Every `references` target of `config`, in listed order, each visited as a project of its own. */
function followReferences(state: GraphState, config: string, manifest: ConfigManifest): void {
  const targets: string[] = [];
  for (const spec of referenceSpecs(manifest)) {
    const target = resolveReference(config, spec, state.root, state.deps);
    if ("outside" in target) {
      report(state, config, spec, "references resolves outside the workspace");
      continue;
    }
    if ("nothing" in target) {
      report(state, config, spec, "references resolves to nothing");
      continue;
    }
    targets.push(target.path);
    state.referenceOrder.push(target.path);
    state.closure.add(target.path);
    visit(state, target.path);
  }
  state.referencesOf.set(config, targets);
}

function visit(state: GraphState, config: string): void {
  if (state.queued.has(config)) return;
  state.queued.add(config);
  if (state.closure.size >= CLOSURE_LIMIT) {
    state.unresolved.push(`the config closure under "${state.root}" exceeds ${CLOSURE_LIMIT} files`);
    return;
  }
  state.closure.add(config);
  if (!state.projects.includes(config)) state.projects.push(config);
  const manifest = state.deps.readJson(config);
  if (manifest === undefined) {
    state.unreadable.push(config);
    state.unresolved.push(unreadableConfigReason(config));
    return;
  }
  followExtends(state, config, manifest);
  followReferences(state, config, manifest);
}

/**
 * The graph of `seeds`, transited through `references`. Each config is read once - a cycle in a
 * `references` list is legal JSONC and must not spin - and every path a spec resolves to joins the closure,
 * whether or not it is itself a project. A spec that resolves to nothing, or to a path outside `root`, is
 * collected as unresolved: the caller cannot prove a closure it cannot finish.
 */
export function readConfigGraph(seeds: readonly string[], root: string, deps: Partial<ConfigGraphDeps> = {}): ConfigGraph {
  const state: GraphState = {
    root,
    deps: { ...defaultDeps, ...deps },
    closure: new Set(),
    unresolved: [],
    projects: [],
    referenceOrder: [],
    referencesOf: new Map(),
    unreadable: [],
    queued: new Set(),
    inherited: new Set(),
  };
  for (const seed of seeds) visit(state, resolve(seed));
  const { projects, referenceOrder, referencesOf, unreadable, unresolved } = state;
  return { projects, closure: [...state.closure], referenceOrder, referencesOf, unreadable, unresolved };
}
