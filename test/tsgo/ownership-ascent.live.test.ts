import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { textDocumentId } from "../../src/lsp/document-uri.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import { isExistingFile } from "../../src/paths/resolve-safe-path.js";
import { pathOfUri, rangeStart, recordOf } from "../../src/tools/lsp-locations.js";
import {
  CALL_BUDGET_MS,
  fixtures,
  itIfTsgoAvailable,
  requireTsgo,
  stampsOf,
  tsgoProcessLog,
  type TsgoProcessLog,
} from "../helpers/tsgo-live.js";

/**
 * The discriminating ownership-ascent pin, RUN. It recorded the one fact
 * about a running `tsc.exe --lsp`: whether tsgo assigns a file to a `tsconfig.json` above the one
 * in the file's own directory. It does. The pin is therefore the CLIMB branch, and that branch is the rule
 * `src/tsgo/project-map.ts` implements in `ownerOf`: at the nearest named config C, C's own listing, then C's
 * `references` closure depth-first in listed order, then the same two questions at the next named config above
 * C's directory, stopping at the first owner.
 *
 * What was measured, on the production config with no project map and no anchors, one process, one document
 * (`nested/shared.ts`) opened: `references` for the declared symbol came back with three rows —
 * `nested/shared.ts` at 0-based line 6 (its declaration) and `nested/consumer.ts` at 0-based lines 4 (the import
 * binding) and 7 (the use). `nested/consumer.ts` is in neither the nested config's listing nor its closure, so
 * the program that answered held the consumer as well as the opened file: the ancestor's. The other branch —
 * the declaration alone coming back, which would have left the ancestor owning nothing and `failed` — did not
 * happen.
 *
 * `test/fixtures/ts-workspace-ascent` is the shape this pin needs and nothing else:
 *
 * - the ancestor `tsconfig.json` includes `nested`, so its program is the only one in the fixture that holds
 *   `nested/consumer.ts` and its use of the disputed symbol;
 * - `nested/tsconfig.json` includes `inner` only, so the nearest config of `nested/shared.ts` leaves it out, and
 *   has no `references` that could reach it either;
 * - `nested/inner/owned.ts` makes the nested config a real project with a member of its own.
 *
 * Why this discriminates where the parent-climb pin did not. There, the ancestor's own anchor
 * was the consumer's file, so this server loaded the ancestor before asking, and the answer said nothing about
 * tsgo's assignment. Here the pin builds a raw session on the production config with NO project map and NO
 * anchors — it never calls `buildProjectMap`, `walkWorkspace` or `openAnchors` — so nothing loads the ancestor
 * except the disputed file's own assignment. And the one document opened is `nested/shared.ts`: under the climb
 * rule this server now implements the ancestor's anchor is `nested/consumer.ts` (the lexically first member it
 * owns) and the nested project's anchor is `nested/inner/owned.ts` (the only member its own listing names); this
 * pin opens neither, so neither project is loaded by this client, and `log.opened` being exactly the one document
 * is what makes that claim checkable rather than assumed.
 *
 * What the two answers would have meant, stated in advance, with the one that happened marked:
 *
 * - the use in `nested/consumer.ts` comes back — tsgo put the disputed file in the ancestor's program, which is
 *   THE CLIMB, and this is what the run answered, so no-ascent is the branch that
 *   contradicts the server and is not the rule this server carries;
 * - only the declaration comes back — it did not. Had it, no-ascent would have stood and the ancestor would own
 *   nothing and be a `failed` project, exactly the disagreement this pin looks for.
 *
 * The assertions now pin the measured answer: the request answered, the reply stayed inside the fixture, the
 * declaration is present at the declaration's own line, the consumer answered at the import-binding line and at
 * the use line, one document was opened, the documents-opened proof was never made because nothing was anchored
 * (opens alone make the proof, so an unanchored session stays unproven and no proof is
 * claimed here), one process served the whole pin, and the disk was not written. The `console.info` lines still
 * record the raw reply, so a re-run can be compared with the record above.
 */

const root = join(fixtures, "ts-workspace-ascent");
const sharedFile = join(root, "nested", "shared.ts");
const consumerFile = join(root, "nested", "consumer.ts");

/** The two files a row of this answer may name, by their path below the fixture root. */
const SHARED = "nested/shared.ts";
const CONSUMER = "nested/consumer.ts";

/** The disputed symbol, and the three fixture lines the measured answer named: its declaration in the opened
 * file, the consumer's import binding of it, and the consumer's use of it. */
const SYMBOL = "SHARED_HERE";
const DECLARATION = "export const SHARED_HERE";
const BINDING = "import { SHARED_HERE }";
const USE = "return SHARED_HERE;";

// ---------------------------------------------------------------- fixture reading

/** Paths compared the way the map compares them: separators normalised, case folded on this OS. */
const pathKey = (path: string): string => path.replace(/\\/g, "/").toLowerCase();

