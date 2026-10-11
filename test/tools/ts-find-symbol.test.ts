// `ts_find_symbol`'s mocked contract: `go_find_symbol`'s payload over a TypeScript
// workspace - per-row `container` relative to `workspaceRoot`, `external`, the description read from hover, a
// `lookup` that says which request answered, `one-file` on a file anchor and `listing-capped` at the
// watermark. No `tsc.exe`, no `npm` and no real tsgo runs here: the executable comes through `resolveBinary`,
// the project listings through `exec`, and every tsgo answer through the fake server's `respond`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import type { LspSession } from "../../src/lsp/session.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import {
  runTsFindSymbol,
  TS_WORKSPACE_SYMBOL_CAP_WATERMARK,
  TsFindSymbolInput,
} from "../../src/tools/ts-find-symbol.js";
import type { TsQueryDeps } from "../../src/tools/ts-navigation-shared.js";
import type { TsgoBinary, TsgoBinaryResult, TsExecFn } from "../../src/tsgo/binary.js";
import { dropProjectMap, PROJECT_MAP_LIMIT } from "../../src/tsgo/project-map.js";
import { fakeServer, pathOfDocumentId, uriOf, type FakeServer } from "../helpers/fake-lsp.js";
import { runUntilBudgetExpires } from "../helpers/go-tool-harness.js";

type Result = Awaited<ReturnType<typeof runTsFindSymbol>>;
type Input = { sourceRoots: string[]; symbol: string; anchor: string; timeBudgetMs: number };
type Row = Record<string, unknown>;

const BINARY: TsgoBinary = {
  executable: "C:/fake/npm-global/typescript/node_modules/@typescript/typescript-win32-x64/lib/tsc.exe",
  version: "7.0.2",
  source: "global",
};
const SERVER_VERSION = "7.0.2";

const SYMBOL_METHOD = "workspace/symbol";
const HOVER_METHOD = "textDocument/hover";
const CAP_SENTENCE =
  "tsgo's symbol search returns a bounded list and this one came back at the size this server treats as " +
  "that bound, so a declaration of this name may have been ranked out of it.";

/**
 * The file every case addresses. `parse` is an overload set, `Merged` a class beside an interface, `Worker`
 * exists at top level and inside `Geometry`, and `scaled` is the variable whose type is inferred.
 */
const MAIN_TEXT = [
  "export interface Shape {",
  "  area(): number;",
  "}",
  "export class Driver {",
  "  run(): string { return \"d\"; }",
  "}",
  "export function parse(text: string): number;",
  "export function parse(value: number): string;",
  "export function parse(value: string | number): string | number { return 1; }",
  "export class Merged {}",
  "export interface Merged {}",
  "export namespace Geometry {",
  "  export class Worker {",
  "    run(): string { return \"g\"; }",
  "  }",
  "  export const UNIT = 1;",
  "}",
  "export class Worker {",
  "  run(): number { return 1; }",
  "}",
  "export const scaled = compute();",
  "export type ShapeName = \"a\" | \"b\";",
];

const AREA_TEXT = ["export function area(width: number, height: number): number {", "  return width * height;", "}"];

const SHAPE_AREA_TEXT = ["export function area(shape: unknown): number {", "  return 1;", "}"];

type P = { line: number; character: number };

function at(lines: readonly string[], line: number, needle: string): P {
  const found = lines[line]?.indexOf(needle) ?? -1;
  if (found < 0) throw new Error(`"${needle}" is not on line ${line} of the fixture text`);
  return { line, character: found };
}

function sym(
  lines: readonly string[],
  name: string,
  kind: number,
  start: [number, string],
  end: [number, string],
  selection: [number, string],
  children?: LspDocumentSymbol[],
): LspDocumentSymbol {
  return {
    name,
    kind,
    range: { start: at(lines, start[0], start[1]), end: at(lines, end[0], end[1]) },
    selectionRange: { start: at(lines, selection[0], selection[1]) },
    ...(children === undefined ? {} : { children }),
  };
}

/** tsgo's kind numbers: 3 namespace, 5 class, 6 method, 11 interface, 12 function, 13 variable. */
const MAIN_OUTLINE: LspDocumentSymbol[] = [
  sym(MAIN_TEXT, "Shape", 11, [0, "Shape"], [2, "}"], [0, "Shape"], [
    sym(MAIN_TEXT, "area", 6, [1, "area"], [1, ";"], [1, "area"]),
  ]),
  sym(MAIN_TEXT, "Driver", 5, [3, "Driver"], [5, "}"], [3, "Driver"], [
    sym(MAIN_TEXT, "run", 6, [4, "run"], [4, "}"], [4, "run"]),
  ]),
  sym(MAIN_TEXT, "parse", 12, [6, "parse"], [6, ";"], [6, "parse"]),
  sym(MAIN_TEXT, "parse", 12, [7, "parse"], [7, ";"], [7, "parse"]),
  sym(MAIN_TEXT, "parse", 12, [8, "parse"], [8, "}"], [8, "parse"]),
  sym(MAIN_TEXT, "Merged", 5, [9, "class Merged"], [9, "}"], [9, "Merged"]),
  sym(MAIN_TEXT, "Merged", 11, [10, "Merged"], [10, "}"], [10, "Merged"]),
  sym(MAIN_TEXT, "Geometry", 3, [11, "Geometry"], [16, "}"], [11, "Geometry"], [
    sym(MAIN_TEXT, "Worker", 5, [12, "Worker"], [14, "}"], [12, "Worker"], [
      sym(MAIN_TEXT, "run", 6, [13, "run"], [13, "}"], [13, "run"]),
    ]),
    sym(MAIN_TEXT, "UNIT", 13, [15, "UNIT"], [15, ";"], [15, "UNIT"]),
  ]),
  sym(MAIN_TEXT, "Worker", 5, [17, "Worker"], [19, "}"], [17, "Worker"], [
    sym(MAIN_TEXT, "run", 6, [18, "run"], [18, "}"], [18, "run"]),
  ]),
  sym(MAIN_TEXT, "scaled", 13, [20, "scaled"], [20, ";"], [20, "scaled"]),
  sym(MAIN_TEXT, "ShapeName", 5, [21, "ShapeName"], [21, ";"], [21, "ShapeName"]),
];

