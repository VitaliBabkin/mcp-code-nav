// `ts_find_references`' mocked contract: `go_find_references`' payload over a TypeScript
// workspace, with the group-by-file listing, the exact counts behind both caps, and the `scope` block that
// states the ground the answer was computed on. No `tsc.exe`, no `npm` and no compiler run anywhere here: the
// executable is injected through `resolveBinary`, the project listings through `exec`, and every tsgo answer
// through the fake server's `respond`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import type { LspSession } from "../../src/lsp/session.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runTsFindReferences, TsFindReferencesInput } from "../../src/tools/ts-find-references.js";
import {
  REFERENCE_FILES_LIMIT,
  REFERENCE_SITES_PER_FILE_LIMIT,
} from "../../src/tools/navigation-limits.js";
import type { TsQueryDeps } from "../../src/tools/ts-navigation-shared.js";
import type { TsgoBinary, TsExecFn } from "../../src/tsgo/binary.js";
import { dropProjectMap } from "../../src/tsgo/project-map.js";
import { fakeServer, pathOfDocumentId, uriOf, type FakeServer } from "../helpers/fake-lsp.js";

type Result = Awaited<ReturnType<typeof runTsFindReferences>>;
type Input = {
  sourceRoots: string[];
  file: string;
  symbol: string;
  includeDeclaration: boolean;
  timeBudgetMs: number;
};
type FileGroup = Record<string, unknown>;
type Site = Record<string, unknown>;

/** What the located package states for itself; the fake process says something else in `initialize`. */
const BINARY: TsgoBinary = {
  executable: "C:/fake/npm-global/typescript/node_modules/@typescript/typescript-win32-x64/lib/tsc.exe",
  version: "7.0.2",
  source: "global",
};
const SERVER_VERSION = "7.0.2";

/** The text of the file that declares the symbol; the outline below points into it. */
const MAIN_TEXT = [
  "export interface Storage {",
  "  get(key: string): string;",
  "}",
  "export class Driver {",
  "  run(job: string): string {",
  "    const local = job.trim();",
  "    return local;",
  "  }",
  "  stop(): void {}",
  "}",
  "export const Widget = 1;",
  "export interface Widget { size: number }",
  "export function build() {}",
];

const USES_TEXT = ["export function caller(): void {", "  Storage.get(\"k\");", "}"];

/** Two overload signatures and their implementation: one symbol behind three outline entries. */
const OVER_TEXT = [
  "export function pick(a: string): string;",
  "export function pick(a: number): number;",
  "export function pick(a: any): any { return a; }",
  "export const use = pick;",
];

type P = { line: number; character: number };

/** Where `needle` first sits on a line of the fixture text — the offset tsgo reports for it. */
function at(lines: readonly string[], line: number, needle: string): P {
  const found = lines[line]?.indexOf(needle) ?? -1;
  if (found < 0) throw new Error(`"${needle}" is not on line ${line} of the fixture text`);
  return { line, character: found };
}

/** One `DocumentSymbol` as tsgo answers it: `range` from the declaration's first character, name included. */
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

/** tsgo's kind numbers: 11 interface, 5 class, 6 method, 14 constant, 12 function, 13 variable. */
const MAIN_OUTLINE: LspDocumentSymbol[] = [
  sym(MAIN_TEXT, "Storage", 11, [0, "Storage"], [2, "}"], [0, "Storage"], [
    sym(MAIN_TEXT, "get", 6, [1, "get"], [1, ";"], [1, "get"]),
  ]),
  sym(MAIN_TEXT, "Driver", 5, [3, "Driver"], [9, "}"], [3, "Driver"], [
    sym(MAIN_TEXT, "run", 6, [4, "run"], [7, "}"], [4, "run"], [
      sym(MAIN_TEXT, "local", 13, [5, "local"], [5, ";"], [5, "local"]),
    ]),
    sym(MAIN_TEXT, "stop", 6, [8, "stop"], [8, "}"], [8, "stop"]),
  ]),
  sym(MAIN_TEXT, "Widget", 14, [10, "Widget"], [10, ";"], [10, "Widget"]),
  sym(MAIN_TEXT, "Widget", 11, [11, "Widget"], [11, "}"], [11, "Widget"]),
  sym(MAIN_TEXT, "build", 12, [12, "build"], [12, "}"], [12, "build"]),
];

const USES_OUTLINE: LspDocumentSymbol[] = [
  sym(USES_TEXT, "caller", 12, [0, "caller"], [2, "}"], [0, "caller"]),
];

const OVER_OUTLINE: LspDocumentSymbol[] = [
  sym(OVER_TEXT, "pick", 12, [0, "export"], [0, ";"], [0, "pick"]),
  sym(OVER_TEXT, "pick", 12, [1, "export"], [1, ";"], [1, "pick"]),
  sym(OVER_TEXT, "pick", 12, [2, "export"], [2, "}"], [2, "pick"]),
  sym(OVER_TEXT, "use", 14, [3, "export"], [3, ";"], [3, "use"]),
];

/** One `Location` as tsgo spells it: 0-based line and character. */
function location(path: string, line: number, character = 4): unknown {
  return { uri: uriOf(path), range: { start: { line, character }, end: { line, character: character + 5 } } };
}

/** One `SymbolInformation` — the flat shape a server answers when its client never asked for a hierarchy. */
function flatSymbol(path: string, name: string, line: number): unknown {
  return {
    name,
    kind: 11,
    location: { uri: uriOf(path), range: { start: { line, character: 2 }, end: { line, character: 9 } } },
  };
}

