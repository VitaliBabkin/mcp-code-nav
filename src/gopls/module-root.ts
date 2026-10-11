import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { containingRoot } from "../paths/path-containment.js";

/**
 * The three outcomes of deriving a file's Go module root. They stay distinct because they need
 * different answers: a root outside the declared boundary must not be rooted in silently, and a file
 * with no module at all must not read as a module whose answer happens to be empty.
 */
export type ModuleRootOutcome =
  | { readonly kind: "found"; readonly moduleRoot: string; readonly goWork: string | null }
  | { readonly kind: "outside-roots"; readonly moduleRoot: string; readonly declaredRoots: readonly string[] }
  | { readonly kind: "not-in-module"; readonly searchedFrom: string };

const GO_MOD = "go.mod";
const GO_WORK = "go.work";

/**
 * What shape the path a module is derived from has. A file's `go.mod` can only be at or above its own
 * directory; a directory may BE the module root, so its own directory is where the search starts.
 */
export type ModuleRootPathKind = "file" | "directory";

/** `startDir` itself, then every ancestor, stopping at the volume root (`dirname` is a fixed point there). */
function nearestAncestorFile(startDir: string, name: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The nearest `go.mod` at or above `path`, checked against the declared roots only AFTER the upward
 * search runs out: stopping the search at the outermost `sourceRoots` entry would fold "found, but
 * outside the boundary" into "none found" and report one boundary defect as the other
 *. `goWork` is the nearest `go.work` at or above the module root, reported even
 * though the child runs with `GOWORK=off` and so does not span it. A `directory` starts the search at
 * itself, because a module root is a legal anchor and its own `go.mod` is the answer for it.
 */
export function findModuleRoot(
  path: string,
  sourceRoots: readonly string[],
  kind: ModuleRootPathKind = "file",
): ModuleRootOutcome {
  const searchedFrom = kind === "directory" ? resolve(path) : dirname(resolve(path));
  const goMod = nearestAncestorFile(searchedFrom, GO_MOD);
  if (goMod === undefined) return { kind: "not-in-module", searchedFrom };

  const moduleRoot = dirname(goMod);
  const declaredRoots = sourceRoots.map((root) => resolve(root));
  if (containingRoot(declaredRoots, moduleRoot) === undefined) {
    return { kind: "outside-roots", moduleRoot, declaredRoots };
  }
  return { kind: "found", moduleRoot, goWork: nearestAncestorFile(moduleRoot, GO_WORK) ?? null };
}