const AREA_OUTLINE: LspDocumentSymbol[] = [
  sym(AREA_TEXT, "area", 12, [0, "area"], [2, "}"], [0, "area"]),
];

const SHAPE_AREA_OUTLINE: LspDocumentSymbol[] = [
  sym(SHAPE_AREA_TEXT, "area", 12, [0, "area"], [2, "}"], [0, "area"]),
];

/**
 * One `workspace/symbol` entry as tsgo reports it: a `SymbolInformation` whose `location.range` is the
 * identifier's own span, with `containerName` naming only the NEAREST container (measured live).
 */
function indexed(path: string, name: string, kind: number, line: number, character: number, containerName?: string): unknown {
  return {
    name,
    kind,
    ...(containerName === undefined ? {} : { containerName }),
    location: {
      uri: uriOf(path),
      range: { start: { line, character }, end: { line, character: character + name.length } },
    },
  };
}

/** A hover answer as tsgo spells it: a markdown fence tagged `typescript`, with prose after it when documented. */
function hover(signature: string, documentation?: string): unknown {
  return {
    contents: {
      kind: "markdown",
      value: `\`\`\`typescript\n${signature}\n\`\`\`\n${documentation === undefined ? "" : `${documentation}\n`}`,
    },
  };
}

interface Harness {
  readonly tmp: string;
  readonly ws: string;
  readonly main: string;
  readonly area: string;
  readonly shapeArea: string;
  readonly outside: string;
  readonly session: LspSession;
  readonly servers: FakeServer[];
  readonly server: FakeServer;
  outline(path: string, symbols: LspDocumentSymbol[] | null): void;
  /** The outline of this file never arrives, so a check against it runs out of budget. */
  hangOutline(path: string): void;
  /** tsgo answers an error for the outline of this file. */
  failOutline(path: string, message: string): void;
  /** What `workspace/symbol` answers with. */
  index(entries: unknown): void;
  /** A list of exactly `count` entries, of which `entries` are the ones the test cares about. */
  indexOfSize(count: number, entries: unknown[]): void;
  /** Per-file hover replies. */
  hovers(replies: Record<string, unknown>): void;
  /** Hover answers `null` at this file, which is a server that has nothing to say about it. */
  hangInitialize(): void;
  hangSymbol(): void;
  hangHover(): void;
  crashNextSymbol(): void;
  /** The project listing a config answers with; an entry with an exit code fails that listing. */
  listing(config: string, files: readonly string[] | { readonly failWith: string }): void;
  run(overrides?: Partial<Input>): Promise<Result>;
}

const built: { tmp: string; ws: string }[] = [];

/**
 * A tsgo whose outlines, symbol index, hovers and project listings the test supplies, over a real temp
 * workspace. The project's anchor is `lib/area.ts` (the lexically first member it owns).
 */
function harness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-tssym-"));
  const ws = resolve(join(tmp, "ws"));
  built.push({ tmp, ws });
  const src = join(ws, "packages", "ui", "src");
  mkdirSync(join(src, "lib"), { recursive: true });
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
  writeFileSync(join(ws, "packages", "ui", "package.json"), JSON.stringify({ name: "@mono/ui" }));
  const config = join(ws, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: {} }));
  const main = join(src, "main.ts");
  writeFileSync(main, `${MAIN_TEXT.join("\n")}\n`);
  const area = join(src, "lib", "area.ts");
  writeFileSync(area, `${AREA_TEXT.join("\n")}\n`);
  const shapeArea = join(src, "shape-area.ts");
  writeFileSync(shapeArea, `${SHAPE_AREA_TEXT.join("\n")}\n`);
  const outside = join(tmp, "outside", "io.ts");

  const outlines = new Map<string, LspDocumentSymbol[] | null>([
    [main, MAIN_OUTLINE],
    [area, AREA_OUTLINE],
    [shapeArea, SHAPE_AREA_OUTLINE],
  ]);
  const listing = new Map<string, readonly string[] | { readonly failWith: string }>([[config, [area, main, shapeArea]]]);
  const exec: TsExecFn = async (_executable, args) => {
    const found = listing.get(args[2] ?? "");
    if (found === undefined) return { stdout: "", stderr: "", exitCode: 0 };
    if ("failWith" in found) return { stdout: "", stderr: found.failWith, exitCode: 1 };
    return { stdout: found.join("\n"), stderr: "", exitCode: 0 };
  };

  let symbols: unknown = [];
  let replies: Record<string, unknown> = {};
  const hungOutlines = new Set<string>();
  const failedOutlines = new Map<string, string>();
  let initializeHangs = false;
  let symbolHangs = false;
  let hoverHangs = false;
  let crashing = false;
  let alive = true;
  const servers: FakeServer[] = [];
  const manager = new LspSessionManager({
    spawn: () => {
      const server = fakeServer({
        alive: () => alive,
        respond: (method, params) => {
          if (method === "initialize") {
            if (initializeHangs) return new Promise<unknown>(() => {});
            return { serverInfo: { name: "tsgo", version: SERVER_VERSION } };
          }
          if (method === "textDocument/documentSymbol") {
            const path = pathOfDocumentId(params) ?? "";
            if (hungOutlines.has(path)) return new Promise<unknown>(() => {});
            const failure = failedOutlines.get(path);
            if (failure !== undefined) throw new Error(failure);
            return outlines.has(path) ? outlines.get(path) : [];
          }
          if (method === SYMBOL_METHOD) {
            if (symbolHangs) return new Promise<unknown>(() => {});
            if (crashing) {
              crashing = false;
              alive = false;
              throw new Error("connection got disposed");
            }
            return symbols;
          }
          if (method === HOVER_METHOD) {
            if (hoverHangs) return new Promise<unknown>(() => {});
            return replies[pathOfDocumentId(params) ?? ""] ?? null;
          }
          throw new Error(`unexpected request: ${method}`);
        },
      });
      servers.push(server);
      alive = true;
      return server.process;
    },
    sleep: async () => {},
  });
  const deps: TsQueryDeps = { resolveBinary: async () => ({ binary: BINARY }), exec };
  const session = manager.get(ws, tsgoConfig(BINARY));
  return {
    tmp,
    ws,
    main,
    area,
    shapeArea,
    outside,
    session,
    servers,
    get server() {
      const last = servers[servers.length - 1];
      if (last === undefined) throw new Error("this run started no tsgo process");
      return last;
    },
    outline: (path, list) => outlines.set(path, list),
    hangOutline: (path) => hungOutlines.add(path),
    failOutline: (path, message) => failedOutlines.set(path, message),
    index: (entries) => {
      symbols = entries;
    },
    indexOfSize: (count, entries) => {
      const filler = Array.from({ length: count - entries.length }, (_unused, index) =>
        indexed(join(src, `noise${index}.ts`), `Near${index}`, 12, index, 16),
      );
      symbols = [...filler, ...entries];
    },
    hovers: (next) => {
      replies = next;
    },
    hangInitialize: () => {
      initializeHangs = true;
    },
    hangSymbol: () => {
      symbolHangs = true;
    },
    hangHover: () => {
      hoverHangs = true;
    },
    crashNextSymbol: () => {
      crashing = true;
    },
    listing: (path, files) => listing.set(path, files),
    run: (overrides = {}) =>
      runTsFindSymbol(manager, { sourceRoots: [ws], symbol: "Driver", anchor: main, timeBudgetMs: 60_000, ...overrides }, deps),
  };
}