interface Harness {
  readonly tmp: string;
  readonly ws: string;
  readonly main: string;
  readonly uses: string;
  readonly over: string;
  readonly outside: string;
  readonly config: string;
  readonly session: LspSession;
  readonly servers: FakeServer[];
  readonly server: FakeServer;
  readonly listings: { readonly executable: string; readonly args: readonly string[]; readonly cwd: string }[];
  outline(path: string, symbols: LspDocumentSymbol[]): void;
  answer(result: unknown): void;
  /** What `textDocument/hover` answers with, asked only for an import binding. */
  hover(result: unknown): void;
  /** What `textDocument/definition` answers with; an `Error` makes the request fail. */
  definition(result: unknown): void;
  hangReferences(): void;
  crashNextReferences(): void;
  /** Open this session's anchors from a second caller, while the query is being answered. */
  raceAnchorsBesideAnswer(): void;
  /** Another caller's freshness check reloads the session while the query is in flight, then proves its own anchors. */
  reloadBesideAnswer(): void;
  /** What one project's `--listFilesOnly` prints; a string is the compiler's error line instead. */
  listing(configPath: string, answer: readonly string[] | string): void;
  run(overrides?: Partial<Input>): Promise<Result>;
}

const built: { tmp: string; ws: string }[] = [];

