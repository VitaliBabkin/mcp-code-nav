import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declarationKey } from "../../src/tools/go-navigation-shared.js";
import { runGoFindSymbol, WORKSPACE_SYMBOL_CAP_WATERMARK } from "../../src/tools/go-find-symbol.js";
import { notStarted, fakeGo, WINDOWS_AMD64 } from "../helpers/fake-go.js";
import { pathOfDocumentId, uriOf, type FakeServer } from "../helpers/fake-lsp.js";
import {
  buildGoToolHarness,
  cleanupGoToolHarnesses,
  closedPaths,
  countOf,
  limitsOf,
  missingGoplsSpawn,
  openedPaths,
  payload,
  requestFor,
  runUntilBudgetExpires,
  scopeOf,
  symbol,
  textOf,
  type GoToolHarness,
  type GoToolHarnessOptions,
} from "../helpers/go-tool-harness.js";

type Result = Awaited<ReturnType<typeof runGoFindSymbol>>;
type Input = { sourceRoots: string[]; symbol: string; anchor: string; timeBudgetMs: number };
type Row = Record<string, unknown>;

const SYMBOL_METHOD = "workspace/symbol";
const HOVER_METHOD = "textDocument/hover";
const CAP_SENTENCE =
  "gopls's symbol search returns a bounded list and this one came back at the size this server treats as that bound";

interface Harness extends GoToolHarness {
  /** The list gopls's symbol index answers with. */
  index(entries: unknown[]): void;
  /** A list of exactly `count` entries, of which `entries` are the ones the test cares about. */
  indexOfSize(count: number, entries: unknown[]): void;
  /** Per-declaration hover replies, keyed by the file each request names. */
  hovers(replies: Record<string, unknown>): void;
  run(overrides?: Partial<Input>): Promise<Result>;
}

/** What the test wants that `go`, or the child process, answers differently. */
type HarnessOptions = Pick<GoToolHarnessOptions, "go" | "spawn">;

const STORAGE = symbol("Storage", 11, 13, 17);
const METHOD = symbol("(*Store).Get", 6, 30, 34);

/**
 * One `workspace/symbol` answer as gopls really reports it: a plain `SymbolInformation` whose
 * `location.range` is the declaration's identifier span — `normaliseKey` at line 31 arrives as line 30,
 * characters 5 to 17 — so that range is both the row's line and the position its hover is asked at.
 */
function indexed(path: string, name: string, kind: number, line: number, containerName?: string): unknown {
  return {
    name,
    kind,
    ...(containerName === undefined ? {} : { containerName }),
    location: {
      uri: uriOf(path),
      range: { start: { line, character: 5 }, end: { line, character: 5 + name.length } },
    },
  };
}

/** The same entry with no character in its range: the row has a line, and no position to ask a hover at. */
function namelessSpan(path: string, name: string, kind: number, line: number): unknown {
  return {
    name,
    kind,
    location: { uri: uriOf(path), range: { start: { line }, end: { line } } },
  };
}

/** The `WorkspaceSymbol` variant, which names the identifier's range beside the declaration's own. */
function named(path: string, name: string, kind: number, line: number): unknown {
  return {
    name,
    kind,
    location: {
      uri: uriOf(path),
      targetRange: { start: { line, character: 0 }, end: { line: line + 3, character: 1 } },
      targetSelectionRange: { start: { line, character: 6 }, end: { line, character: 10 } },
    },
  };
}

/** A hover answer in the shape gopls spells a declaration: a `go` code block and prose beside it. */
function hover(signature: string, documentation?: string): unknown {
  return {
    contents: [
      { language: "go", value: signature },
      ...(documentation === undefined ? [] : [{ kind: "markdown", value: documentation }]),
    ],
  };
}

/** The part of `scope` every answer carries, with the fake toolchain and an untouched module. */
const SCOPE_BASE = {
  freshness: { kind: "unchanged" },
  environment: WINDOWS_AMD64,
  osArchExcluded: { count: 0, files: [], namedFileExcluded: false },
};

