import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGoFindReferences } from "../../src/tools/go-find-references.js";
import { REFERENCE_FILES_LIMIT, REFERENCE_SITES_PER_FILE_LIMIT } from "../../src/tools/navigation-limits.js";
import { notStarted, fakeGo, WINDOWS_AMD64, type FakeGo } from "../helpers/fake-go.js";
import { uriOf, type FakeServer } from "../helpers/fake-lsp.js";
import {
  buildGoToolHarness,
  cleanupGoToolHarnesses,
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

type Result = Awaited<ReturnType<typeof runGoFindReferences>>;
type Input = {
  sourceRoots: string[];
  file: string;
  symbol: string;
  includeDeclaration: boolean;
  timeBudgetMs: number;
};
type FileGroup = Record<string, unknown>;
type Site = Record<string, unknown>;

const REFERENCES_METHOD = "textDocument/references";

interface Harness extends GoToolHarness {
  answer(locations: unknown[]): void;
  /** Kills the child the next time it is asked a `references` query, then answers from its replacement. */
  failNextReferences(): void;
  /** Makes every `references` query reject with this message, the way a refused file does. */
  refuseReferences(message: string): void;
  run(overrides?: Partial<Input>): Promise<Result>;
}

/** What the test wants that `go`, or the child process, answers differently. */
type HarnessOptions = Pick<GoToolHarnessOptions, "go" | "spawn">;

const STORAGE = symbol("Storage", 11, 13, 17);
const OPEN = symbol("Open", 12, 20, 25);

/** One `Location` as gopls spells it: 0-based line and character. */
function location(path: string, line: number, character = 4): unknown {
  return { uri: uriOf(path), range: { start: { line, character }, end: { line, character: character + 5 } } };
}

/** A gopls whose outlines and `references` answer the test supplies, rooted at a real temp module. */
function harness(options: HarnessOptions = {}): Harness {
  const core = buildGoToolHarness({
    prefix: "mcp-code-nav-goref-",
    fileName: "storage.go",
    outline: [STORAGE, OPEN],
    expects: [REFERENCES_METHOD],
    go: options.go,
    spawn: options.spawn,
  });
  return {
    ...core,
    answer: (locations) => core.query.answer(REFERENCES_METHOD, locations),
    failNextReferences: () => core.query.crashNext(REFERENCES_METHOD),
    refuseReferences: (message) => core.query.refuse(REFERENCES_METHOD, message),
    run: (overrides) =>
      runGoFindReferences(
        core.manager,
        {
          sourceRoots: [core.mod],
          file: core.file,
          symbol: "Storage",
          includeDeclaration: false,
          timeBudgetMs: 60_000,
          ...overrides,
        },
        { exec: core.go.exec },
      ),
  };
}

function filesOf(result: Result): FileGroup[] {
  return payload(result).files as FileGroup[];
}

/** How many outline requests the fake saw, which is how many files the naming fan-out read. */
function documentSymbolCount(server: FakeServer): number {
  return countOf(server, "textDocument/documentSymbol");
}

/** The `scope` the mocked toolchain and an untouched module produce. */
function expectedScope(visibility: string, limits: string[]): Record<string, unknown> {
  return {
    moduleRoot: undefined,
    freshness: { kind: "unchanged" },
    visibility,
    environment: WINDOWS_AMD64,
    osArchExcluded: { count: 0, files: [], namedFileExcluded: false },
    limits,
  };
}

describe("runGoFindReferences", () => {
  afterEach(() => cleanupGoToolHarnesses());

  it("groups every reported use by file, naming each one and stating the boundary it was computed under", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    const outside = join(h.tmp, "outside", "io.go");
    h.outline(pg, [symbol("Serve", 12, 39, 45)]);
    h.answer([location(pg, 40, 8), location(h.file, 22, 2), location(outside, 70, 1)]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(payload(out)).toEqual({
      resolved: { name: "Storage", kind: "interface", file: h.file, line: 14 },
      totalReferences: 3,
      files: [
        {
          file: pg,
          external: false,
          count: 1,
          sitesTruncated: 0,
          sites: [{ line: 41, column: 9, in: "Serve" }],
        },
        {
          file: h.file,
          external: false,
          count: 1,
          sitesTruncated: 0,
          sites: [{ line: 23, column: 3, in: "Open" }],
        },
        {
          file: outside,
          external: true,
          count: 1,
          sitesTruncated: 0,
          sites: [{ line: 71, column: 2, in: null, reason: "outside the module root; not named" }],
        },
      ],
      filesTruncated: 0,
      scope: {
        ...expectedScope("exported", ["one-module", "one-port", "exported-symbol-importers-invisible"]),
        moduleRoot: resolve(h.mod),
      },
    });
    expect(textOf(out)).toContain('References to interface "Storage"');
    expect(textOf(out)).toContain("3 reference(s) across 3 file(s)");
    expect(textOf(out)).toContain("visibility: exported");
    expect(textOf(out)).toContain("limits: one-module, one-port, exported-symbol-importers-invisible");
  });

  it("asks about the name and not the keyword: the position is selectionRange.start", async () => {
    const h = harness();
    await h.ready();
    await h.run();

    expect(requestFor(h.server, "textDocument/references")).toEqual({
      textDocument: { uri: uriOf(h.file) },
      position: { line: 13, character: 5 },
      context: { includeDeclaration: false },
    });
  });

  it("passes includeDeclaration through to gopls, defaulting to no", async () => {
    const h = harness();
    await h.ready();

    await h.run({ includeDeclaration: true });
    expect(requestFor(h.server, "textDocument/references")).toMatchObject({
      context: { includeDeclaration: true },
    });
  });

  it("counts every use gopls reported even when both caps drop part of the listing", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 60)]);
    const manySites = Array.from({ length: REFERENCE_SITES_PER_FILE_LIMIT + 5 }, (_unused, index) =>
      location(pg, 40 + index, 4),
    );
    const manyFiles = Array.from({ length: REFERENCE_FILES_LIMIT + 2 }, (_unused, index) =>
      location(join(h.tmp, "outside", `f${index}.go`), 3, 1),
    );
    h.answer([...manySites, ...manyFiles]);
    await h.ready();

    const out = await h.run();
    const files = filesOf(out);
    expect(payload(out).totalReferences).toBe(manySites.length + manyFiles.length);
    expect(files).toHaveLength(REFERENCE_FILES_LIMIT);
    // 43 groups answered (pg plus one per external file), 40 listed.
    expect(payload(out).filesTruncated).toBe(3);
    // The exact per-file count survives the site cap, which narrows only what is listed.
    expect(files[0]).toMatchObject({ file: pg, external: false, count: manySites.length, sitesTruncated: 5 });
    expect((files[0]?.sites as Site[])).toHaveLength(REFERENCE_SITES_PER_FILE_LIMIT);
    expect(limitsOf(out)).toContain("listing-capped");
    const listed = files.reduce((total, group) => total + (group.count as number), 0);
    // Each dropped group held exactly one site, so the exact total is the listed counts plus those groups.
    expect(payload(out).totalReferences).toBe(listed + (payload(out).filesTruncated as number));
    // Naming stopped at the sites that survived the caps, so no dropped group was ever opened.
    expect(documentSymbolCount(h.server)).toBe(3);
    expect(h.session.getOpenedFiles()).toEqual([h.file]);
  });

  it("keeps the in-module group when gopls reported the external ones first and the cap bit", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 45)]);
    const externalFirst = Array.from({ length: REFERENCE_FILES_LIMIT + 2 }, (_unused, index) =>
      location(join(h.tmp, "outside", `f${index}.go`), 3, 1),
    );
    h.answer([...externalFirst, location(pg, 40, 8)]);
    await h.ready();

    const out = await h.run();
    const files = filesOf(out);
    expect(payload(out).totalReferences).toBe(externalFirst.length + 1);
    expect(files).toHaveLength(REFERENCE_FILES_LIMIT);
    // The in-module group was reported last and still survived; the dropped ones are all external.
    expect(files[0]).toMatchObject({ file: pg, external: false, count: 1, sites: [{ line: 41, column: 9, in: "Serve" }] });
    expect(files.filter((group) => !group.external)).toHaveLength(1);
    expect(files.slice(1).every((group) => group.external)).toBe(true);
    expect(payload(out).filesTruncated).toBe(3);
  });

  it("carries listing-capped when only the per-file site cap bites, with the group's count still exact", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 70)]);
    const many = REFERENCE_SITES_PER_FILE_LIMIT + 5;
    h.answer(Array.from({ length: many }, (_unused, index) => location(pg, 40 + index, 4)));
    await h.ready();

    const out = await h.run();
    expect(payload(out).totalReferences).toBe(many);
    expect(payload(out).filesTruncated).toBe(0);
    expect(filesOf(out)).toHaveLength(1);
    expect(filesOf(out)[0]).toMatchObject({ file: pg, count: many, sitesTruncated: 5 });
    expect((filesOf(out)[0]?.sites as Site[])).toHaveLength(REFERENCE_SITES_PER_FILE_LIMIT);
    // One cap biting is enough for the code: it says the listing narrowed, not that both caps did.
    expect(limitsOf(out)).toContain("listing-capped");
  });

  it("answers a symbol nothing uses with a scoped empty, which is what proves readiness was observed", async () => {
    const h = harness();
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(payload(out).totalReferences).toBe(0);
    expect(filesOf(out)).toEqual([]);
    expect(payload(out).filesTruncated).toBe(0);
    expect(textOf(out)).toContain("0 reference(s)");
    expect(textOf(out)).not.toMatch(/cannot be proven complete/);
  });

  it("keeps a use whose file gopls refuses to outline, saying why instead of dropping it", async () => {
    const h = harness();
    const broken = join(h.mod, "broken.go");
    h.failToOutline(broken);
    h.answer([location(broken, 3, 2)]);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    const [group] = filesOf(out);
    expect(group).toMatchObject({ file: broken, external: false, count: 1, sitesTruncated: 0 });
    const [site] = (group?.sites ?? []) as Site[];
    expect(site).toMatchObject({ line: 4, column: 3, in: null });
    expect(String(site?.reason)).toContain("no package metadata for file");
  });

  it("keeps a use no top-level declaration encloses, naming the reason rather than losing the row", async () => {
    const h = harness();
    const pg = join(h.mod, "pg.go");
    h.outline(pg, [symbol("Serve", 12, 39, 45)]);
    h.answer([location(pg, 60, 4)]);
    await h.ready();

    const out = await h.run();
    expect((filesOf(out)[0]?.sites as Site[])[0]).toEqual({
      line: 61,
      column: 5,
      in: null,
      reason: "no top-level declaration in this file encloses the reported location",
    });
  });

  it("reports a use outside the module without ever opening or reading that file", async () => {
    const h = harness();
    const outside = join(h.tmp, "outside", "io.go");
    h.answer([location(outside, 70, 1)]);
    await h.ready();

    const out = await h.run();
    expect(filesOf(out)).toEqual([
      {
        file: outside,
        external: true,
        count: 1,
        sitesTruncated: 0,
        sites: [{ line: 71, column: 2, in: null, reason: "outside the module root; not named" }],
      },
    ]);
    expect(h.read.mock.calls.every((call) => call[0] !== outside)).toBe(true);
    expect(openedPaths(h.server)).toEqual([h.file]);
  });

  it.each([
    ["(*Store).Get", "exported"],
    ["(*store).Get", "exported"],
    ["(*Store).get", "package-private"],
    ["(*store).get", "package-private"],
    ["(m *Store).Get", "exported"],
    ["(m *store).Get", "exported"],
    ["(m *store).get", "package-private"],
    ["(Store).Get", "exported"],
    ["Store.Get", "exported"],
    ["store.Get", "exported"],
    ["Store.get", "package-private"],
    ["store.get", "package-private"],
    ["Cache[K, V].Get", "exported"],
    ["cache[K, V].get", "package-private"],
    ["(*Store[K, V]).Get", "exported"],
    ["(*store[K, V]).Get", "exported"],
    ["(*store[T]).get", "package-private"],
    ["(*Store).Éclat", "exported"],
    ["(*Store).éclat", "package-private"],
    ["(*Store).ǅx", "package-private"],
    ["Store", "exported"],
    ["store", "package-private"],
    ["_store", "package-private"],
  ])("reads the visibility of %s as %s", async (name: string, visibility: string) => {
    const h = harness();
    h.outline(h.file, [symbol(name, name.includes(".") ? 6 : 11, 13, 17)]);
    await h.ready();

    const out = await h.run({ symbol: name });
    expect(scopeOf(out).visibility).toBe(visibility);
    expect(limitsOf(out).includes("exported-symbol-importers-invisible")).toBe(visibility === "exported");
  });

  it("addresses a generic-receiver method by its base type", async () => {
    const h = harness();
    h.outline(h.file, [symbol("(*Store[K, V]).Get", 6, 30, 33)]);
    await h.ready();

    // Every spelling that names the base type and the method is the same declaration: no not-found, and
    // never an ambiguity with itself.
    for (const spelling of ["Store.Get", "(*Store).Get", "(*Store[K, V]).Get", "(s *Store[K,V]).Get"]) {
      const out = await h.run({ symbol: spelling });
      expect(out.isError, `${spelling}: ${textOf(out)}`).toBeFalsy();
      expect(payload(out).resolved).toMatchObject({ name: "(*Store[K, V]).Get", kind: "method" });
    }
  });

  it("two generic types sharing a method name are not one declaration", async () => {
    const h = harness();
    // A receiver read that stopped at the last whitespace token would key both of these `V].Get`, making
    // `A.Get` ambiguous; a bare `Get` is a different declaration again.
    h.outline(h.file, [symbol("(*A[K, V]).Get", 6, 30, 33), symbol("(*B[K, V]).Get", 6, 40, 43)]);
    await h.ready();

    const first = await h.run({ symbol: "A.Get" });
    expect(first.isError, textOf(first)).toBeFalsy();
    expect(payload(first).resolved).toMatchObject({ name: "(*A[K, V]).Get" });

    const bare = await h.run({ symbol: "Get" });
    expect(bare.isError).toBe(true);
    expect(textOf(bare)).toMatch(/no top-level declaration named "Get"/);
  });

  it.each([
    [true, true, true, ["one-module", "one-port", "osarch-excluded-files", "exported-symbol-importers-invisible", "listing-capped"]],
    [true, true, false, ["one-module", "one-port", "osarch-excluded-files", "exported-symbol-importers-invisible"]],
    [true, false, true, ["one-module", "one-port", "exported-symbol-importers-invisible", "listing-capped"]],
    [true, false, false, ["one-module", "one-port", "exported-symbol-importers-invisible"]],
    [false, true, true, ["one-module", "one-port", "osarch-excluded-files", "listing-capped"]],
    [false, true, false, ["one-module", "one-port", "osarch-excluded-files"]],
    [false, false, true, ["one-module", "one-port", "listing-capped"]],
    [false, false, false, ["one-module", "one-port"]],
  ])(
    "states the boundary codes for exported=%s, excluded-files=%s, cap-bitten=%s",
    async (exported: boolean, excluded: boolean, capped: boolean, limits: string[]) => {
      const h = harness();
      h.outline(h.file, [symbol(exported ? "Storage" : "storage", 11, 13, 17)]);
      if (excluded) writeFileSync(join(h.mod, "disk_linux.go"), "package mod\n");
      const sites = capped
        ? Array.from({ length: REFERENCE_FILES_LIMIT + 1 }, (_unused, index) =>
            location(join(h.tmp, "outside", `f${index}.go`), index + 1, 1),
          )
        : [location(h.file, 22, 2)];
      h.answer(sites);
      await h.ready();

      const out = await h.run({ symbol: exported ? "Storage" : "storage" });
      expect(limitsOf(out)).toEqual(limits);
    },
  );

  it("drops one-port with the environment it describes, and says the port is unknown", async () => {
    const h = harness({ go: fakeGo({ env: notStarted("ENOENT", "go: executable file not found") }) });
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBeFalsy();
    expect(limitsOf(out)).toEqual(["one-module", "exported-symbol-importers-invisible"]);
    expect(textOf(out)).toContain("the port this answer describes is unknown");
  });

  it("adds corresponding-interface-methods-included for a method, and never indirect-dispatch-not-resolved", async () => {
    const h = harness();
    h.outline(h.file, [STORAGE, OPEN, symbol("(*Store).Get", 6, 30, 33)]);
    await h.ready();

    const method = await h.run({ symbol: "(*Store).Get" });
    expect(method.isError, textOf(method)).toBeFalsy();
    expect(scopeOf(method).visibility).toBe("exported");
    // A use listing over-reports through the correspondence; it never narrows on dispatch.
    expect(limitsOf(method)).toEqual([
      "one-module",
      "one-port",
      "exported-symbol-importers-invisible",
      "corresponding-interface-methods-included",
    ]);

    const iface = await h.run({ symbol: "Storage" });
    expect(iface.isError, textOf(iface)).toBeFalsy();
    expect(limitsOf(iface)).not.toContain("corresponding-interface-methods-included");
    expect(limitsOf(iface)).not.toContain("indirect-dispatch-not-resolved");
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

  it("fails at the budget when the initial workspace load was never proven, asking nothing type-aware", async () => {
    const h = harness();
    h.answer([location(join(h.mod, "pg.go"), 21)]);

    // The clock is held, so the expiry can only land on the readiness wait: every step above it answers on
    // a microtask, so a starved host cannot spend the 40 ms before the step under test is reached.
    const out = await runUntilBudgetExpires(() => h.run({ timeBudgetMs: 40 }), 40);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/initial workspace load/);
    expect(textOf(out)).toContain("40 ms budget");
    expect(h.server.methods).not.toContain("textDocument/references");
  });

  it("refuses an answer from a server that restarted while the query was in flight", async () => {
    const h = harness();
    h.answer([location(join(h.mod, "pg.go"), 3)]);
    h.failNextReferences();
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/gopls restarted during the query/);
    expect(textOf(out)).toMatch(/initial workspace load has not been proven/);
    // The retried query really was answered — what is refused is the proof, not the reply.
    expect(h.server.methods.filter((method) => method === "textDocument/references")).toHaveLength(2);
  }, 10_000);

  it("refuses a query gopls answered with no package metadata, naming the file and the constraint", async () => {
    const h = harness();
    const tagged = join(h.mod, "gpu.go");
    h.refuseReferences(`no package metadata for file ${tagged}`);
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(`"${tagged}"`);
    expect(textOf(out)).toMatch(/Commonly a build constraint/);
    expect(textOf(out)).toMatch(/filename carries no GOOS\/GOARCH suffix/);
  });

  it("propagates any other refusal from the query to the caller's handler", async () => {
    const h = harness();
    h.refuseReferences("no identifier found");
    await h.ready();

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("no identifier found");
    expect(textOf(out)).not.toMatch(/build constraint/);
  });

  it("names the file it searched when the symbol is not declared there", async () => {
    const h = harness();
    await h.ready();

    const out = await h.run({ symbol: "Absent" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/no top-level declaration named "Absent"/);
    expect(textOf(out)).toContain(h.file);
    expect(h.server.methods).not.toContain("textDocument/references");
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

  it("fails rather than guessing a position when gopls reported no selection range", async () => {
    const h = harness();
    h.outline(h.file, [{ name: "Bare", kind: 11, range: { start: { line: 2 }, end: { line: 4 } } }]);
    await h.ready();

    const out = await h.run({ symbol: "Bare" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/no selection range/);
    expect(h.server.methods).not.toContain("textDocument/references");
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
  });

  it("refuses a relative file that exists under two declared roots, naming both candidates", async () => {
    const h = harness();
    writeFileSync(join(h.tmp, "storage.go"), "package mod\n");

    const out = await h.run({ sourceRoots: [h.tmp, h.mod], file: "storage.go" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/exists under more than one declared root/);
    expect(textOf(out)).toContain(resolve(h.tmp));
    expect(textOf(out)).toContain(resolve(join(h.mod, "storage.go")));
    expect(textOf(out)).toContain("pass an absolute path");
    // Deciding between roots is a boundary question, so it is settled before any child is started.
    expect(h.server.methods).toEqual([]);
  });

  it("fails with gopls's own unavailability text when no session can be obtained", async () => {
    const h = harness({ spawn: missingGoplsSpawn() });

    const out = await h.run();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("Cannot start gopls");
    expect(textOf(out)).toContain("MCP_CODE_NAV_GOPLS");
    expect(textOf(out)).toContain("go install golang.org/x/tools/gopls@latest");
  });

  it("keeps the tried spellings of a relative file when the prelude throws on the way to an answer", async () => {
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
    h.outline(pg, [symbol("Serve", 12, 39, 45)]);
    h.answer([location(pg, 40, 8)]);
    await h.ready();
    await h.run();

    expect(h.server.requests[0]?.[1]).toMatchObject({ rootUri: uriOf(resolve(h.mod)) });
    expect(h.server.methods).toEqual([
      "initialize",
      "textDocument/documentSymbol",
      "textDocument/documentSymbol",
      "textDocument/references",
      "textDocument/documentSymbol",
    ]);
  });
});
