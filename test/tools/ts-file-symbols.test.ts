import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LspDocumentSymbol, OutlineSymbol } from "../../src/clangd/outline.js";
import { LanguageServerUnavailableError, TSGO_IDENTITY } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { TsFileSymbolsInput, runTsFileSymbols } from "../../src/tools/ts-file-symbols.js";
import type { TsTargetDeps } from "../../src/tools/ts-shared.js";
import { resolveTsgoBinary, type TsgoBinary, type TsgoBinaryDeps, type TsgoBinaryResult } from "../../src/tsgo/binary.js";
import { fakeServer, type FakeServer } from "../helpers/fake-lsp.js";

/** The executable the suite pretends this host has, so no call runs `npm` or looks for a real install. */
const BINARY: TsgoBinary = { executable: "C:/fake/lib/tsc.exe", version: "7.0.2", source: "global" };

/** Every call under test resolves this one binary. */
const LOCATED: TsTargetDeps = { resolveBinary: async () => ({ binary: BINARY }) };

/**
 * tsgo's `documentSymbol` for one module: an import binding at top level (kind 13, like a `const`), a type alias
 * it reports with kind 5 (Class), an interface whose member it nests, a function holding a local, and a `const`
 * holding an object literal's property. Lines are 0-based, as the server counts them.
 */
const TSGO_ANSWER: LspDocumentSymbol[] = [
  {
    name: "join",
    kind: 13,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 30 } },
    selectionRange: { start: { line: 0, character: 9 } },
  },
  { name: "RunFn", kind: 5, range: { start: { line: 2, character: 5 }, end: { line: 2, character: 31 } } },
  {
    name: "Storage",
    kind: 11,
    range: { start: { line: 4 }, end: { line: 8 } },
    selectionRange: { start: { line: 4, character: 17 } },
    children: [{ name: "Get", kind: 6, range: { start: { line: 5 }, end: { line: 5 } } }],
  },
  {
    name: "run",
    kind: 12,
    range: { start: { line: 10 }, end: { line: 14 } },
    selectionRange: { start: { line: 10, character: 16 } },
    children: [{ name: "attached", kind: 13, range: { start: { line: 11 }, end: { line: 11 } } }],
  },
  {
    name: "table",
    kind: 13,
    range: { start: { line: 16 }, end: { line: 18 } },
    selectionRange: { start: { line: 16, character: 6 } },
    children: [{ name: "save", kind: 7, range: { start: { line: 17 }, end: { line: 17 } } }],
  },
];

/** What tsgo's hover answers at the name of each top-level `variable` entry above, keyed by the 0-based line. */
const HOVER_BY_LINE: Record<number, string> = {
  0: "(alias) function join(...paths: string[]): string\nimport join",
  16: "const table: { save: () => void; }",
};

function hoverAnswer(params: unknown): unknown {
  const line = (params as { position: { line: number } }).position.line;
  const text = HOVER_BY_LINE[line];
  return text === undefined ? null : { contents: { kind: "markdown", value: `\`\`\`typescript\n${text}\n\`\`\`` } };
}

/** The same outline at `depth` 1: 1-based lines and kind names, the binding gone and only containers keep children. */
const OUTLINE_DEPTH_1: OutlineSymbol[] = [
  { name: "RunFn", kind: "class", range: { startLine: 3, endLine: 3 } },
  {
    name: "Storage",
    kind: "interface",
    range: { startLine: 5, endLine: 9 },
    children: [{ name: "Get", kind: "method", range: { startLine: 6, endLine: 6 } }],
  },
  { name: "run", kind: "function", range: { startLine: 11, endLine: 15 } },
  { name: "table", kind: "variable", range: { startLine: 17, endLine: 19 } },
];

/** `depth` 0: the same top-level entries, with the nested member gone. */
const OUTLINE_DEPTH_0: OutlineSymbol[] = OUTLINE_DEPTH_1.map(({ children: _children, ...rest }) => rest);

const BINDINGS: readonly { name: string; line: number }[] = [{ name: "join", line: 1 }];

type Input = { sourceRoots: string[]; file: string; depth: number; timeBudgetMs: number };

