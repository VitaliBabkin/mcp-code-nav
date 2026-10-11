import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import type { ModuleSnapshotFn } from "../../src/lsp/module-freshness.js";
import type { SpawnLsp } from "../../src/lsp/process.js";
import { goplsConfig } from "../../src/lsp/server-config.js";
import type { LspSession } from "../../src/lsp/session.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runGoFindImplementations } from "../../src/tools/go-find-implementations.js";
import { IMPLEMENTATIONS_LIMIT } from "../../src/tools/navigation-limits.js";
import {
  exited,
  fakeGo,
  goEnvJson,
  notStarted,
  ran,
  WINDOWS_AMD64,
  type FakeGo,
} from "../helpers/fake-go.js";
import { fakeServer, pathOfDocumentId, uriOf, type FakeServer } from "../helpers/fake-lsp.js";

type Result = Awaited<ReturnType<typeof runGoFindImplementations>>;
type Input = { sourceRoots: string[]; file: string; symbol: string; timeBudgetMs: number };
type Row = Record<string, unknown>;

/** The `scope` block of a successful call. */
function scopeOf(result: Result): Record<string, unknown> {
  return payload(result).scope as Record<string, unknown>;
}

/** Which of the two exclusive pairs `scope` actually carries. */
function exclusivesOf(scope: Record<string, unknown>): string[] {
  return ["environment", "environmentUnavailable", "osArchExcluded", "osArchExcludedUnavailable"].filter(
    (key) => key in scope,
  );
}

// Windows spells one path in two cases and `pathKey` is what equates them; on a case-sensitive filesystem
// the case would not be skipped silently but would also not be the thing under test.
const itIfCaseInsensitive = process.platform === "win32" ? it : it.skip;

function symbol(name: string, kind: number, startLine: number, endLine = startLine): LspDocumentSymbol {
  return {
    name,
    kind,
    range: { start: { line: startLine }, end: { line: endLine } },
    selectionRange: { start: { line: startLine, character: 5 } },
  };
}

/** A declaration gopls reported with no name range, which no type-aware position can be taken from. */
const NO_SELECTION: LspDocumentSymbol = { name: "Bare", kind: 11, range: { start: { line: 2 }, end: { line: 4 } } };

const STORAGE = symbol("Storage", 11, 13, 17);
const PG = symbol("PgStorage", 23, 21, 24);

function location(path: string, line: number, character = 4): unknown {
  return { uri: uriOf(path), range: { start: { line, character }, end: { line, character: character + 5 } } };
}

/** A one-line declaration whose name and member share the line, as LSP reports them. */
function ranged(
  name: string,
  kind: number,
  line: number,
  startCharacter: number,
  endCharacter: number,
  children?: LspDocumentSymbol[],
): LspDocumentSymbol {
  return {
    name,
    kind,
    range: { start: { line, character: startCharacter }, end: { line, character: endCharacter } },
    selectionRange: { start: { line, character: startCharacter } },
    ...(children === undefined ? {} : { children }),
  };
}

function locationLink(path: string, line: number): unknown {
  return {
    targetUri: uriOf(path),
    targetRange: { start: { line: 0 }, end: { line: 40 } },
    targetSelectionRange: { start: { line, character: 4 } },
    originSelectionRange: { start: { line: 13 }, end: { line: 13 } },
  };
}

interface Harness {
  tmp: string;
  mod: string;
  file: string;
  server: FakeServer;
  session: LspSession;
  read: ReturnType<typeof vi.fn>;
  go: FakeGo;
  outline(path: string, symbols: LspDocumentSymbol[]): void;
  failToOutline(path: string): void;
  /** Holds that file's outline answer open until the returned function runs, to force an out-of-order finish. */
  delayOutline(path: string): () => void;
  answer(locations: unknown[]): void;
  /** Kills the child the next time it is asked an `implementation` query, then answers from its replacement. */
  failNextImplementation(): void;
  /** Makes every `implementation` query reject with this message, the way a refused file does. */
  refuseImplementation(message: string): void;
  /** Proves the initial workspace load, which only a child that has started can report. */
  ready(): Promise<void>;
  run(overrides?: Partial<Input>): Promise<Result>;
}

