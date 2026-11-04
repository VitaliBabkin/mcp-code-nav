// Every error text a `ts_` tool can answer with, read from the code that emits it, so a reworded TS refusal
// fails here instead of drifting into `internal`. The reason is read from the tool's own result; a helper that
// only builds a text is pinned to its phrase, and the reason it is answered with is checked where the tool that
// returns it is tested.
// No `tsc.exe`, no `npm` and no real tsgo runs: the executable comes through `resolveBinary`, the project
// listings through `exec`, and every tsgo answer through the fake server's `respond`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { TSGO_IDENTITY, tsgoConfig, unavailableMessage } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runTsFileSymbols } from "../../src/tools/ts-file-symbols.js";
import { runTsFindCallers } from "../../src/tools/ts-find-callers.js";
import { runTsFindImplementations } from "../../src/tools/ts-find-implementations.js";
import { runTsFindReferences } from "../../src/tools/ts-find-references.js";
import { runTsFindSymbol } from "../../src/tools/ts-find-symbol.js";
import {
  listingBudgetText,
  noAnchorText,
  tsBudgetText,
  tsReadinessText,
  tsRestartedText,
  notAddressableText,
  unreadableSourceText,
  unreadableSpanText,
  type TsQueryDeps,
} from "../../src/tools/ts-navigation-shared.js";
import { budgetOf } from "../../src/tools/budget.js";
import { unexpectedAnswerText, WORKSPACE_SYMBOL_ANSWER } from "../../src/tools/lsp-locations.js";
import { classifyError } from "../../src/call-log/error-class.js";
import { fieldOf, resultView, textOf } from "../helpers/tool-result.js";
import { resolveTsgoBinary, type TsgoBinary, type TsExecFn } from "../../src/tsgo/binary.js";
import { dropProjectMap } from "../../src/tsgo/project-map.js";
import { fakeServer, pathOfDocumentId } from "../helpers/fake-lsp.js";

const BINARY: TsgoBinary = {
  executable:
    "C:/fake/npm-global/typescript/node_modules/@typescript/typescript-win32-x64/lib/tsc.exe",
  version: "7.0.2",
  source: "global",
};

const TEXT = [
  "export const Foo = 1;",
  "export interface Foo {}",
  'export const label = "x";',
  "export function run() {}",
  "export class Driver {",
  "  go(): void {}",
  "}",
];

function pos(line: number, needle: string) {
  return { line, character: TEXT[line]!.indexOf(needle) };
}

function entry(
  name: string,
  kind: number,
  line: number,
  children?: LspDocumentSymbol[],
): LspDocumentSymbol {
  return {
    name,
    kind,
    range: {
      start: pos(line, name),
      end: { line, character: TEXT[line]!.length },
    },
    selectionRange: { start: pos(line, name) },
    ...(children === undefined ? {} : { children }),
  };
}

/** tsgo's kinds: 5 class, 6 method, 11 interface, 12 function, 13 variable. */
const OUTLINE: LspDocumentSymbol[] = [
  entry("Foo", 13, 0),
  entry("Foo", 11, 1),
  entry("label", 13, 2),
  entry("run", 12, 3),
  entry("Driver", 5, 4, [entry("go", 6, 5)]),
];

const built: string[] = [];

interface Harness {
  readonly ws: string;
  readonly main: string;
  readonly manager: LspSessionManager;
  readonly deps: TsQueryDeps;
  /** What each type-aware request answers with; unset ones answer an empty list. */
  readonly answers: Map<string, unknown>;
  base(): { sourceRoots: string[]; file: string; timeBudgetMs: number };
}

/** A temp npm package holding one tsconfig project and one source file, over a tsgo that answers from `answers`. */
function harness(listing: "ok" | "fails" = "ok"): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-tserr-"));
  built.push(tmp);
  const ws = resolve(join(tmp, "ws"));
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "pkg" }));
  const config = join(ws, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: {} }));
  const main = join(ws, "src", "main.ts");
  writeFileSync(main, `${TEXT.join("\n")}\n`);

  const answers = new Map<string, unknown>();
  const exec: TsExecFn = async () =>
    listing === "ok"
      ? { stdout: main, stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "error TS5083: Cannot read file", exitCode: 1 };
  const manager = new LspSessionManager({
    spawn: () =>
      fakeServer({
        respond: (method, params) => {
          if (method === "initialize") return { serverInfo: { name: "tsgo", version: "7.0.2" } };
          if (method === "textDocument/documentSymbol")
            return pathOfDocumentId(params) === main ? OUTLINE : [];
          return answers.get(method) ?? [];
        },
      }).process,
    sleep: async () => {},
  });
  manager.get(ws, tsgoConfig(BINARY));
  return {
    ws,
    main,
    manager,
    answers,
    deps: { resolveBinary: async () => ({ binary: BINARY }), exec },
    base: () => ({ sourceRoots: [ws], file: main, timeBudgetMs: 60_000 }),
  };
}