function payload(result: Result): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

function scopeOf(result: Result): Record<string, unknown> {
  return payload(result).scope as Record<string, unknown>;
}

function limitsOf(result: Result): string[] {
  return scopeOf(result).limits as string[];
}

function rowsOf(result: Result): Row[] {
  return payload(result).declarations as Row[];
}

function textOf(result: Result): string {
  return (result.content ?? [])[0]?.text ?? "";
}

function countOf(server: FakeServer, method: string): number {
  return server.methods.filter((name) => name === method).length;
}

function requestFor(server: FakeServer, method: string): Record<string, unknown> {
  return (server.requests.find(([name]) => name === method)?.[1] ?? {}) as Record<string, unknown>;
}

function openedPaths(server: FakeServer): (string | undefined)[] {
  return server.notifications.filter(([method]) => method === "textDocument/didOpen").map(([, p]) => pathOfDocumentId(p));
}

function hoveredPaths(server: FakeServer): (string | undefined)[] {
  return server.requests.filter(([method]) => method === HOVER_METHOD).map(([, p]) => pathOfDocumentId(p));
}

/** The `scope` of a clean, fully mapped answer over this temp workspace. */
function cleanScope(h: Harness, lookup: string, limits: string[]): Record<string, unknown> {
  return {
    workspaceRoot: h.ws,
    enclosingWorkspace: null,
    freshness: { kind: "unchanged" },
    server: { version: SERVER_VERSION },
    workspaceTypescript: null,
    projects: { count: 1, configs: [join(h.ws, "tsconfig.json")], failed: [], subsumed: [] },
    uncoveredSources: {
      count: 0,
      grepRequired: false,
      directories: [],
      directoriesTruncated: 0,
      mentioning: { name: expect.any(String), count: 0, files: [], filesTruncated: 0, unchecked: 0 },
      namedFileUncovered: false,
    },
    lookup,
    limits,
  };
}

describe("TsFindSymbolInput", () => {
  it("takes a symbol and an anchor, needs a root, and defaults the budget to 60000 ms", () => {
    const parsed = TsFindSymbolInput.parse({ sourceRoots: ["C:/ws"], symbol: "Driver", anchor: "src" });
    expect(parsed.timeBudgetMs).toBe(60_000);
    expect(Object.keys(TsFindSymbolInput.shape).sort()).toEqual(["anchor", "sourceRoots", "symbol", "timeBudgetMs"]);
    expect(TsFindSymbolInput.safeParse({ sourceRoots: [], symbol: "S", anchor: "src" }).success).toBe(false);
  });
});