function input(partial: Pick<Input, "sourceRoots" | "file"> & Partial<Input>): Input {
  return { depth: 1, timeBudgetMs: 60_000, ...partial };
}

function payloadOf(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

function symbolsOf(result: unknown): OutlineSymbol[] {
  return (payloadOf(result).symbols ?? []) as OutlineSymbol[];
}

function textOf(result: unknown): string {
  return ((result as { content?: readonly { text?: string }[] }).content ?? [])[0]?.text ?? "";
}

/** A session manager whose tsgo answers `documentSymbol` with `symbols`, counting each child started. */
function sessionsAnswering(symbols: () => LspDocumentSymbol[]): { manager: LspSessionManager; servers: FakeServer[] } {
  const servers: FakeServer[] = [];
  const manager = new LspSessionManager({
    spawn: () => {
      const server = fakeServer({
        respond: (method, params) => {
          if (method === "textDocument/documentSymbol") return symbols();
          return method === "textDocument/hover" ? hoverAnswer(params) : {};
        },
      });
      servers.push(server);
      return server.process;
    },
    sleep: async () => {},
  });
  return { manager, servers };
}

describe("ts_file_symbols input schema", () => {
  it("requires at least one sourceRoots entry, because there is no projectRoot to fall back to", () => {
    expect(TsFileSymbolsInput.safeParse({ sourceRoots: [], file: "a.ts" }).success).toBe(false);
    expect(TsFileSymbolsInput.safeParse({ file: "a.ts" }).success).toBe(false);
    expect(TsFileSymbolsInput.safeParse({ sourceRoots: ["/repo"], file: "a.ts" }).success).toBe(true);
  });

  it("defaults depth to 1 and timeBudgetMs to 60000, and refuses a budget past the ceiling", () => {
    const parsed = TsFileSymbolsInput.parse({ sourceRoots: ["/repo"], file: "a.ts" });
    expect(parsed.depth).toBe(1);
    expect(parsed.timeBudgetMs).toBe(60_000);
    expect(TsFileSymbolsInput.safeParse({ sourceRoots: ["/repo"], file: "a.ts", depth: 2 }).success).toBe(false);
    expect(
      TsFileSymbolsInput.safeParse({ sourceRoots: ["/repo"], file: "a.ts", timeBudgetMs: 600_001 }).success,
    ).toBe(false);
  });
});

describe("runTsFileSymbols", () => {
  let tmp: string;
  /** The npm workspace: its root `package.json` declares `workspaces`. */
  let ws: string;
  /** The member package the file lives in. */
  let pkg: string;
  let src: string;
  let main: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-tsfs-"));
    ws = join(tmp, "ws");
    pkg = join(ws, "packages", "ui");
    src = join(pkg, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@mono/ui" }));
    main = join(src, "main.ts");
    writeFileSync(main, "export interface Storage { Get(): void }\n");
    for (const name of ["a.ts", "a.tsx", "a.js", "a.jsx"]) writeFileSync(join(src, name), "export const x = 1;\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("maps tsgo's outline through toOutline and answers with `symbols` and `bindings`, with no scope", async () => {
    const { manager } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), LOCATED);
    expect(out.isError).toBeFalsy();
    expect(payloadOf(out)).toEqual({ symbols: OUTLINE_DEPTH_1, bindings: BINDINGS });
    // No `scope` key at all, and no `bindingsUnverified` when every hover answered.
    expect(Object.keys(payloadOf(out))).toEqual(["symbols", "bindings"]);
  });

  it("counts depth plainly: 0 returns top-level declarations without their children", async () => {
    const { manager } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main, depth: 0 }), LOCATED);
    expect(payloadOf(out)).toEqual({ symbols: OUTLINE_DEPTH_0, bindings: BINDINGS });
  });

  it("publishes a type alias with the kind tsgo reported it, kind 5 becoming \"class\" and nothing re-derived", async () => {
    const { manager } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), LOCATED);
    const runFn = symbolsOf(out).find((symbol) => symbol.name === "RunFn");
    expect(runFn).toEqual({ name: "RunFn", kind: "class", range: { startLine: 3, endLine: 3 } });
  });

  it("moves a binding whose hover opens with (alias) out of `symbols` and lists it, with its line, in `bindings`", async () => {
    const { manager } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), LOCATED);
    expect(symbolsOf(out).map((symbol) => symbol.name)).not.toContain("join");
    expect(payloadOf(out).bindings).toEqual(BINDINGS);
  });

  it("lists no child under a function or a const, and still lists the members of an interface", async () => {
    const { manager } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), LOCATED);
    const byName = new Map(symbolsOf(out).map((symbol) => [symbol.name, symbol]));
    expect(byName.get("run")).not.toHaveProperty("children");
    expect(byName.get("table")).not.toHaveProperty("children");
    expect(byName.get("Storage")?.children?.map((child) => child.name)).toEqual(["Get"]);
  });

  it("asks at most 32 hovers at once, however many top-level variables the file holds", async () => {
    const many: LspDocumentSymbol[] = Array.from({ length: 100 }, (_unused, index) => ({
      name: `v${index}`,
      kind: 13,
      range: { start: { line: index, character: 0 }, end: { line: index, character: 10 } },
      selectionRange: { start: { line: index, character: 6 } },
    }));
    let inFlight = 0;
    let peak = 0;
    const manager = new LspSessionManager({
      spawn: () =>
        fakeServer({
          respond: async (method) => {
            if (method === "textDocument/documentSymbol") return many;
            if (method !== "textDocument/hover") return {};
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((done) => setTimeout(done, 2));
            inFlight -= 1;
            return { contents: { kind: "markdown", value: "```typescript\nconst v: 1\n```" } };
          },
        }).process,
      sleep: async () => {},
    });
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), LOCATED);
    expect(out.isError).toBeFalsy();
    expect(symbolsOf(out)).toHaveLength(100);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(32);
  });

  it("keeps an entry whose hover failed in `symbols` and says how many could not be checked, with the first reason", async () => {
    const servers: FakeServer[] = [];
    const manager = new LspSessionManager({
      spawn: () => {
        const server = fakeServer({
          respond: (method) => {
            if (method === "textDocument/documentSymbol") return TSGO_ANSWER;
            if (method === "textDocument/hover") throw new Error("hover exploded");
            return {};
          },
        });
        servers.push(server);
        return server.process;
      },
      sleep: async () => {},
    });
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), LOCATED);
    expect(out.isError).toBeFalsy();
    // `join` and `table` are both top-level variables nobody could read: neither is dropped, neither is a binding.
    expect(symbolsOf(out).map((symbol) => symbol.name)).toEqual(["join", "RunFn", "Storage", "run", "table"]);
    expect(payloadOf(out).bindings).toEqual([]);
    expect(payloadOf(out).bindingsUnverified).toMatch(
      /^2 top-level variable entries could not be checked: tsgo refused the hover: .*hover exploded/,
    );
  });

  it("roots tsgo at the npm workspace holding the file, not the member package, and opens it as typescript", async () => {
    const { manager, servers } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), LOCATED);
    expect(out.isError).toBeFalsy();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.requests[0]?.[1]).toMatchObject({
      rootUri: pathToFileURL(resolve(ws)).toString(),
    });
    expect(servers[0]?.requests[0]?.[1]).not.toMatchObject({ rootUri: pathToFileURL(resolve(pkg)).toString() });
    const didOpen = servers[0]?.notifications.find(([method]) => method === "textDocument/didOpen");
    expect(didOpen?.[1]).toMatchObject({ textDocument: { languageId: "typescript" } });
  });

  it.each([
    ["a.ts", "typescript"],
    ["a.tsx", "typescriptreact"],
    ["a.js", "javascript"],
    ["a.jsx", "javascriptreact"],
  ])("opens %s under languageId %s, because the extension decides how tsgo parses it", async (name, languageId) => {
    const { manager, servers } = sessionsAnswering(() => []);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: join(src, name) }), LOCATED);
    expect(out.isError).toBeFalsy();
    const didOpen = servers[0]?.notifications.find(([method]) => method === "textDocument/didOpen");
    expect(didOpen?.[1]).toMatchObject({ textDocument: { languageId } });
  });

  it("reports a confident empty for an empty outline, without asking tsgo twice", async () => {
    const { manager, servers } = sessionsAnswering(() => []);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), LOCATED);
    expect(out.isError).toBeFalsy();
    expect(payloadOf(out)).toEqual({ symbols: [], bindings: [] });
    expect(servers[0]?.methods.filter((method) => method === "textDocument/documentSymbol")).toHaveLength(1);
  });

  it.each(["notes.md", "a.py"])(
    "refuses %s before any child starts, naming the extensions the tools accept",
    async (name) => {
      const file = join(src, name);
      writeFileSync(file, "text\n");
      const { manager, servers } = sessionsAnswering(() => TSGO_ANSWER);
      const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file }), LOCATED);
      expect(out.isError).toBe(true);
      expect(textOf(out)).toBe(
        `ts_file_symbols failed: "${resolve(file)}" is not a TypeScript or JavaScript source. These tools accept ` +
          ".ts, .mts, .cts, .tsx, .js, .mjs, .cjs, .jsx - the file's extension also decides how tsgo parses it.",
      );
      expect(servers).toHaveLength(0);
    },
  );

  it("fails with the package sentence when no package.json exists above the file, without starting a child", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    const file = join(plain, "a.ts");
    writeFileSync(file, "export const x = 1;\n");
    const { manager, servers } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [plain], file }), LOCATED);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("is not inside an npm package - no package.json exists in ");
    expect(textOf(out)).toContain(`"${resolve(plain)}"`);
    expect(textOf(out)).toContain("tsgo answers for the workspace holding a file; name one inside a package.");
    expect(servers).toHaveLength(0);
  });

  it("fails when the package sits outside every declared root, naming the package, the file and the roots", async () => {
    // The declared root is a subdirectory of the package, so the file is inside the boundary while the
    // package.json that governs it is not.
    const outsidePkg = join(tmp, "outside");
    const outsideSrc = join(outsidePkg, "src");
    mkdirSync(outsideSrc, { recursive: true });
    writeFileSync(join(outsidePkg, "package.json"), JSON.stringify({ name: "outside" }));
    const file = join(outsideSrc, "a.ts");
    writeFileSync(file, "export const x = 1;\n");
    const { manager, servers } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [outsideSrc], file }), LOCATED);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(
      `belongs to the npm package "${resolve(outsidePkg)}" (its nearest package.json), which is `,
    );
    expect(textOf(out)).toContain(`outside every declared sourceRoots entry: "${resolve(outsideSrc)}"`);
    expect(textOf(out)).toContain(`"${resolve(file)}"`);
    expect(textOf(out)).toContain(
      "Add that package's directory to sourceRoots - this server will not root tsgo outside the boundary you declared.",
    );
    expect(servers).toHaveLength(0);
  });

  it("fails with the locator's own miss sentence, naming the override and the install, and starts no child", async () => {
    // The search is driven entirely by injected deps: `npm` answers with a directory that holds no readable
    // `typescript/package.json`, which is a miss the real producer writes.
    const missDeps: Partial<TsgoBinaryDeps> = {
      platform: "win32",
      arch: "x64",
      override: "",
      exec: async () => ({ stdout: "C:/fake/npm-global\n", stderr: "", exitCode: 0 }),
      readJson: () => undefined,
      exists: (path) => path === "C:/fake/npm-global",
    };
    const miss: TsgoBinaryResult = await resolveTsgoBinary(missDeps);
    if ("binary" in miss) throw new Error(`the injected search must miss, found ${miss.binary.executable}`);
    const failure = new LanguageServerUnavailableError(
      { config: TSGO_IDENTITY, attempted: miss.attempted, fromOverride: false },
      { message: miss.unavailable },
    );
    const { manager, servers } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), {
      resolveBinary: async () => miss,
    });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(`ts_file_symbols failed: ${failure.message}`);
    expect(textOf(out)).toContain("Cannot start tsgo:");
    expect(textOf(out)).toContain("MCP_CODE_NAV_TSGO");
    expect(textOf(out)).toContain("npm install -g typescript@7");
    expect(failure.name).toBe("LanguageServerUnavailableError");
    expect(servers).toHaveLength(0);
  });

  it("fails within the caller's budget when tsgo has not answered, and refuses to call that an empty file", async () => {
    const manager = new LspSessionManager({
      spawn: () =>
        fakeServer({
          respond: (method) =>
            method === "textDocument/documentSymbol" ? new Promise<LspDocumentSymbol[]>(() => {}) : {},
        }).process,
      sleep: async () => {},
    });
    const out = await runTsFileSymbols(
      manager,
      input({ sourceRoots: [ws], file: main, timeBudgetMs: 30 }),
      LOCATED,
    );
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/did not answer[\s\S]*30 ms budget/);
    expect(textOf(out)).toMatch(/do not read this as an empty file/);
    expect(textOf(out)).toContain(`The workspace at "${resolve(ws)}" may still be loading its projects`);
  });

  it("rejects a file outside every declared root before any disk access", async () => {
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const file = join(elsewhere, "a.ts");
    writeFileSync(file, "export const x = 1;\n");
    const { manager, servers } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file }), LOCATED);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/escapes every declared root/);
    expect(servers).toHaveLength(0);
  });

  it("resolves a relative file against the declared roots", async () => {
    const { manager } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(
      manager,
      input({ sourceRoots: [ws], file: join("packages", "ui", "src", "main.ts") }),
      LOCATED,
    );
    expect(out.isError).toBeFalsy();
    expect(payloadOf(out)).toEqual({ symbols: OUTLINE_DEPTH_1, bindings: BINDINGS });
  });

  it("bounds the search for the executable by this call's budget and asks no server when it expires", async () => {
    const { manager, servers } = sessionsAnswering(() => TSGO_ANSWER);
    // The first TS call of a process runs `npm root -g`, which costs hundreds of milliseconds and can hang;
    // the caller's ceiling is the only thing that may bound it, and an expired ceiling must ask nothing.
    const slow = {
      resolveBinary: async (): Promise<TsgoBinaryResult> => {
        // Never settles, so there is no second timer to race the budget's deadline on a loaded host.
        return new Promise<TsgoBinaryResult>(() => {});
      },
    };

    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main, timeBudgetMs: 1 }), slow);

    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("1 ms budget");
    expect(textOf(out)).toContain("npm root -g");
    expect(textOf(out)).toContain(TSGO_IDENTITY.commandEnvOverride);
    expect(servers).toHaveLength(0);
  });

  it("answers inside a 1 ms budget when the executable is already known, because the bound is a ceiling", async () => {
    const { manager } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main, timeBudgetMs: 1 }), LOCATED);

    expect(out.isError).toBeFalsy();
    expect(payloadOf(out)).toEqual({ symbols: OUTLINE_DEPTH_1, bindings: BINDINGS });
  });

  it("pays a re-asked search out of the next call's own budget, after a search that missed", async () => {
    const { manager, servers } = sessionsAnswering(() => TSGO_ANSWER);
    let asking = 0;
    const firstMissThenSlow = {
      resolveBinary: async (): Promise<TsgoBinaryResult> => {
        asking += 1;
        if (asking === 1) return { unavailable: "no native package here", attempted: BINARY.executable };
        // Never settles: nothing here needs the search to finish, and a second real timer would race the budget's.
        return new Promise<TsgoBinaryResult>(() => {});
      },
    };

    const missed = await runTsFileSymbols(manager, input({ sourceRoots: [ws], file: main }), firstMissThenSlow);

    // The miss itself is the unavailability sentence, unchanged (and the cache's re-ask rule is pinned in
    // test/tools/ts-workspace-text.test.ts); what the retry must not do is wait out the whole search again.
    expect(textOf(missed)).toContain("no native package here");
    expect(asking).toBe(1);

    const retried = await runTsFileSymbols(
      manager,
      input({ sourceRoots: [ws], file: main, timeBudgetMs: 1 }),
      firstMissThenSlow,
    );

    expect(retried.isError).toBe(true);
    expect(textOf(retried)).toContain("1 ms budget");
    expect(asking).toBe(2);
    expect(servers).toHaveLength(0);
  });

  it("keeps a missing file the loud failure it is", async () => {
    const { manager } = sessionsAnswering(() => TSGO_ANSWER);
    const out = await runTsFileSymbols(
      manager,
      input({ sourceRoots: [ws], file: join(src, "gone.ts") }),
      LOCATED,
    );
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/ENOENT/);
    expect(textOf(out)).toContain("gone.ts");
  });
});