/** The class its text alone is given, which is what a transcript reader sees. */
function classOf(text: string): string {
  return classifyError(text).errorClass;
}

/** The reason a tool result carries in `structuredContent`; `undefined` when it carries none. */
function reasonIn(answer: { readonly structuredContent?: unknown }): unknown {
  return fieldOf(answer.structuredContent, "reason");
}

afterEach(() => {
  for (const tmp of built.splice(0)) {
    dropProjectMap(resolve(join(tmp, "ws")));
    rmSync(tmp, { recursive: true, force: true });
  }
});

describe("what the shared TS target resolution refuses with", () => {
  it("input-invalid, for a file whose extension tsgo cannot be asked about", async () => {
    const h = harness();
    const notes = join(h.ws, "src", "notes.txt");
    writeFileSync(notes, "x");
    const out = await runTsFileSymbols(h.manager, { ...h.base(), file: notes, depth: 1 }, h.deps);

    expect(resultView(out).isError).toBe(true);
    expect(reasonIn(out)).toBe("input-invalid");
    expect(classOf(textOf(out))).toBe("input-invalid");
  });

  it("no-module, for a file that sits in no npm package", async () => {
    const h = harness();
    const bare = mkdtempSync(join(tmpdir(), "mcp-code-nav-tserr-bare-"));
    built.push(bare);
    const file = join(bare, "a.ts");
    writeFileSync(file, "export {};\n");
    const out = await runTsFileSymbols(
      h.manager,
      { sourceRoots: [bare], file, timeBudgetMs: 60_000, depth: 1 },
      h.deps,
    );

    expect(textOf(out)).toContain("is not inside an npm package");
    expect(reasonIn(out)).toBe("no-module");
    expect(classOf(textOf(out))).toBe("no-module");
  });

  it("path-escape, for a package that lies outside every declared root", async () => {
    const h = harness();
    const out = await runTsFileSymbols(
      h.manager,
      {
        sourceRoots: [join(h.ws, "src")],
        file: h.main,
        timeBudgetMs: 60_000,
        depth: 1,
      },
      h.deps,
    );

    expect(textOf(out)).toContain("outside every declared sourceRoots entry");
    expect(reasonIn(out)).toBe("path-escape");
    expect(classOf(textOf(out))).toBe("path-escape");
  });

  it("server-unavailable, for a located binary that is missing and one that could not be located", async () => {
    const h = harness();
    const missing = unavailableMessage(
      { config: TSGO_IDENTITY, attempted: "C:/x/tsc.exe", fromOverride: true },
      "ENOENT",
    );
    const out = await runTsFileSymbols(
      h.manager,
      { ...h.base(), depth: 1 },
      {
        ...h.deps,
        resolveBinary: async () => ({
          unavailable: missing,
          attempted: "C:/x/tsc.exe",
        }),
      },
    );

    expect(textOf(out)).toContain("Cannot start tsgo:");
    expect(reasonIn(out)).toBe("server-unavailable");
    expect(classOf(textOf(out))).toBe("server-unavailable");
  });

  it("server-unavailable, for a real locator miss whose clipped npm stderr names a missing file", async () => {
    const miss = await resolveTsgoBinary({
      platform: "win32",
      arch: "x64",
      override: "",
      exec: async () => ({
        stdout: "",
        stderr: "ENOENT: no such file or directory, open 'C:/npm/x'",
        exitCode: 1,
      }),
      readJson: () => undefined,
      exists: () => false,
    });

    expect("unavailable" in miss).toBe(true);
    const h = harness();
    const out = await runTsFileSymbols(
      h.manager,
      { ...h.base(), depth: 1 },
      { ...h.deps, resolveBinary: async () => miss },
    );
    expect(textOf(out)).toContain("Cannot start tsgo:");
    expect(textOf(out)).toContain("no such file or directory");
    expect(reasonIn(out)).toBe("server-unavailable");
    expect(classOf(textOf(out))).toBe("server-unavailable");
  });

  it("file-not-found, for a `file` that does not exist, through a TS tool", async () => {
    const h = harness();
    const out = await runTsFileSymbols(
      h.manager,
      { ...h.base(), file: join(h.ws, "src", "gone.ts"), depth: 1 },
      h.deps,
    );

    expect(resultView(out).isError).toBe(true);
    expect(reasonIn(out)).toBe("file-not-found");
    expect(classOf(textOf(out))).toBe("file-not-found");
  });

  it("budget-exceeded, for a call whose budget ran out while the executable was still being looked for", async () => {
    const h = harness();
    const out = await runTsFileSymbols(
      h.manager,
      { ...h.base(), timeBudgetMs: 25, depth: 1 },
      { ...h.deps, resolveBinary: () => new Promise(() => {}) },
    );

    expect(textOf(out)).toContain("still looking for the TypeScript 7 native server");
    expect(reasonIn(out)).toBe("budget-exceeded");
    expect(classOf(textOf(out))).toBe("budget-exceeded");
  });
});

