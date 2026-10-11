import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runCppFindCallers, type CallerRow, type CppFindCallersPayload } from "../../src/tools/cpp-find-callers.js";
import { runCppFindReferences, type CppFindReferencesPayload } from "../../src/tools/cpp-find-references.js";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";
import { runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";

// clangd is optional on this host in exactly the way gopls is, so the suite skips rather than failing with
// the symptom it exists to detect. `MCP_CODE_NAV_CLANGD` overrides, as it does at runtime.
function isClangdAvailable(): boolean {
  try {
    execFileSync(process.env.MCP_CODE_NAV_CLANGD ?? "clangd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const itIfClangd = isClangdAvailable() ? it : it.skip;

/**
 * The two C++ listing tools, asked of a real clangd over a real index. What this suite pins
 * is what no faked connection can say: that clangd's index reports the uses and callers this server then
 * groups, caps and names; that a translation unit outside every declared `sourceRoots` entry arrives as a
 * location this server states without ever opening; that a source the compile database never named is both
 * a listed blind spot and the reason a caller really exists yet is absent; and which way clangd resolves a
 * call that reaches its subject indirectly — through a base declaration, or through a function value.
 *
 * 1-based lines as written below.
 */
const SHAPE_H = [
  "#pragma once", //                       1
  "", //                                  2
  "namespace gizmo {", //                  3
  "", //                                  4
  "/// A drawn thing.", //                 5
  "class Shape {", //                      6
  "public:", //                            7
  "  virtual int area() const;", //        8
  "", //                                  9
  "  int side() const;", //               10
  "};", //                                11
  "", //                                 12
  "class Circle : public Shape {", //     13
  "public:", //                           14
  "  int area() const override;", //      15
  "", //                                 16
  "  int radius;", //                     17
  "};", //                                18
  "", //                                 19
  "int total(const Shape *s);", //        20
  "int twice(Shape *s);", //              21
  "int square(const Circle &c);", //      22
  "", //                                 23
  "/// A second override of the same virtual, so \"under every override\" is tested against two.", // 24
  "class Ring : public Shape {", //       25
  "public:", //                           26
  "  int area() const override;", //      27
  "", //                                 28
  "  int band;", //                       29
  "};", //                                30
  "}  // namespace gizmo", //             31
  "", //                                 32
].join("\n");

/** The base's non-virtual member calls the virtual on `this`: a direct call, not a dispatch. */
const CIRCLE_CPP = [
  '#include "shape.h"', //                    1
  "", //                                     2
  "namespace gizmo {", //                    3
  "", //                                     4
  "int Shape::side() const {", //            5
  "  return area();", //                     6
  "}", //                                    7
  "", //                                     8
  "int Circle::area() const {", //           9
  "  return radius * 2;", //                10
  "}", //                                   11
  "", //                                    12
  "int Ring::area() const {", //             13
  "  return band * 4;", //                   14
  "}", //                                    15
  "", //                                     16
  "}  // namespace gizmo", //                17
  "", //                                     18
].join("\n");

/** Two calls through a base pointer, two through a reference to the derived type, one direct call. */
const TOTAL_CPP = [
  '#include "shape.h"', //                   1
  "", //                                     2
  "namespace gizmo {", //                    3
  "", //                                     4
  "int total(const Shape *s) {", //          5
  "  return s->area()", //                   6
  "       + s->area();", //                  7
  "}", //                                    8
  "", //                                     9
  "int twice(Shape *s) {", //               10
  "  return total(s);", //                  11
  "}", //                                   12
  "", //                                    13
  "int square(const Circle &c) {", //       14
  "  return c.area() * c.area();", //       15
  "}", //                                   16
  "", //                                    17
  "}  // namespace gizmo", //               18
  "", //                                    19
].join("\n");

/** In the compile database but outside every declared source root: a location to report, never to read. */
const ELSEWHERE_CPP = [
  '#include "shape.h"', //                        1
  "", //                                         2
  "int elsewhere(const gizmo::Shape *s) {", //   3
  "  return gizmo::total(s);", //                4
  "}", //                                         5
  "", //                                         6
].join("\n");

/** A function value bound to the subject, and a call made through that value rather than its name. */
const POINTER_CPP = [
  '#include "shape.h"', //                                1
  "", //                                                 2
  "int (*pick)(const gizmo::Shape *) = &gizmo::total;", //  3
  "", //                                                 4
  "int viaPointer(const gizmo::Shape *s) {", //           5
  "  return pick(s);", //                                6
  "}", //                                                 7
  "", //                                                 8
].join("\n");

/** The blind spot: never in the database and never opened, so the call it makes cannot be indexed. */
const ORPHAN_CPP = [
  '#include "shape.h"', //                 1
  "", //                                   2
  "int orphan(gizmo::Shape *s) {", //      3
  "  return gizmo::twice(s);", //          4
  "}", //                                   5
  "", //                                   6
].join("\n");

const sleep = async (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface Answer<P> {
  isError?: boolean;
  structuredContent?: P;
  content: readonly { text?: string }[];
}

const textOf = (answer: Answer<unknown>): string => answer.content[0]?.text ?? "";

/** Rows and groups arrive in the order clangd's index happened to finish, so compare them sorted. */
const sorted = (lines: readonly string[]): string[] => [...lines].sort();

/** Either half of `scope.index`, read without the union narrowing it away. */
type IndexFacts = {
  state: string;
  staleFiles?: { count: number; files: string[] };
  driftUnknown?: string;
};

const indexFacts = (payload: { scope: unknown }): IndexFacts => (payload.scope as { index: IndexFacts }).index;

describe("cpp_find_references and cpp_find_callers against a real clangd binary", () => {
  let tmp: string;
  let buildDir: string;
  let sourceDir: string;
  let outsideDir: string;
  let header: string;
  let circle: string;
  let total: string;
  let elsewhere: string;
  let pointer: string;
  let orphan: string;
  const managers: LspSessionManager[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-cpp-nav-live-"));
    buildDir = join(tmp, "build");
    sourceDir = join(tmp, "src");
    outsideDir = join(tmp, "outside");
    mkdirSync(buildDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    header = join(sourceDir, "shape.h");
    circle = join(sourceDir, "circle.cpp");
    total = join(sourceDir, "total.cpp");
    elsewhere = join(outsideDir, "elsewhere.cpp");
    pointer = join(sourceDir, "pointer.cpp");
    orphan = join(sourceDir, "orphan.cpp");
    writeFileSync(header, SHAPE_H);
    writeFileSync(circle, CIRCLE_CPP);
    writeFileSync(total, TOTAL_CPP);
    writeFileSync(elsewhere, ELSEWHERE_CPP);
    writeFileSync(pointer, POINTER_CPP);
    writeFileSync(orphan, ORPHAN_CPP);
    writeFileSync(
      join(buildDir, "compile_commands.json"),
      JSON.stringify([
        { directory: sourceDir, command: `clang++ -std=c++17 -c "${circle}" -o circle.o`, file: circle },
        { directory: sourceDir, command: `clang++ -std=c++17 -c "${total}" -o total.o`, file: total },
        { directory: sourceDir, command: `clang++ -std=c++17 -c "${pointer}" -o pointer.o`, file: pointer },
        {
          directory: sourceDir,
          command: `clang++ -std=c++17 -I"${sourceDir}" -c "${elsewhere}" -o elsewhere.o`,
          file: elsewhere,
        },
      ]),
    );
  });

  afterEach(async () => {
    while (managers.length > 0) managers.pop()?.disposeAll();
    // The clangd child's cwd is the directory it was rooted at, so Windows keeps that handle locked briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        return;
      } catch {
        if (attempt >= 9) throw new Error(`could not remove ${tmp}`);
        await sleep(300);
      }
    }
  });

  function freshManager(): LspSessionManager {
    const manager = new LspSessionManager();
    managers.push(manager);
    return manager;
  }

  const asked = () => ({ projectRoot: buildDir, sourceRoots: [sourceDir] });

  /**
   * Asks until the session can state both of its index facts: that clangd's progress reports the index idle
   * across the answer's window, and that this server has a baseline to compare the disk against. An empty
   * answer from an index that was at work is one of those readings rather than an end — its own text names
   * its remedy, "call again once indexing has settled" — and the first answer over a root set carries
   * `driftUnknown` for the same reason, so the settled answer is what these cases state facts about.
   */
  async function settled<P>(manager: LspSessionManager, ask: () => Promise<Answer<P>>): Promise<P> {
    const stopAt = Date.now() + 90_000;
    for (;;) {
      const answer = await ask();
      const index = (answer.structuredContent as unknown as { scope?: { index: { state: string; staleFiles?: unknown } } })?.scope?.index;
      if (index?.state === "quiescent" && index.staleFiles !== undefined && answer.structuredContent !== undefined) {
        return answer.structuredContent;
      }
      const askedToWait = answer.isError === true && /indexing has settled|confirmed warm/.test(textOf(answer));
      if (answer.isError && !askedToWait) throw new Error(textOf(answer));
      expect(Date.now(), textOf(answer)).toBeLessThan(stopAt);
      await sleep(400);
    }
  }

  const references = (manager: LspSessionManager, name: string) =>
    settled<CppFindReferencesPayload>(manager, () =>
      runCppFindReferences(manager, { ...asked(), name, file: header } as never) as Promise<Answer<CppFindReferencesPayload>>,
    );

  const callers = (manager: LspSessionManager, name: string) =>
    settled<CppFindCallersPayload>(manager, () =>
      runCppFindCallers(manager, { ...asked(), name, file: header } as never) as Promise<Answer<CppFindCallersPayload>>,
    );

  /**
   * The same two questions with no `file` at all: the subject has to come from clangd's index, and
   * `roots` is what the answer is bounded by — which need not contain the file the index names.
   */
  const referencesAnywhere = (manager: LspSessionManager, name: string, roots: readonly string[]) =>
    settled<CppFindReferencesPayload>(manager, () =>
      runCppFindReferences(manager, { projectRoot: buildDir, name, sourceRoots: roots } as never) as Promise<
        Answer<CppFindReferencesPayload>
      >,
    );

  const callersAnywhere = (manager: LspSessionManager, name: string) =>
    settled<CppFindCallersPayload>(manager, () =>
      runCppFindCallers(manager, { ...asked(), name } as never) as Promise<Answer<CppFindCallersPayload>>,
    );

  /** `file:line in name`, which is what a listing row is: where, and what it sits in. */
  const referenceRows = (payload: CppFindReferencesPayload): string[] =>
    payload.files.flatMap((group) =>
      group.sites.map((site) => `${group.file}:${site.line}:${site.column} in ${site.in ?? site.reason}`),
    );

  /** The same rows without clangd's column, for a case that pins which declaration and which line. */
  const where = (payload: CppFindReferencesPayload): string[] =>
    payload.files.flatMap((group) => group.sites.map((site) => `${group.file}:${site.line} in ${site.in ?? site.reason}`));

  const callerRows = (payload: CppFindCallersPayload): string[] =>
    payload.callers.map(
      (row) => `${row.file}:${row.line} ${row.name ?? "null"} (${row.kind ?? "null"}) sites=${row.callSites.map((site) => site.line).join(",")}`,
    );

  itIfClangd("lists every indexed use of a virtual member, named by the declaration it sits in", async () => {
    const found = await references(freshManager(), "gizmo::Shape::area");

    expect(found.resolved).toEqual({ name: "gizmo::Shape::area", kind: "method", file: header, line: 8 });
    // Three uses: the two dispatching calls through the base pointer, and the direct call from the base's
    // own member. Each is named by the declaration it is inside, qualified the way this server's own `name`
    // input spells a declaration, so a row can be asked about directly.
    expect(sorted(referenceRows(found))).toEqual([
      `${circle}:6:10 in gizmo::Shape::side`,
      `${total}:6:13 in gizmo::total`,
      `${total}:7:13 in gizmo::total`,
    ]);
    expect(found.totalReferences).toBe(3);
    expect(found.filesTruncated).toBe(0);
    // The declaration itself is not a use of itself, and the override's declaration is a reference to the
    // override, not to the base: the header holds none of these three sites.
    expect(found.files.map((group) => group.file)).not.toContain(header);
  }, 180_000);

  itIfClangd("lays its disk baseline on the first call it makes, even one it ends up refusing", async () => {
    const manager = freshManager();
    const ask = () =>
      runCppFindReferences(manager, { ...asked(), name: "gizmo::Shape::area", file: header } as never) as Promise<
        Answer<CppFindReferencesPayload>
      >;

    // clangd may answer the very first request with nothing at all — no outline for a header it has not read
    // yet, or no uses while its index is mid-round — and both refusals say to ask again. The reading of the
    // disk happens before either question is asked, so a refused call still records the baseline: which
    // answer is the first index-backed one decides whether the block says `I cannot tell` or `nothing moved`.
    let first = await ask();
    const refused: string[] = [];
    const stopAt = Date.now() + 90_000;
    while (first.structuredContent === undefined) {
      refused.push(textOf(first));
      expect(Date.now(), refused.join(" then ")).toBeLessThan(stopAt);
      await sleep(400);
      first = await ask();
    }

    const index = indexFacts(first.structuredContent as { scope: unknown });
    const limits = (first.structuredContent as CppFindReferencesPayload).scope.limits;
    if (refused.length === 0) {
      expect(index.staleFiles, "the session's first call must not claim the disk is unchanged").toBeUndefined();
      expect(index.driftUnknown).toContain("first index-backed answer over");
      expect(limits).toContain("index-drift-unknown");
    } else {
      expect(index.driftUnknown, `refused: ${refused.join(" then ")}`).toBeUndefined();
      expect(index.staleFiles).toEqual({ count: 0, files: [] });
      expect(limits).not.toContain("index-drift-unknown");
    }
    expect(limits).toContain("compile-database-only");

    const again = await ask();
    expect(again.isError, textOf(again)).toBeFalsy();
    expect(indexFacts((again.structuredContent as { scope: unknown })).staleFiles).toEqual({ count: 0, files: [] });
  }, 180_000);

  itIfClangd("names the scope an answer came from, and the source it could not have seen", async () => {
    const found = await references(freshManager(), "gizmo::Shape::area");

    expect(found.scope.projectRoot).toBe(buildDir);
    expect(found.scope.index).toEqual({ state: "quiescent", staleFiles: { count: 0, files: [] } });
    expect(found.scope.limits).toEqual(["compile-database-only", "uncovered-sources-present"]);
    // The blind spot is named, not described: `orphan.cpp` is on disk under a declared root and in no
    // translation unit of the database, so clangd's index holds nothing from it.
    expect(found.scope.uncoveredSources).toEqual({ count: 1, files: [orphan] });
    expect(JSON.stringify(found.scope)).not.toContain("freshness");
  }, 180_000);

  itIfClangd("reports a use in a translation unit outside every declared source root, unread", async () => {
    const found = await references(freshManager(), "gizmo::total");

    expect(found.resolved).toEqual({ name: "gizmo::total", kind: "function", file: header, line: 20 });
    expect(found.totalReferences).toBe(3);
    const external = found.files.find((group) => group.external);
    // The location is stated with its position and no name, because naming it would mean reading a file the
    // caller never declared as a source root. The same rule as the Go answers' rule with a module.
    expect(external).toEqual({
      file: elsewhere,
      external: true,
      count: 1,
      sitesTruncated: 0,
      sites: [{ line: 4, column: 17, in: null, reason: "outside every declared source root; not named" }],
    });
    // In-boundary groups lead the listing, so a cap can only ever drop what would not have been read.
    expect(found.files.map((group) => group.external)).toEqual([false, false, true]);
    expect(sorted(referenceRows(found).filter((row) => row.startsWith(elsewhere)))).toEqual([
      `${elsewhere}:4:17 in outside every declared source root; not named`,
    ]);
  }, 180_000);

  itIfClangd("hands a dispatching call site to the base declaration and to every override alike", async () => {
    const manager = freshManager();
    const onBase = await callers(manager, "gizmo::Shape::area");
    const onCircle = await callers(manager, "gizmo::Circle::area");
    const onRing = await callers(manager, "gizmo::Ring::area");

    expect(sorted(callerRows(onBase))).toEqual(
      sorted([
        `${circle}:5 gizmo::Shape::side (method) sites=6`,
        `${total}:5 gizmo::total (function) sites=6,7`,
      ]),
    );
    // clangd answers both directions of the virtual relation generously: the override's callers include the
    // two calls written against the base pointer and even the direct, non-dispatching call inside the base's
    // own member, beside the two `c.area()` calls that really name the derived type. A caller row is
    // therefore a possible caller, and the listing over-reports rather than missing one.
    expect(sorted(callerRows(onCircle))).toEqual(
      sorted([
        `${circle}:5 gizmo::Shape::side (method) sites=6`,
        `${total}:5 gizmo::total (function) sites=6,7`,
        `${total}:14 gizmo::square (function) sites=15,15`,
      ]),
    );
    // The ruled reading is "under every override", so a second override of the same virtual is what pins it:
    // `Ring::area` carries the dispatching sites and the base's direct call too, and carries no `square`
    // site — the listing is the hierarchy's, widened at the written declaration, not one flat set.
    expect(sorted(callerRows(onRing))).toEqual(
      sorted([
        `${circle}:5 gizmo::Shape::side (method) sites=6`,
        `${total}:5 gizmo::total (function) sites=6,7`,
      ]),
    );
    expect([onBase.totalCallers, onCircle.totalCallers, onRing.totalCallers]).toEqual([2, 3, 2]);
    expect(onRing.scope.limits).toContain("indirect-dispatch-not-resolved");
  }, 300_000);

  itIfClangd("counts the binding of a function value as a caller and misses the call made through it", async () => {
    const found = await callers(freshManager(), "gizmo::total");

    expect(found.totalCallers).toBe(3);
    expect(sorted(callerRows(found))).toEqual([
      `${elsewhere}:3 null (null) sites=4`,
      `${pointer}:3 pick (variable) sites=3`,
      `${total}:10 gizmo::twice (function) sites=11`,
    ]);
    // `&gizmo::total` at pointer.cpp:3 is a reference and clangd also hands it back as a caller; the actual
    // call, `pick(s)` at pointer.cpp:6, is not a call-hierarchy edge at all. So the listing carries the
    // alias and loses the indirect call, which is the direction `indirect-dispatch-not-resolved` states.
    const pick = found.callers.find((row: CallerRow) => row.file === pointer) as CallerRow;
    expect(pick.callSites).toEqual([{ line: 3, column: 45 }]);
    expect(found.callers.some((row: CallerRow) => row.callSites.some((site) => site.line === 6))).toBe(false);
    expect(found.scope.limits).toEqual([
      "compile-database-only",
      "uncovered-sources-present",
      "indirect-dispatch-not-resolved",
    ]);
  }, 180_000);

  itIfClangd("asks about a declaration in a file this session never opened, and refuses one beyond the boundary", async () => {
    const manager = freshManager();
    // One parse is enough to put the header's declarations in front of clangd's index: `total.cpp` includes
    // `shape.h`, and `shape.h` itself is a file this session never opens. That is the difference between
    // an answer and `trying to get AST for non-added document`, because a reference query and a call
    // hierarchy are both read from the AST of the declaring document.
    await runCppFileSymbols(manager, { projectRoot: buildDir, file: total, sourceRoots: [sourceDir] } as never);

    const found = await referencesAnywhere(manager, "gizmo::Circle::area", [sourceDir]);

    // The point is that this answer arrives at all: the subject's own file was never opened by
    // this session, and a reference query about it is answered from the AST of the document that declares it.
    // WHICH location the index names is not stable across runs — `shape.h:15` (the declaration) in one,
    // `circle.cpp:9` (the out-of-line definition) in another, both measured on this fixture — so the subject
    // is pinned as the declaration it is, and its listing as the sites that name it.
    expect(found.resolved.name).toBe("gizmo::Circle::area");
    expect(found.resolved.kind).toBe("method");
    expect([header, circle]).toContain(found.resolved.file);
    expect(found.totalReferences).toBe(6);
    // The two `c.area()` calls `square` makes on a `const Circle &`, named by the declaration they sit in.
    expect(sorted(where(found))).toEqual(
      expect.arrayContaining([`${total}:15 in gizmo::square`, `${total}:15 in gizmo::square`]),
    );
    // Nothing in-boundary came back unnamed.
    expect(found.files.filter((group) => !group.external).flatMap((group) => group.sites).every((site) => site.in !== null)).toBe(true);

    // The same hold on the hierarchy: `prepareCallHierarchy` is answered from the declaring document too, and
    // `Shape::area` is declared in the header this session never opened. Its rows are the base's own direct
    // call and the two dispatching sites through `const Shape *` — the ones measured against a
    // `file`-named subject, which is the point: the subject's file is not how the answer is reached.
    const hierarchy = await callersAnywhere(manager, "gizmo::Shape::area");
    expect(hierarchy.resolved).toEqual({ name: "gizmo::Shape::area", kind: "method", file: header, line: 8 });
    expect(sorted(callerRows(hierarchy))).toEqual(
      sorted([
        `${circle}:5 gizmo::Shape::side (method) sites=6`,
        `${total}:5 gizmo::total (function) sites=6,7`,
      ]),
    );

    // The same name, with a boundary that excludes the file it lives in: the answer is a refusal that names
    // the boundary, and clangd is never asked about a document this server will not open.
    const outsideRoot = join(sourceDir, "outside-roots");
    mkdirSync(outsideRoot, { recursive: true });
    const refused = (await runCppFindReferences(manager, {
      projectRoot: buildDir,
      name: "gizmo::Circle::area",
      sourceRoots: [outsideRoot],
    } as never)) as Answer<CppFindReferencesPayload>;

    expect(refused.isError).toBe(true);
    // Which declaring location the index names is not stable, so the refusal is
    // pinned as naming one of the two, inside the boundary it refuses to cross — not as naming the header.
    // The separator class accepts the host's own (`\` on Windows, `/` elsewhere): the path is quoted verbatim.
    expect(textOf(refused)).toMatch(/is declared in "[^"]*[\\/](?:shape\.h|circle\.cpp)"/);
    expect(textOf(refused)).toContain("outside every declared source root");
    expect(textOf(refused)).toContain("reported and never opened");
    expect(refused.structuredContent).toBeUndefined();

    // And neither unscoped answer changed what the session holds. `shape.h` was read to name rows and to
    // answer the questions, always transiently, so a following `cpp_find_symbol` still has to go to the index —
    // which is the one thing that tells a caller where its name came from.
    const symbol = (await runCppFindSymbol(manager, {
      projectRoot: buildDir,
      name: "gizmo::Circle::area",
      sourceRoots: [sourceDir],
    })) as Answer<{ scope?: unknown }>;
    expect(symbol.isError, textOf(symbol)).toBeFalsy();
    expect(symbol.structuredContent?.scope).toBeDefined();
  }, 300_000);

  itIfClangd("answers a caller question whose only caller is in the blind spot as a scoped empty", async () => {
    const found = await callers(freshManager(), "gizmo::twice");

    // `orphan.cpp` calls `gizmo::twice`, and never will appear: it is in no translation unit of the database
    // and this server opened no document for it. The empty listing is honest only beside the code and the
    // named blind spot, which is why both are part of this answer.
    expect(found.totalCallers).toBe(0);
    expect(found.callers).toEqual([]);
    expect(found.scope.limits).toEqual([
      "compile-database-only",
      "uncovered-sources-present",
      "indirect-dispatch-not-resolved",
    ]);
    expect(found.scope.uncoveredSources).toEqual({ count: 1, files: [orphan] });
    expect(found.scope.index).toEqual({ state: "quiescent", staleFiles: { count: 0, files: [] } });
  }, 180_000);

  itIfClangd("codes an answer whose subject moved on disk since this session took its baseline", async () => {
    const manager = freshManager();
    await references(manager, "gizmo::Shape::area");
    writeFileSync(total, TOTAL_CPP.replace("  return total(s);", "  return total(s) + 1;"));

    const drifted = await references(manager, "gizmo::Shape::area");

    // The walk this server takes compares what is on disk with what it stamped before, so a moved source is
    // named rather than the answer being silently stale. clangd is told about it too, and re-indexing is
    // asked for — never known to have happened — which is why this is a drift code and not a claim.
    expect(drifted.scope.index).toEqual({ state: "quiescent", staleFiles: { count: 1, files: [total] } });
    expect(drifted.scope.limits).toContain("index-behind-disk");
    expect(drifted.scope.limits).not.toContain("index-drift-unknown");
    expect(JSON.stringify(drifted.scope.index)).not.toContain("driftUnknown");
  }, 180_000);

  /**
   * The live half, over this fixture's real out-of-tree layout: `tmp` is the repository
   * root a caller passes by mistake and `buildDir` the build directory that actually holds the database.
   * The refusal names it, the head a caller matches on is byte-identical to what it always was, and the
   * directory the text hands back is the one every tool then answers from.
   */
  const hintText = (tool: string, projectRoot: string): string => {
    const body =
      `compile_commands.json not found or unreadable at "${projectRoot}". Directories under it that hold a ` +
      `compile_commands.json, nearest first: "${buildDir}". Pass one of them as projectRoot.`;
    return `${tool} failed: ${body}`;
  };

  itIfClangd("refuses the repository root for the three index-backed tools, naming the build directory under it", async () => {
    const manager = freshManager();
    const refused: readonly (readonly [string, Answer<unknown>])[] = [
      ["cpp_find_symbol", await runCppFindSymbol(manager, { projectRoot: tmp, name: "gizmo::Shape::area", sourceRoots: [sourceDir] })],
      ["cpp_find_references", await runCppFindReferences(manager, { projectRoot: tmp, name: "gizmo::Shape::area", sourceRoots: [sourceDir] } as never)],
      ["cpp_find_callers", await runCppFindCallers(manager, { projectRoot: tmp, name: "gizmo::Shape::area", sourceRoots: [sourceDir] } as never)],
    ];

    for (const [tool, answer] of refused) {
      expect(answer.isError, tool).toBe(true);
      expect(textOf(answer), tool).toBe(hintText(tool, tmp));
      expect(answer.structuredContent, tool).toBeUndefined();
    }
  }, 180_000);

  itIfClangd("outlines the repository root's header from a default-flags parse, with the same text in its summary", async () => {
    const manager = freshManager();

    const answer = await runCppFileSymbols(manager, { projectRoot: tmp, file: header, sourceRoots: [sourceDir] } as never);

    expect(answer.isError).toBeUndefined();
    const payload = answer.structuredContent as { summary: string; symbols: unknown[]; scope: { limits: string[] } };
    expect(payload.summary.endsWith(hintText("cpp_file_symbols", tmp).replace("cpp_file_symbols failed: ", ""))).toBe(true);
    expect(payload.scope.limits).toEqual(["parsed-without-compile-database"]);
    expect(payload.symbols.length).toBeGreaterThan(0);
  }, 180_000);

  itIfClangd("answers from the directory the refusal named, which is the way out the text exists to give", async () => {
    const manager = freshManager();
    const refused = await runCppFindSymbol(manager, { projectRoot: tmp, name: "gizmo::Shape::area", sourceRoots: [sourceDir] });
    const named = /nearest first: "([^"]+)"/.exec(textOf(refused))?.[1];

    expect(named).toBe(buildDir);
    const found = await settled<CppFindReferencesPayload>(manager, () =>
      runCppFindReferences(manager, { projectRoot: named ?? buildDir, name: "gizmo::Shape::area", file: header, sourceRoots: [sourceDir] } as never) as Promise<
        Answer<CppFindReferencesPayload>
      >,
    );

    expect(found.scope.projectRoot).toBe(buildDir);
    expect(found.totalReferences).toBeGreaterThan(0);
  }, 300_000);
});
