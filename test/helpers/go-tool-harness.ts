// The scaffolding the Go navigation tool suites share: a fake gopls over a real temp module, and the
// accessors that read a tool result.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import { goplsConfig, LanguageServerUnavailableError } from "../../src/lsp/server-config.js";
import type { LspSession } from "../../src/lsp/session.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import type { SpawnLsp } from "../../src/lsp/process.js";
import { fakeGo, type FakeGo } from "./fake-go.js";
import { fakeServer, pathOfDocumentId, uriOf, type FakeServer } from "./fake-lsp.js";

/** A tool result, as far as these accessors care: a text block and a structured payload. */
export interface ToolResultLike {
  readonly content: readonly { readonly text?: string }[];
  readonly structuredContent?: unknown;
}

/** One outline entry as gopls reports it: line-only ranges unless the test gives characters. */
export function symbol(name: string, kind: number, startLine: number, endLine = startLine): LspDocumentSymbol {
  return {
    name,
    kind,
    range: { start: { line: startLine }, end: { line: endLine } },
    selectionRange: { start: { line: startLine, character: 5 } },
  };
}

/** What a test tells the fake to do with one query method. */
export interface GoToolQueries {
  /** The result that method answers with — `undefined` and `null` stay distinct. */
  answer(method: string, result: unknown): void;
  /** Make every call to that method reject, the way a refused file does. */
  refuse(method: string, message: string): void;
  /**
   * Answer each call to that method from its own params, so a test can give one row of a fan-out a
   * signature and another `null` — every hover arrives on the same method name and only the request
   * says which declaration it is about.
   */
  answerEach(method: string, reply: (params: unknown) => unknown): void;
  /** Never resolve that method, so the call's budget has to run out. */
  hang(method: string): void;
  /** Kill the child the next time that method is asked, then answer from its replacement. */
  crashNext(method: string): void;
}

export interface GoToolHarness {
  tmp: string;
  mod: string;
  file: string;
  server: FakeServer;
  session: LspSession;
  manager: LspSessionManager;
  read: ReturnType<typeof vi.fn>;
  go: FakeGo;
  query: GoToolQueries;
  outline(path: string, symbols: LspDocumentSymbol[]): void;
  failToOutline(path: string): void;
  /** Proves the initial workspace load, which only a child that has started can report. */
  ready(): Promise<void>;
}

export interface GoToolHarnessOptions {
  /** The temp root's prefix, so a run's leftovers are traceable to the suite that made them. */
  readonly prefix: string;
  /** The file that declares the symbol, inside `mod`. */
  readonly fileName: string;
  /** The outline that file answers with before a test overrides it. */
  readonly outline: readonly LspDocumentSymbol[];
  /** The query methods this tool asks; anything else the session sends is a test failure. */
  readonly expects: readonly string[];
  /** What the test wants that `go` answers differently. */
  readonly go?: FakeGo;
  /** A child that never appears, the way an absent binary defeats a real session. */
  readonly spawn?: SpawnLsp;
}

const tempDirs: string[] = [];

