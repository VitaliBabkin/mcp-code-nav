import { readFile, stat } from "node:fs/promises";
import { pathKey } from "../paths/path-containment.js";
import { type Budget, withinBudget } from "../tools/budget.js";
import type { TsUncoveredMention } from "../tools/ts-navigation-shared.js";

/**
 * Which of the sources no tsconfig project includes hold the subject's name in their text
 *. A mention is a pointer for a text search, never a row: nothing this
 * scan finds is counted as a use, named in the listing, or allowed to change `isError`.
 *
 * Every file is read as UTF-8 under the call's remaining budget, and every file that could not be read — too
 * big, unreadable, or behind a total or a budget that ran out — is counted in `unchecked` rather than quietly
 * skipped. The files are sized first and the ones to read are chosen in the order given, so the byte caps cut the same files they
 * would cut one at a time; only the reads of the chosen files overlap.
 */

/** A file this scan will not open: reading a whole generated bundle to count one word costs the call. */
export const UNCOVERED_MENTION_FILE_BYTES = 1_048_576;

/** The most any one call reads for mentions, however many files ask for it. */
export const UNCOVERED_MENTION_TOTAL_BYTES = 33_554_432;

/** How many files (or hover requests, for the outline) are in flight at once; bounds open handles and queued requests. */
export const READ_CONCURRENCY = 32;

/** What a call's scan found: every file holding the name, and how many it could not read. */
export interface MentionHits {
  readonly hits: readonly TsUncoveredMention[];
  readonly unchecked: number;
}

/** The scan, as the `scope` block reaches it; a measurement arm replaces it with an answer of its own. */
export type MentionScanner = (files: readonly string[], name: string, budget: Budget) => Promise<MentionHits>;

/**
 * The name as a whole identifier: neither neighbour may be a character an identifier can carry (`$` included,
 * because source holds it), which is what stops `Store` matching inside `Storehouse` or `$Store`. Comments and
 * strings count — this is text, and the block that publishes it says so.
 */
function mentionOf(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`(?<![\\p{ID_Continue}$])${escaped}(?![\\p{ID_Continue}$])`, "u");
}

/** How many lines of `text` hold at least one occurrence; a text without the bare name is not split at all. */
function countLines(text: string, name: string, pattern: RegExp): number {
  if (!text.includes(name)) return 0;
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (pattern.test(line)) lines += 1;
  }
  return lines;
}

/** The size of one file, or `undefined` when even that could not be read. */
async function sizeOf(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size;
  } catch {
    return undefined;
  }
}

/** `work` over `items`, at most `READ_CONCURRENCY` at a time, each result filed under its index as it settles; a spent budget starts no more. */
async function inPool<T, R>(
  budget: Budget,
  items: readonly T[],
  work: (item: T) => Promise<R>,
  settled: (index: number, result: R) => void,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length && budget.remainingMs() > 0) {
      const index = next++;
      settled(index, await work(items[index] as T));
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, lane));
}

/**
 * The files to read, chosen in the order given: the ones the byte caps leave, and how many the caps and an
 * unreadable size set aside.
 */
function chooseReads(
  files: readonly string[],
  sizes: ReadonlyMap<string, number | undefined>,
): { readonly chosen: readonly string[]; readonly setAside: number } {
  const chosen: string[] = [];
  let setAside = 0;
  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
    if (totalBytes >= UNCOVERED_MENTION_TOTAL_BYTES) {
      setAside += files.length - index;
      break;
    }
    const size = sizes.get(file);
    if (size === undefined || size > UNCOVERED_MENTION_FILE_BYTES) {
      setAside += 1;
      continue;
    }
    totalBytes += size;
    chosen.push(file);
  }
  return { chosen, setAside };
}

/**
 * Which of `files` mention `name`, under `budget`. The hits come back complete and ordered by line count
 * descending then path: the cap that bounds the published list belongs to the block that publishes it, while
 * the exact number of files that mention the name belongs here.
 */
export async function scanMentions(files: readonly string[], name: string, budget: Budget): Promise<MentionHits> {
  // A budget the type-aware question spent is a fact about the answer's scope, and the caller has to be able to read it.
  // An empty name matches at every boundary, so it is no search at all.
  if (files.length === 0 || name === "" || budget.remainingMs() <= 0) return { hits: [], unchecked: files.length };
  const sizes = new Map<string, number | undefined>();
  const sized = await withinBudget(
    inPool(budget, files, sizeOf, (index, size) => sizes.set(files[index] as string, size)).then(() => true),
    budget,
  );
  if (sized === undefined) return { hits: [], unchecked: files.length };

  const { chosen, setAside } = chooseReads(files, sizes);
  const pattern = mentionOf(name);
  const read = new Map<string, number | undefined>();
  await withinBudget(
    inPool(
      budget,
      chosen,
      (file) => readFile(file, "utf-8").then((text) => countLines(text, name, pattern), () => undefined),
      (index, lines) => read.set(chosen[index] as string, lines),
    ),
    budget,
  );

  const hits: TsUncoveredMention[] = [];
  let unchecked = setAside;
  for (const file of chosen) {
    const lines = read.get(file);
    if (lines === undefined) unchecked += 1;
    else if (lines > 0) hits.push({ file, matchingLines: lines });
  }
  return { hits: order(hits), unchecked };
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function order(hits: readonly TsUncoveredMention[]): readonly TsUncoveredMention[] {
  return [...hits].sort(
    (left, right) => right.matchingLines - left.matchingLines || compareKeys(pathKey(left.file), pathKey(right.file)),
  );
}