/** What the test wants that `go` answers differently. */
interface HarnessOptions {
  go?: FakeGo;
  snapshot?: ModuleSnapshotFn;
  /** Proves the initial load from inside the first outline answer, for a test whose child starts mid-call. */
  autoReady?: boolean;
  /** A child that never appears, the way an absent binary defeats a real session. */
  spawn?: SpawnLsp;
}

/** A gopls whose outlines and `implementation` answer the test supplies, rooted at a real temp module. */
function buildHarness(options: HarnessOptions = {}): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-gofi-"));
  const mod = join(tmp, "mod");
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, "go.mod"), "module example.com/mod\n");
  const file = join(mod, "storage.go");
  writeFileSync(file, "package mod\n");

  const outlines = new Map<string, LspDocumentSymbol[]>([[file, [STORAGE]]]);
  const failing = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  let implementations: unknown[] = [];
  let refusal: string | undefined;
  // The one child this harness hands out, killed and replaced under the caller's feet on request.
  let childAlive = true;
  let crashNextImplementation = false;
  let autoReadied = false;
  const read = vi.fn(() => "package mod\n");
  const go = options.go ?? fakeGo();
  const server = fakeServer({
    alive: () => childAlive,
    respond: async (method, params) => {
      if (method === "initialize") return {};
      if (method === "textDocument/documentSymbol") {
        const { textDocument } = params as { textDocument: { uri: string } };
        const path = fileURLToPath(textDocument.uri);
        if (failing.has(path)) throw new Error(`no package metadata for file ${path}`);
        await pending.get(path);
        if (options.autoReady && !autoReadied) {
          autoReadied = true;
          void server
            .createProgress("tok-auto")
            .then(() => server.sendProgress("tok-auto", { kind: "end", message: "Finished loading packages." }));
        }
        return outlines.get(path) ?? [];
      }
      if (method === "textDocument/implementation") {
        if (crashNextImplementation) {
          crashNextImplementation = false;
          childAlive = false;
          throw new Error("connection got disposed");
        }
        if (refusal !== undefined) throw new Error(refusal);
        return implementations;
      }
      throw new Error(`unexpected request: ${method}`);
    },
  });
  const manager = new LspSessionManager({
    spawn: options.spawn ?? (() => server.process),
    readFile: read,
    sleep: async () => {},
  });
  const config = options.snapshot === undefined ? goplsConfig : { ...goplsConfig, moduleSnapshot: options.snapshot };
  const session = manager.get(resolve(mod), config);
  return {
    tmp,
    mod,
    file,
    server,
    session,
    read,
    go,
    outline: (path, symbols) => {
      outlines.set(path, symbols);
    },
    failToOutline: (path) => {
      failing.add(path);
    },
    delayOutline: (path) => {
      let release: () => void = () => {};
      pending.set(
        path,
        new Promise<void>((done) => {
          release = done;
        }),
      );
      return () => release();
    },
    answer: (locations) => {
      implementations = locations;
    },
    failNextImplementation: () => {
      crashNextImplementation = true;
    },
    refuseImplementation: (message) => {
      refusal = message;
    },
    ready: async () => {
      await session.documentSymbol(file);
      await server.createProgress("tok-1");
      server.sendProgress("tok-1", { kind: "end", message: "Finished loading packages." });
    },
    run: (overrides) =>
      runGoFindImplementations(
        manager,
        {
          sourceRoots: [mod],
          file,
          symbol: "Storage",
          timeBudgetMs: 60_000,
          ...overrides,
        },
        { exec: go.exec },
      ),
  };
}

const tempDirs: string[] = [];

