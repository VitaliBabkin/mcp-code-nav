// `ts_find_implementations`' mocked contract: the `{ resolved, implementations,
// truncated, scope }` shape with no `direction` — tsgo's answer is one-directional — over a TypeScript
// workspace, with `structural-implementers-not-reported` on every answer because a type that satisfies an
// interface only structurally is invisible to `textDocument/implementation` . No `tsc.exe`, no
// `npm` and no real tsgo runs here: the executable comes through `resolveBinary`, the project listings
// through `exec`, and every tsgo answer through the fake server's `respond`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import type { LspSession } from "../../src/lsp/session.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import {
  runTsFindImplementations,
  TsFindImplementationsInput,
} from "../../src/tools/ts-find-implementations.js";
import { IMPLEMENTATIONS_LIMIT } from "../../src/tools/navigation-limits.js";
import type { TsQueryDeps } from "../../src/tools/ts-navigation-shared.js";
import type { TsgoBinary, TsExecFn } from "../../src/tsgo/binary.js";
import { dropProjectMap } from "../../src/tsgo/project-map.js";
import { fakeServer, pathOfDocumentId, uriOf, type FakeServer } from "../helpers/fake-lsp.js";

type Result = Awaited<ReturnType<typeof runTsFindImplementations>>;
type Input = {
  sourceRoots: string[];
  file: string;
  symbol: string;
  timeBudgetMs: number;
};
type Row = Record<string, unknown>;

/** What the located package states for itself; the fake process says something else in `initialize`. */
const BINARY: TsgoBinary = {
  executable: "C:/fake/npm-global/typescript/node_modules/@typescript/typescript-win32-x64/lib/tsc.exe",
  version: "7.0.2",
  source: "global",
};
const SERVER_VERSION = "7.0.2";

/**
 * The file every case addresses. `Widget` is the merged pair — a class and an interface of one name, which
 * TypeScript makes one symbol and an implementations call asks at the interface. `Base.count` is a property,
 * one of the four kinds asked, and `Named` is the type alias tsgo reports as a class.
 */
const MAIN_TEXT = [
  "export interface Storage {",
  "  get(key: string): string;",
  "}",
  "export class Driver implements Storage {",
  "  get(key: string): string {",
  "    return key;",
  "  }",
  "}",
  "export class Widget {}",
  "export interface Widget {}",
  "export abstract class Base {",
  "  count = 1;",
  "  run(): void {}",
  "}",
  "export const label = \"x\";",
  "export type Named = { label: string };",
  "export enum Level { Low }",
  "export function build() {}",
  "export namespace Pair {}",
  "export class Pair {}",
];

/** A file with an implementing class, so a row's name comes from that file's own outline. */
const IMPL_TEXT = [
  "export class ExecDriver implements Storage {",
  "  get(key: string): string {",
  "    return key;",
  "  }",
  "}",
];

/** A file whose class satisfies `Storage` only structurally — tsgo reports no location for it, hence the code. */
const STRUCT_TEXT = [
  "export class StructuralDriver {",
  "  get(key: string): string {",
  "    return key;",
  "  }",
  "}",
];

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

/** tsgo's kind numbers: 11 interface, 5 class, 6 method, 7 property, 10 enum, 12 function, 13 variable. */
const MAIN_OUTLINE: LspDocumentSymbol[] = [
  sym(MAIN_TEXT, "Storage", 11, [0, "Storage"], [2, "}"], [0, "Storage"], [
    sym(MAIN_TEXT, "get", 6, [1, "get"], [1, ";"], [1, "get"]),
  ]),
  sym(MAIN_TEXT, "Driver", 5, [3, "Driver"], [7, "}"], [3, "Driver"], [
    sym(MAIN_TEXT, "get", 6, [4, "get"], [6, "}"], [4, "get"]),
  ]),
  sym(MAIN_TEXT, "Widget", 5, [8, "class Widget"], [8, "}"], [8, "Widget"]),
  sym(MAIN_TEXT, "Widget", 11, [9, "Widget"], [9, "}"], [9, "Widget"]),
  sym(MAIN_TEXT, "Base", 5, [10, "Base"], [13, "}"], [10, "Base"], [
    sym(MAIN_TEXT, "count", 7, [11, "count"], [11, ";"], [11, "count"]),
    sym(MAIN_TEXT, "run", 6, [12, "run"], [12, "}"], [12, "run"]),
  ]),
  sym(MAIN_TEXT, "label", 13, [14, "label"], [14, ";"], [14, "label"]),
  sym(MAIN_TEXT, "Named", 5, [15, "Named"], [15, "}"], [15, "Named"]),
  sym(MAIN_TEXT, "Level", 10, [16, "Level"], [16, "}"], [16, "Level"]),
  sym(MAIN_TEXT, "build", 12, [17, "build"], [17, "}"], [17, "build"]),
  // LSP kind 3 is `namespace`: the declaration TypeScript merges with a class of one name, listed first here so
  // the merged symbol's FIRST entry is not one of the four asked kinds.
  sym(MAIN_TEXT, "Pair", 3, [18, "Pair"], [18, "}"], [18, "Pair"]),
  sym(MAIN_TEXT, "Pair", 5, [19, "class Pair"], [19, "}"], [19, "Pair"]),
];

