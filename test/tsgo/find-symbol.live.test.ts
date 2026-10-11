import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import { pathKey } from "../../src/paths/path-containment.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import {
  runTsFindSymbol,
  TS_WORKSPACE_SYMBOL_CAP_WATERMARK,
  type TsDeclarationRow,
  type TsFindSymbolPayload,
} from "../../src/tools/ts-find-symbol.js";
import { walkWorkspace } from "../../src/tsgo/workspace-snapshot.js";
import {
  CALL_BUDGET_MS,
  describeProcesses,
  descendantsOf,
  fixtures,
  isAcquisitionProcess,
  itIfTsgoAvailable,
  payloadOf,
  recordAnswer,
  requireTsgo,
  stampsOf,
  textOf,
  tsgoProcessLog,
} from "../helpers/tsgo-live.js";

/**
 * Live: `ts_find_symbol` against the real TypeScript 7 native server, over
 * `test/fixtures/ts-find-symbol` (and `ts-find-symbol-external`, a sibling directory the workspace's program
 * reads but does not own). The questions this suite exists to answer are the ones a mock would only repeat from
 * what its author assumed: what hover says for a declaration whose type is inferred, which entries `workspace/symbol`
 * lists for overloads, merged pairs, barrels and locals, how it spells a nested member, whether it lists a
 * declaration outside the root, and where its list stops.
 *
 * Expected lines and names are read out of the fixture's own text (`lineOf`), never remembered, and no case
 * writes into `test/fixtures/**`.
 */

const workspaceRoot = join(fixtures, "ts-find-symbol");
const shapesFile = join(workspaceRoot, "src", "shapes.ts");
const libArea = join(workspaceRoot, "src", "lib", "area.ts");
const barrelFile = join(workspaceRoot, "src", "barrel.ts");
const externalFile = join(fixtures, "ts-find-symbol-external", "ext.ts");

type Result = Awaited<ReturnType<typeof runTsFindSymbol>>;

const managers: LspSessionManager[] = [];

function freshManager(): LspSessionManager {
  const manager = new LspSessionManager();
  managers.push(manager);
  return manager;
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.disposeAll();
});

function ask(manager: LspSessionManager, symbol: string, anchor: string, root = workspaceRoot): Promise<Result> {
  return runTsFindSymbol(manager, { sourceRoots: [root], symbol, anchor, timeBudgetMs: CALL_BUDGET_MS });
}

function payload(result: Result): TsFindSymbolPayload {
  return payloadOf<TsFindSymbolPayload>(result, "ts_find_symbol");
}

const linesOf = (file: string): string[] => readFileSync(file, "utf-8").split(/\r?\n/);