describe("runTsFindSymbol", () => {
  afterEach(() => {
    for (const root of built.splice(0)) {
      dropProjectMap(root.ws);
      rmSync(root.tmp, { recursive: true, force: true });
    }
  });

  describe("a file anchor", () => {
    it("answers from that file's outline, with the description read from hover at the name itself", async () => {
      const h = harness();
      h.hovers({ [h.main]: hover("class Driver", "Runs things.") });

      const out = await h.run();
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(payload(out)).toEqual({
        summary: expect.any(String),
        declarations: [
          {
            name: "Driver",
            kind: "class",
            file: h.main,
            line: 4,
            container: "packages/ui/src",
            external: false,
            ownedBy: join(h.ws, "tsconfig.json"),
            signature: "class Driver",
            documentation: "Runs things.",
          },
        ],
        scope: cleanScope(h, "document-symbol", ["one-workspace", "one-file"]),
      });
      expect(requestFor(h.server, HOVER_METHOD)).toEqual({
        textDocument: { uri: uriOf(h.main) },
        position: at(MAIN_TEXT, 3, "Driver"),
      });
      expect(textOf(out)).toContain('Declarations named "Driver" (exact match) in the outline of');
      expect(textOf(out)).toContain("1 declaration(s)");
      expect(textOf(out)).toContain("limits: one-workspace, one-file");
      expect(Object.keys(rowsOf(out)[0] ?? {})).toEqual([
        "name",
        "kind",
        "file",
        "line",
        "container",
        "external",
        "ownedBy",
        "signature",
        "documentation",
      ]);
      expect(JSON.stringify(payload(out))).not.toContain("visibility");
    });

    it("reads an inferred signature straight from hover, which is what grep cannot show", async () => {
      const h = harness();
      h.hovers({ [h.main]: hover("const scaled: {\n    factor: number;\n    label: string;\n}") });

      const out = await h.run({ symbol: "scaled" });
      expect(rowsOf(out)[0]).toMatchObject({
        name: "scaled",
        kind: "variable",
        signature: "const scaled: {\n    factor: number;\n    label: string;\n}",
      });
      expect(rowsOf(out)[0]).not.toHaveProperty("documentation");
    });

    it("lists overloads and a merged pair as several rows, in source order, never an error", async () => {
      const h = harness();
      h.hovers({ [h.main]: hover("function parse(value: string | number): string | number") });

      const parse = await h.run({ symbol: "parse" });
      expect(rowsOf(parse).map((row) => [row.name, row.line, row.kind])).toEqual([
        ["parse", 7, "function"],
        ["parse", 8, "function"],
        ["parse", 9, "function"],
      ]);

      const merged = await h.run({ symbol: "Merged" });
      expect(rowsOf(merged).map((row) => [row.kind, row.line])).toEqual([
        ["class", 10],
        ["interface", 11],
      ]);
      // One hold per file however many rows it carries; nothing joins the session's opened set.
      expect(h.session.getOpenedFiles().sort()).toEqual([h.area, h.main].sort());
    });

    it("descends a dotted name through containers only, and a bare name never reaches a member", async () => {
      const h = harness();

      const method = await h.run({ symbol: "Driver.run" });
      expect(rowsOf(method).map((row) => [row.name, row.kind, row.line])).toEqual([["Driver.run", "method", 5]]);

      const nested = await h.run({ symbol: "Geometry.Worker.run" });
      expect(rowsOf(nested).map((row) => [row.name, row.line])).toEqual([["Geometry.Worker.run", 14]]);

      const bare = await h.run({ symbol: "run" });
      expect(bare.isError).toBe(true);
      expect(textOf(bare)).toContain('no declaration named "run" was found');
    });

    it("names the file it searched and the exactness of the match when it finds nothing, asking nothing type-aware", async () => {
      const h = harness();

      const out = await h.run({ symbol: "Absent" });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain(`no declaration named "Absent" was found in the outline of "${h.main}"`);
      expect(textOf(out)).toContain("The match is exact, not fuzzy");
      expect(h.server.methods).not.toContain(SYMBOL_METHOD);
      expect(h.server.methods).not.toContain(HOVER_METHOD);
      // A name with no answer here never paid for the project map's anchors either.
      expect(openedPaths(h.server)).toEqual([h.main]);
    });

    it("never guesses a hover position for an outline row with no selection range", async () => {
      const h = harness();
      h.outline(h.main, [{ name: "Bare", kind: 5, range: { start: { line: 2 }, end: { line: 4 } } }]);

      const out = await h.run({ symbol: "Bare" });
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(rowsOf(out)[0]).toMatchObject({ name: "Bare", line: 3 });
      expect(String(rowsOf(out)[0]?.descriptionUnavailable)).toMatch(/named no position/);
      expect(countOf(h.server, HOVER_METHOD)).toBe(0);
    });

    it("loads the project map and holds every anchor before it hovers, like every other TS answer", async () => {
      const h = harness();

      await h.run();
      expect(openedPaths(h.server)).toEqual([h.main, h.area]);
      expect(h.server.methods).toEqual(["initialize", "textDocument/documentSymbol", HOVER_METHOD]);
    });
  });

  describe("a directory anchor", () => {
    it("asks the symbol index for the last segment of the name and keeps only exact matches", async () => {
      const h = harness();
      h.index([
        indexed(h.area, "area", 12, 0, 16),
        indexed(h.main, "areaOf", 12, 30, 16),
        indexed(h.main, "Area", 5, 31, 13),
        indexed(h.shapeArea, "area", 12, 0, 16),
        indexed(h.main, "area", 6, 1, 2, "Shape"),
      ]);
      h.hovers({
        [h.area]: hover("function area(width: number, height: number): number"),
        [h.shapeArea]: hover("function area(shape: unknown): number"),
      });

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(requestFor(h.server, SYMBOL_METHOD)).toEqual({ query: "area" });
      expect(rowsOf(out)).toEqual([
        {
          name: "area",
          kind: "function",
          file: h.area,
          line: 1,
          container: "packages/ui/src/lib",
          external: false,
          ownedBy: join(h.ws, "tsconfig.json"),
          signature: "function area(width: number, height: number): number",
        },
        {
          name: "area",
          kind: "function",
          file: h.shapeArea,
          line: 1,
          container: "packages/ui/src",
          external: false,
          ownedBy: join(h.ws, "tsconfig.json"),
          signature: "function area(shape: unknown): number",
        },
      ]);
      expect(scopeOf(out)).toEqual(cleanScope(h, "workspace-symbol", ["one-workspace"]));
      expect(textOf(out)).toContain("the whole workspace");
    });

    it("composes a member with its container and checks the row against the file's own outline", async () => {
      const h = harness();
      // tsgo names only the NEAREST container, so `Geometry.Worker.run` and the top-level `Worker.run` both read
      // `Worker.run`; only the outline says which one this row is.
      h.index([
        indexed(h.main, "run", 6, 13, 4, "Worker"),
        indexed(h.main, "run", 6, 18, 2, "Worker"),
        indexed(h.main, "run", 6, 4, 2, "Driver"),
      ]);

      const out = await h.run({ symbol: "Worker.run", anchor: h.ws });
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(requestFor(h.server, SYMBOL_METHOD)).toEqual({ query: "run" });
      expect(rowsOf(out).map((row) => [row.name, row.kind, row.line])).toEqual([["Worker.run", "method", 19]]);

      const nested = await h.run({ symbol: "Geometry.Worker.run", anchor: h.ws });
      expect(rowsOf(nested).map((row) => [row.name, row.line])).toEqual([["Geometry.Worker.run", 14]]);
    });

    it("drops a local that only reads like a member: a function is not a container a name descends through", async () => {
      const h = harness();
      h.outline(h.main, [
        sym(MAIN_TEXT, "scaled", 12, [20, "scaled"], [20, ";"], [20, "scaled"], [
          sym(MAIN_TEXT, "compute", 13, [20, "compute"], [20, "("], [20, "compute"]),
        ]),
      ]);
      h.index([indexed(h.main, "compute", 13, 20, 16, "scaled")]);

      const out = await h.run({ symbol: "scaled.compute", anchor: h.ws });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain('no declaration named "scaled.compute" was found in the whole workspace');
    });

    it("keeps a dotted row whose outline cannot be read, and says why in `pathUnverified`", async () => {
      const h = harness();
      h.index([indexed(h.main, "run", 6, 4, 2, "Driver")]);
      h.outline(h.main, null);

      const unreadable = await h.run({ symbol: "Driver.run", anchor: h.ws });
      expect(unreadable.isError, textOf(unreadable)).toBeFalsy();
      expect(rowsOf(unreadable)).toHaveLength(1);
      expect(rowsOf(unreadable)[0]).toMatchObject({ name: "Driver.run", line: 5 });
      expect(String(rowsOf(unreadable)[0]?.pathUnverified)).toMatch(/answered no outline/);
      expect(textOf(unreadable)).toContain("path unverified: tsgo answered no outline for its file");

      const h2 = harness();
      h2.index([indexed(h2.main, "run", 6, 4, 2, "Driver")]);
      h2.hangOutline(h2.main);
      const late = await runUntilBudgetExpires(() => h2.run({ symbol: "Driver.run", anchor: h2.ws, timeBudgetMs: 300 }), 300);
      expect(late.isError, textOf(late)).toBeFalsy();
      expect(String(rowsOf(late)[0]?.pathUnverified)).toMatch(/budget ran out before the outline/);
    });

    it("a rejected outline read marks that one row and keeps every other row, naming the cause", async () => {
      const h = harness();
      const ghost = join(h.ws, "packages", "ui", "src", "ghost.ts");
      h.index([
        indexed(h.main, "run", 6, 4, 2, "Driver"),
        indexed(h.shapeArea, "run", 6, 4, 2, "Driver"),
        indexed(ghost, "run", 6, 4, 2, "Driver"),
      ]);
      h.outline(h.shapeArea, [
        sym(SHAPE_AREA_TEXT, "Driver", 5, [0, "area"], [2, "}"], [0, "area"], [
          sym(SHAPE_AREA_TEXT, "run", 6, [0, "area"], [0, "area"], [0, "area"]),
        ]),
      ]);
      h.failOutline(h.shapeArea, "boom: no outline");

      const out = await h.run({ symbol: "Driver.run", anchor: h.ws });
      expect(out.isError, textOf(out)).toBeFalsy();
      const byFile = new Map(rowsOf(out).map((row) => [row.file, row]));
      expect(byFile.get(h.main)).not.toHaveProperty("pathUnverified");
      expect(String(byFile.get(h.shapeArea)?.pathUnverified)).toContain("boom: no outline");
      expect(String(byFile.get(ghost)?.pathUnverified)).toMatch(/ENOENT/);
    });

    it("fails at the budget when tsgo never answers `initialize`, instead of waiting past timeBudgetMs", async () => {
      const h = harness();
      h.hangInitialize();

      const out = await runUntilBudgetExpires(() => h.run({ symbol: "area", anchor: h.ws, timeBudgetMs: 100 }), 100);
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain("100 ms budget");
      expect(textOf(out)).toContain("tsgo did not start");
      expect(h.server.methods).not.toContain(SYMBOL_METHOD);
    });

    it("leaves `pathUnverified` off a row the outline confirmed, and off a bare name, which needs no outline", async () => {
      const h = harness();
      h.index([indexed(h.main, "run", 6, 4, 2, "Driver"), indexed(h.area, "area", 12, 0, 16)]);

      const dotted = await h.run({ symbol: "Driver.run", anchor: h.ws });
      expect(rowsOf(dotted)[0]).not.toHaveProperty("pathUnverified");
      const bare = await h.run({ symbol: "area", anchor: h.ws });
      expect(rowsOf(bare)[0]).not.toHaveProperty("pathUnverified");
    });

    it("marks each in-workspace row with the config that owns its file, and orders owned, unowned, external", async () => {
      const h = harness();
      const dist = join(h.ws, "packages", "ui", "dist", "area.d.ts");
      mkdirSync(join(h.ws, "packages", "ui", "dist"), { recursive: true });
      writeFileSync(dist, "export declare function area(): number;\n");
      h.index([
        indexed(h.outside, "area", 12, 70, 16),
        indexed(dist, "area", 12, 0, 24),
        indexed(h.area, "area", 12, 0, 16),
      ]);

      const out = await h.run({ symbol: "area", anchor: h.ws });
      const rows = rowsOf(out);
      expect(rows.map((row) => row.file)).toEqual([h.area, dist, h.outside]);
      expect(rows[0]?.ownedBy).toBe(join(h.ws, "tsconfig.json"));
      expect(rows[1]).toHaveProperty("ownedBy", null);
      expect(rows[2]).not.toHaveProperty("ownedBy");
      expect(textOf(out)).toContain("(no owning project)");
    });

    it("omits `ownedBy` from every row when no project map could be proved", async () => {
      const h = harness();
      for (let index = 0; index < PROJECT_MAP_LIMIT + 1; index += 1) {
        const dir = join(h.ws, "many", `p${index}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
      }

      const out = await h.run();
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(rowsOf(out)[0]).not.toHaveProperty("ownedBy");
      expect(scopeOf(out)).toHaveProperty("projectsUnavailable");
    });

    it("a bare name never matches a member of a class, only a top-level declaration", async () => {
      const h = harness();
      h.index([indexed(h.main, "run", 6, 4, 2, "Driver")]);

      const out = await h.run({ symbol: "run", anchor: h.ws });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain('no declaration named "run" was found');
    });

    it("reports an outside-the-workspace row, flags it, sorts it last and never opens, reads or hovers it", async () => {
      const h = harness();
      const nodeModules = join(h.ws, "node_modules", "dep", "index.d.ts");
      h.index([
        indexed(h.outside, "area", 12, 70, 16),
        indexed(nodeModules, "area", 12, 3, 16),
        indexed(h.area, "area", 12, 0, 16),
      ]);
      h.hovers({ [h.area]: hover("function area(width: number, height: number): number") });

      const out = await h.run({ symbol: "area", anchor: h.ws });
      const rows = rowsOf(out);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ file: h.area, external: false, container: "packages/ui/src/lib" });
      const external = rows.slice(1).map((row) => ({ ...row }));
      expect(external).toContainEqual({
        name: "area",
        kind: "function",
        file: h.outside,
        line: 71,
        container: null,
        external: true,
        descriptionUnavailable: "outside the workspace root; not read",
      });
      expect(external).toContainEqual(expect.objectContaining({ file: nodeModules, external: true, container: null }));
      expect(hoveredPaths(h.server)).toEqual([h.area]);
      expect(openedPaths(h.server)).not.toContain(h.outside);
      expect(openedPaths(h.server)).not.toContain(nodeModules);
    });

    it("an answer whose every row is outside the workspace is still an answer", async () => {
      const h = harness();
      h.index([indexed(h.outside, "area", 12, 70, 16)]);

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(rowsOf(out)[0]).toMatchObject({ external: true, container: null });
    });

    it("carries listing-capped when the raw list reached the watermark, and says so beside the rows", async () => {
      const h = harness();
      h.indexOfSize(TS_WORKSPACE_SYMBOL_CAP_WATERMARK, [indexed(h.area, "area", 12, 0, 16)]);

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(rowsOf(out)).toHaveLength(1);
      expect(limitsOf(out)).toEqual(["one-workspace", "listing-capped"]);
      expect(textOf(out)).toContain(CAP_SENTENCE);
      expect(textOf(out)).not.toContain(String(TS_WORKSPACE_SYMBOL_CAP_WATERMARK));
    });

    it("says nothing about a cap when the raw list came back one entry short of the watermark", async () => {
      const h = harness();
      h.indexOfSize(TS_WORKSPACE_SYMBOL_CAP_WATERMARK - 1, [indexed(h.area, "area", 12, 0, 16)]);

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(limitsOf(out)).toEqual(["one-workspace"]);
      expect(textOf(out)).not.toMatch(/bounded list/);
    });

    it("returns every exact match below the watermark: this server caps nothing", async () => {
      const h = harness();
      h.index(
        Array.from({ length: TS_WORKSPACE_SYMBOL_CAP_WATERMARK - 1 }, (_unused, index) =>
          indexed(join(h.ws, `p${index}.ts`), "area", 12, index, 16),
        ),
      );

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(rowsOf(out)).toHaveLength(TS_WORKSPACE_SYMBOL_CAP_WATERMARK - 1);
      expect(limitsOf(out)).toEqual(["one-workspace"]);
    });

    it("a capped search that found no exact match says both, and an uncapped one says only the first", async () => {
      const h = harness();

      h.indexOfSize(TS_WORKSPACE_SYMBOL_CAP_WATERMARK, [indexed(h.main, "Nearby", 12, 3, 16)]);
      const capped = await h.run({ symbol: "Absent", anchor: h.ws });
      expect(capped.isError).toBe(true);
      expect(textOf(capped)).toContain('no declaration named "Absent" was found in the whole workspace');
      expect(textOf(capped)).toContain("The match is exact, not fuzzy");
      expect(textOf(capped)).toContain("may have been ranked out of it");

      h.indexOfSize(TS_WORKSPACE_SYMBOL_CAP_WATERMARK - 1, [indexed(h.main, "Nearby", 12, 3, 16)]);
      const uncapped = await h.run({ symbol: "Absent", anchor: h.ws });
      expect(uncapped.isError).toBe(true);
      expect(textOf(uncapped)).not.toMatch(/ranked out/);
    });

    it("keeps a row whose hover never arrives, with the reason beside it", async () => {
      const h = harness();
      h.index([indexed(h.area, "area", 12, 0, 16)]);
      h.hangHover();

      const out = await runUntilBudgetExpires(() => h.run({ symbol: "area", anchor: h.ws, timeBudgetMs: 300 }), 300);
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(String(rowsOf(out)[0]?.descriptionUnavailable)).toMatch(/hover never arrived inside this call's 300 ms budget/);
    });

    it("fails loudly on an index entry it cannot read rather than reporting fewer declarations", async () => {
      const h = harness();
      h.index([{ nonsense: true }]);

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/cannot read/);
      expect(textOf(out)).toMatch(/entry 1/);
    });

    it("fails at the budget when the symbol search never arrives, saying which step timed out", async () => {
      const h = harness();
      h.hangSymbol();

      const out = await runUntilBudgetExpires(() => h.run({ symbol: "area", anchor: h.ws, timeBudgetMs: 100 }), 100);
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain('search the workspace for "area"');
      expect(textOf(out)).toMatch(/do not read this as an empty answer/);
      expect(out).not.toHaveProperty("structuredContent");
    });

    it("refuses an answer from a tsgo that was replaced while the search was in flight", async () => {
      const h = harness();
      h.index([indexed(h.area, "area", 12, 0, 16)]);
      h.crashNextSymbol();

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/tsgo restarted during the query about "area"/);
      expect(h.servers).toHaveLength(2);
    });

    it("holds the project anchors before asking, so a silent [] can only mean no declaration", async () => {
      const h = harness();
      h.index([indexed(h.area, "area", 12, 0, 16)]);

      await h.run({ symbol: "area", anchor: h.ws });
      expect(openedPaths(h.server)).toContain(h.area);
      expect(h.server.journal.indexOf(`req:${SYMBOL_METHOD}`)).toBeGreaterThan(
        h.server.journal.indexOf("note:textDocument/didOpen"),
      );
      expect(h.server.methods[0]).toBe("initialize");
    });

    it("roots tsgo at the workspace and asks only the methods its config allows", async () => {
      const h = harness();
      h.index([indexed(h.area, "area", 12, 0, 16)]);
      h.hovers({ [h.area]: hover("function area(): number") });

      await h.run({ symbol: "area", anchor: h.ws });
      expect(h.server.requests[0]?.[1]).toMatchObject({ rootUri: uriOf(h.ws) });
      expect(h.server.methods).toEqual(["initialize", SYMBOL_METHOD, HOVER_METHOD]);
      expect(h.session.getOpenedFiles()).toEqual([h.area]);
    });

    it("states the scope of a directory answer with no named file, so none can be uncovered", async () => {
      const h = harness();
      writeFileSync(join(h.ws, "packages", "ui", "src", "lonely.ts"), "export const lonely = 1;\n");
      h.index([indexed(h.area, "area", 12, 0, 16)]);

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(scopeOf(out)).toMatchObject({
        uncoveredSources: { count: 1, namedFileUncovered: false },
      });
      expect(limitsOf(out)).toEqual(["one-workspace", "uncovered-sources-present"]);
    });
  });

  describe("a directory anchor whose map yields no anchor", () => {
    it("is an error naming the failed projects and their reasons, never an empty answer", async () => {
      const h = harness();
      h.listing(join(h.ws, "tsconfig.json"), { failWith: "error TS5083: Cannot read file" });

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain("no project anchor could be opened");
      expect(textOf(out)).toContain(join(h.ws, "tsconfig.json"));
      expect(textOf(out)).toContain("error TS5083");
      expect(h.server.methods).not.toContain(SYMBOL_METHOD);
    });

    it("is an error naming a solution-style config that owns no member", async () => {
      const h = harness();
      h.listing(join(h.ws, "tsconfig.json"), []);

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain("no project anchor could be opened");
      expect(textOf(out)).toContain("lists no member file");
      expect(h.server.methods).not.toContain(SYMBOL_METHOD);
    });

    it("is an error naming why there is no map when the workspace holds more projects than the limit", async () => {
      const h = harness();
      for (let index = 0; index < PROJECT_MAP_LIMIT + 1; index += 1) {
        const dir = join(h.ws, "many", `p${index}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
      }

      const out = await h.run({ symbol: "area", anchor: h.ws });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain("no project anchor could be opened");
      expect(textOf(out)).toContain("no project map");
      expect(h.server.methods).not.toContain(SYMBOL_METHOD);
    });
  });

  describe("boundaries", () => {
    it("fails when the anchor does not exist, before starting a child", async () => {
      const h = harness();

      const out = await h.run({ anchor: join(h.ws, "gone.ts") });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/the anchor ".*gone\.ts" does not exist/);
      expect(h.servers).toHaveLength(0);
    });

    it("fails when the anchor escapes every declared root", async () => {
      const h = harness();

      const out = await h.run({ anchor: join(h.tmp, "outside") });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/escapes every declared root/);
      expect(h.servers).toHaveLength(0);
    });

    it("refuses a file anchor that is not a TypeScript or JavaScript source", async () => {
      const h = harness();
      writeFileSync(join(h.ws, "README.md"), "# x\n");

      const out = await h.run({ anchor: join(h.ws, "README.md") });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain("is not a TypeScript or JavaScript source");
      expect(h.servers).toHaveLength(0);
    });

    it("accepts a directory anchor whatever its name, because only a file's extension decides", async () => {
      const h = harness();
      h.index([indexed(h.area, "area", 12, 0, 16)]);

      const out = await h.run({ symbol: "area", anchor: join(h.ws, "packages", "ui", "src", "lib") });
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(scopeOf(out)).toMatchObject({ workspaceRoot: h.ws, lookup: "workspace-symbol" });
    });

    it("fails when a directory anchor is in no npm package, naming the directory it searched from", async () => {
      const h = harness();
      const plain = join(h.tmp, "plain");
      mkdirSync(plain, { recursive: true });

      const out = await h.run({ sourceRoots: [h.tmp], anchor: plain });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/is not inside an npm package/);
      expect(textOf(out)).toContain(plain);
      expect(h.servers).toHaveLength(0);
    });

    it("fails when the anchor's package sits outside the declared roots, naming both", async () => {
      const h = harness();
      const pkg = join(h.ws, "packages", "ui", "src");

      const out = await h.run({ sourceRoots: [pkg], anchor: pkg });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/outside every declared sourceRoots entry/);
      expect(textOf(out)).toContain(join(h.ws, "packages", "ui"));
    });

    it("reports the missing tsgo at once for either anchor, naming the override", async () => {
      const h = harness();
      const manager = new LspSessionManager();
      const miss: TsQueryDeps = {
        resolveBinary: async (): Promise<TsgoBinaryResult> => ({
          unavailable: "no TypeScript 7 native server was found",
          attempted: "npm root -g",
        }),
      };

      for (const anchor of [h.main, h.ws]) {
        const out = await runTsFindSymbol(
          manager,
          { sourceRoots: [h.ws], symbol: "Driver", anchor, timeBudgetMs: 60_000 },
          miss,
        );
        expect(out.isError).toBe(true);
        expect(textOf(out)).toContain("no TypeScript 7 native server was found");
        expect(textOf(out)).not.toMatch(/budget/);
      }
    });
  });

  // A signature the printer shortened is published as sent, and marked.
  describe("a signature TypeScript's printer shortened", () => {
    const ELIDED = "const scaled: {\n    factor: number;\n} | {\n    ...;\n}";

    it("sets signatureTruncated on a row whose signature holds an elided arm, and says where to read the rest", async () => {
      const h = harness();
      h.hovers({ [h.main]: hover(ELIDED) });

      const out = await h.run({ symbol: "scaled" });
      expect(rowsOf(out)[0]).toMatchObject({ signature: ELIDED, signatureTruncated: true });
      expect(textOf(out)).toContain(
        `scaled (variable) in packages/ui/src at ${h.main}:21 - signature shortened by TypeScript; read ${h.main}:21 for the full type`,
      );
    });

    it("sets it on the elided run of members that reads `... N more ...`", async () => {
      const h = harness();
      h.hovers({ [h.main]: hover("const scaled: {\n    a: 1;\n    ... 12 more ...;\n    z: 1;\n}") });

      expect(rowsOf(await h.run({ symbol: "scaled" }))[0]).toHaveProperty("signatureTruncated", true);
    });

    it("leaves a rest parameter alone: `...args: T[]` is the signature, not an elision", async () => {
      const h = harness();
      h.hovers({ [h.main]: hover("function parse(...args: string[]): number") });

      const out = await h.run({ symbol: "parse" });
      expect(rowsOf(out)[0]).not.toHaveProperty("signatureTruncated");
      expect(textOf(out)).not.toContain("signature shortened");
    });
  });

  // A successful answer carries the uncovered pointer as its second line too.
  it("puts the uncovered pointer on the second line of a success summary", async () => {
    const h = harness();
    const orphan = join(h.ws, "packages", "ui", "src", "orphan.ts");
    writeFileSync(orphan, "const d = new Driver();\n");

    const out = await h.run();
    expect(out.isError, textOf(out)).toBeFalsy();
    const lines = textOf(out).split("\n");
    expect(lines[0]).not.toContain("not searched");
    expect(lines[1]).toBe(
      `INCOMPLETE: 1 file(s) no tsconfig project includes were not searched (packages/ui/src 1). 1 of them contain "Driver" and may hold more results - grep "Driver" in: ${orphan} (1 matching line). Do not report this answer as complete until you have.`,
    );
    expect(lines[2]).toMatch(/^limits: /);
    // The same two lines are structuredContent's first key, with no limits line and no rows.
    const structured = (out as { structuredContent?: object }).structuredContent;
    expect(JSON.stringify(structured).startsWith('{"summary":"')).toBe(true);
    expect(payload(out).summary).toBe(lines.slice(0, 2).join("\n"));
    expect(scopeOf(out).uncoveredSources).toMatchObject({ grepRequired: true });
  });

  // The refusal is where a declaration in a file no project includes is lost.
  describe("a refusal while sources no project includes exist", () => {
    function withOrphan(h: Harness): string {
      const orphan = join(h.ws, "packages", "ui", "src", "orphan.ts");
      writeFileSync(orphan, "export const ONLY_HERE = 1;\nexport const again = ONLY_HERE;\n");
      return orphan;
    }

    const CLAUSE = (orphan: string): string =>
      `INCOMPLETE: 1 file(s) no tsconfig project includes were not searched (packages/ui/src 1). 1 of them contain "ONLY_HERE" and may hold more results - grep "ONLY_HERE" in: ${orphan} (2 matching lines). Do not report this answer as complete until you have.`;

    it("appends the clause to a directory anchor's no-match refusal", async () => {
      const h = harness();
      const orphan = withOrphan(h);
      h.index([]);

      const out = await h.run({ symbol: "ONLY_HERE", anchor: h.ws });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain(`no declaration named "ONLY_HERE" was found`);
      expect(textOf(out).endsWith(`\n${CLAUSE(orphan)}`)).toBe(true);
      // An error result is text only and carries no summary key.
      expect(out).not.toHaveProperty("structuredContent");
    });

    it("appends the clause to a file anchor's refusal too, building the map only for that refusal", async () => {
      const h = harness();
      const orphan = withOrphan(h);

      const out = await h.run({ symbol: "ONLY_HERE" });
      expect(out.isError).toBe(true);
      expect(textOf(out).endsWith(`\n${CLAUSE(orphan)}`)).toBe(true);
      expect(h.server.methods).not.toContain(SYMBOL_METHOD);
    });

    it("points at nothing for an ill-formed name, which names no identifier to look for", async () => {
      const h = harness();
      withOrphan(h);

      for (const symbol of ["ONLY_HERE.", "A..b", " "]) {
        const out = await h.run({ symbol });
        expect(out.isError).toBe(true);
        expect(textOf(out)).not.toContain("were not searched");
        expect(textOf(out)).not.toContain("mention");
      }
    });

    it("leaves the file anchor's refusal exactly as it read before when nothing is uncovered", async () => {
      const h = harness();

      const out = await h.run({ symbol: "Absent" });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/is not an answer this call can give\.$/);
      expect(textOf(out)).not.toContain("were not searched");
    });

    it("leaves a file anchor's refusal as it read before when the project map cannot be built", async () => {
      const h = harness();
      withOrphan(h);
      h.listing(join(h.ws, "tsconfig.json"), { failWith: "error TS5083: Cannot read file" });

      const out = await h.run({ symbol: "ONLY_HERE" });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/is not an answer this call can give\.$/);
    });
  });
});
