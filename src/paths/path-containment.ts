import { isAbsolute, relative, resolve, sep } from "node:path";

/** `resolve`, case-folded on win32 where one path is routinely spelled with different casing; compare paths by this. */
export function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * True when a `relative()` result leads outside its base: only a `..` *segment* escapes (`..hidden` is an
 * ordinary entry), and a path on another drive or root escapes without any `..`.
 */
export function isEscapingRelative(rel: string): boolean {
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
}

/** True when `path` steps outside `root`. */
export function escapesRoot(root: string, path: string): boolean {
  return isEscapingRelative(relative(root, path));
}

/** The first of `absoluteRoots` that contains `absolutePath`, or `undefined` when none does. */
export function containingRoot(absoluteRoots: readonly string[], absolutePath: string): string | undefined {
  return absoluteRoots.find((root) => !escapesRoot(root, absolutePath));
}
