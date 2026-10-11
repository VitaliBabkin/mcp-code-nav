import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModuleRootPathKind } from "../gopls/module-root.js";
import { containingRoot } from "../paths/path-containment.js";

/**
 * The root a tsgo answer covers. It is the npm *workspace* holding the file, not the
 * nearest `tsconfig.json`: configs come in sibling and solution sets inside one package, and the workspace is
 * what npm links — so a member package's consumer sits in a sibling of the file named, the shape of a
 * monorepo `packages/ui` member that a per-config root would answer only partly for.
 */

const PACKAGE_JSON = "package.json";
const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

/** Where the search began, what it rooted the session at, and — when it declined a wider root — why. */
export type WorkspaceRootOutcome =
  | { readonly kind: "found"; readonly workspaceRoot: string; readonly enclosingWorkspace: string | null }
  | { readonly kind: "outside-roots"; readonly workspaceRoot: string; readonly declaredRoots: readonly string[] }
  | { readonly kind: "not-in-package"; readonly searchedFrom: string };

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

/** A `package.json` whose `workspaces` field lists anything is a workspace root's manifest. */
function declaresWorkspaces(packageJsonPath: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return false;
  }
  const workspaces =
    typeof parsed === "object" && parsed !== null ? (parsed as { workspaces?: unknown }).workspaces : undefined;
  if (Array.isArray(workspaces)) return workspaces.length > 0;
  // npm, pnpm and yarn each spell the field a list, and a map of lists is what a scoped setup writes; either
  // one makes this directory the root that links the others.
  if (typeof workspaces === "object" && workspaces !== null) return Object.keys(workspaces).length > 0;
  return false;
}

function isWorkspaceRoot(dir: string): boolean {
  const manifest = join(dir, PACKAGE_JSON);
  if (existsSync(manifest) && declaresWorkspaces(manifest)) return true;
  return existsSync(join(dir, PNPM_WORKSPACE_FILE));
}

/**
 * The workspace above `packageRoot`, or `undefined` when the package is its own workspace. Strictly above: a
 * package that declares workspaces and holds the named file directly is already the root, and naming it
 * twice would report a widening that spans nothing.
 */
function enclosingWorkspace(packageRoot: string): string | undefined {
  let dir = dirname(packageRoot);
  for (;;) {
    if (isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The npm workspace holding `path`, searched to the filesystem root and then compared with the declared roots
 * the way `findModuleRoot` compares a module: inside, outside (named, never rooted), or no package at all.
 *
 * A workspace above the package that lies outside every declared root is not used — the package is, and
 * `enclosingWorkspace` names the root that was not spanned, which is `go.work`'s treatment applied to npm links.
 */
export function findWorkspaceRoot(
  path: string,
  roots: readonly string[],
  kind: ModuleRootPathKind = "file",
): WorkspaceRootOutcome {
  const searchedFrom = kind === "directory" ? resolve(path) : dirname(resolve(path));
  const manifest = nearestAncestorFile(searchedFrom, PACKAGE_JSON);
  if (manifest === undefined) return { kind: "not-in-package", searchedFrom };
  const packageRoot = dirname(manifest);

  const declaredRoots = roots.map((root) => resolve(root));
  const workspace = enclosingWorkspace(packageRoot);
  if (workspace !== undefined && containingRoot(declaredRoots, workspace) !== undefined) {
    return { kind: "found", workspaceRoot: workspace, enclosingWorkspace: null };
  }
  if (containingRoot(declaredRoots, packageRoot) !== undefined) {
    return { kind: "found", workspaceRoot: packageRoot, enclosingWorkspace: workspace ?? null };
  }
  return { kind: "outside-roots", workspaceRoot: packageRoot, declaredRoots };
}