/** `path` under the fixture root in forward slashes; its own spelling when it is not under it at all. */
function under(path: string): string {
  const rel = relative(root, path);
  if (!rel.startsWith("..")) return rel.split(sep).join("/");
  // The same directory spelled with another drive-letter case is still under it: `relative` would call that an
  // escape, and the server spells a URI back the way it was given one.
  const key = pathKey(root);
  return pathKey(path).startsWith(`${key}/`) ? path.slice(key.length + 1).split("\\").join("/") : path;
}

const linesOf = (file: string): string[] => readFileSync(file, "utf-8").split(/\r?\n/);

/** The 1-based line a fixture text sits on, or a failure naming the fixture that no longer carries it. */
function lineOf(file: string, needle: string): number {
  const index = linesOf(file).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer declares "${needle}" in ${file}`);
  return index + 1;
}

/**
 * Every file of the fixture. The tree is `nested` and `nested/inner` deep and holds no `node_modules`, so this
 * is the whole of it; existence is a stat rather than a guess from the name, so a directory that appeared during
 * the run is not mistaken for one of the files it holds.
 */
function fixtureFiles(): string[] {
  const files: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2 && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          queue.push({ dir: path, depth: depth + 1 });
        }
      } else if (isExistingFile(path)) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

/** What a run must leave exactly as it found it. */
const treeStamps = (): Map<string, string> => stampsOf(fixtureFiles());

// ---------------------------------------------------------------- live scaffolding

const managers: LspSessionManager[] = [];

/** One manager per case, kept so `afterEach` disposes what a throwing assertion never reached. */
function freshManager(log: TsgoProcessLog): LspSessionManager {
  const manager = new LspSessionManager({ spawn: log.spawn });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.disposeAll();
});

// ---------------------------------------------------------------------- the answer

/** One reported location, placed on the fixture's map. `line` is 1-based, as the record states it. */
interface Row {
  readonly where: string;
  readonly line: number;
  readonly character: number | undefined;
}

/**
 * Read one entry without deciding the reply's shape first: a `Location` carries `uri` and `range`, a
 * `LocationLink` carries `targetUri` and a target range, and the pin must be able to record either (this is the
 * same reading `src/tools/lsp-locations.ts` uses for a published answer). An entry that yields neither is placed
 * nowhere, which is what fails the "nothing outside the fixture answered" assertion loudly and by name.
 */
function rowOf(entry: unknown): Row {
  const raw = recordOf(entry);
  const file = pathOfUri(raw.uri) ?? pathOfUri(raw.targetUri);
  const start = rangeStart(raw.range) ?? rangeStart(raw.targetSelectionRange) ?? rangeStart(raw.targetRange);
  if (file === undefined || start === undefined) return { where: "<unreadable entry>", line: -1, character: undefined };
  return { where: under(file), line: start.line + 1, character: start.character };
}

/** The declaration's own identifier span, the only position a type-aware request may be asked at. */
function subjectPosition(symbols: readonly LspDocumentSymbol[]): { line: number; character: number } {
  const entry = symbols.find((symbol) => symbol.name === SYMBOL);
  if (entry === undefined) {
    throw new Error(`the outline of "${SHARED}" names no "${SYMBOL}": ${JSON.stringify(symbols)}`);
  }
  const start = entry.selectionRange?.start;
  if (start === undefined) {
    throw new Error(`the "${SYMBOL}" entry of "${SHARED}" carries no selectionRange: ${JSON.stringify(entry)}`);
  }
  return start;
}

/** The whole reply, quoted: the pin's product is the record, so a failure must carry it without a re-run. */
const evidence = (answer: unknown, opened: readonly string[]): string =>
  `reply ${JSON.stringify(answer)} || documents opened on the answering process ${JSON.stringify(opened)}`;

const yesNo = (count: number): string => (count > 0 ? "yes" : "no");

/** Line numbers compare as numbers, whichever order the reply happened to report them in. */
const byLine = (left: number, right: number): number => left - right;

// ---------------------------------------------------------------------- the case

describe("a file its nearest config leaves out, asked of a tsgo that was given no anchor", () => {
  itIfTsgoAvailable(
    "opening only the disputed file answers the use in the ancestor's own file — measured CLIMB, so ownership ascends",
    async () => {
      const before = treeStamps();
      const log = tsgoProcessLog();
      const manager = freshManager(log);
      const binary = requireTsgo();
      try {
        const session = manager.get(root, tsgoConfig(binary));

        // The documents-opened proof is made by opens, and this pin makes none but the
        // disputed file's own. So the workspace is unproven before the open and must still be unproven after it
        // — no anchor was opened, and no proof of a loaded project is being claimed.
        expect(session.isWorkspaceLoaded(), "the session was asked to load no project before the pin opened one").toBe(
          false,
        );

        // The pin's only open. `documentSymbol` is what hands back the position the question is asked at, and it
        // is the tracked open this shape allows: the file whose assignment is in question, and nothing else.
        const outline = await session.documentSymbol(sharedFile);
        if (outline.state !== "ok") throw new Error(`tsgo answered "${outline.state}" for "${SHARED}"`);
        const position = subjectPosition(outline.symbols);
        expect(log.opened, `documents opened to outline "${SHARED}": ${JSON.stringify(log.opened)}`).toEqual([
          { file: sharedFile, languageId: "typescript" },
        ]);

        const answer = await session.request<unknown>("textDocument/references", {
          textDocument: textDocumentId(sharedFile),
          position,
          context: { includeDeclaration: true },
        });

        // (1) The request answered, and every row it answered with is one of the fixture's two files: nothing
        // outside this root, and no file this client never showed the server, may appear in a pin's record.
        const opened = [...new Set(log.opened.map((doc) => doc.file))].map(under).sort();
        expect(Array.isArray(answer), evidence(answer, opened)).toBe(true);
        const rows = (answer as unknown[]).map(rowOf);
        const sharedRows = rows.filter((row) => row.where === SHARED);
        const consumerRows = rows.filter((row) => row.where === CONSUMER);
        const outsideRows = rows.filter((row) => row.where !== SHARED && row.where !== CONSUMER);
        expect(outsideRows.map((row) => row.where), evidence(answer, opened)).toEqual([]);

        // (2) The declaration itself is in the answer, which is what `includeDeclaration: true` asks for and the
        // floor beneath which the reply is not an answer about this symbol at all.
        const sharedLines = sharedRows.map((row) => row.line);
        const consumerLines = consumerRows.map((row) => row.line);
        expect(sharedLines.length, evidence(answer, opened)).toBeGreaterThan(0);

        // (3) Still exactly the one document: no other file was opened while the question was asked, which is the
        // whole reason the record below is about tsgo's assignment and not about this client's anchors.
        expect(log.opened, evidence(answer, opened)).toEqual([{ file: sharedFile, languageId: "typescript" }]);
        expect(opened, evidence(answer, opened)).toEqual([SHARED]);

        // The three rows the pin exists to look for, with their lines read off the fixture's own text rather
        // than copied from the reply: the declaration in the opened file, and in the consumer both the import
        // binding that names the symbol and the use of it.
        const declarationLine = lineOf(sharedFile, DECLARATION);
        const bindingLine = lineOf(consumerFile, BINDING);
        const useLine = lineOf(consumerFile, USE);
        const climbed = consumerLines.length > 0;
        // both outcomes were ruled in advance. The pin ran and the consumer answered, so the climb branch is
        // the one `ownerOf` implements, and a run that loses the consumer fails HERE and names what changed.
        expect(
          climbed,
          `ascent pin: tsgo answered no row in ${CONSUMER} (shared.ts at ${JSON.stringify(sharedLines)}, the use ` +
            `is line ${String(useLine)} and the binding line ${String(bindingLine)}) — ownership does NOT ascend, ` +
            `which contradicts the climb branch ${evidence(answer, opened)}`,
        ).toBe(true);
        // The exact lines, 1-based as this file states them: 0-based 6 in `nested/shared.ts` and 0-based 4 and 7
        // in `nested/consumer.ts` were what the measured reply carried.
        expect([...sharedLines].sort(byLine), evidence(answer, opened)).toEqual([declarationLine]);
        expect([...consumerLines].sort(byLine), evidence(answer, opened)).toEqual([bindingLine, useLine]);

        console.info(
          `ascent pin (tsgo ${binary.version}): shared.ts=${yesNo(sharedLines.length)} ` +
            `consumer.ts=${yesNo(consumerLines.length)} rows=${String(rows.length)} ` +
            `lines=${JSON.stringify({ [SHARED]: sharedLines, [CONSUMER]: consumerLines })} ` +
            `raw=${JSON.stringify(answer)}`,
        );
        const verdict = climbed
          ? "CLIMB (the ancestor's program answered)"
          : "NO CLIMB (only the opened file answered)";
        console.info(`ascent pin verdict: ${verdict}`);

        // (4) The same process answered, unreplaced: one spawn for the pin, so the record cannot be the answer of
        // a second process that had been given more documents than this one.
        expect(session.isWorkspaceLoaded(), evidence(answer, opened)).toBe(false);
        expect(log.pids, evidence(answer, opened)).toHaveLength(1);
      } finally {
        manager.disposeAll();
      }

      // (6) Disposal started nothing: one process served the whole pin, from the open to the answer.
      expect(log.pids, `processes spawned by the pin: ${JSON.stringify(log.pids)}`).toHaveLength(1);
      // (5) Nothing was written: a read-only question leaves the fixture's files exactly as it found them.
      expect(treeStamps()).toEqual(before);
    },
    CALL_BUDGET_MS,
  );
});