/** The 1-based line of the first fixture line holding `needle`, or a failure naming the fixture that lost it. */
function lineOf(file: string, needle: string): number {
  const index = linesOf(file).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture no longer declares "${needle}" in ${file}`);
  return index + 1;
}

/** The 1-based line of `needle` at or after the line that holds `anchor`, for a member beside lookalikes. */
function lineAfter(file: string, anchor: string, needle: string): number {
  const lines = linesOf(file);
  const from = lines.findIndex((line) => line === anchor);
  if (from < 0) throw new Error(`the fixture no longer holds the line "${anchor}" in ${file}`);
  const offset = lines.slice(from).findIndex((line) => line.includes(needle));
  if (offset < 0) throw new Error(`"${needle}" does not follow "${anchor}" in ${file}`);
  return from + offset + 1;
}

/** Every row as `<name> (<kind>) <file relative to the fixture>:<line>`, which is what a failure has to show. */
function listed(answer: TsFindSymbolPayload): string[] {
  return answer.declarations.map((row) => {
    const where = row.external ? "<external>" : relative(workspaceRoot, row.file).replaceAll("\\", "/");
    return `${row.name} (${row.kind}) ${where}:${row.line}`;
  });
}

function treeStamps(root: string): Map<string, string> {
  const walked = walkWorkspace(root);
  if (walked === undefined) throw new Error(`the walk of "${root}" did not complete`);
  return stampsOf([...walked.entries.keys()]);
}

describe("ts_find_symbol against the real tsgo", () => {
  itIfTsgoAvailable(
    "a file anchor answers a declaration whose type is inferred with the signature hover states, not one the source writes",
    async () => {
      const before = treeStamps(workspaceRoot);
      const manager = freshManager();
      const scaled = payload(await ask(manager, "scaled", shapesFile));
      recordAnswer("find-symbol-file-scaled", scaled);
      expect(scaled.declarations).toHaveLength(1);
      const row = scaled.declarations[0] as TsDeclarationRow;
      expect(row).toMatchObject({
        name: "scaled",
        kind: "variable",
        file: shapesFile,
        line: lineOf(shapesFile, "export const scaled"),
        container: "src",
        external: false,
      });
      // The fixture's own text never writes `label: string`, so only the checker can be where those words came from.
      expect(readFileSync(shapesFile, "utf-8")).not.toContain("label: string");
      expect(row.signature).toContain("factor: number");
      expect(row.signature).toContain("label: string");
      expect(scaled.scope).toMatchObject({ lookup: "document-symbol", workspaceRoot, limits: ["one-workspace", "one-file"] });
      expect(treeStamps(workspaceRoot)).toEqual(before);
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "a file anchor lists overloads and a merged pair as several rows, and a dotted name descends through containers only",
    async () => {
      const manager = freshManager();

      const parse = payload(await ask(manager, "parse", shapesFile));
      recordAnswer("find-symbol-file-parse", parse);
      const parseLines = linesOf(shapesFile)
        .map((line, index) => (line.startsWith("export function parse(") ? index + 1 : 0))
        .filter((line) => line > 0);
      expect(parse.declarations.map((row) => row.line)).toEqual(parseLines);
      expect(parse.declarations).toHaveLength(3);
      for (const row of parse.declarations) expect(row.signature, JSON.stringify(row)).toContain("function parse(");

      const merged = payload(await ask(manager, "Merged", shapesFile));
      recordAnswer("find-symbol-file-merged", merged);
      expect(merged.declarations.map((row) => row.kind)).toEqual(["class", "interface"]);
      expect(merged.declarations.map((row) => row.line)).toEqual([
        lineOf(shapesFile, "export class Merged"),
        lineOf(shapesFile, "export interface Merged"),
      ]);

      const nested = payload(await ask(manager, "Geometry.Worker.run", shapesFile));
      recordAnswer("find-symbol-file-nested", nested);
      expect(listed(nested)).toEqual([`Geometry.Worker.run (method) src/shapes.ts:${lineAfter(shapesFile, "  export class Worker {", "run()")}`]);
      expect(nested.declarations[0]?.signature).toBe("(method) Worker.run(): string");

      const aliased = payload(await ask(manager, "ShapeName", shapesFile));
      recordAnswer("find-symbol-file-alias", aliased);
      // tsgo reports a type alias with the kind number of a class; published as reported.
      expect(aliased.declarations[0]).toMatchObject({ kind: "class", signature: 'type ShapeName = "circle" | "square"' });

      const bare = await ask(manager, "run", shapesFile);
      expect(bare.isError).toBe(true);
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "a directory anchor lists the same name in two directories and one outside the workspace, in-workspace first",
    async () => {
      const before = treeStamps(workspaceRoot);
      const log = tsgoProcessLog();
      const manager = new LspSessionManager({ spawn: log.spawn });
      managers.push(manager);

      const answer = payload(await ask(manager, "area", workspaceRoot));
      recordAnswer("find-symbol-dir-area", answer);
      const shapesArea = lineOf(shapesFile, "export function area(");
      expect(answer.declarations.map((row) => row.name)).toEqual(["area", "area", "area"]);
      expect(answer.declarations.map((row) => [pathKey(row.file), row.line, row.external])).toEqual([
        [pathKey(libArea), 1, false],
        [pathKey(shapesFile), shapesArea, false],
        [pathKey(externalFile), lineOf(externalFile, "export function area("), true],
      ]);
      expect(answer.declarations.map((row) => row.container)).toEqual(["src/lib", "src", null]);
      expect(answer.declarations[0]?.signature).toBe("function area(width: number, height: number): number");
      expect(answer.declarations[1]?.signature).toBe("function area(shape: Shape): number");
      expect(answer.declarations[2]).toMatchObject({
        descriptionUnavailable: "outside the workspace root; not read",
      });
      expect(answer.declarations[2]).not.toHaveProperty("signature");
      // The fuzzy index offers `rectangleArea` and the interface and class members beside the exact name; none survives.
      expect(listed(answer).some((row) => row.startsWith("rectangleArea"))).toBe(false);

      const opened = new Set(log.opened.map((document) => pathKey(document.file)));
      expect(opened.has(pathKey(externalFile)), "the external file must never be opened").toBe(false);
      expect(answer.scope).toMatchObject({
        lookup: "workspace-symbol",
        workspaceRoot,
        projects: { count: 1, failed: [] },
        uncoveredSources: { count: 0, namedFileUncovered: false },
        limits: ["one-workspace"],
      });
      expect(treeStamps(workspaceRoot)).toEqual(before);
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "a directory anchor spells a nested member by its outline, never a same-named sibling, local or bare member",
    async () => {
      const manager = freshManager();

      const top = payload(await ask(manager, "Worker.run", workspaceRoot));
      recordAnswer("find-symbol-dir-worker-run", top);
      const topLine = lineAfter(shapesFile, "export class Worker {", "run()");
      expect(listed(top)).toEqual([`Worker.run (method) src/shapes.ts:${topLine}`]);
      expect(top.declarations[0]?.signature).toBe("(method) Worker.run(): number");

      const nested = payload(await ask(manager, "Geometry.Worker.run", workspaceRoot));
      expect(listed(nested)).toEqual([`Geometry.Worker.run (method) src/shapes.ts:${lineAfter(shapesFile, "  export class Worker {", "run()")}`]);
      expect(nested.declarations[0]?.signature).toBe("(method) Worker.run(): string");

      const constant = payload(await ask(manager, "Geometry.UNIT", workspaceRoot));
      expect(listed(constant)).toEqual([`Geometry.UNIT (variable) src/shapes.ts:${lineOf(shapesFile, "export const UNIT")}`]);

      // `run` is a member of three classes, and no top-level declaration: a bare name never matches a member.
      const bare = await ask(manager, "run", workspaceRoot);
      expect(bare.isError, textOf(bare)).toBe(true);
      expect(textOf(bare)).toContain('no declaration named "run" was found in the whole workspace');

      // `local` is declared inside `describe()` in consumer.ts, which tsgo lists with containerName `describe`.
      // The pin discriminates only while tsgo still lists that local, so the raw index answer is asserted first.
      const binary = requireTsgo();
      const raw = manager.get(workspaceRoot, tsgoConfig(binary));
      await raw.openAnchors([shapesFile]);
      const entries = await raw.request<{ name: string; containerName?: string }[] | null>("workspace/symbol", { query: "local" });
      expect(entries?.some((entry) => entry.name === "local" && entry.containerName === "describe")).toBe(true);

      const local = await ask(manager, "describe.local", workspaceRoot);
      expect(local.isError, textOf(local)).toBe(true);
      expect(textOf(local)).toContain('no declaration named "describe.local" was found in the whole workspace');
      const bareLocal = await ask(manager, "local", workspaceRoot);
      expect(bareLocal.isError, textOf(bareLocal)).toBe(true);
      expect(textOf(bareLocal)).toContain('no declaration named "local" was found in the whole workspace');
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "a barrel is pinned: the renamed re-export is a row of its own, the plain one adds no second declaration",
    async () => {
      const manager = freshManager();

      const renamed = payload(await ask(manager, "rectangleArea", workspaceRoot));
      recordAnswer("find-symbol-dir-barrel-renamed", renamed);
      expect(listed(renamed)).toEqual([`rectangleArea (variable) src/barrel.ts:${lineOf(barrelFile, "rectangleArea")}`]);

      const plain = payload(await ask(manager, "Circle", workspaceRoot));
      recordAnswer("find-symbol-dir-barrel-plain", plain);
      expect(plain.declarations.map((row) => pathKey(row.file))).toEqual([pathKey(shapesFile)]);
      expect(plain.declarations[0]?.signature).toBe("class Circle");
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "build output the program reads is a row no project owns, ordered after the owned source row",
    async () => {
      const builtRoot = join(fixtures, "ts-find-symbol-built");
      const before = treeStamps(builtRoot);
      const manager = freshManager();
      const answer = payload(await ask(manager, "area", builtRoot, builtRoot));
      recordAnswer("find-symbol-dir-built", answer);
      const summary = JSON.stringify(answer.declarations.map((row) => [row.file, row.ownedBy]));
      expect(answer.declarations.map((row) => pathKey(row.file)), summary).toEqual([
        pathKey(join(builtRoot, "app", "src", "area.ts")),
        pathKey(join(builtRoot, "built", "area.d.ts")),
      ]);
      expect(answer.declarations[0]?.ownedBy, summary).toBeDefined();
      expect(pathKey(answer.declarations[0]?.ownedBy ?? ""), summary).toBe(pathKey(join(builtRoot, "app", "tsconfig.json")));
      expect(answer.declarations[1], summary).toHaveProperty("ownedBy", null);
      expect(answer.declarations[1]?.external).toBe(false);
      expect(treeStamps(builtRoot)).toEqual(before);
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "an exact name that is not declared is an error naming the workspace, and the answer was not a silent empty list",
    async () => {
      const manager = freshManager();
      const out = await ask(manager, "NoSuchDeclaration", workspaceRoot);
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain('no declaration named "NoSuchDeclaration" was found in the whole workspace');
      expect(textOf(out)).not.toMatch(/ranked out/);
    },
    CALL_BUDGET_MS + 30_000,
  );
});

// --------------------------------------------------------------------------------
// the watermark probe
// --------------------------------------------------------------------------------

/**
 * A temporary workspace is removed only once the `tsc.exe` rooted in it has exited: the child's working
 * directory is the workspace root, and Windows refuses to delete a directory a live process is standing in.
 * The retry waits for that exit rather than hiding the failure, and the last attempt reports it.
 */
async function removeWorkspace(root: string): Promise<void> {
  const ATTEMPTS = 40;
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt === ATTEMPTS) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * tsgo's `workspace/symbol` list is cut at a count the protocol does not state and the server does not flag. The
 * watermark this server treats as that bound is pinned here the way the Go one was: two queries that
 * deliberately overflow the list each come back with exactly the same count, which is the cap's signature, and a
 * query that cannot overflow comes back short of it.
 */
describe("the workspace/symbol cap watermark", () => {
  const GENERATED = 400;

  function generatedWorkspace(): { root: string; file: string } {
    const root = mkdtempSync(join(tmpdir(), "mcp-code-nav-tssym-cap-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cap-probe", private: true }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }));
    const file = join(root, "src", "gen.ts");
    const body = Array.from({ length: GENERATED }, (_unused, index) => {
      const name = `gen${String(index).padStart(3, "0")}`;
      return `export function ${name}(): number {\n  return ${index};\n}`;
    });
    body.push("export function gen(): number {\n  return -1;\n}");
    writeFileSync(file, `${body.join("\n")}\n`);
    return { root, file };
  }

  itIfTsgoAvailable(
    "two overflowing queries each return exactly the watermark, and a narrow one returns fewer",
    async () => {
      const binary = requireTsgo();
      const { root, file } = generatedWorkspace();
      const manager = freshManager();
      try {
        const session = manager.get(root, tsgoConfig(binary));
        await session.openAnchors([file]);
        const ask = async (query: string): Promise<number> => {
          const answer = await session.request<unknown[] | null>("workspace/symbol", { query });
          return answer?.length ?? 0;
        };
        const broad = await ask("gen");
        const single = await ask("e");
        const narrow = await ask("gen007");
        const evidence = `gen=${broad} e=${single} gen007=${narrow} of ${GENERATED} declared`;
        recordAnswer("find-symbol-watermark", { broad, single, narrow, declared: GENERATED, watermark: TS_WORKSPACE_SYMBOL_CAP_WATERMARK });
        expect(broad, evidence).toBe(TS_WORKSPACE_SYMBOL_CAP_WATERMARK);
        expect(single, evidence).toBe(TS_WORKSPACE_SYMBOL_CAP_WATERMARK);
        expect(narrow, evidence).toBeLessThan(TS_WORKSPACE_SYMBOL_CAP_WATERMARK);
        expect(narrow, evidence).toBeGreaterThan(0);
      } finally {
        manager.disposeAll();
        await removeWorkspace(root);
      }
    },
    CALL_BUDGET_MS + 30_000,
  );

  itIfTsgoAvailable(
    "the tool reports listing-capped on a capped answer with a hit, not on one that fits, and says so when nothing matched",
    async () => {
      const { root } = generatedWorkspace();
      const manager = freshManager();
      try {
        const fits = payload(await ask(manager, "gen007", root, root));
        expect(fits.declarations.map((row) => row.name)).toEqual(["gen007"]);
        expect(fits.scope.limits).toEqual(["one-workspace"]);

        // `gen` is declared, and is also a prefix of four hundred other names: the list is full, the exact hit
        // survives the filter, and the row carries `listing-capped` because a same-named one may have been cut.
        const cappedHit = payload(await ask(manager, "gen", root, root));
        expect(cappedHit.declarations.map((row) => row.name)).toEqual(["gen"]);
        expect(cappedHit.scope.limits).toEqual(["one-workspace", "listing-capped"]);

        // `ge` names nothing and is a prefix of four hundred names: the list is full, the filter empties it,
        // and the two facts together are what a caller needs to hear.
        const capped = await ask(manager, "ge", root, root);
        expect(capped.isError, textOf(capped)).toBe(true);
        expect(textOf(capped)).toContain('no declaration named "ge" was found');
        expect(textOf(capped)).toContain("may have been ranked out of it");
      } finally {
        manager.disposeAll();
        await removeWorkspace(root);
      }
    },
    CALL_BUDGET_MS + 30_000,
  );
});