const IMPL_OUTLINE: LspDocumentSymbol[] = [
  sym(IMPL_TEXT, "ExecDriver", 5, [0, "ExecDriver"], [4, "}"], [0, "ExecDriver"], [
    sym(IMPL_TEXT, "get", 6, [1, "get"], [3, "}"], [1, "get"]),
  ]),
];

const STRUCT_OUTLINE: LspDocumentSymbol[] = [
  sym(STRUCT_TEXT, "StructuralDriver", 5, [0, "StructuralDriver"], [4, "}"], [0, "StructuralDriver"]),
];

/** One `Location` as tsgo spells it: 0-based line and character. */
function location(path: string, line: number, character = 13): unknown {
  return { uri: uriOf(path), range: { start: { line, character }, end: { line, character: character + 5 } } };
}

/** One `LocationLink`, the other shape `textDocument/implementation` may answer with. */
function link(target: string, line: number, character: number): unknown {
  return {
    targetUri: uriOf(target),
    targetRange: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
    targetSelectionRange: { start: { line, character }, end: { line, character: character + 10 } },
  };
}

interface Harness {
  readonly tmp: string;
  readonly ws: string;
  readonly main: string;
  readonly impl: string;
  readonly struct: string;
  readonly outside: string;
  readonly session: LspSession;
  readonly servers: FakeServer[];
  readonly server: FakeServer;
  outline(path: string, symbols: LspDocumentSymbol[]): void;
  /** What `textDocument/implementation` answers with. */
  answer(result: unknown): void;
  hangImplementation(): void;
  crashNextImplementation(): void;
  /** Another caller's freshness check reloads the session while the query is in flight, then proves its own anchors. */
  reloadBesideAnswer(): void;
  run(overrides?: Partial<Input>): Promise<Result>;
}

const built: { tmp: string; ws: string }[] = [];

/**
 * A tsgo whose outlines, implementation answer and project listings the test supplies, over a real temp
 * workspace. The three sources are named so the project's anchor is `main.ts` — the anchor is the lexically
 * first member the project OWNS, and the assertions below read the opened-document journal as one file.
 */