/** A tsgo whose outlines, query answer and project listings the test supplies, over a real temp workspace. */
function harness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-tsref-"));
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
  const uses = join(src, "uses.ts");
  writeFileSync(uses, `${USES_TEXT.join("\n")}\n`);
  const over = join(src, "over.ts");
  writeFileSync(over, `${OVER_TEXT.join("\n")}\n`);
  const outside = join(tmp, "outside", "io.ts");

  const outlines = new Map<string, LspDocumentSymbol[]>([
    [main, MAIN_OUTLINE],
    [uses, USES_OUTLINE],
    [over, OVER_OUTLINE],
  ]);
  const listings = new Map<string, readonly string[] | string>([[config, [main, uses, over]]]);
  const listingsAsked: Harness["listings"] = [];
  let references: unknown = [];
  let hovered: unknown = null;
  let defined: unknown = [];
  let hanging = false;
  let crashing = false;
  let alive = true;
  /** Run beside the answer to the query, by the case that wants a second caller on the same session. */
  let beside: (() => Promise<unknown>) | undefined;
  const servers: FakeServer[] = [];
  const exec: TsExecFn = async (executable, args, cwd) => {
    listingsAsked.push({ executable, args, cwd });
    const answer = listings.get(args[2] ?? "");
    if (answer === undefined) return { stdout: "", stderr: "", exitCode: 0 };
    return typeof answer === "string"
      ? { stdout: "", stderr: answer, exitCode: 1 }
      : { stdout: answer.join("\n"), stderr: "", exitCode: 0 };
  };
  const manager = new LspSessionManager({
    spawn: () => {
      const server = fakeServer({
        alive: () => alive,
        respond: (method, params) => {
          if (method === "initialize") return { serverInfo: { name: "tsgo", version: SERVER_VERSION } };
          if (method === "textDocument/documentSymbol") return outlines.get(pathOfDocumentId(params) ?? "") ?? [];
          if (method === "textDocument/references") {
            if (hanging) return new Promise<unknown>(() => {});
            if (crashing) {
              crashing = false;
              alive = false;
              throw new Error("connection got disposed");
            }
            if (beside !== undefined) return beside().then(() => references);
            return references;
          }
          if (method === "textDocument/hover") return hovered;
          if (method === "textDocument/definition") {
            if (defined instanceof Error) throw defined;
            return defined;
          }
          throw new Error(`unexpected request: ${method}`);
        },
      });
      servers.push(server);
      // The child that has just been spawned is alive; the flag describes the one that was replaced to get it.
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
    uses,
    over,
    outside,
    config,
    session,
    servers,
    get server() {
      const last = servers[servers.length - 1];
      if (last === undefined) throw new Error("this run started no tsgo process");
      return last;
    },
    listings: listingsAsked,
    outline: (path, symbols) => outlines.set(path, symbols),
    answer: (result) => {
      references = result;
    },
    hover: (result) => {
      hovered = result;
    },
    definition: (result) => {
      defined = result;
    },
    hangReferences: () => {
      hanging = true;
    },
    crashNextReferences: () => {
      crashing = true;
    },
    raceAnchorsBesideAnswer: () => {
      beside = () => session.openAnchors([uses]);
    },
    reloadBesideAnswer: () => {
      beside = async () => {
        session.dispose();
        await session.openAnchors([uses]);
      };
    },
    listing: (configPath, answer) => {
      listings.set(configPath, answer);
    },
    run: (overrides = {}) =>
      runTsFindReferences(
        manager,
        {
          sourceRoots: [ws],
          file: main,
          symbol: "Storage",
          includeDeclaration: false,
          timeBudgetMs: 60_000,
          ...overrides,
        },
        deps,
      ),
  };
}

/** The serialised structuredContent opens with the summary, the text block's lines before `limits:`. */
function expectSummaryFirst(result: Result): void {
  const structured = (result as { structuredContent?: { summary?: string } }).structuredContent;
  expect(JSON.stringify(structured).startsWith('{"summary":"')).toBe(true);
  expect(structured?.summary).toBe((result.content ?? [])[0]?.text?.split("\nlimits: ")[0]);
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

function filesOf(result: Result): FileGroup[] {
  return payload(result).files as FileGroup[];
}

function sitesOf(group: FileGroup | undefined): Site[] {
  return (group?.sites ?? []) as Site[];
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

/** The params of the most recent request for `method`, which is the one a second call in the test just sent. */
function lastRequestFor(server: FakeServer, method: string): Record<string, unknown> {
  return (server.requests.filter(([name]) => name === method).at(-1)?.[1] ?? {}) as Record<string, unknown>;
}

/** Every path a `didOpen` named, in order — which documents this server holds, and which it only borrowed. */
function openedPaths(server: FakeServer): (string | undefined)[] {
  return server.notifications.filter(([method]) => method === "textDocument/didOpen").map(([, p]) => pathOfDocumentId(p));
}

function closedPaths(server: FakeServer): (string | undefined)[] {
  return server.notifications.filter(([method]) => method === "textDocument/didClose").map(([, p]) => pathOfDocumentId(p));
}

/** The `scope` the temp workspace's one loaded project and an untouched disk produce. */
function cleanScope(h: Harness): Record<string, unknown> {
  return {
    workspaceRoot: h.ws,
    enclosingWorkspace: null,
    freshness: { kind: "unchanged" },
    server: { version: SERVER_VERSION },
    workspaceTypescript: null,
    projects: { count: 1, configs: [h.config], failed: [], subsumed: [] },
    uncoveredSources: NO_UNCOVERED("Storage"),
    limits: ["one-workspace"],
  };
}

/** The block of a workspace whose every source a project includes: the scan found nothing because there was nothing. */
function NO_UNCOVERED(name: string): Record<string, unknown> {
  return {
    count: 0,
    grepRequired: false,
    directories: [],
    directoriesTruncated: 0,
    mentioning: { name, count: 0, files: [], filesTruncated: 0, unchecked: 0 },
    namedFileUncovered: false,
  };
}

const SCOPE_SENTENCE = ` under workspace "${"{ws}"}": 1 project(s) found, 1 loaded, 0 failed, answered by tsgo 7.0.2, freshness: unchanged`;

describe("TsFindReferencesInput", () => {
  it("defaults includeDeclaration to no and the budget to 60000 ms, and needs a root to bound the call", () => {
    const parsed = TsFindReferencesInput.parse({ sourceRoots: ["C:/ws"], file: "src/main.ts", symbol: "Storage" });
    expect(parsed.includeDeclaration).toBe(false);
    expect(parsed.timeBudgetMs).toBe(60_000);
    expect(TsFindReferencesInput.safeParse({ sourceRoots: [], file: "a.ts", symbol: "S" }).success).toBe(false);
    expect(
      TsFindReferencesInput.safeParse({ sourceRoots: ["C:/ws"], file: "a.ts", symbol: "S", timeBudgetMs: 600_001 })
        .success,
    ).toBe(false);
  });
});

describe("runTsFindReferences", () => {
  afterEach(() => {
    for (const root of built.splice(0)) {
      dropProjectMap(root.ws);
      rmSync(root.tmp, { recursive: true, force: true });
    }
  });

  it("groups every use by file, names each row, and states the ground it was computed on", async () => {
    const h = harness();
    h.answer([location(h.outside, 70, 1), location(h.uses, 1, 2), location(h.main, 5, 10), location(h.main, 6, 4)]);

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(payload(out)).toEqual({
      summary: expect.any(String),
      resolved: { name: "Storage", kind: "interface", file: h.main, line: 1 },
      totalReferences: 4,
      files: [
        {
          file: h.uses,
          external: false,
          count: 1,
          sitesTruncated: 0,
          sites: [{ line: 2, column: 3, in: "caller" }],
        },
        {
          file: h.main,
          external: false,
          count: 2,
          sitesTruncated: 0,
          sites: [
            { line: 6, column: 11, in: "Driver.run" },
            { line: 7, column: 5, in: "Driver.run" },
          ],
        },
        {
          file: h.outside,
          external: true,
          count: 1,
          sitesTruncated: 0,
          sites: [{ line: 71, column: 2, in: null, reason: "outside the workspace root; not named" }],
        },
      ],
      filesTruncated: 0,
      scope: cleanScope(h),
    });
    expect(textOf(out)).toBe(
      `References to interface "Storage" (${h.main}:1)${SCOPE_SENTENCE.replaceAll("{ws}", h.ws)} - 4 reference(s) across 3 file(s).\n` +
        "limits: one-workspace\n" +
        `  ${h.uses} - 1 reference(s) in the workspace\n` +
        "    2:3 in caller\n" +
        `  ${h.main} - 2 reference(s) in the workspace\n` +
        "    6:11 in Driver.run\n" +
        "    7:5 in Driver.run\n" +
        `  ${h.outside} - 1 reference(s) outside the workspace\n` +
        "    71:2 in <unnamed> - outside the workspace root; not named",
    );
  });

  // The uncovered pointer is the summary's second line, not part of the head.
  it("puts the uncovered pointer on the second line, between the head and limits", async () => {
    const h = harness();
    const orphan = join(dirname(h.main), "orphan.test.ts");
    writeFileSync(orphan, "const s: Storage = make();\n");
    h.answer([location(h.main, 5, 10)]);

    const out = await h.run();
    const lines = textOf(out).split("\n");
    expect(lines[0]).not.toContain("not searched");
    expect(lines[1]).toBe(
      `INCOMPLETE: 1 file(s) no tsconfig project includes were not searched (packages/ui/src 1). 1 of them contain "Storage" and may hold more results - grep "Storage" in: ${orphan} (1 matching line). Do not report this answer as complete until you have.`,
    );
    expect(lines[2]).toMatch(/^limits: /);
    expectSummaryFirst(out);
    expect(payload(out).summary).toBe(lines.slice(0, 2).join("\n"));
    expect(payload(out).summary).not.toContain("limits:");
    expect(scopeOf(out).uncoveredSources).toMatchObject({ grepRequired: true });
  });

  it("publishes the Go payload keys and no `visibility` anywhere in `scope`", async () => {
    const h = harness();
    h.answer([location(h.main, 5, 10)]);

    const out = await h.run();
    expect(Object.keys(payload(out))).toEqual(["summary", "resolved", "totalReferences", "files", "filesTruncated", "scope"]);
    expect(Object.keys(payload(out).resolved as object)).toEqual(["name", "kind", "file", "line"]);
    expect(Object.keys(filesOf(out)[0] ?? {})).toEqual(["file", "external", "count", "sitesTruncated", "sites"]);
    expect(Object.keys(sitesOf(filesOf(out)[0])[0] ?? {})).toEqual(["line", "column", "in"]);
    const scope = scopeOf(out);
    expect(Object.keys(scope)).toEqual([
      "workspaceRoot",
      "enclosingWorkspace",
      "freshness",
      "server",
      "workspaceTypescript",
      "projects",
      "uncoveredSources",
      "limits",
    ]);
    expect(scope).not.toHaveProperty("visibility");
  });

  it("asks at the identifier the address resolved, about the path the document was opened under", async () => {
    const h = harness();
    h.answer([location(h.main, 1, 2)]);

    const out = await h.run({ file: join("packages", "ui", "src", "main.ts") });
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(requestFor(h.server, "textDocument/references")).toEqual({
      textDocument: { uri: uriOf(h.main) },
      position: { line: 0, character: 17 },
      context: { includeDeclaration: true },
    });
    expect(openedPaths(h.server)[0]).toBe(h.main);
  });

  // With `false` tsgo drops every location it flags as a definition in any group of the
  // search, import and re-export specifiers included, so the request never carries the caller's flag.
  it("asks tsgo for includeDeclaration true whatever the caller passed", async () => {
    const h = harness();
    await h.run();
    expect(requestFor(h.server, "textDocument/references")).toMatchObject({ context: { includeDeclaration: true } });

    await h.run({ includeDeclaration: true });
    expect(lastRequestFor(h.server, "textDocument/references")).toMatchObject({
      context: { includeDeclaration: true },
    });
    expect(countOf(h.server, "textDocument/references")).toBe(2);
  });

  describe("the subject's own declaration", () => {
    /**
     * Three declarations of `pick` in one file (two overload signatures and the implementation), a use of it, the
     * same symbol reported in another file, and a location on a declaration's line that carries no character.
     */
    function overloadAnswer(h: Harness): unknown[] {
      const declaration = at(OVER_TEXT, 0, "pick").character;
      return [
        location(h.over, 0, declaration),
        location(h.over, 1, declaration),
        location(h.over, 2, declaration),
        location(h.over, 3, at(OVER_TEXT, 3, "pick").character),
        location(h.uses, 1, 2),
        { uri: uriOf(h.over), range: { start: { line: 0 }, end: { line: 0 } } },
      ];
    }

    it("drops every merged entry of the subject in the file by default, and nothing else", async () => {
      const h = harness();
      h.answer(overloadAnswer(h));

      const out = await h.run({ file: h.over, symbol: "pick" });
      expect(out.isError, textOf(out)).toBeFalsy();
      // The use, the same symbol's row in another file, and the location that names no character.
      expect(payload(out).totalReferences).toBe(3);
      expect(filesOf(out).map((group) => [group.file, group.count])).toEqual([
        [h.over, 2],
        [h.uses, 1],
      ]);
      const [group] = filesOf(out);
      expect(sitesOf(group).map((site) => [site.line, site.column])).toEqual([
        [4, 20],
        [1, null],
      ]);
    });

    it("keeps every row, the declarations included, with includeDeclaration true", async () => {
      const h = harness();
      h.answer(overloadAnswer(h));

      const out = await h.run({ file: h.over, symbol: "pick", includeDeclaration: true });
      expect(payload(out).totalReferences).toBe(6);
      expect(filesOf(out).map((group) => group.count)).toEqual([5, 1]);
    });

    it("drops a dotted namespace's own declaration at the identifier it is asked at, not at the entry's start", async () => {
      const h = harness();
      const text = ["export namespace A.B {", "  export const f = 1;", "}", "export const n = A.B.f;"];
      const dotted = join(dirname(h.main), "dotted.ts");
      writeFileSync(dotted, `${text.join("\n")}\n`);
      h.outline(dotted, [
        {
          name: "A.B",
          kind: 3,
          range: { start: at(text, 0, "export"), end: at(text, 2, "}") },
          selectionRange: { start: at(text, 0, "A.B"), end: at(text, 0, " {") },
          children: [sym(text, "f", 14, [1, "export"], [1, ";"], [1, "f"])],
        },
        sym(text, "n", 14, [3, "export"], [3, ";"], [3, "n"]),
      ]);
      // tsgo reports the `B` of the declaration (where a request about \`A.B\` is asked) and the `B` of the use.
      h.answer([location(dotted, 0, at(text, 0, "B {").character), location(dotted, 3, at(text, 3, "B.f").character)]);

      const kept = await h.run({ file: dotted, symbol: "A.B" });
      expect(kept.isError, textOf(kept)).toBeFalsy();
      expect(payload(kept).totalReferences).toBe(1);
      expect(sitesOf(filesOf(kept)[0]).map((site) => site.line)).toEqual([4]);

      const all = await h.run({ file: dotted, symbol: "A.B", includeDeclaration: true });
      expect(payload(all).totalReferences).toBe(2);
    });

    describe("a subject addressed through an import binding", () => {
      const IMPORT_TEXT = ['import { pick } from "./over.js";', "export const x = pick;"];
      const PICK_AT = at(IMPORT_TEXT, 0, "pick");
      const DECLARATION_AT = at(OVER_TEXT, 0, "pick");

      /** An importing file whose `pick` binding is a top-level variable entry, as tsgo reports one. */
      function importing(h: Harness): string {
        const file = join(dirname(h.main), "imp.ts");
        writeFileSync(file, `${IMPORT_TEXT.join("\n")}\n`);
        h.outline(file, [
          sym(IMPORT_TEXT, "pick", 13, [0, "import"], [0, ";"], [0, "pick"]),
          sym(IMPORT_TEXT, "x", 14, [1, "export"], [1, ";"], [1, "x"]),
        ]);
        return file;
      }

      const hoverOf = (signature: string): unknown => ({
        contents: { kind: "markdown", value: `\`\`\`typescript\n${signature}\n\`\`\`` },
      });
      const aliasHover = hoverOf("(alias) function pick(a: string): string");

      /** The import specifier, its use, and the declaration in the other file. */
      function answerFor(h: Harness, file: string): unknown[] {
        return [
          location(file, 0, PICK_AT.character),
          location(file, 1, at(IMPORT_TEXT, 1, "pick").character),
          location(h.over, 0, DECLARATION_AT.character),
        ];
      }

      it("takes the identity from where definition lands: the import line stays a row, the declaration goes", async () => {
        const h = harness();
        const file = importing(h);
        h.answer(answerFor(h, file));
        h.hover(aliasHover);
        h.definition([location(h.over, 0, DECLARATION_AT.character)]);

        const out = await h.run({ file, symbol: "pick" });
        expect(out.isError, textOf(out)).toBeFalsy();
        expect(payload(out).totalReferences).toBe(2);
        expect(filesOf(out).map((group) => group.file)).toEqual([file]);
        expect(sitesOf(filesOf(out)[0]).map((site) => site.line)).toEqual([1, 2]);
        expect(requestFor(h.server, "textDocument/definition")).toEqual({
          textDocument: { uri: uriOf(file) },
          position: PICK_AT,
        });

        const all = await h.run({ file, symbol: "pick", includeDeclaration: true });
        expect(payload(all).totalReferences).toBe(3);
      });

      it("reads a LocationLink's targetSelectionRange", async () => {
        const h = harness();
        const file = importing(h);
        h.answer(answerFor(h, file));
        h.hover(aliasHover);
        h.definition([
          {
            targetUri: uriOf(h.over),
            targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 40 } },
            targetSelectionRange: {
              start: { line: 0, character: DECLARATION_AT.character },
              end: { line: 0, character: DECLARATION_AT.character + 4 },
            },
          },
        ]);

        const out = await h.run({ file, symbol: "pick" });
        expect(payload(out).totalReferences).toBe(2);
      });

      it.each([
        ["an empty answer", []],
        ["a null answer", null],
        ["a failed request", new Error("definition exploded")],
      ])("drops nothing when definition gives %s, rather than guessing a declaration", async (_label, definition) => {
        const h = harness();
        const file = importing(h);
        h.answer(answerFor(h, file));
        h.hover(aliasHover);
        h.definition(definition);

        const out = await h.run({ file, symbol: "pick" });
        expect(out.isError, textOf(out)).toBeFalsy();
        expect(payload(out).totalReferences).toBe(3);
      });

      it("drops nothing when the hover is unreadable", async () => {
        const h = harness();
        const file = importing(h);
        h.answer(answerFor(h, file));
        h.hover(null);

        const out = await h.run({ file, symbol: "pick" });
        expect(payload(out).totalReferences).toBe(3);
        expect(countOf(h.server, "textDocument/definition")).toBe(0);
      });

      it("keeps the identity for a variable whose hover is not an alias, and asks no definition", async () => {
        const h = harness();
        const file = importing(h);
        h.answer(answerFor(h, file));
        h.hover(hoverOf("const pick: number"));

        const out = await h.run({ file, symbol: "pick" });
        // The entry's own position is the identity: the import line goes, the declaration elsewhere stays.
        expect(payload(out).totalReferences).toBe(2);
        expect(countOf(h.server, "textDocument/definition")).toBe(0);
      });

      // The renamed import: tsgo scopes the references to the local name, so its raw answer holds
      // none of the places definition named.
      const scopedAnswer = (file: string): unknown[] => [
        location(file, 0, PICK_AT.character),
        location(file, 1, at(IMPORT_TEXT, 1, "pick").character),
      ];

      it.each([[false], [true]])(
        "says a renamed import lists the local name's uses only, and where the full set is (includeDeclaration %s)",
        async (includeDeclaration) => {
          const h = harness();
          const file = importing(h);
          h.answer(scopedAnswer(file));
          h.hover(aliasHover);
          h.definition([location(h.over, 0, DECLARATION_AT.character)]);

          const out = await h.run({ file, symbol: "pick", includeDeclaration });
          expect(out.isError, textOf(out)).toBeFalsy();
          expect(payload(out).totalReferences).toBe(2);
          expect((payload(out).resolved as Record<string, unknown>).renamedImportOf).toEqual({
            symbol: "pick",
            file: h.over,
            line: 1,
            module: false,
            reExport: false,
          });
          expect(textOf(out)).toContain(
            `; "pick" is a renamed import of pick (${h.over}:1) - this lists the local name's uses only; ask for pick in ${h.over} for every use.`,
          );
          // The sentence reaches the model through structuredContent.summary.
          expect(payload(out).summary).toContain(
            `; "pick" is a renamed import of pick (${h.over}:1) - this lists the local name's uses only; ask for pick in ${h.over} for every use`,
          );
        },
      );

      it("names the declaration by place when its file is outside the workspace and cannot be spelled", async () => {
        const h = harness();
        const file = importing(h);
        h.answer(scopedAnswer(file));
        h.hover(aliasHover);
        h.definition([location(h.outside, 4, 2)]);

        const out = await h.run({ file, symbol: "pick" });
        expect((payload(out).resolved as Record<string, unknown>).renamedImportOf).toEqual({
          symbol: null,
          file: h.outside,
          line: 5,
          module: false,
          reExport: false,
        });
        expect(textOf(out)).toContain(
          `is a renamed import of the declaration at ${h.outside}:5 - this lists the local name's uses only; ask for the declaration at ${h.outside}:5 for every use`,
        );
      });

      /** The statement for a definition landing at `at` in over.ts, with the alias hover given. */
      async function statedFor(at: { line: number; character: number }, hover: unknown = aliasHover) {
        const h = harness();
        const file = importing(h);
        h.answer(scopedAnswer(file));
        h.hover(hover);
        h.definition([location(h.over, at.line, at.character)]);
        const out = await h.run({ file, symbol: "pick" });
        return { h, out, stated: (payload(out).resolved as Record<string, unknown>).renamedImportOf };
      }

      it("spells the symbol only where an entry is declared exactly at the definition position", async () => {
        // Inside the second overload's range but not at its name: the row rule would name `pick`, nothing is declared here.
        const { h, out, stated } = await statedFor({ line: 1, character: 2 });
        expect(stated).toEqual({ symbol: null, file: h.over, line: 2, module: false, reExport: false });
        expect(textOf(out)).toContain(`is a renamed import of the declaration at ${h.over}:2 - `);
      });

      it("says a binding of a whole module names the module, not a declaration", async () => {
        // tsgo answers a namespace import at line 0, character 0, where no entry is declared.
        const { h, out, stated } = await statedFor({ line: 0, character: 0 });
        expect(stated).toEqual({ symbol: null, file: h.over, line: 1, module: true, reExport: false });
        expect(textOf(out)).toContain(
          `"pick" names the whole module ${h.over}, not one declaration - this lists the local name's uses only; for every use of a member, ask for that member in ${h.over}`,
        );
      });

      it("calls a binding a re-export when the alias hover shows an export clause", async () => {
        const { h, out, stated } = await statedFor(
          DECLARATION_AT,
          hoverOf('(alias) function pick(a: string): string\nexport { pick as other } from "./over.js"'),
        );
        expect(stated).toMatchObject({ symbol: "pick", reExport: true, module: false });
        expect(textOf(out)).toContain(`"pick" is a renamed re-export of pick (${h.over}:1) - `);
      });

      it("carries no renamedImportOf when the raw answer lists the declaration, or when definition said nothing", async () => {
        const plain = harness();
        const plainFile = importing(plain);
        plain.answer(answerFor(plain, plainFile));
        plain.hover(aliasHover);
        plain.definition([location(plain.over, 0, DECLARATION_AT.character)]);
        const listed = await plain.run({ file: plainFile, symbol: "pick" });
        expect(payload(listed).resolved).not.toHaveProperty("renamedImportOf");
        expect(textOf(listed)).not.toContain("renamed import");

        const empty = harness();
        const emptyFile = importing(empty);
        empty.answer(scopedAnswer(emptyFile));
        empty.hover(aliasHover);
        empty.definition([]);
        expect(payload(await empty.run({ file: emptyFile, symbol: "pick" })).resolved).not.toHaveProperty(
          "renamedImportOf",
        );
      });

      it("sends neither request for a subject that is not a top-level variable", async () => {
        const h = harness();
        h.answer([location(h.main, 5, 10)]);

        await h.run();
        expect(countOf(h.server, "textDocument/hover")).toBe(0);
        expect(countOf(h.server, "textDocument/definition")).toBe(0);
      });
    });

    it("counts the caps and the totals over the kept rows only", async () => {
      const h = harness();
      const declaration = at(OVER_TEXT, 0, "pick").character;
      h.answer([
        location(h.over, 0, declaration),
        ...Array.from({ length: REFERENCE_SITES_PER_FILE_LIMIT + 2 }, (_unused, index) => location(h.over, 3, index + 30)),
      ]);

      const out = await h.run({ file: h.over, symbol: "pick" });
      expect(payload(out).totalReferences).toBe(REFERENCE_SITES_PER_FILE_LIMIT + 2);
      expect(filesOf(out)[0]).toMatchObject({ count: REFERENCE_SITES_PER_FILE_LIMIT + 2, sitesTruncated: 2 });
    });
  });

  it("keeps a site the answer gave no character for, with its column left null", async () => {
    const h = harness();
    h.answer([{ uri: uriOf(h.main), range: { start: { line: 6 }, end: { line: 6 } } }]);

    const out = await h.run();
    expect(sitesOf(filesOf(out)[0])[0]).toEqual({ line: 7, column: null, in: "Driver.run" });
  });

  it("counts every use tsgo reported when the per-file site cap narrows the listing", async () => {
    const h = harness();
    const many = REFERENCE_SITES_PER_FILE_LIMIT + 5;
    h.answer(Array.from({ length: many }, (_unused, index) => location(h.uses, 1, index + 1)));

    const out = await h.run();
    const [group] = filesOf(out);
    expect(payload(out).totalReferences).toBe(many);
    expect(payload(out).filesTruncated).toBe(0);
    expect(group).toMatchObject({ file: h.uses, external: false, count: many, sitesTruncated: 5 });
    expect(sitesOf(group)).toHaveLength(REFERENCE_SITES_PER_FILE_LIMIT);
    expect(limitsOf(out)).toContain("listing-capped");
    expect(textOf(out)).toContain(`5 site(s) not listed`);
    // Naming ran after the caps: twenty-five kept rows in one file cost one outline read, not twenty-five.
    expect(countOf(h.server, "textDocument/documentSymbol")).toBe(2);
    expect(h.session.getOpenedFiles()).toEqual([h.main]);
    expect(closedPaths(h.server)).toEqual([h.uses]);
  });

  it("counts every use tsgo reported when the file cap drops whole groups", async () => {
    const h = harness();
    const externalFirst = Array.from({ length: REFERENCE_FILES_LIMIT + 2 }, (_unused, index) =>
      location(join(h.tmp, "outside", `f${index}.ts`), 3, 1),
    );
    h.answer([...externalFirst, location(h.main, 5, 10)]);

    const out = await h.run();
    const files = filesOf(out);
    expect(payload(out).totalReferences).toBe(externalFirst.length + 1);
    expect(files).toHaveLength(REFERENCE_FILES_LIMIT);
    expect(payload(out).filesTruncated).toBe(3);
    // The in-workspace group was reported last and survived; the dropped ones are all external.
    expect(files[0]).toMatchObject({
      file: h.main,
      external: false,
      count: 1,
      sites: [{ line: 6, column: 11, in: "Driver.run" }],
    });
    expect(files.slice(1).every((group) => group.external)).toBe(true);
    const listed = files.reduce((total, group) => total + (group.count as number), 0);
    expect(payload(out).totalReferences).toBe(listed + (payload(out).filesTruncated as number));
    expect(limitsOf(out)).toContain("listing-capped");
    // A dropped group was never opened, and neither was a kept external one: one outline read, the named file's.
    expect(countOf(h.server, "textDocument/documentSymbol")).toBe(1);
    expect(openedPaths(h.server)).toEqual([h.main]);
    expect(h.session.getOpenedFiles()).toEqual([h.main]);
  });

  it("reports an external use without ever opening or reading the file it is in", async () => {
    const h = harness();
    h.answer([location(h.outside, 70, 1)]);

    const out = await h.run();
    expect(filesOf(out)).toEqual([
      {
        file: h.outside,
        external: true,
        count: 1,
        sitesTruncated: 0,
        sites: [{ line: 71, column: 2, in: null, reason: "outside the workspace root; not named" }],
      },
    ]);
    expect(openedPaths(h.server)).toEqual([h.main]);
    expect(h.session.getOpenedFiles()).toEqual([h.main]);
  });

  it.each([
    ["a file under any node_modules", "dependency", true],
    ["a file in the workspace", "own", false],
  ])("treats %s as %s ground for the boundary it states", async (_label: string, _kind: string, expectExternal: boolean) => {
    const h = harness();
    const inside = join(h.ws, "node_modules", "dep", "index.ts");
    const target = expectExternal ? inside : h.main;
    h.answer([location(target, 5, 10)]);

    const out = await h.run();
    expect(filesOf(out)[0]).toMatchObject({ file: target, external: expectExternal });
  });

  it.each([["an empty list", []], ["a null answer", null]])(
    "answers a symbol nothing uses with %s as a scoped empty, which is what proves the anchors were opened",
    async (_label: string, result: unknown) => {
      const h = harness();
      h.answer(result);

      const out = await h.run();
      expect(out.isError).toBeFalsy();
      expect(payload(out)).toMatchObject({ totalReferences: 0, files: [], filesTruncated: 0 });
      expect(limitsOf(out)).toEqual(["one-workspace"]);
      expect(textOf(out)).toBe(
        `References to interface "Storage" (${h.main}:1)${SCOPE_SENTENCE.replaceAll("{ws}", h.ws)} - 0 reference(s) across 0 file(s).\nlimits: one-workspace`,
      );
      expect(textOf(out)).not.toMatch(/did not answer/);
    },
  );

  it("names a row for a declaration whose key is shared with the prefix that selects it", async () => {
    const h = harness();
    h.answer([location(h.main, 10, 13), location(h.main, 11, 17)]);

    const out = await h.run();
    expect(sitesOf(filesOf(out)[0])).toEqual([
      { line: 11, column: 14, in: "value Widget" },
      { line: 12, column: 18, in: "type Widget" },
    ]);
  });

  it("keeps a use no declaration encloses, naming the reason rather than losing the row", async () => {
    const h = harness();
    h.answer([location(h.main, 99, 4)]);

    const out = await h.run();
    expect(sitesOf(filesOf(out)[0])[0]).toEqual({
      line: 100,
      column: 5,
      in: null,
      reason: "no declaration in this file encloses the reported location",
    });
  });

  it("refuses a name the declaring file does not carry, stating the addressing rule and asking nothing type-aware", async () => {
    const h = harness();

    const out = await h.run({ symbol: "Absent" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_references failed: "${h.main}" declares nothing named "Absent". \`symbol\` is a top-level name in the file, or a dotted path descending through a class, interface, enum or namespace (\`ExecDriver.run\`, \`Ns.Inner.x\`); an import binding matches like a variable and the checker follows the alias. A local, or an object literal's member, is not addressable.`,
    );
    expect(h.server.methods).toEqual(["initialize", "textDocument/documentSymbol"]);
  });

  it("refuses a key two unmerged declarations share, listing each with the spelling that selects it", async () => {
    const h = harness();

    const out = await h.run({ symbol: "Widget" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_references failed: "Widget" names 2 declarations in "${h.main}" that TypeScript does not merge into one, so this server will not pick between them. Select one with a prefix - \`static\`, \`instance\`, \`value\`, \`type\` or \`namespace\`:\n` +
        `  - value Widget (constant) at ${h.main}:11\n` +
        `  - type Widget (interface) at ${h.main}:12`,
    );
    expect(h.server.methods).not.toContain("textDocument/references");
  });

  it("refuses a path that descends through a function, naming what it tried to descend through", async () => {
    const h = harness();

    const out = await h.run({ symbol: "build.inner" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_references failed: "build.inner" cannot be addressed in "${h.main}": "build" is not a class, interface, enum or namespace (it is a function), and only those four hold addressable members. Locals and object-literal members are not addressable.`,
    );
  });

  it("fails rather than reporting a shorter answer for a flat SymbolInformation reply", async () => {
    const h = harness();
    const flat = flatSymbol(h.main, "Storage", 5);
    h.answer([flat]);

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      "ts_find_references failed: tsgo answered the query for \"Storage\" with entry 1 this server cannot read, " +
        "so the answer cannot be reported without possibly dropping a match. It expects `Location` or " +
        "`LocationLink` entries: " +
        JSON.stringify(flat),
    );
  });

  it("fails the same way for a reply that is not a list at all", async () => {
    const h = harness();
    h.answer({ references: [] });

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      "ts_find_references failed: tsgo answered the query for \"Storage\" with an object this server cannot read, " +
        "so the answer cannot be reported without possibly dropping a match. It expects `Location` or " +
        "`LocationLink` entries: {\"references\":[]}",
    );
  });

  it("refuses an answer from a tsgo that was replaced while the query was in flight", async () => {
    const h = harness();
    h.answer([location(h.main, 5, 10)]);
    h.crashNextReferences();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_references failed: tsgo restarted during the query about "Storage" in the workspace "${h.ws}", so the documents the answer depends on were opened on a process that is not the one that answered. Call again: the restarted server opens its anchors and proves them before answering.`,
    );
    // The retried query really was answered; what is refused is the proof, not the reply.
    expect(h.servers).toHaveLength(2);
    expect(h.servers.flatMap((server) => server.methods).filter((method) => method === "textDocument/references"))
      .toHaveLength(2);
  });

  // The other half: an unprovable closure means no
  // snapshot, so every call reloads — but the map is still built from the paths the walk did see, and the
  // answer still names the projects and anchors them. Refusing the map here threw the whole workspace away
  // for one spec this server could not follow, which is a narrowing nothing asks for.
  it("builds the project map from the paths an unprovable closure did see, and anchors from it", async () => {
    const h = harness();
    writeFileSync(h.config, JSON.stringify({ extends: "./gone.json" }));
    h.answer([location(h.main, 1, 2)]);

    // The first call finds no live process to reload; the reload is what every call after it reports.
    await h.run({ file: h.uses, symbol: "caller" });
    const out = await h.run({ file: h.uses, symbol: "caller" });
    expect(out.isError, textOf(out)).toBeFalsy();
    const scope = scopeOf(out);

    expect(scope.freshness).toMatchObject({ kind: "reloaded", reason: expect.stringContaining("gone.json") });
    expect(scope).not.toHaveProperty("projectsUnavailable");
    expect(scope.projects).toEqual({ count: 1, configs: [h.config], failed: [], subsumed: [] });
    expect(scope.uncoveredSources).toEqual(NO_UNCOVERED("caller"));
    expect(scope.limits).toEqual(["one-workspace"]);
    // The anchor is the project's own first owned file — not the file the call named — and it was opened on
    // the process that answered, which is the whole of the readiness proof.
    expect(openedPaths(h.server)).toEqual([h.uses, h.main]);
  });

  // The proof is about the process that answers, not about the boolean any caller may have set on it. A retry
  // after a replacement is answered by a process this call never anchored; a second caller's `openAnchors`
  // marks THAT process loaded while the first call's answer is still in flight, and a shared flag would let
  // that partial answer through as proved.
  it("refuses an answer taken from a process another call marked loaded while it was in flight", async () => {
    const h = harness();
    h.answer([location(h.main, 5, 10)]);
    h.crashNextReferences();
    h.raceAnchorsBesideAnswer();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("tsgo restarted during the query");
    // The other call's proof really was made — on the replacement, for its own documents. That is the fact the
    // boolean records, and it is not a fact about this answer.
    expect(h.session.isWorkspaceLoaded()).toBe(true);
    expect(h.servers).toHaveLength(2);
  });

  // Dispose-then-respawn is not a replacement of a live child, so the process generation does not move; the
  // process this call anchored on is what identifies the answerer.
  it("refuses an answer from a process that another call reloaded and proved while this one was in flight", async () => {
    const h = harness();
    h.answer([location(h.main, 5, 10)]);
    h.reloadBesideAnswer();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("tsgo restarted during the query");
    expect(h.session.isWorkspaceLoaded()).toBe(true);
    expect(h.servers).toHaveLength(2);
  });

  it("fails at the budget when tsgo never answers the query, and returns no listing to be read as empty", async () => {
    const h = harness();
    h.hangReferences();

    const out = await h.run({ timeBudgetMs: 100 });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(
      `ts_find_references failed: tsgo did not answer the query for "Storage" within this call's 100 ms budget. The workspace at "${h.ws}" may still be loading its projects; raise timeBudgetMs or call again, and do not read this as an empty answer.`,
    );
    expect(out).not.toHaveProperty("structuredContent");
    expect(countOf(h.server, "textDocument/references")).toBe(1);
  });

  it("asks tsgo only the methods its config allows, in the order the proof needs", async () => {
    const h = harness();
    h.answer([location(h.uses, 1, 2), location(h.main, 5, 10)]);

    await h.run();
    expect(h.server.methods).toEqual([
      "initialize",
      "textDocument/documentSymbol",
      "textDocument/references",
      "textDocument/documentSymbol",
    ]);
    expect(h.server.requests[0]?.[1]).toMatchObject({ rootUri: uriOf(h.ws) });
  });
});