/** A gopls whose outlines and query answers the test supplies, rooted at a real temp module. */
export function buildGoToolHarness(options: GoToolHarnessOptions): GoToolHarness {
  const tmp = mkdtempSync(join(tmpdir(), options.prefix));
  tempDirs.push(tmp);
  const mod = join(tmp, "mod");
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, "go.mod"), "module example.com/mod\n");
  const file = join(mod, options.fileName);
  writeFileSync(file, "package mod\n");

  const outlines = new Map<string, LspDocumentSymbol[]>([[file, [...options.outline]]]);
  const failing = new Set<string>();
  const answers = new Map<string, unknown>();
  const refusals = new Map<string, string>();
  const replies = new Map<string, (params: unknown) => unknown>();
  const hung = new Set<string>();
  const crashing = new Set<string>();
  const expected = new Set(options.expects);
  let childAlive = true;
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
        return outlines.get(path) ?? [];
      }
      if (!expected.has(method)) throw new Error(`unexpected request: ${method}`);
      if (crashing.has(method)) {
        crashing.delete(method);
        childAlive = false;
        throw new Error("connection got disposed");
      }
      const refusal = refusals.get(method);
      if (refusal !== undefined) throw new Error(refusal);
      if (hung.has(method)) return new Promise<unknown>(() => {});
      const reply = replies.get(method);
      if (reply !== undefined) return reply(params);
      return answers.has(method) ? answers.get(method) : [];
    },
  });
  const manager = new LspSessionManager({
    spawn: options.spawn ?? (() => server.process),
    readFile: read,
    sleep: async () => {},
  });
  const session = manager.get(resolve(mod), goplsConfig);
  return {
    tmp,
    mod,
    file,
    server,
    session,
    manager,
    read,
    go,
    query: {
      answer: (method, result) => {
        answers.set(method, result);
      },
      refuse: (method, message) => {
        refusals.set(method, message);
      },
      answerEach: (method, reply) => {
        replies.set(method, reply);
      },
      hang: (method) => {
        hung.add(method);
      },
      crashNext: (method) => {
        crashing.add(method);
      },
    },
    outline: (path, symbols) => {
      outlines.set(path, symbols);
    },
    failToOutline: (path) => {
      failing.add(path);
    },
    ready: async () => {
      await session.documentSymbol(file);
      await server.createProgress("tok-1");
      server.sendProgress("tok-1", { kind: "end", message: "Finished loading packages." });
    },
  };
}

/** Removes every temp root the suites built; each suite calls this from its own `afterEach`. */
export function cleanupGoToolHarnesses(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A spawn that reports gopls absent, the way the real child does when PATH has no `gopls`. */
export function missingGoplsSpawn(): SpawnLsp {
  return () => {
    throw new LanguageServerUnavailableError(
      { config: goplsConfig, attempted: "gopls", fromOverride: false },
      { code: "ENOENT" },
    );
  };
}

/**
 * Runs a call whose budget must expire at one named step. The fake gopls answers on microtasks, so with
 * the clock held every step that does not wait on the budget finishes first, and the one that does times
 * out when this advances — not when the host happens to get there. `setTimeout` and `Date` only: the
 * rest of the event loop stays real, so nothing that relies on `nextTick` can stall.
 */
export async function runUntilBudgetExpires<T>(work: () => Promise<T>, budgetMs: number): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const running = work();
    await vi.advanceTimersByTimeAsync(budgetMs + 1_000);
    return await running;
  } finally {
    vi.useRealTimers();
  }
}

export function payload(result: ToolResultLike): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

export function scopeOf(result: ToolResultLike): Record<string, unknown> {
  return payload(result).scope as Record<string, unknown>;
}

export function limitsOf(result: ToolResultLike): string[] {
  return scopeOf(result).limits as string[];
}

export function textOf(result: ToolResultLike): string {
  return result.content[0]?.text ?? "";
}

/** The params of the first request that method saw. */
export function requestFor(server: FakeServer, method: string): unknown {
  return server.requests.find(([name]) => name === method)?.[1];
}

export function countOf(server: FakeServer, method: string): number {
  return server.methods.filter((name) => name === method).length;
}

/** Every `didOpen` path the server saw, decoded — what a listing opened, and in what order. */
export function openedPaths(server: FakeServer): string[] {
  return server.notifications
    .filter(([method]) => method === "textDocument/didOpen")
    .map(([, params]) => pathOfDocumentId(params))
    .filter((path): path is string => path !== undefined);
}

/** Every `didClose` path the server saw, decoded: which documents a call let go again rather than holding. */
export function closedPaths(server: FakeServer): string[] {
  return server.notifications
    .filter(([method]) => method === "textDocument/didClose")
    .map(([, params]) => pathOfDocumentId(params))
    .filter((path): path is string => path !== undefined);
}