function harness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-tsimpl-"));
  const ws = resolve(join(tmp, "ws"));
  built.push({ tmp, ws });
  const src = join(ws, "packages", "ui", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
  writeFileSync(join(ws, "packages", "ui", "package.json"), JSON.stringify({ name: "@mono/ui" }));
  const config = join(ws, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: {} }));
  const main = join(src, "main.ts");
  writeFileSync(main, `${MAIN_TEXT.join("\n")}\n`);
  const impl = join(src, "store-impl.ts");
  writeFileSync(impl, `${IMPL_TEXT.join("\n")}\n`);
  const struct = join(src, "store-structural.ts");
  writeFileSync(struct, `${STRUCT_TEXT.join("\n")}\n`);
  const outside = join(tmp, "outside", "io.ts");

  const outlines = new Map<string, LspDocumentSymbol[]>([
    [main, MAIN_OUTLINE],
    [impl, IMPL_OUTLINE],
    [struct, STRUCT_OUTLINE],
  ]);
  const listing = new Map<string, readonly string[]>([[config, [main, impl, struct]]]);
  const exec: TsExecFn = async (_executable, args) => {
    const found = listing.get(args[2] ?? "");
    return found === undefined
      ? { stdout: "", stderr: "", exitCode: 0 }
      : { stdout: found.join("\n"), stderr: "", exitCode: 0 };
  };

  let implementation: unknown = [];
  let hanging = false;
  let crashing = false;
  let alive = true;
  let beside: (() => Promise<unknown>) | undefined;
  const servers: FakeServer[] = [];
  const manager = new LspSessionManager({
    spawn: () => {
      const server = fakeServer({
        alive: () => alive,
        respond: (method, params) => {
          if (method === "initialize") return { serverInfo: { name: "tsgo", version: SERVER_VERSION } };
          if (method === "textDocument/documentSymbol") return outlines.get(pathOfDocumentId(params) ?? "") ?? [];
          if (method === "textDocument/implementation") {
            if (hanging) return new Promise<unknown>(() => {});
            if (crashing) {
              crashing = false;
              alive = false;
              throw new Error("connection got disposed");
            }
            if (beside !== undefined) return beside().then(() => implementation);
            return implementation;
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
    impl,
    struct,
    outside,
    session,
    servers,
    get server() {
      const last = servers[servers.length - 1];
      if (last === undefined) throw new Error("this run started no tsgo process");
      return last;
    },
    outline: (path, symbols) => outlines.set(path, symbols),
    answer: (result) => {
      implementation = result;
    },
    hangImplementation: () => {
      hanging = true;
    },
    crashNextImplementation: () => {
      crashing = true;
    },
    reloadBesideAnswer: () => {
      beside = async () => {
        session.dispose();
        await session.openAnchors([impl]);
      };
    },
    run: (overrides = {}) =>
      runTsFindImplementations(
        manager,
        { sourceRoots: [ws], file: main, symbol: "Storage", timeBudgetMs: 60_000, ...overrides },
        deps,
      ),
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
  return payload(result).implementations as Row[];
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

function closedPaths(server: FakeServer): (string | undefined)[] {
  return server.notifications.filter(([method]) => method === "textDocument/didClose").map(([, p]) => pathOfDocumentId(p));
}

/** The `scope` of a clean, fully mapped answer over this temp workspace, for an interface subject. */
function cleanScope(h: Harness): Record<string, unknown> {
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
    limits: ["one-workspace", "structural-implementers-not-reported"],
  };
}

const SCOPE_SENTENCE =
  ` under workspace "{ws}": 1 project(s) found, 1 loaded, 0 failed, answered by tsgo 7.0.2,` +
  " freshness: unchanged";

describe("TsFindImplementationsInput", () => {
  it("needs a root to bound the call and defaults the budget to 60000 ms", () => {
    const parsed = TsFindImplementationsInput.parse({ sourceRoots: ["C:/ws"], file: "src/main.ts", symbol: "Storage" });
    expect(parsed.timeBudgetMs).toBe(60_000);
    expect(Object.keys(TsFindImplementationsInput.shape).sort()).toEqual(["file", "sourceRoots", "symbol", "timeBudgetMs"]);
    expect(TsFindImplementationsInput.safeParse({ sourceRoots: [], file: "a.ts", symbol: "S" }).success).toBe(false);
  });
});

describe("runTsFindImplementations", () => {
  afterEach(() => {
    for (const root of built.splice(0)) {
      dropProjectMap(root.ws);
      rmSync(root.tmp, { recursive: true, force: true });
    }
  });

  // An implementer in a file no project includes is never a row, and is pointed at.
  it("names an uncovered file that mentions the interface, and lists no row for it", async () => {
    const h = harness();
    const orphan = join(dirname(h.main), "orphan.ts");
    writeFileSync(orphan, "export class Late implements Storage {}\n");
    h.answer([]);

    const out = await h.run();
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(payload(out).implementations).toEqual([]);
    expect((scopeOf(out) as { uncoveredSources: unknown }).uncoveredSources).toEqual({
      count: 1,
      grepRequired: true,
      directories: [{ directory: "packages/ui/src", count: 1 }],
      directoriesTruncated: 0,
      mentioning: { name: "Storage", count: 1, files: [{ file: orphan, matchingLines: 1 }], filesTruncated: 0, unchecked: 0 },
      namedFileUncovered: false,
    });
    const lines = textOf(out).split("\n");
    expect(lines[0]).not.toContain("not searched");
    expect(lines[1]).toBe(
      `INCOMPLETE: 1 file(s) no tsconfig project includes were not searched (packages/ui/src 1). 1 of them contain "Storage" and may hold more results - grep "Storage" in: ${orphan} (1 matching line). Do not report this answer as complete until you have.`,
    );
    // The same two lines are structuredContent's first key, with no limits line and no rows.
    const structured = (out as { structuredContent?: object }).structuredContent;
    expect(JSON.stringify(structured).startsWith('{"summary":"')).toBe(true);
    expect(payload(out).summary).toBe(lines.slice(0, 2).join("\n"));
    expect(scopeOf(out).uncoveredSources).toMatchObject({ grepRequired: true });
  });

  it("lists each implementation with its own name and kind, and states the ground it was computed on", async () => {
    const h = harness();
    h.answer([location(h.impl, 0, 13), location(h.main, 3, 13)]);

    const out = await h.run();
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(payload(out)).toEqual({
      summary: expect.any(String),
      resolved: { name: "Storage", kind: "interface", file: h.main, line: 1 },
      implementations: [
        { name: "ExecDriver", kind: "class", file: h.impl, line: 1, external: false },
        { name: "Driver", kind: "class", file: h.main, line: 4, external: false },
      ],
      truncated: 0,
      scope: cleanScope(h),
    });
    expect(requestFor(h.server, "textDocument/implementation")).toEqual({
      textDocument: { uri: uriOf(h.main) },
      position: at(MAIN_TEXT, 0, "Storage"),
    });
    expect(textOf(out)).toBe(
      `Implementations of interface "Storage" (${h.main}:1)${SCOPE_SENTENCE.replaceAll("{ws}", h.ws)} ` +
        "- 2 row(s).\n" +
        "limits: one-workspace, structural-implementers-not-reported\n" +
        `  ExecDriver (class) ${h.impl}:1\n` +
        `  Driver (class) ${h.main}:4`,
    );
  });

  it("publishes the keys in order, with no `direction` field and no `visibility`", async () => {
    const h = harness();
    h.answer([location(h.impl, 0, 13)]);

    const out = await h.run();
    expect(Object.keys(payload(out))).toEqual(["summary", "resolved", "implementations", "truncated", "scope"]);
    expect(Object.keys(rowsOf(out)[0] ?? {})).toEqual(["name", "kind", "file", "line", "external"]);
    expect(Object.keys(scopeOf(out))).toEqual([
      "workspaceRoot",
      "enclosingWorkspace",
      "freshness",
      "server",
      "workspaceTypescript",
      "projects",
      "uncoveredSources",
      "limits",
    ]);
    expect(JSON.stringify(payload(out))).not.toContain("direction");
    expect(JSON.stringify(payload(out))).not.toContain("visibility");
  });

  it("reads a LocationLink reply, naming the declaration at its selection range", async () => {
    const h = harness();
    h.answer([link(h.impl, 0, 13)]);

    const out = await h.run();
    expect(rowsOf(out)).toEqual([{ name: "ExecDriver", kind: "class", file: h.impl, line: 1, external: false }]);
  });

  it("asks a merged class-and-interface symbol at the interface entry, which is what a type implements", async () => {
    const h = harness();
    h.answer([location(h.impl, 0, 13)]);

    const out = await h.run({ symbol: "Widget" });
    expect(out.isError, textOf(out)).toBeFalsy();
    // One key, several entries, one symbol — and an implementations call prefers the interface or
    // class entry among them. The interface is the SECOND here, so the request is not at the position the
    // bare address would have used, and `resolved` says what the answer is about.
    expect(payload(out).resolved).toEqual({ name: "Widget", kind: "interface", file: h.main, line: 10 });
    expect(requestFor(h.server, "textDocument/implementation")).toEqual({
      textDocument: { uri: uriOf(h.main) },
      position: at(MAIN_TEXT, 9, "Widget"),
    });
  });

  it("asks a merged namespace-and-class symbol at its class, the entry the question belongs to", async () => {
    // The kind gate reads the entry the QUERY is asked at, not whichever declaration came first: a namespace
    // sharing its key with a class is merged with it, and the class is a valid subject.
    const h = harness();
    h.answer([location(h.impl, 0, 13)]);

    const out = await h.run({ symbol: "Pair" });
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(payload(out).resolved).toEqual({ name: "Pair", kind: "class", file: h.main, line: 20 });
    expect(requestFor(h.server, "textDocument/implementation")).toEqual({
      textDocument: { uri: uriOf(h.main) },
      position: at(MAIN_TEXT, 19, "Pair"),
    });
  });

  it("never lists the subject among its own implementations, which is what tsgo answers for a class", async () => {
    // Measured live on `implementations(Base)`: the server lists the queried class itself. It is the subject, so
    // it is dropped rather than re-derived, and the drop is said in the tool's own description - a listing that
    // quietly held the answer's own subject reads as "one implementation exists" for a class with none.
    const h = harness();
    h.answer([location(h.main, 0, 17), location(h.impl, 0, 13)]);

    const out = await h.run();
    expect(rowsOf(out)).toEqual([{ name: "ExecDriver", kind: "class", file: h.impl, line: 1, external: false }]);
    expect(payload(out).truncated).toBe(0);
    expect(textOf(out)).toContain("- 1 row(s)");
  });

  it("keeps a row reported without a character, because identity with the subject cannot be shown for it", async () => {
    // The self-row filter compares exact positions, so a location that carries only a
    // line errs toward keeping the row rather than dropping a real implementer.
    const h = harness();
    const lineOnly = { uri: uriOf(h.main), range: { start: { line: 0 }, end: { line: 0 } } };
    h.answer([lineOnly, location(h.impl, 0, 13)]);

    const out = await h.run();
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(rowsOf(out).map((row) => row.file)).toEqual([h.main, h.impl]);
    expect(textOf(out)).toContain("- 2 row(s)");
  });

  it.each([
    ["an interface", "Storage", "interface"],
    ["a class", "Driver", "class"],
    ["a method", "Storage.get", "method"],
    ["a property", "Base.count", "property"],
    // the measured server behaviour: tsgo reports a type alias with the kind number of a class, and it is published as
    // reported, never re-derived — so this is the class the kind gate asks, which is the fact to pin.
    ["a type alias, reported as a class", "Named", "class"],
  ])("asks %s, one of the four kinds", async (_label: string, symbol: string, kind: string) => {
    const h = harness();
    h.answer([]);

    const out = await h.run({ symbol });
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(payload(out).resolved.kind).toBe(kind);
    expect(h.server.methods).toContain("textDocument/implementation");
  });

  it.each([
    ["a function", "build"],
    ["a variable", "label"],
    ["an enum", "Level"],
  ])("refuses %s, naming the kind it found, and asks nothing type-aware", async (article: string, symbol: string) => {
    const h = harness();
    h.answer([location(h.impl, 0, 13)]);

    const out = await h.run({ symbol });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_implementations failed: "${symbol}" is ${article}, and only an interface, class, method or ` +
        "property has implementations. tsgo answers that question for those four; for any other declaration " +
        "ask ts_find_references for where it is used.",
    );
    expect(h.server.methods).not.toContain("textDocument/implementation");
  });

  it("carries structural-implementers-not-reported on every answer, empty ones included", async () => {
    const h = harness();
    h.answer([]);

    const out = await h.run();
    expect(payload(out)).toMatchObject({ implementations: [], truncated: 0 });
    expect(limitsOf(out)).toEqual(["one-workspace", "structural-implementers-not-reported"]);
    // The class that satisfies `Storage` without naming it is in the workspace and in the project's listing;
    // tsgo reports no location for it, which is exactly what the code tells the caller about this empty.
    expect(h.session.getOpenedFiles()).toEqual([h.main]);
    expect(textOf(out)).toBe(
      `Implementations of interface "Storage" (${h.main}:1)${SCOPE_SENTENCE.replaceAll("{ws}", h.ws)} ` +
        "- 0 row(s).\nlimits: one-workspace, structural-implementers-not-reported",
    );
  });

  it("counts every implementation tsgo reported when the row cap narrows the listing, external rows first", async () => {
    const h = harness();
    const external = Array.from({ length: IMPLEMENTATIONS_LIMIT - 1 }, (_unused, index) =>
      location(join(h.tmp, "outside", `f${index}.ts`), index + 1),
    );
    h.answer([location(h.main, 3, 13), ...external, location(h.impl, 0, 13)]);

    const out = await h.run();
    const rows = rowsOf(out);
    expect(rows).toHaveLength(IMPLEMENTATIONS_LIMIT);
    expect(payload(out).truncated).toBe(1);
    expect(rows[0]).toMatchObject({ file: h.main, external: false });
    expect(rows[1]).toMatchObject({ file: h.impl, external: false });
    expect(rows.slice(2).every((row) => row.external)).toBe(true);
    expect(limitsOf(out)).toEqual(["one-workspace", "structural-implementers-not-reported", "listing-capped"]);
    expect(textOf(out)).toContain(`${IMPLEMENTATIONS_LIMIT}-row cap`);
    // A dropped row was never opened and a kept external one never is: one transient read, for the one other
    // in-workspace file a kept row sits in. The anchor and the named file are the same file here.
    expect(countOf(h.server, "textDocument/documentSymbol")).toBe(2);
    expect(openedPaths(h.server)).toEqual([h.main, h.impl]);
    expect(closedPaths(h.server)).toEqual([h.impl]);
  });

  it("reports an implementation outside the workspace and never opens or names its file", async () => {
    const h = harness();
    h.answer([location(h.outside, 20, 4)]);

    const out = await h.run();
    expect(rowsOf(out)).toEqual([
      {
        name: null,
        kind: null,
        file: h.outside,
        line: 21,
        external: true,
        reason: "outside the workspace root; not named",
      },
    ]);
    expect(openedPaths(h.server)).toEqual([h.main]);
    expect(closedPaths(h.server)).toEqual([]);
  });

  it("keeps a row the naming step cannot name, with its reason beside it", async () => {
    const h = harness();
    h.outline(h.impl, []);
    h.answer([location(h.impl, 9, 13)]);

    const out = await h.run();
    expect(rowsOf(out)[0]).toMatchObject({
      name: null,
      kind: null,
      reason: "no declaration in this file encloses the reported location",
    });
  });

  it("fails rather than reporting a shorter answer for a reply it cannot read", async () => {
    const h = harness();
    h.answer({ implementations: [] });

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("answered the query for \"Storage\" with an object this server cannot read");
    expect(textOf(out)).toContain("possibly dropping a match");
  });

  it("refuses an answer from a tsgo that was replaced while the query was in flight", async () => {
    const h = harness();
    h.answer([location(h.impl, 0, 13)]);
    h.crashNextImplementation();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_implementations failed: tsgo restarted during the query about "Storage" in the workspace ` +
        `"${h.ws}", so the documents the answer depends on were opened on a process that is not the one that ` +
        "answered. Call again: the restarted server opens its anchors and proves them before answering.",
    );
    expect(h.servers).toHaveLength(2);
  });

  it("refuses an answer from a process another call reloaded and proved while this one was in flight", async () => {
    const h = harness();
    h.answer([location(h.impl, 0, 13)]);
    h.reloadBesideAnswer();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("tsgo restarted during the query");
    expect(h.session.isWorkspaceLoaded()).toBe(true);
    expect(h.servers).toHaveLength(2);
  });

  it("fails at the budget when tsgo never answers, and returns no listing to be read as empty", async () => {
    const h = harness();
    h.hangImplementation();

    const out = await h.run({ timeBudgetMs: 100 });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_implementations failed: tsgo did not answer the query for "Storage" within this call's 100 ms ` +
        `budget. The workspace at "${h.ws}" may still be loading its projects; raise timeBudgetMs or call ` +
        "again, and do not read this as an empty answer.",
    );
    expect(out).not.toHaveProperty("structuredContent");
    expect(countOf(h.server, "textDocument/implementation")).toBe(1);
  });

  it("asks tsgo only the methods its config allows, in the order the proof needs", async () => {
    const h = harness();
    h.answer([location(h.impl, 0, 13)]);

    await h.run();
    expect(h.server.methods).toEqual([
      "initialize",
      "textDocument/documentSymbol",
      "textDocument/implementation",
      "textDocument/documentSymbol",
    ]);
    expect(h.server.requests[0]?.[1]).toMatchObject({ rootUri: uriOf(h.ws) });
  });
});