describe("what addressing a `symbol` refuses with", () => {
  it("symbol-not-found, for a name the file does not declare", async () => {
    const h = harness();
    const out = await runTsFindReferences(
      h.manager,
      { ...h.base(), symbol: "Nope", includeDeclaration: false },
      h.deps,
    );

    expect(textOf(out)).toContain('declares nothing named "Nope"');
    expect(reasonIn(out)).toBe("symbol-not-found");
    expect(classOf(textOf(out))).toBe("symbol-not-found");
  });

  it("symbol-ambiguous, for one key that two symbols share", async () => {
    const h = harness();
    const out = await runTsFindReferences(
      h.manager,
      { ...h.base(), symbol: "Foo", includeDeclaration: false },
      h.deps,
    );

    expect(textOf(out)).toContain("will not pick between them");
    expect(reasonIn(out)).toBe("symbol-ambiguous");
    expect(classOf(textOf(out))).toBe("symbol-ambiguous");
  });

  it("symbol-kind-unsupported, for a member asked of a declaration that holds none", async () => {
    const h = harness();
    const out = await runTsFindReferences(
      h.manager,
      { ...h.base(), symbol: "label.size", includeDeclaration: false },
      h.deps,
    );

    expect(textOf(out)).toContain("only those four hold addressable members");
    expect(reasonIn(out)).toBe("symbol-kind-unsupported");
    expect(classOf(textOf(out))).toBe("symbol-kind-unsupported");
  });

  it("symbol-not-found, for a dotted path no entry of the file carries", () => {
    const text = notAddressableText("ts_find_references", "x.y", "a.ts", "x", "nothing");
    expect(text).toContain("no entry in this file carries that path");
    expect(classOf(text)).toBe("symbol-not-found");
  });

  // Helper-only texts: the reason is named beside each text by the tool that returns it, which the TS tool tests check.
  it("a dotted namespace entry whose own span is not the run it claims names the span it could not read", () => {
    const span = unreadableSpanText("ts_find_callers", "a.ts", {
      name: "A.B",
      kind: 3,
      range: pos0(),
      selectionRange: pos0(),
    });

    expect(span).toContain("is not that run of names");
    expect(classOf(span)).toBe("internal");
  });

  it("a source unreadable for a reason other than its absence names the read that failed, whatever the errno", () => {
    expect(
      unreadableSourceText(
        "ts_find_callers",
        "a.ts",
        "S",
        "EACCES: permission denied, open 'a.ts'",
      ),
    ).toContain('"a.ts" could not be read (EACCES: permission denied');
    expect(
      classOf(
        unreadableSourceText(
          "ts_find_callers",
          "a.ts",
          "S",
          "EACCES: permission denied, open 'a.ts'",
        ),
      ),
    ).toBe("internal");
    const absent = unreadableSourceText(
      "ts_find_callers",
      "a.ts",
      "S",
      "ENOENT: no such file or directory, open 'a.ts'",
    );
    expect(absent).toContain('"a.ts" could not be read (ENOENT');
    expect(classOf(absent)).toBe("file-not-found");
  });
});