/** A gopls whose symbol index, hover replies and outlines the test supplies, over a real temp module. */
function harness(options: HarnessOptions = {}): Harness {
  const core = buildGoToolHarness({
    prefix: "mcp-code-nav-gosym-",
    fileName: "storage.go",
    outline: [STORAGE, METHOD],
    expects: [SYMBOL_METHOD, HOVER_METHOD],
    go: options.go,
    spawn: options.spawn,
  });
  return {
    ...core,
    index: (entries) => core.query.answer(SYMBOL_METHOD, entries),
    indexOfSize: (count, entries) => {
      const filler = Array.from({ length: count - entries.length }, (_unused, index) =>
        indexed(join(core.mod, `noise${index}.go`), `Near${index}`, 12, index),
      );
      core.query.answer(SYMBOL_METHOD, [...filler, ...entries]);
    },
    hovers: (replies) =>
      core.query.answerEach(HOVER_METHOD, (params) => {
        const file = pathOfDocumentId(params);
        return file === undefined ? null : (replies[file] ?? null);
      }),
    run: (overrides) =>
      runGoFindSymbol(
        core.manager,
        {
          sourceRoots: [core.mod],
          symbol: "Storage",
          anchor: core.file,
          timeBudgetMs: 60_000,
          ...overrides,
        },
        { exec: core.go.exec },
      ),
  };
}

/** The rows of an answer, each checked against the invariant for a declaration row. */
function rowsOf(result: Result, asked: string): Row[] {
  const rows = payload(result).declarations as Row[];
  for (const row of rows) expect(declarationKey(String(row.name))).toBe(declarationKey(asked));
  return rows;
}

function reason(row: Row | undefined): string {
  return String(row?.descriptionUnavailable ?? "");
}

/** How many times the server was told to hold this one path, which is how often a fan-out opened it. */
function didOpens(server: FakeServer, path: string): number {
  return server.notifications.filter(
    ([method, params]) => method === "textDocument/didOpen" && pathOfDocumentId(params) === path,
  ).length;
}