function harness(options: HarnessOptions = {}): Harness {
  const built = buildHarness(options);
  tempDirs.push(built.tmp);
  return built;
}

function payload(result: Result): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function rowsOf(result: Result): Row[] {
  return payload(result).implementations as Row[];
}

function textOf(result: Result): string {
  return result.content[0]?.text ?? "";
}

/** Every document-scoped notification, in the order it was written, as `method path` lines. */
function notes(server: FakeServer): string[] {
  return server.notifications.map(([method, params]) => {
    const path = pathOfDocumentId(params);
    return path === undefined ? method : `${method} ${path}`;
  });
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) {
    await new Promise((done) => setTimeout(done, 5));
  }
  if (!predicate()) throw new Error(`never happened: ${what}`);
}

describe("runGoFindImplementations", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("answers the implementers of an interface, echoing the direction its kind decided", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [PG]);
    h.answer([location(pg, 21)]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(payload(out)).toEqual({
      resolved: { name: "Storage", kind: "interface", file: h.file, line: 14 },
      direction: "implementers-of-interface",
      implementations: [{ name: "PgStorage", kind: "struct", file: pg, line: 22, external: false }],
      truncated: 0,
      scope: {
        moduleRoot: resolve(h.mod),
        freshness: { kind: "unchanged" },
        environment: WINDOWS_AMD64,
        osArchExcluded: { count: 0, files: [], namedFileExcluded: false },
      },
    });
    expect(textOf(out)).toContain('Implementations of interface "Storage"');
    expect(textOf(out)).toContain("under windows/amd64");
  });

  it("asks about the name and not the keyword: the position is selectionRange.start", async () => {
    const h = harness();
    await h.ready();
    await h.run();

    const request = h.server.requests.find(([method]) => method === "textDocument/implementation");
    expect(request?.[1]).toEqual({ textDocument: { uri: uriOf(h.file) }, position: { line: 13, character: 5 } });
  });

  it("names each in-module file through a transient open that it closes again", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [PG]);
    h.answer([location(pg, 21)]);
    await h.ready();
    await h.run();

    const journal = h.server.journal;
    expect(journal.filter((entry) => entry === "note:textDocument/didOpen")).toHaveLength(2);
    expect(journal.filter((entry) => entry === "note:textDocument/didClose")).toHaveLength(1);
    expect(journal.lastIndexOf("note:textDocument/didOpen")).toBeGreaterThan(
      journal.indexOf("req:textDocument/implementation"),
    );
    expect(journal.indexOf("note:textDocument/didClose")).toBeGreaterThan(
      journal.indexOf("req:textDocument/implementation"),
    );
    expect(h.session.getOpenedFiles()).toEqual([h.file]);
  });

  it("flips the question for a named type, and treats a class-shaped one the same way", async () => {
    for (const [kind, kindName] of [
      [23, "struct"],
      [5, "class"],
    ] as const) {
      const h = harness();
      h.outline(h.file, [symbol("Store", kind, 4)]);
      await h.ready();

      const out = await h.run({ symbol: "Store" });
      expect(payload(out).direction).toBe("interfaces-implemented-by-type");
      expect(payload(out).resolved).toEqual({ name: "Store", kind: kindName, file: h.file, line: 5 });
      expect(textOf(out)).toContain(`Interfaces implemented by ${kindName} "Store"`);
    }
  });

  it("returns a scoped empty for an interface nothing implements, not an error", async () => {
    const h = harness();
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(rowsOf(out)).toEqual([]);
    expect(payload(out).truncated).toBe(0);
    expect(textOf(out)).toContain("0 row(s)");
  });

  it("leaves a row outside the module unnamed, and never opens or reads it", async () => {
    const h = harness();
    const outside = join(h.tmp, "outside", "io.go");
    h.answer([location(outside, 70)]);
    await h.ready();

    const out = await h.run();
    expect(rowsOf(out)).toEqual([
      {
        name: null,
        kind: null,
        file: outside,
        line: 71,
        external: true,
        reason: "outside the module root; not named",
      },
    ]);
    expect(h.read.mock.calls.every((call) => call[0] !== outside)).toBe(true);
    expect(h.server.notifications.some(([, params]) => JSON.stringify(params)?.includes("io.go"))).toBe(false);
  });

  it("reads a LocationLink answer as readily as a Location answer", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [PG]);
    h.answer([locationLink(pg, 21)]);
    await h.ready();

    const out = await h.run();
    expect(rowsOf(out)).toEqual([{ name: "PgStorage", kind: "struct", file: pg, line: 22, external: false }]);
  });

  it("keeps a row whose name cannot be found in the file, saying why instead of dropping it", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [PG]);
    h.answer([location(pg, 40)]);
    await h.ready();

    const out = await h.run();
    expect(rowsOf(out)).toEqual([
      {
        name: null,
        kind: null,
        file: pg,
        line: 41,
        external: false,
        reason: "no top-level declaration in this file encloses the reported location",
      },
    ]);
  });

  it("names the type a one-line declaration shares its line with a field, not the field", async () => {
    const h = harness();
    const disk = join(h.mod, "disk.go");
    // `type DiskSink struct { saved string }` on one line: the type's range spans the line, the field's
    // sits inside it, and gopls reports the implementer at the type name.
    h.outline(disk, [
      ranged("DiskSink", 23, 4, 0, 33, [ranged("saved", 8, 4, 19, 31)]),
    ]);
    h.answer([location(disk, 4, 5)]);
    await h.ready();

    const out = await h.run();
    expect(rowsOf(out)).toEqual([
      { name: "DiskSink", kind: "struct", file: disk, line: 5, external: false },
    ]);
  });

  it("tells two top-level declarations on one line apart by character, in the order reported", async () => {
    const h = harness();
    const pair = join(h.mod, "pair.go");
    // `type A int; type B int` — a line-only match would name both of them "A".
    h.outline(pair, [ranged("A", 23, 3, 0, 10), ranged("B", 23, 3, 12, 22)]);
    h.answer([location(pair, 3, 17), location(pair, 3, 5)]);
    await h.ready();

    const out = await h.run();
    expect(rowsOf(out).map((row) => row.name)).toEqual(["B", "A"]);
  });

  it("looks past a whole-file wrapper declaration when naming a row", async () => {
    const h = harness();
    const wrapped = join(h.mod, "wrapped.go");
    // An outline can carry the package clause as a declaration spanning the file; it contains every
    // location in it and must never win the match.
    h.outline(wrapped, [ranged("fiximpl", 4, 0, 0, 60), ranged("Wrapped", 23, 5, 0, 20)]);
    h.answer([location(wrapped, 5, 6)]);
    await h.ready();

    const out = await h.run();
    expect(rowsOf(out)).toEqual([{ name: "Wrapped", kind: "struct", file: wrapped, line: 6, external: false }]);
  });

  it("names in-module rows first and in reported order, when the outline reads finish out of order", async () => {
    const h = harness();
    const late = join(h.mod, "late.go");
    const quick = join(h.mod, "quick.go");
    h.outline(late, [symbol("Late", 23, 3)]);
    h.outline(quick, [symbol("Quick", 23, 3)]);
    h.answer([location(late, 3), location(quick, 3)]);
    const releaseLate = h.delayOutline(late);
    await h.ready();

    const running = h.run();
    await waitUntil(() => notes(h.server).includes(`textDocument/didClose ${quick}`), "the fast read to finish");
    releaseLate();

    expect(rowsOf(await running).map((row) => row.name)).toEqual(["Late", "Quick"]);
    // The fast file was opened, asked and released while the slow one was still being asked, so the row
    // order cannot be the completion order: both reads were in flight at once.
    const writes = notes(h.server);
    expect(writes.indexOf(`textDocument/didOpen ${quick}`)).toBeLessThan(
      writes.indexOf(`textDocument/didClose ${late}`),
    );
    expect(writes[writes.length - 1]).toBe(`textDocument/didClose ${late}`);
  }, 10_000);

  it("keeps a row whose file gopls refuses to outline, with the server's reason beside it", async () => {
    const h = harness();
    const broken = join(h.mod, "broken.go");
    h.failToOutline(broken);
    h.answer([location(broken, 3)]);
    await h.ready();

    const out = await h.run();
    const [only] = rowsOf(out);
    expect(only).toMatchObject({ name: null, kind: null, file: broken, line: 4, external: false });
    expect(String(only?.reason)).toContain("no package metadata for file");
  });

  it("fails loudly on a location it cannot read rather than reporting a shorter answer", async () => {
    const h = harness();
    h.answer([{ nonsense: true }]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/cannot read/);
    expect(textOf(out)).toContain('"Storage"');
    expect(textOf(out)).toMatch(/entry 1/);
  });

  it("keeps in-module rows ahead of external ones when the cap bites, and counts what it dropped", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [PG]);
    const many = Array.from({ length: IMPLEMENTATIONS_LIMIT + 10 }, (_unused, index) =>
      location(join(h.tmp, "outside", `f${index}.go`), index),
    );
    h.answer([...many, location(pg, 21)]);
    await h.ready();

    const out = await h.run();
    const rows = rowsOf(out);
    expect(rows).toHaveLength(IMPLEMENTATIONS_LIMIT);
    expect(rows[0]).toMatchObject({ name: "PgStorage", external: false });
    expect(rows[1]).toMatchObject({ external: true, name: null });
    expect(payload(out).truncated).toBe(11);
    expect(textOf(out)).toContain(`${IMPLEMENTATIONS_LIMIT}-row cap`);
    // The fan-out stopped at the rows that survived the cap, so no dropped file was ever opened.
    expect(h.server.methods.filter((method) => method === "textDocument/documentSymbol")).toHaveLength(3);
  });

  it("surfaces what the freshness check cost in scope", async () => {
    const h = harness();
    await h.ready();
    // A real file appearing in the module after the child started is what the walk reports; the answer
    // itself comes from the fake, so only `scope.freshness` is under test here.
    writeFileSync(join(h.mod, "later.go"), "package mod\n\n// Later appears after the load.\ntype Later struct{}\n");

    const out = await h.run();
    expect(payload(out).scope.freshness).toEqual({ kind: "pushed", changedFiles: 1 });
    expect(textOf(out)).toContain("pushed 1 changed file(s)");
  });

  it("names the files their filename excludes, from the environment it asked about in the module", async () => {
    const h = harness();
    const linuxOnly = join(h.mod, "disk_linux.go");
    const onHost = join(h.mod, "net_windows.go");
    writeFileSync(linuxOnly, "package mod\n");
    writeFileSync(onHost, "package mod\n");
    await h.ready();

    const out = await h.run();
    const scope = scopeOf(out);
    expect(scope.environment).toEqual(WINDOWS_AMD64);
    expect(scope.osArchExcluded).toEqual({ count: 1, files: [linuxOnly], namedFileExcluded: false });
    expect(exclusivesOf(scope)).toEqual(["environment", "osArchExcluded"]);
    expect(textOf(out)).toContain("1 filename-excluded .go file(s) absent from this answer");

    expect(h.go.asked("env")).toMatchObject({
      cwd: resolve(h.mod),
      args: ["env", "-json"],
      env: { GOWORK: "off", GOTOOLCHAIN: "local" },
    });
    // The workspace question is the one call that must not carry the override that hides the workspace.
    expect(h.go.asked("work")).toMatchObject({
      cwd: resolve(h.mod),
      args: ["env", "GOWORK"],
      env: { GOTOOLCHAIN: "local" },
    });
    // One pass per module root: the environment and the port list come out of the same three calls.
    expect(h.go.calls).toHaveLength(3);
  });

  it("says when the file the caller named is itself filename-excluded", async () => {
    const h = harness({ go: fakeGo({ env: ran(goEnvJson({ GOOS: "linux" })) }) });
    const windowsOnly = join(h.mod, "store_windows.go");
    writeFileSync(windowsOnly, "package mod\n");
    h.outline(windowsOnly, [STORAGE]);
    await h.ready();

    const out = await h.run({ file: windowsOnly });
    expect(scopeOf(out).osArchExcluded).toMatchObject({ namedFileExcluded: true, files: [windowsOnly] });
  });

  it("carries a go.work the answer deliberately does not span", async () => {
    // The value is the fake `go env GOWORK`'s own answer; nothing here reads the workspace itself.
    const workspace = join(tmpdir(), "mcp-code-nav-work", "go.work");
    const h = harness({ go: fakeGo({ work: ran(workspace) }) });
    await h.ready();

    const out = await h.run();
    expect(scopeOf(out).environment).toMatchObject({ goWork: workspace });
    expect(textOf(out)).toContain(`go.work "${workspace}" not spanned`);
  });

  it("reports the environment it read and no exclusion set when the module was never walked", async () => {
    // A walk that cannot complete leaves the live session with no proven file set, so the blind-spot
    // signal has nothing to classify: it says so rather than reporting an empty one.
    const h = harness({ snapshot: () => undefined, autoReady: true });

    const out = await h.run();
    const scope = scopeOf(out);
    expect(scope.freshness).toEqual({ kind: "unchanged" });
    expect(scope.environment).toEqual(WINDOWS_AMD64);
    expect(String(scope.osArchExcludedUnavailable)).toMatch(/no module snapshot/);
    expect(exclusivesOf(scope)).toEqual(["environment", "osArchExcludedUnavailable"]);
    expect(textOf(out)).toMatch(/which of those files their own filename excludes — is unknown/);
  });

  it("gives up on the environment when the call's budget is spent, and answers anyway", async () => {
    const h = harness({ go: fakeGo({ env: "hang", work: "hang", dist: "hang" }) });
    await h.ready();

    const out = await h.run({ timeBudgetMs: 300 });
    expect(out.isError).toBeFalsy();
    const scope = scopeOf(out);
    expect(String(scope.environmentUnavailable)).toMatch(/within this call's 300 ms budget/);
    expect(exclusivesOf(scope)).toEqual(["environmentUnavailable"]);
  });

  it("names why the toolchain could not be asked, in three distinct reasons, and classifies no files without it", async () => {
    const missing = harness({ go: fakeGo({ env: notStarted("ENOENT", "go: executable file not found") }) });
    const nonzero = harness({ go: fakeGo({ env: exited(2, "go: unknown environment variable") }) });
    const unparsable = harness({ go: fakeGo({ env: ran("not json at all") }) });
    for (const h of [missing, nonzero, unparsable]) await h.ready();

    const results = await Promise.all([missing.run(), nonzero.run(), unparsable.run()]);
    const reasons = results.map((out) => String(scopeOf(out).environmentUnavailable));
    expect(new Set(reasons).size).toBe(3);
    expect(reasons[0]).toMatch(/go is not on PATH/);
    expect(reasons[1]).toMatch(/exited with code 2/);
    expect(reasons[2]).toMatch(/did not answer with JSON/);
    for (const out of results) {
      expect(out.isError).toBeFalsy();
      expect(exclusivesOf(scopeOf(out))).toEqual(["environmentUnavailable"]);
      expect(textOf(out)).toContain("the port this answer describes is unknown");
    }
  });

  it("refuses a query gopls answered with no package metadata, naming the file and the constraint", async () => {
    const h = harness();
    const tagged = join(h.mod, "gpu.go");
    h.refuseImplementation(`no package metadata for file ${tagged}`);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(`"${tagged}"`);
    expect(textOf(out)).toMatch(/Commonly a build constraint/);
    expect(textOf(out)).toContain("//go:build");
    expect(textOf(out)).toMatch(/filename carries no GOOS\/GOARCH suffix/);
    expect(textOf(out)).toContain('"Storage"');
  });

  it("says the filename rule explains a no-package-metadata file whose name carries an excluding suffix", async () => {
    const h = harness();
    const excluded = join(h.mod, "gpu_plan9.go");
    h.refuseImplementation(`no package metadata for file ${excluded}`);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/exactly the exclusion `scope.osArchExcluded` reports/);
  });

  it("propagates any other refusal from the query to the caller's handler", async () => {
    const h = harness();
    h.refuseImplementation("no identifier found");
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("no identifier found");
    expect(textOf(out)).not.toMatch(/build constraint/);
  });

  itIfCaseInsensitive("reuses the queried file's outline for a row gopls spelled with another drive-letter case", async () => {
    const h = harness();
    const recased = h.file.replace(
      /^([A-Za-z]:)/,
      (drive) => (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()),
    );
    h.answer([location(recased, 15)]);
    await h.ready();

    const out = await h.run();
    expect(rowsOf(out)).toEqual([
      { name: "Storage", kind: "interface", file: recased, line: 16, external: false },
    ]);
    // Two outline requests only — the one that starts the child and the one for the queried file. A raw
    // string comparison would have asked for the same file a third time under its other spelling.
    expect(h.server.methods.filter((method) => method === "textDocument/documentSymbol")).toHaveLength(2);
  });

  it("fails at the budget when the initial workspace load was never proven, asking nothing type-aware", async () => {
    const h = harness();
    h.answer([location(join(h.mod, "pg.go"), 21)]);

    const out = await h.run({ timeBudgetMs: 40 });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/initial workspace load/);
    expect(textOf(out)).toContain("40 ms budget");
    expect(h.server.methods).not.toContain("textDocument/implementation");
    expect(h.server.notifications.filter(([method]) => method === "textDocument/didOpen")).toHaveLength(1);
  });

  it("names the rows it can and says so when the naming step runs out of the budget", async () => {
    const h = harness();
    const quick = join(h.mod, "quick.go");
    const stuck = join(h.mod, "stuck.go");
    h.outline(quick, [symbol("Quick", 23, 3)]);
    h.outline(stuck, [symbol("Stuck", 23, 3)]);
    h.answer([location(quick, 3), location(stuck, 3)]);
    h.delayOutline(stuck);
    await h.ready();

    const out = await h.run({ timeBudgetMs: 60 });
    expect(out.isError).toBeFalsy();
    const rows = rowsOf(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Quick", kind: "struct", external: false });
    expect(rows[1]).toMatchObject({ name: null, kind: null, external: false });
    expect(String(rows[1]?.reason)).toMatch(/naming step ran out of the call's 60 ms budget/);
  }, 10_000);

  it("refuses an answer from a server that restarted while the query was in flight", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("PgStorage", 23, 3)]);
    h.answer([location(pg, 3)]);
    h.failNextImplementation();
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/gopls restarted during the query/);
    expect(textOf(out)).toMatch(/initial workspace load has not been proven/);
    // The retried query really was answered — what is refused is the proof, not the reply.
    expect(h.server.methods.filter((method) => method === "textDocument/implementation")).toHaveLength(2);
  }, 10_000);

  it("refuses to pick a direction for a func, because gopls cannot tell the two apart", async () => {
    const h = harness();
    h.outline(h.file, [symbol("Handler", 12, 8)]);
    await h.ready();

    const out = await h.run({ symbol: "Handler" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/named func type/);
    expect(textOf(out)).toMatch(/cannot be decided/);
    expect(h.server.methods).not.toContain("textDocument/implementation");
  });

  it.each([
    ["method", 6],
    ["variable", 13],
    ["constant", 14],
    ["field", 8],
  ])("refuses a %s, naming the kind and what does have a direction", async (kindName: string, kind: number) => {
    const h = harness();
    h.outline(h.file, [symbol("Decl", kind, 8)]);
    await h.ready();

    const out = await h.run({ symbol: "Decl" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(`is a ${kindName}`);
    expect(textOf(out)).toMatch(/only named types and interfaces have a direction/);
  });

  it("accepts either receiver spelling for a method, and a bare name for no method at all", async () => {
    for (const spelling of ["(Store).Save", "Store.Save"]) {
      const h = harness();
      h.outline(h.file, [symbol("(Store).Save", 6, 30)]);
      await h.ready();
      const out = await h.run({ symbol: spelling });
      expect(textOf(out)).toMatch(/is a method/);
      expect(textOf(out)).not.toMatch(/no top-level declaration/);
    }

    const h = harness();
    h.outline(h.file, [symbol("(Store).Save", 6, 30)]);
    await h.ready();
    const bare = await h.run({ symbol: "Save" });
    expect(bare.isError).toBe(true);
    expect(textOf(bare)).toMatch(/no top-level declaration named "Save"/);
  });

  it("lists every candidate when the name matches more than one top-level declaration", async () => {
    const h = harness();
    h.outline(h.file, [STORAGE, symbol("Storage", 23, 60, 62)]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/matches 2 top-level declarations/);
    expect(textOf(out)).toContain(`Storage (interface) at ${h.file}:14`);
    expect(textOf(out)).toContain(`Storage (struct) at ${h.file}:61`);
  });

  it("names the file it searched when the symbol is not declared there", async () => {
    const h = harness();
    await h.ready();

    const out = await h.run({ symbol: "Absent" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/no top-level declaration named "Absent"/);
    expect(textOf(out)).toContain(h.file);
  });

  it("fails rather than guessing a position when gopls reported no selection range", async () => {
    const h = harness();
    h.outline(h.file, [NO_SELECTION]);
    await h.ready();

    const out = await h.run({ symbol: "Bare" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/no selection range/);
    expect(h.server.methods).not.toContain("textDocument/implementation");
  });

  it("fails before starting a child for a file that is in no Go module", async () => {
    const h = harness();
    const plain = join(h.tmp, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "a.go"), "package a\n");

    const out = await h.run({ sourceRoots: [plain], file: join(plain, "a.go") });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/not inside a Go module/);
    expect(h.server.methods).toEqual([]);
  });

  it("fails when the module governing the file sits outside the declared roots, naming both", async () => {
    const h = harness();
    const pkg = join(h.mod, "pkg");
    mkdirSync(pkg, { recursive: true });
    const inPkg = join(pkg, "a.go");
    writeFileSync(inPkg, "package pkg\n");

    const out = await h.run({ sourceRoots: [pkg], file: inPkg });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/outside every declared sourceRoots entry/);
    expect(textOf(out)).toContain(resolve(h.mod));
    expect(textOf(out)).toContain(resolve(pkg));
  });

  it("keeps the tried spellings of a relative file when the session throws on the way to an answer", async () => {
    const h = harness({
      spawn: () => {
        throw new Error("Cannot start gopls: \"gopls\" on PATH was not found");
      },
    });

    const out = await h.run({ sourceRoots: [h.tmp, h.mod], file: "storage.go" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("Cannot start gopls");
    expect(textOf(out)).toMatch(/Resolved "storage\.go" to "/);
    expect(textOf(out)).toMatch(/\(tried: "/);
  });

  it("roots gopls at the module and asks only methods its config allows", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [PG]);
    h.answer([location(pg, 21)]);
    await h.ready();
    await h.run();

    expect(h.server.requests[0]?.[1]).toMatchObject({ rootUri: uriOf(resolve(h.mod)) });
    expect(h.server.methods).toEqual([
      "initialize",
      "textDocument/documentSymbol",
      "textDocument/documentSymbol",
      "textDocument/implementation",
      "textDocument/documentSymbol",
    ]);
  });
});