function pos0() {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

describe("what the per-tool gates refuse with", () => {
  it("symbol-kind-unsupported, for an implementations question about a variable", async () => {
    const h = harness();
    const out = await runTsFindImplementations(h.manager, { ...h.base(), symbol: "label" }, h.deps);

    expect(textOf(out)).toContain(
      "only an interface, class, method or property has implementations",
    );
    expect(reasonIn(out)).toBe("symbol-kind-unsupported");
    expect(classOf(textOf(out))).toBe("symbol-kind-unsupported");
  });

  it("symbol-kind-unsupported, for a callers question tsgo offers no call hierarchy for", async () => {
    const h = harness();
    h.answers.set("textDocument/prepareCallHierarchy", []);
    const out = await runTsFindCallers(h.manager, { ...h.base(), symbol: "label" }, h.deps);

    expect(textOf(out)).toContain("so it is not callable");
    expect(reasonIn(out)).toBe("symbol-kind-unsupported");
    expect(classOf(textOf(out))).toBe("symbol-kind-unsupported");
  });

  it("symbol-ambiguous, for a callers question tsgo answers with several items", async () => {
    const h = harness();
    h.answers.set("textDocument/prepareCallHierarchy", [{}, {}]);
    const out = await runTsFindCallers(h.manager, { ...h.base(), symbol: "run" }, h.deps);

    expect(textOf(out)).toContain("picking one would be a guess");
    expect(reasonIn(out)).toBe("symbol-ambiguous");
    expect(classOf(textOf(out))).toBe("symbol-ambiguous");
  });

  it("unexpected-answer, for an answer this server cannot read and will not shrink", async () => {
    const h = harness();
    h.answers.set("textDocument/references", { not: "a list" });
    const out = await runTsFindReferences(
      h.manager,
      { ...h.base(), symbol: "run", includeDeclaration: false },
      h.deps,
    );

    expect(textOf(out)).toContain("this server cannot read");
    expect(reasonIn(out)).toBe("unexpected-answer");
    expect(classOf(textOf(out))).toBe("internal");
  });

  it("symbol-not-found, for a `ts_find_symbol` whose file anchor declares no such name", async () => {
    const h = harness();
    const out = await runTsFindSymbol(
      h.manager,
      {
        sourceRoots: [h.ws],
        symbol: "Nope",
        anchor: h.main,
        timeBudgetMs: 60_000,
      },
      h.deps,
    );

    expect(textOf(out)).toContain('no declaration named "Nope"');
    expect(reasonIn(out)).toBe("symbol-not-found");
    expect(classOf(textOf(out))).toBe("symbol-not-found");
  });

  it("input-invalid, for a directory anchor in a workspace whose only project failed to list", async () => {
    const h = harness("fails");
    const out = await runTsFindSymbol(
      h.manager,
      {
        sourceRoots: [h.ws],
        symbol: "run",
        anchor: h.ws,
        timeBudgetMs: 60_000,
      },
      h.deps,
    );

    expect(textOf(out)).toContain("no project anchor could be opened");
    expect(reasonIn(out)).toBe("input-invalid");
    expect(classOf(textOf(out))).toBe("input-invalid");
  });
});

describe("what the budget, readiness and restart texts say", () => {
  const budget = budgetOf(60_000);

  it("budget-exceeded, for a request or a listing that outran the ceiling", () => {
    const request = tsBudgetText("ts_find_callers", budget, "answer", "D:/ws");
    const listing = listingBudgetText("ts_find_callers", budget, "D:/ws");

    expect(request).toContain("ms budget");
    expect(listing).toContain("ms budget ran out");
    expect(classOf(request)).toBe("budget-exceeded");
    expect(classOf(listing)).toBe("budget-exceeded");
  });

  it("not-ready, not budget-exceeded, for documents that were never proved open", () => {
    const text = tsReadinessText("ts_find_callers", budget, "run", "D:/ws", "timed-out");

    expect(text).toContain("could not prove within its");
    expect(classOf(text)).toBe("not-ready");
  });

  it("session-lost, for the process replaced mid-call", () => {
    const restarted = tsRestartedText("ts_find_callers", "run", "D:/ws");
    const readiness = tsReadinessText("ts_find_callers", budget, "run", "D:/ws", "restarted");

    expect(restarted).toContain("restarted during the query about");
    expect(classOf(restarted)).toBe("session-lost");
    expect(classOf(readiness)).toBe("session-lost");
  });

  it("input-invalid, for the no-anchor refusal in both its variants", () => {
    const empty = {
      projects: [],
      failed: [],
      subsumed: [],
      uncovered: undefined,
      projectsUnavailable: undefined,
      anchors: [],
    };
    const unavailable = noAnchorText("ts_find_symbol", "run", "D:/ws", {
      ...empty,
      projectsUnavailable: "too many",
    });
    const none = noAnchorText("ts_find_symbol", "run", "D:/ws", empty);

    expect(unavailable).toContain("no project anchor could be opened");
    expect(classOf(unavailable)).toBe("input-invalid");
    expect(classOf(none)).toBe("input-invalid");
  });

  it("internal by text, for a workspace-symbol answer this server cannot read", () => {
    const text = unexpectedAnswerText(
      "tsgo",
      "ts_find_symbol",
      { x: 1 },
      "run",
      undefined,
      WORKSPACE_SYMBOL_ANSWER,
    );

    expect(text).toContain("project-wide symbol search");
    expect(classOf(text)).toBe("internal");
  });
});