describe("runGoFindSymbol", () => {
  afterEach(() => cleanupGoToolHarnesses());

  it("answers a file anchor from that file's outline, with the description read from the name itself", async () => {
    const h = harness();
    h.hovers({ [h.file]: hover("type Storage interface {\n\tGet(id string) ([]byte, error)\n}", "Storage is the blob store.") });
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(payload(out)).toEqual({
      declarations: [
        {
          name: "Storage",
          kind: "interface",
          file: h.file,
          line: 14,
          container: ".",
          visibility: "exported",
          external: false,
          signature: "type Storage interface {\n\tGet(id string) ([]byte, error)\n}",
          documentation: "Storage is the blob store.",
        },
      ],
      scope: {
        ...SCOPE_BASE,
        moduleRoot: resolve(h.mod),
        lookup: "document-symbol",
        limits: ["one-module", "one-file", "one-port"],
      },
    });
    expect(textOf(out)).toContain('Declarations named "Storage" (exact match) in the top-level declarations of');
    expect(textOf(out)).toContain("1 declaration(s)");
    expect(textOf(out)).toContain("limits: one-module, one-file, one-port");
  });

  it("asks about the name and not the keyword: the hover position is selectionRange.start", async () => {
    const h = harness();
    await h.ready();
    await h.run();

    expect(requestFor(h.server, HOVER_METHOD)).toEqual({
      textDocument: { uri: uriOf(h.file) },
      position: { line: 13, character: 5 },
    });
  });

  it("states which lookup answered and bounds a file answer to one file", async () => {
    const h = harness();
    h.index([indexed(h.file, "Storage", 11, 13)]);
    await h.ready();

    const file = await h.run();
    expect(scopeOf(file).lookup).toBe("document-symbol");
    expect(limitsOf(file)).toEqual(["one-module", "one-file", "one-port"]);

    const module = await h.run({ anchor: h.mod });
    expect(scopeOf(module).lookup).toBe("workspace-symbol");
    expect(limitsOf(module)).toEqual(["one-module", "one-port"]);
  });

  it.each(["Store.Get", "(*Store).Get"])("asks gopls's matcher for the name it indexes, asked as %s", async (asked: string) => {
    const h = harness();
    h.index([indexed(h.file, "(*Store).Get", 6, 30)]);
    await h.ready();

    // Either receiver spelling is a search for the identifier gopls keys the method under; the receiver is
    // applied by the exact-name filter, which is where both spellings land on one declaration key.
    const out = await h.run({ symbol: asked, anchor: h.mod });
    expect(requestFor(h.server, SYMBOL_METHOD)).toEqual({ query: "Get" });
    expect(rowsOf(out, asked)[0]).toMatchObject({ name: "(*Store).Get", kind: "method" });
  });

  it("drops the near-matches a fuzzy index offers beside the exact name", async () => {
    const h = harness();
    const other = join(h.mod, "other.go");
    h.index([
      indexed(other, "Getter", 12, 4),
      indexed(other, "get", 12, 8),
      indexed(other, "Gate", 12, 12),
      indexed(other, "Get", 12, 16),
      indexed(other, "Store.Get", 6, 20),
    ]);
    await h.ready();

    const out = await h.run({ symbol: "Get", anchor: h.mod });
    const rows = rowsOf(out, "Get");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Get", file: other, line: 17, kind: "function" });
  });

  it.each(["Store.Get", "(*Store).Get"])("accepts both method spellings asked as %s", async (asked: string) => {
    const h = harness();
    const a = join(h.mod, "a.go");
    const b = join(h.mod, "b.go");
    h.index([indexed(b, "Store.Get", 6, 20), indexed(a, "(*Store).Get", 6, 10)]);
    await h.ready();

    const out = await h.run({ symbol: asked, anchor: h.mod });
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(rowsOf(out, asked).map((row) => row.name)).toEqual(["(*Store).Get", "Store.Get"]);
  });

  it("composes a bare member name with gopls's own receiver and reports it as a method", async () => {
    const h = harness();
    mkdirSync(join(h.mod, "sub"), { recursive: true });
    // gopls answers `function` for a method here, so the composition cannot gate on
    // the kind the entry arrived with — and the package beside it is gopls's, not this row's container.
    h.index([indexed(join(h.mod, "sub", "store.go"), "Get", 12, 30, "*Store")]);
    await h.ready();

    const out = await h.run({ symbol: "Store.Get", anchor: h.mod });
    expect(rowsOf(out, "Store.Get")[0]).toMatchObject({
      name: "(*Store).Get",
      kind: "method",
      visibility: "exported",
      container: "sub",
    });
  });

  it("reads a package path in `containerName` as no container at all", async () => {
    const h = harness();
    h.index([indexed(h.file, "Errorf", 12, 6, "example.com/m/storage")]);
    await h.ready();

    const out = await h.run({ symbol: "Errorf", anchor: h.mod });
    expect(rowsOf(out, "Errorf")[0]).toMatchObject({ name: "Errorf", kind: "function", container: "." });
  });

  it("names the same declaration in two packages as two rows with two containers", async () => {
    const h = harness();
    mkdirSync(join(h.mod, "sub"), { recursive: true });
    const rootFile = join(h.mod, "load.go");
    const subFile = join(h.mod, "sub", "load.go");
    h.index([named(subFile, "LoadValue", 12, 8), named(rootFile, "LoadValue", 12, 5)]);
    h.hovers({ [rootFile]: hover("func LoadValue() int"), [subFile]: hover("func LoadValue() string") });
    await h.ready();

    const out = await h.run({ symbol: "LoadValue", anchor: h.mod });
    const rows = rowsOf(out, "LoadValue");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ file: rootFile, container: ".", external: false, signature: "func LoadValue() int" });
    expect(rows[1]).toMatchObject({ file: subFile, container: "sub", external: false, signature: "func LoadValue() string" });
    expect(requestFor(h.server, HOVER_METHOD)).toMatchObject({
      textDocument: { uri: uriOf(rootFile) },
      position: { line: 5, character: 6 },
    });
  });

  it("a file answer names two receivers of one method name, and one package beside them", async () => {
    const h = harness();
    h.outline(h.file, [symbol("(*Cache).Get", 6, 10, 14), symbol("(*Index).Get", 6, 20, 24)]);
    h.hovers({ [h.file]: hover("func (c *Cache) Get(k string) string") });
    await h.ready();

    const cache = await h.run({ symbol: "Cache.Get" });
    expect(rowsOf(cache, "Cache.Get")).toHaveLength(1);
    expect(rowsOf(cache, "Cache.Get")[0]).toMatchObject({ name: "(*Cache).Get", container: "." });

    // The same file holds a second declaration the bare name cannot reach: `Get` alone is another declaration.
    const both = await h.run({ symbol: "(*Cache).Get" });
    expect(rowsOf(both, "(*Cache).Get")).toHaveLength(1);
  });

  it.each([
    ["(*hidden).Ping", "exported"],
    ["(*hidden).ping", "package-private"],
    ["hidden.Ping", "exported"],
    ["hidden.ping", "package-private"],
    ["Gauge", "exported"],
    ["gauge", "package-private"],
  ])("reads the visibility of the file row %s as %s, from its own name", async (name: string, visibility: string) => {
    const h = harness();
    h.outline(h.file, [symbol(name, name.includes(".") ? 6 : 23, 10, 14)]);
    await h.ready();

    const out = await h.run({ symbol: name });
    expect(rowsOf(out, name)[0]).toMatchObject({ visibility });
    expect(scopeOf(out)).not.toHaveProperty("visibility");
    expect(limitsOf(out)).not.toContain("exported-symbol-importers-invisible");
  });

  it("reads the visibility of a workspace row from the member name gopls spelled", async () => {
    const h = harness();
    h.index([indexed(h.file, "Ping", 12, 20, "*hidden")]);
    await h.ready();

    const out = await h.run({ symbol: "Ping", anchor: h.mod });
    expect(rowsOf(out, "Ping")[0]).toMatchObject({ name: "Ping", visibility: "exported" });
    expect(scopeOf(out)).not.toHaveProperty("visibility");
    expect(limitsOf(out)).not.toContain("exported-symbol-importers-invisible");
  });

  it("keeps gopls's own dotted method spelling in the row, and reads its export status from it", async () => {
    const h = harness();
    // This is how the installed gopls names a method in its symbol index: the receiver and the member
    // joined by a dot, with no parentheses and no star, whatever the caller typed. The row carries that
    // spelling, and the method part of it decides the visibility.
    h.index([indexed(h.file, "hidden.Ping", 6, 20)]);
    await h.ready();

    for (const asked of ["hidden.Ping", "(*hidden).Ping"]) {
      const out = await h.run({ symbol: asked, anchor: h.mod });
      const [row] = rowsOf(out, asked);
      expect(row).toMatchObject({ name: "hidden.Ping", kind: "method", visibility: "exported", container: "." });
    }

    const lower = await h.run({ symbol: "(*hidden).ping", anchor: h.mod });
    expect(lower.isError).toBe(true);

    h.index([indexed(h.file, "hidden.ping", 6, 22)]);
    const dotted = await h.run({ symbol: "hidden.ping", anchor: h.mod });
    expect(rowsOf(dotted, "hidden.ping")[0]).toMatchObject({ visibility: "package-private" });
  });

  it("holds each row's file open for its hover and closes it again, once per file", async () => {
    const h = harness();
    const first = join(h.mod, "first.go");
    const second = join(h.mod, "second.go");
    // Neither file was named by the caller and neither is open in the session: gopls answers a hover
    // about a document it holds, so a search that named these rows has to hold them open to describe them.
    h.index([named(first, "LoadValue", 12, 4), named(first, "LoadValue", 12, 9), named(second, "LoadValue", 12, 3)]);
    h.hovers({
      [first]: hover("func LoadValue() int"),
      [second]: hover("func LoadValue() string"),
    });
    await h.ready();

    const out = await h.run({ symbol: "LoadValue", anchor: h.mod });
    const rows = rowsOf(out, "LoadValue");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ file: first, line: 5, signature: "func LoadValue() int" });
    expect(rows[1]).toMatchObject({ file: first, line: 10, signature: "func LoadValue() int" });
    expect(rows[2]).toMatchObject({ file: second, line: 4, signature: "func LoadValue() string" });
    expect(countOf(h.server, HOVER_METHOD)).toBe(3);
    // One hold per file however many rows it carries, and none of it enters the session's opened set.
    expect(didOpens(h.server, first)).toBe(1);
    expect(didOpens(h.server, second)).toBe(1);
    expect(closedPaths(h.server)).toContain(first);
    expect(closedPaths(h.server)).toContain(second);
    expect(h.session.getOpenedFiles()).toEqual([h.file]);
  });

  it("says nothing about importers, for an exported name or any other", async () => {
    const h = harness();
    h.index([indexed(h.file, "Storage", 11, 13)]);
    await h.ready();

    const out = await h.run({ anchor: h.mod });
    expect(rowsOf(out, "Storage")[0]).toMatchObject({ visibility: "exported" });
    expect(limitsOf(out)).toEqual(["one-module", "one-port"]);
  });

  it("reports an out-of-module row, flags it, and never opens or hovers it", async () => {
    const h = harness();
    const inside = join(h.mod, "zoo.go");
    const goroot = join(h.tmp, "go", "src", "errors", "a.go");
    // Reported first, and its path sorts before the in-module one, so only a comparator that keys `external`
    // can put it last: an in-module-first partition followed by a path sort would interleave them again.
    h.index([indexed(goroot, "Get", 12, 70), named(inside, "Get", 12, 3)]);
    h.hovers({ [inside]: hover("func Get() int") });
    await h.ready();

    const out = await h.run({ symbol: "Get", anchor: h.mod });
    const rows = rowsOf(out, "Get");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ file: inside, external: false, container: ".", signature: "func Get() int" });
    expect(rows[1]).toEqual({
      name: "Get",
      kind: "function",
      file: goroot,
      line: 71,
      container: null,
      visibility: "exported",
      external: true,
      descriptionUnavailable: "outside the module root; not read",
    });
    expect(countOf(h.server, HOVER_METHOD)).toBe(1);
    expect(openedPaths(h.server)).not.toContain(goroot);
    expect(h.read.mock.calls.every((call) => call[0] !== goroot)).toBe(true);
  });

  it("an answer whose every row is outside the module is still an answer", async () => {
    const h = harness();
    const goroot = join(h.tmp, "go", "src", "fmt", "print.go");
    h.index([indexed(goroot, "Println", 12, 400)]);
    await h.ready();

    const out = await h.run({ symbol: "Println", anchor: h.mod });
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(rowsOf(out, "Println")[0]).toMatchObject({ external: true, container: null });
    expect(limitsOf(out)).toEqual(["one-module", "one-port"]);
  });

  it("every unavailable description is a sentence naming its own cause", async () => {
    const h = harness();
    const described = join(h.mod, "a1.go");
    const refused = join(h.mod, "a2.go");
    const nothing = join(h.mod, "a3.go");
    const unreadable = join(h.mod, "a4.go");
    const noRange = join(h.mod, "a5.go");
    h.index([
      named(described, "Trim", 12, 4),
      named(refused, "Trim", 12, 8),
      named(nothing, "Trim", 12, 12),
      named(unreadable, "Trim", 12, 16),
      namelessSpan(noRange, "Trim", 12, 20),
    ]);
    h.query.answerEach(HOVER_METHOD, (params) => {
      const file = pathOfDocumentId(params);
      if (file === described) return hover("func Trim(s string) string", "Trim cuts both ends.");
      if (file === refused) throw new Error("no identifier found");
      if (file === unreadable) return { contents: 42 };
      return null;
    });
    await h.ready();

    const out = await h.run({ symbol: "Trim", anchor: h.mod });
    const rows = rowsOf(out, "Trim");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ signature: "func Trim(s string) string", documentation: "Trim cuts both ends." });
    expect(reason(rows[1])).toMatch(/refused the hover: no identifier found/);
    expect(reason(rows[2])).toMatch(/hover answer carried nothing/);
    expect(reason(rows[3])).toMatch(/carried a number/);
    expect(reason(rows[4])).toMatch(/named no position/);
    // Four were hoverable and were asked about; the fifth lost its description without ever being read.
    expect(countOf(h.server, HOVER_METHOD)).toBe(4);
  });

  it("asks the hover at the identifier span the symbol index named", async () => {
    const h = harness();
    h.index([indexed(h.file, "Storage", 11, 13)]);
    h.hovers({ [h.file]: hover("type Storage interface {}") });
    await h.ready();

    const out = await h.run({ anchor: h.mod });
    expect(requestFor(h.server, HOVER_METHOD)).toEqual({
      textDocument: { uri: uriOf(h.file) },
      position: { line: 13, character: 5 },
    });
    expect(rowsOf(out, "Storage")[0]).toMatchObject({ line: 14, signature: "type Storage interface {}" });
  });

  it("never guesses a hover position: an answer naming none for the identifier keeps the row, not the read", async () => {
    const h = harness();
    // A range with a line and no character places the row and describes nothing; a range that is not there
    // at all cannot place the row, and that entry fails the call instead of becoming a location-less one.
    h.index([namelessSpan(h.file, "Storage", 11, 13)]);
    await h.ready();

    const out = await h.run({ anchor: h.mod });
    const [row] = rowsOf(out, "Storage");
    expect(out.isError).toBeFalsy();
    expect(row).toMatchObject({ line: 14 });
    expect(reason(row)).toMatch(/named no position/);
    expect(reason(row)).toMatch(/guessed location/);
    expect(countOf(h.server, HOVER_METHOD)).toBe(0);
  });

  it("never guesses a hover position for an outline row with no selection range either", async () => {
    const h = harness();
    // The file anchor keeps the rule untouched: there the outline's `range.start` is the `type`
    // keyword, so a row without `selectionRange` is reported and never asked about.
    h.outline(h.file, [{ name: "Bare", kind: 11, range: { start: { line: 2 }, end: { line: 4 } } }]);
    await h.ready();

    const out = await h.run({ symbol: "Bare" });
    const [row] = rowsOf(out, "Bare");
    expect(out.isError).toBeFalsy();
    expect(row).toMatchObject({ name: "Bare", line: 3, container: "." });
    expect(reason(row)).toMatch(/named no position/);
    expect(countOf(h.server, HOVER_METHOD)).toBe(0);
  });

  it("reads a signature only out of a code block, and prose only as documentation", async () => {
    const h = harness();
    h.query.answer(HOVER_METHOD, { contents: [{ language: "go", value: "func Trim(s string) string" }] });
    await h.ready();

    const coded = await h.run();
    expect(rowsOf(coded, "Storage")[0]).toMatchObject({ signature: "func Trim(s string) string" });
    expect(rowsOf(coded, "Storage")[0]).not.toHaveProperty("descriptionUnavailable");

    h.query.answer(HOVER_METHOD, { contents: "An untagged sentence gopls chose to send as prose." });
    const prose = await h.run();
    expect(rowsOf(prose, "Storage")[0]).not.toHaveProperty("signature");
    expect(rowsOf(prose, "Storage")[0]).toMatchObject({ documentation: "An untagged sentence gopls chose to send as prose." });
  });

  it("reads the signature out of a go fence inside a markdown answer, and the prose beside it as documentation", async () => {
    const h = harness();
    h.outline(h.file, [symbol("(*Memory).Read", 6, 19, 25)]);
    h.query.answer(HOVER_METHOD, {
      contents: {
        kind: "markdown",
        value: "```go\nfunc (m *Memory) Read(id string) ([]byte, error)\n```\n\nRead returns what is stored.",
      },
    });
    await h.ready();

    const out = await h.run({ symbol: "(*Memory).Read" });
    expect(rowsOf(out, "(*Memory).Read")[0]).toMatchObject({
      signature: "func (m *Memory) Read(id string) ([]byte, error)",
      documentation: "Read returns what is stored.",
    });
  });

  it("reads an untagged fenced block as the signature too, and never prose as one", async () => {
    const h = harness();
    h.outline(h.file, [symbol("(*Memory).Read", 6, 19, 25)]);
    h.query.answer(HOVER_METHOD, {
      contents: { kind: "markdown", value: "```\ntype Memory struct{ data map[string][]byte }\n```\n\nMemory keeps values in a map." },
    });
    await h.ready();

    const out = await h.run({ symbol: "(*Memory).Read" });
    expect(rowsOf(out, "(*Memory).Read")[0]).toMatchObject({
      signature: "type Memory struct{ data map[string][]byte }",
      documentation: "Memory keeps values in a map.",
    });
  });

  it("carries listing-capped when the raw list reached the watermark, and says so beside the rows", async () => {
    const h = harness();
    h.indexOfSize(WORKSPACE_SYMBOL_CAP_WATERMARK, [indexed(h.file, "Storage", 11, 13)]);
    await h.ready();

    const out = await h.run({ anchor: h.mod });
    expect(rowsOf(out, "Storage")).toHaveLength(1);
    expect(limitsOf(out)).toEqual(["one-module", "one-port", "listing-capped"]);
    expect(textOf(out)).toContain(CAP_SENTENCE);
    expect(textOf(out)).not.toContain(String(WORKSPACE_SYMBOL_CAP_WATERMARK));
  });

  it("says nothing about a cap when the raw list came back one entry short of the watermark", async () => {
    const h = harness();
    h.indexOfSize(WORKSPACE_SYMBOL_CAP_WATERMARK - 1, [indexed(h.file, "Storage", 11, 13)]);
    await h.ready();

    const out = await h.run({ anchor: h.mod });
    expect(limitsOf(out)).toEqual(["one-module", "one-port"]);
    expect(textOf(out)).not.toMatch(/bounded list/);
  });

  it("returns every exact match below the watermark: this server caps nothing", async () => {
    const h = harness();
    const rows = Array.from({ length: WORKSPACE_SYMBOL_CAP_WATERMARK - 1 }, (_unused, index) =>
      indexed(join(h.mod, `p${index}.go`), "Get", 12, index),
    );
    h.index(rows);
    await h.ready();

    const out = await h.run({ symbol: "Get", anchor: h.mod });
    expect(rowsOf(out, "Get")).toHaveLength(WORKSPACE_SYMBOL_CAP_WATERMARK - 1);
    expect(limitsOf(out)).toEqual(["one-module", "one-port"]);
  });

  it("a capped search that found no exact match says both, and an uncapped one says only the first", async () => {
    const h = harness();
    await h.ready();

    h.indexOfSize(WORKSPACE_SYMBOL_CAP_WATERMARK, [indexed(h.file, "Nearby", 12, 3)]);
    const capped = await h.run({ symbol: "Absent", anchor: h.mod });
    expect(capped.isError).toBe(true);
    expect(textOf(capped)).toContain('no declaration named "Absent" was found in the whole module');
    expect(textOf(capped)).toContain("The match is exact, not fuzzy");
    expect(textOf(capped)).toContain("may have been ranked out of it");

    h.indexOfSize(WORKSPACE_SYMBOL_CAP_WATERMARK - 1, [indexed(h.file, "Nearby", 12, 3)]);
    const uncapped = await h.run({ symbol: "Absent", anchor: h.mod });
    expect(uncapped.isError).toBe(true);
    expect(textOf(uncapped)).not.toMatch(/ranked out/);
  });

  it("names the file it searched and the exactness of the match when a file answer finds nothing", async () => {
    const h = harness();
    await h.ready();

    const out = await h.run({ symbol: "Absent" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(`no declaration named "Absent" was found in the top-level declarations of "${h.file}"`);
    expect(textOf(out)).toContain("The match is exact, not fuzzy");
    // A name with no answer here never spent the readiness wait, let alone a search or a hover.
    expect(h.server.methods).not.toContain(SYMBOL_METHOD);
    expect(h.server.methods).not.toContain(HOVER_METHOD);
  });

  it("fails when the anchor does not exist, before starting a child", async () => {
    const h = harness();
    const out = await h.run({ anchor: join(h.mod, "gone.go") });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/the anchor ".*gone\.go" does not exist/);
    expect(h.server.methods).toEqual([]);
  });

  it("fails when the anchor escapes every declared root", async () => {
    const h = harness();
    const out = await h.run({ anchor: join(h.tmp, "outside") });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/escapes every declared root/);
    expect(h.server.methods).toEqual([]);
  });

  it("fails when a directory anchor is in no Go module, naming the directory it searched from", async () => {
    const h = harness();
    const plain = join(h.tmp, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "a.go"), "package a\n");

    const out = await h.run({ sourceRoots: [h.tmp], anchor: plain });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/is not inside a Go module/);
    expect(textOf(out)).toContain(plain);
    expect(h.server.methods).toEqual([]);
  });

  it("fails when a directory anchor's module sits outside the declared roots, naming both", async () => {
    const h = harness();
    const pkg = join(h.mod, "pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "a.go"), "package pkg\n");

    const out = await h.run({ sourceRoots: [pkg], anchor: pkg });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/outside every declared sourceRoots entry/);
    expect(textOf(out)).toContain(resolve(h.mod));
  });

  it("fails at the budget when the initial workspace load was never proven, asking nothing type-aware", async () => {
    const h = harness();
    h.index([indexed(h.file, "Storage", 11, 13)]);

    const out = await runUntilBudgetExpires(() => h.run({ anchor: h.mod, timeBudgetMs: 40 }), 40);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/initial workspace load/);
    expect(textOf(out)).toContain("40 ms budget");
    expect(h.server.methods).not.toContain(SYMBOL_METHOD);
  });

  it("fails at the budget when the symbol search never arrives, and says which step timed out", async () => {
    const h = harness();
    h.query.hang(SYMBOL_METHOD);
    await h.ready();

    const out = await runUntilBudgetExpires(() => h.run({ anchor: h.mod, timeBudgetMs: 40 }), 40);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('search the module for "Storage"');
    expect(textOf(out)).toMatch(/do not read this as an empty answer/);
  });

  it("keeps the declarations it has when a hover runs out of budget, with the reason beside each row", async () => {
    const h = harness();
    h.index([named(h.file, "Storage", 11, 13)]);
    h.query.hang(HOVER_METHOD);
    await h.ready();

    const out = await runUntilBudgetExpires(() => h.run({ anchor: h.mod, timeBudgetMs: 40 }), 40);
    expect(out.isError).toBeFalsy();
    expect(reason(rowsOf(out, "Storage")[0])).toMatch(/hover never arrived inside this call's 40 ms budget/);
  });

  it("refuses an answer from a server that restarted while the search was in flight", async () => {
    const h = harness();
    h.index([indexed(h.file, "Storage", 11, 13)]);
    h.query.crashNext(SYMBOL_METHOD);
    await h.ready();

    const out = await h.run({ anchor: h.mod });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/gopls restarted during the query/);
    // The retried search really was answered — what is refused is the proof, not the reply.
    expect(h.server.methods.filter((method) => method === SYMBOL_METHOD)).toHaveLength(2);
  }, 10_000);

  it("refuses a search gopls answered with no package metadata, naming the file and the constraint", async () => {
    const h = harness();
    const tagged = join(h.mod, "gpu.go");
    h.query.refuse(SYMBOL_METHOD, `no package metadata for file ${tagged}`);
    await h.ready();

    const out = await h.run({ anchor: h.mod });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(`"${tagged}"`);
    expect(textOf(out)).toMatch(/Commonly a build constraint/);
  });

  it("fails loudly on an index entry it cannot read rather than reporting fewer declarations", async () => {
    const h = harness();
    h.index([{ nonsense: true }]);
    await h.ready();

    const out = await h.run({ anchor: h.mod });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/cannot read/);
    expect(textOf(out)).toMatch(/entry 1/);
  });

  it("drops one-port with the environment it describes, and keeps the bounds it can still state", async () => {
    const h = harness({ go: fakeGo({ env: notStarted("ENOENT", "go: executable file not found") }) });
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(limitsOf(out)).toEqual(["one-module", "one-file"]);
    expect(textOf(out)).toContain("the port this answer describes is unknown");
  });

  it("adds osarch-excluded-files to a declaration answer when the module holds an excluded file", async () => {
    const h = harness();
    writeFileSync(join(h.mod, "disk_linux.go"), "package mod\n");
    h.hovers({ [h.file]: hover("type Storage interface {}") });
    await h.ready();

    const out = await h.run();
    expect(limitsOf(out)).toEqual(["one-module", "one-file", "one-port", "osarch-excluded-files"]);
    expect(scopeOf(out)).toMatchObject({ osArchExcluded: { count: 1 } });
  });

  it.each(["file", "directory"])("reports gopls's own unavailability at once for a %s anchor", async (kind: string) => {
    const h = harness({ spawn: missingGoplsSpawn() });
    const anchor = kind === "file" ? h.file : h.mod;

    const out = await h.run({ anchor });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("Cannot start gopls");
    expect(textOf(out)).toContain("MCP_CODE_NAV_GOPLS");
    expect(textOf(out)).not.toMatch(/budget/);
    expect(h.server.methods).toEqual([]);
  });

  it("roots gopls at the module and asks only the methods its config allows", async () => {
    const h = harness();
    h.index([named(h.file, "Storage", 11, 13)]);
    h.hovers({ [h.file]: hover("type Storage interface {}") });
    await h.ready();
    await h.run({ anchor: h.mod });

    const goMod = join(h.mod, "go.mod");
    expect(h.server.requests[0]?.[1]).toMatchObject({ rootUri: uriOf(resolve(h.mod)) });
    expect(h.server.methods).toEqual([
      "initialize",
      "textDocument/documentSymbol",
      "textDocument/documentSymbol",
      SYMBOL_METHOD,
      HOVER_METHOD,
    ]);
    // The second outline is the module-wide pre-flight on the module's own build file, and it is transient:
    // the call holds nothing it did not have before, and the search answers from the graph, not from it.
    expect(openedPaths(h.server)).toContain(goMod);
    expect(closedPaths(h.server)).toContain(goMod);
    expect(h.session.getOpenedFiles()).toEqual([h.file]);
  });
});
