import { fileURLToPath, pathToFileURL } from "node:url";
import { vi } from "vitest";
import type { ProgressToken } from "vscode-jsonrpc/node";
import { goplsConfig, type LanguageServerConfig, type LanguageServerUnavailableError } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import type { LspProcess } from "../../src/lsp/process.js";

type Connection = LspProcess["connection"];

/** The `file:` URI that names `path` as a document, spelled the way the session spells it. */
export function uriOf(path: string): string {
  return pathToFileURL(path).toString();
}

/** The path a server-side URI names, decoded the way `node:url` decodes it. */
export function pathOfUri(uri: string): string {
  return fileURLToPath(uri);
}

/** The path a `textDocument`-carrying request or notification names, or `undefined` if it names none. */
export function pathOfDocumentId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || !("textDocument" in params)) return undefined;
  const doc = params.textDocument;
  if (typeof doc !== "object" || doc === null || !("uri" in doc) || typeof doc.uri !== "string") return undefined;
  return fileURLToPath(doc.uri);
}

export interface FakeServerOptions {
  /** What `sendRequest` answers; throwing here rejects that request the way a dead connection does. */
  respond?: (method: string, params: unknown) => unknown;
  /**
   * Awaited after a notification is recorded. A test uses it to hold one write open and prove that a
   * concurrent caller waited for it.
   */
  notify?: (method: string, params: unknown) => unknown;
  /** What `process.spawnFailure()` reports — a child that emitted an `error` event. */
  failure?: () => LanguageServerUnavailableError | undefined;
  /**
   * Answer a request about a document this client never added the way clangd does: with a refusal
   *. Off by
   * default, because the Go fakes have no such rule; the C++ suites turn it on so a request that would fail
   * live cannot pass here by forgetting to hold its document. `didOpen` and `didClose` move the held set.
   */
  refusesUnaddedDocuments?: boolean;
  alive?: () => boolean;
  kill?: () => void;
}

/** The methods clangd answers from the AST of a client-held document, and so refuses without one. */
const NEEDS_ADDED_DOCUMENT = new Set([
  "textDocument/documentSymbol",
  "textDocument/hover",
  "textDocument/references",
  "textDocument/prepareCallHierarchy",
  "textDocument/implementation",
]);

/**
 * A language server double that records both halves of the protocol: what the session sent, and the
 * server-to-client handlers it registered, which `createProgress`/`sendProgress` then drive.
 *
 * `onProgress` reproduces vscode-jsonrpc's rule that a second subscription for one token throws, so a
 * session that re-subscribes on a repeated `window/workDoneProgress/create` fails here instead of only
 * against a real gopls.
 */
export function fakeServer(options: FakeServerOptions = {}) {
  const requests: [string, unknown][] = [];
  const notifications: [string, unknown][] = [];
  const journal: string[] = [];
  const requestHandlers = new Map<string, (params: unknown) => unknown>();
  const progressHandlers = new Map<ProgressToken, (value: unknown) => unknown>();
  const respond = options.respond ?? (() => []);
  // The documents this client has EVER added. clangd's refusal says "non-added", and the live drift
  // case proves the distinction: after `didClose` — which the drift push sends for a held buffer it changed —
  // clangd still answers a references query from what it parsed. A document it was never given cannot be
  // answered at all, which is the failure this guards against.
  const added = new Set<string>();
  const heldUri = (params: unknown): string | undefined =>
    (params as { textDocument?: { uri?: string } } | undefined)?.textDocument?.uri;

  const connection = {
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      requests.push([method, params]);
      journal.push(`req:${method}`);
      if (options.refusesUnaddedDocuments && NEEDS_ADDED_DOCUMENT.has(method)) {
        const uri = heldUri(params);
        if (uri !== undefined && !added.has(uri)) {
          throw new Error("trying to get AST for non-added document");
        }
      }
      return respond(method, params);
    }),
    sendNotification: vi.fn(async (method: string, params?: unknown) => {
      notifications.push([method, params]);
      journal.push(`note:${method}`);
      const uri = heldUri(params);
      if (method === "textDocument/didOpen" && uri !== undefined) added.add(uri);
      await options.notify?.(method, params);
    }),
    onRequest: vi.fn((method: string, handler: (params: unknown) => unknown) => {
      requestHandlers.set(method, handler);
      return { dispose: () => {} };
    }),
    onProgress: vi.fn((_type: unknown, token: ProgressToken, handler: (value: unknown) => unknown) => {
      if (progressHandlers.has(token)) throw new Error(`Progress handler for token ${String(token)} already registered`);
      progressHandlers.set(token, handler);
      return { dispose: () => {} };
    }),
  } as unknown as Connection;

  return {
    process: {
      connection,
      isAlive: options.alive ?? (() => true),
      kill: options.kill ?? (() => {}),
      spawnFailure: options.failure ?? (() => undefined),
    },
    requests,
    notifications,
    get journal() {
      return [...journal];
    },
    get methods() {
      return requests.map(([method]) => method);
    },
    get registeredRequestHandlers() {
      return [...requestHandlers.keys()];
    },
    get progressTokens() {
      return [...progressHandlers.keys()];
    },
    createProgress: async (token?: ProgressToken) => {
      const handler = requestHandlers.get("window/workDoneProgress/create");
      if (!handler) throw new Error("this session registered no window/workDoneProgress/create handler");
      return handler({ token });
    },
    sendProgress: (token: ProgressToken, value: unknown) => {
      const handler = progressHandlers.get(token);
      if (!handler) return false;
      void handler(value);
      return true;
    },
  };
}

export type FakeServer = ReturnType<typeof fakeServer>;

export interface SessionOverOptions {
  root?: string;
  config?: LanguageServerConfig;
  readFile?: (path: string) => string;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A session talking to one fake server. The defaults are the mocked-gopls shape most of these tests need:
 * a gopls config, a `/mod` root and a fixed file body. A test that wants to control the module walk passes
 * its own config — `{ ...goplsConfig, moduleSnapshot: () => myMap }` — because that is where the walk
 * lives: a config without one is never walked.
 */
export function sessionOver(server: FakeServer, options: SessionOverOptions = {}): LspSession {
  return new LspSession({
    root: options.root ?? "/mod",
    config: options.config ?? goplsConfig,
    spawn: () => server.process,
    readFile: options.readFile ?? (() => "package main\n"),
    sleep: options.sleep ?? (async () => {}),
  });
}
