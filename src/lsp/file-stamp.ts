import { statSync } from "node:fs";

/**
 * `size|mtimeMs` for one path, or `undefined` when it cannot be stat'ed. This is the whole currency of
 * the staleness checks in `session.ts` and `src/gopls/module-snapshot.ts`: two files are the same file
 * when their stamps are equal strings, and a stamp that cannot be taken is reported as such rather
 * than as a change or as a match.
 */
export function fileStamp(path: string): string | undefined {
  try {
    const { size, mtimeMs } = statSync(path);
    return `${size}|${mtimeMs}`;
  } catch {
    return undefined;
  }
}
