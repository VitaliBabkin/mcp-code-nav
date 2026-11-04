// Language-neutral helpers the live suites share: reading a fixture's text, comparing the paths a server
// reports, and tearing down a directory a killed server may still hold.

import { readFileSync, rmSync } from "node:fs";
import { relative, sep } from "node:path";

export const linesOf = (file: string): string[] => readFileSync(file, "utf-8").split(/\r?\n/);

/** The 1-based line a fixture text sits on, or a failure naming the fixture that no longer carries it. */
export function lineOf(file: string, needle: string): number {
  const index = linesOf(file).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer declares "${needle}" in ${file}`);
  return index + 1;
}

/** Paths compared the way the workspace model compares them: separators normalised, case folded on this OS. */
export const pathKey = (path: string): string => path.replace(/\\/g, "/").toLowerCase();

/** Whether two spellings name one path, on the footing the OS compares them; an absent path names nothing. */
export function samePath(a: string | null | undefined, b: string): boolean {
  return a !== undefined && a !== null && pathKey(a) === pathKey(b);
}

/** `path` under `root` in forward slashes; its own spelling when it is not under it at all. */
export function under(root: string, path: string | null | undefined): string {
  if (path === undefined || path === null) return "<none>";
  const rel = relative(root, path);
  if (!rel.startsWith("..")) return rel.split(sep).join("/");
  // The same directory spelled with another drive-letter case is still under it: `relative` would call that an
  // escape, and the server spells a URI back the way it was given one.
  const key = pathKey(root);
  return pathKey(path).startsWith(`${key}/`)
    ? path
        .slice(key.length + 1)
        .split("\\")
        .join("/")
    : path;
}

/** `child.kill()` does not wait, and on Windows the killed server held `dir` as its working directory. */
export async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= 9) throw e;
      await new Promise((done) => setTimeout(done, 300));
    }
  }
}
