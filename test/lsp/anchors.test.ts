import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goplsConfig, tsgoConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import type { TsgoBinary } from "../../src/tsgo/binary.js";
import {
  fakeServer,
  pathOfDocumentId,
  pathOfUri,
  sessionOver,
  uriOf,
  type FakeServer,
} from "../helpers/fake-lsp.js";

/**
 * The documents-opened readiness proof, over the fake server the Go and C++ session
 * suites use. `openAnchors` is the whole proof for a backend that sends no progress and loads a project while
 * handling the `didOpen` of a file in it, so these cases pin what was sent, in what order, and what the session
 * is then willing to say about the process that answers.
 *
 * The call also answers whether it made the proof: the proof is never
 * vacuous, so an empty set opens nothing and proves nothing, and a config whose proof is progress answers
 * `false` however many documents it opened.
 */

const BINARY: TsgoBinary = { executable: "C:/fake/lib/tsc.exe", version: "7.0.2", source: "global" };

const TSGO = tsgoConfig(BINARY);

const OPEN = "textDocument/didOpen";
const CLOSE = "textDocument/didClose";

/** A path as it comes back out of the URI this server sends, so both sides are spelled alike. */
const shown = (path: string): string => pathOfUri(uriOf(path));

const readFile = (path: string): string => readFileSync(path, "utf-8");

interface OpenedDocument {
  readonly path: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

/**
 * Every `didOpen` the session sent, in the order it sent them. `path` is the payload's `uri` decoded, so the
 * uri is compared through it and not carried a second time beside it.
 */
function openedDocuments(server: FakeServer): OpenedDocument[] {
  return server.notifications.flatMap(([method, params]) => {
    if (method !== OPEN) return [];
    const path = pathOfDocumentId(params);
    if (path === undefined) throw new Error("a textDocument/didOpen notification named no document");
    const { languageId, version, text } = (params as { textDocument: Omit<OpenedDocument, "path"> & { uri: string } })
      .textDocument;
    return [{ path, languageId, version, text }];
  });
}

/** The notifications from `from` on, as `method path` lines — the order is the contract. */
function sequence(server: FakeServer, from = 0): string[] {
  return server.notifications.slice(from).map(([method, params]) => {
    const path = pathOfDocumentId(params);
    return path === undefined ? method : `${method} ${path}`;
  });
}

/** An `initialize` result stating one server, and an empty answer for every other request. */
const answersServerInfo = (serverInfo: unknown) => (method: string): unknown =>
  method === "initialize" ? { serverInfo } : [];

describe("LspSession.openAnchors", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-anchors-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A workspace source holding `text`, opened as an anchor by the test that made it. */
  function source(name: string, text: string): string {
    const path = join(tmp, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  it("opens one document per anchor, in the order it was named, each under its extension's languageId", async () => {
    const tsx = source("b.tsx", "export const tsx = 1;\n");
    const ts = source("a.ts", "export const ts = 1;\n");
    const jsx = source("d.jsx", "export const jsx = 1;\n");
    const js = source("c.js", "export const js = 1;\n");
    const server = fakeServer({ respond: () => [] });
    const session = sessionOver(server, { root: tmp, config: TSGO, readFile });

    await session.openAnchors([tsx, ts, jsx, js]);

    // One process answers TypeScript and JavaScript, so the id a document is opened under is a property of
    // the file: a `.tsx` opened as `typescript` is parsed without JSX, which is a wrong answer about the file.
    expect(openedDocuments(server)).toEqual([
      { path: shown(tsx), languageId: "typescriptreact", version: 1, text: "export const tsx = 1;\n" },
      { path: shown(ts), languageId: "typescript", version: 1, text: "export const ts = 1;\n" },
      { path: shown(jsx), languageId: "javascriptreact", version: 1, text: "export const jsx = 1;\n" },
      { path: shown(js), languageId: "javascript", version: 1, text: "export const js = 1;\n" },
    ]);
    expect(server.notifications.map(([method]) => method)).toEqual(["initialized", OPEN, OPEN, OPEN, OPEN]);
  });

  it("holds the documents it opened, so a second call for the same anchors sends nothing", async () => {
    const app = source("app.ts", "export const app = 1;\n");
    const store = source("store.ts", "export const store = 1;\n");
    const server = fakeServer({ respond: () => [] });
    const session = sessionOver(server, { root: tmp, config: TSGO, readFile });

    await session.openAnchors([app, store]);
    const sent = server.notifications.length;

    // A second call over the anchors it already holds still makes the proof: the documents are open on the
    // process that answers, which is the whole of what is asked. And tsgo never drops a project it was
    // given, so a second `didOpen` for a held file would hand it two buffers.
    expect(await session.openAnchors([app, store])).toBe(true);
    expect(openedDocuments(server)).toHaveLength(2);
    expect(server.notifications).toHaveLength(sent);
    expect(session.getOpenedFiles()).toEqual([app, store]);
  });

  it("proves the workspace loaded with the opens alone, and says so, for a server that reports no progress", async () => {
    const app = source("app.ts", "export const app = 1;\n");
    const server = fakeServer({ respond: () => [] });
    const session = sessionOver(server, { root: tmp, config: TSGO, readFile });

    expect(session.isWorkspaceLoaded()).toBe(false);
    const waiting = session.awaitWorkspaceReady(30_000);
    const proved = await session.openAnchors([app]);

    // No `window/workDoneProgress/create` was ever answered, so there is no token whose `end` could prove this.
    expect(proved).toBe(true);
    expect(await waiting).toBe("ready");
    expect(session.isWorkspaceLoaded()).toBe(true);
    expect(await session.awaitWorkspaceReady(10)).toBe("ready");
    expect(server.progressTokens).toEqual([]);
    expect(server.methods).toEqual(["initialize"]);
  });

  it("proves nothing for an empty set of anchors, and leaves the workspace unproven", async () => {
    const server = fakeServer({ respond: () => [] });
    const session = sessionOver(server, { root: tmp, config: TSGO, readFile });

    const proved = await session.openAnchors([]);

    // The proof is that the documents an answer depends on were opened. A map that anchored
    // nothing opened nothing, so `workspace/symbol` would answer a silent `[]` and the call must be refused
    // rather than reported as an empty answer.
    expect(proved).toBe(false);
    expect(session.isWorkspaceLoaded()).toBe(false);
    expect(session.getOpenedFiles()).toEqual([]);
    expect(server.notifications.map(([method]) => method)).toEqual(["initialized"]);
    expect(await session.awaitWorkspaceReady(10)).toBe("timed-out");
  });

  it("answers false for a config whose proof is progress, having opened the documents all the same", async () => {
    const main = source("main.go", "package main\n");
    const server = fakeServer({ respond: () => [] });
    const session = sessionOver(server, { root: tmp, config: goplsConfig, readFile });

    const proved = await session.openAnchors([main]);

    // gopls proves its load with `$/progress` on its own token, so opening its documents is not the proof and
    // must not mark the workspace loaded: a caller of a progress backend waits on `awaitWorkspaceReady`.
    expect(proved).toBe(false);
    expect(session.isWorkspaceLoaded()).toBe(false);
    expect(openedDocuments(server)).toEqual([
      { path: shown(main), languageId: "go", version: 1, text: "package main\n" },
    ]);
  });

  it("reports the server version the process that answers stated for itself", async () => {
    const app = source("app.ts", "export const app = 1;\n");
    const server = fakeServer({ respond: answersServerInfo({ name: "typescript-go", version: "7.0.2" }) });
    const session = sessionOver(server, { root: tmp, config: TSGO, readFile });

    expect(session.serverInfo()).toBeUndefined();
    await session.openAnchors([app]);

    expect(session.serverInfo()).toEqual({ name: "typescript-go", version: "7.0.2" });
  });

  it("states no server version for a process that answered initialize without naming itself", async () => {
    const app = source("app.ts", "export const app = 1;\n");
    const server = fakeServer({ respond: () => ({}) });
    const session = sessionOver(server, { root: tmp, config: TSGO, readFile });

    await session.openAnchors([app]);

    expect(server.methods).toEqual(["initialize"]);
    expect(session.serverInfo()).toBeUndefined();
  });

  it("answers for the process that is live now, after the session was disposed and used again", async () => {
    const app = source("app.ts", "export const app = 1;\n");
    const first = fakeServer({ respond: answersServerInfo({ name: "typescript-go", version: "7.0.2" }) });
    const second = fakeServer({ respond: answersServerInfo({ name: "typescript-go", version: "7.1.0" }) });
    let started = 0;
    const session = new LspSession({
      root: tmp,
      config: TSGO,
      spawn: () => (started++ === 0 ? first.process : second.process),
      readFile,
      sleep: async () => {},
    });

    await session.openAnchors([app]);
    expect(session.serverInfo()).toEqual({ name: "typescript-go", version: "7.0.2" });
    expect(session.isWorkspaceLoaded()).toBe(true);

    session.dispose();
    expect(session.serverInfo()).toBeUndefined();
    expect(session.isWorkspaceLoaded()).toBe(false);

    expect(await session.openAnchors([app])).toBe(true);

    expect(session.serverInfo()).toEqual({ name: "typescript-go", version: "7.1.0" });
    expect(session.isWorkspaceLoaded()).toBe(true);
    expect(openedDocuments(second)).toEqual([
      { path: shown(app), languageId: "typescript", version: 1, text: "export const app = 1;\n" },
    ]);
  });

  it("moves the process generation when a live child is replaced, and only then", async () => {
    const app = source("app.ts", "export const app = 1;\n");
    let alive = true;
    const first = fakeServer({
      alive: () => alive,
      respond: (method) => {
        if (method === "textDocument/documentSymbol") {
          alive = false;
          throw new Error("connection got disposed");
        }
        return [];
      },
    });
    const second = fakeServer({ respond: () => [] });
    let started = 0;
    const session = new LspSession({
      root: tmp,
      config: TSGO,
      spawn: () => (started++ === 0 ? first.process : second.process),
      readFile,
      sleep: async () => {},
    });

    expect(await session.openAnchors([app])).toBe(true);
    // A first spawn takes nothing away from anyone, so nothing a caller is measuring goes stale.
    expect(session.generation()).toBe(0);

    // The child dies mid-request and the session replaces it to answer the same call.
    await session.request("textDocument/documentSymbol", { textDocument: { uri: uriOf(app) } });
    expect(started).toBe(2);
    expect(session.generation()).toBe(1);

    // That number is what a cached project map is bound to: the map was
    // proved against the dead process's baseline, which the replacement does not share.
    expect(await session.openAnchors([app])).toBe(true);
    expect(session.generation()).toBe(1);
  });

  it("proves nothing when the process is replaced partway through the opens, and proves the next one", async () => {
    const a = source("a.ts", "export const a = 1;\n");
    const b = source("b.ts", "export const b = 1;\n");
    let alive = true;
    let started = 0;
    let replace: () => Promise<unknown> = async () => {};
    let trip = true;
    const first = fakeServer({
      alive: () => alive,
      respond: (method) => {
        if (!alive) throw new Error("connection got disposed");
        return method === "initialize" ? { serverInfo: { name: "typescript-go", version: "7.0.2" } } : [];
      },
      // Another caller's request lands while this one is still writing its first anchor: the child dies and
      // the session replaces it to answer that call, so the loop below keeps opening documents onto a process
      // that is already gone.
      notify: async (method) => {
        if (method !== OPEN || !trip) return;
        trip = false;
        alive = false;
        await replace();
      },
    });
    const second = fakeServer({ respond: () => [] });
    const session = new LspSession({
      root: tmp,
      config: TSGO,
      spawn: () => (started++ === 0 ? first.process : second.process),
      readFile,
      sleep: async () => {},
    });
    replace = () => session.request("textDocument/documentSymbol", { textDocument: { uri: uriOf(b) } });

    // The mid-loop half: the mark is that the documents were opened ON THE PROCESS THAT ANSWERS, so a
    // loop that was interrupted by a replacement holds some documents on a dead child and none on the live one.
    expect(await session.openAnchors([a, b])).toBe(false);
    expect(session.generation()).toBe(1);
    expect(session.isWorkspaceLoaded()).toBe(false);
    // The loop stops at the replacement rather than writing the rest onto a dead child.
    expect(openedDocuments(first)).toHaveLength(1);
    expect(openedDocuments(second)).toEqual([]);

    // The next call opens everything again, on the process that will answer it, and the proof holds then.
    expect(await session.openAnchors([a, b])).toBe(true);
    expect(session.isWorkspaceLoaded()).toBe(true);
    expect(openedDocuments(second)).toHaveLength(2);
  });

  it("names the spawn a proof was made on, and that spawn moves on dispose-then-respawn where the generation does not", async () => {
    const app = source("app.ts", "export const app = 1;\n");
    const servers = [fakeServer({ respond: () => [] }), fakeServer({ respond: () => [] })];
    let started = 0;
    const session = new LspSession({
      root: tmp,
      config: TSGO,
      spawn: () => (servers[started++] as FakeServer).process,
      readFile,
      sleep: async () => {},
    });

    expect(session.spawnSerial()).toBeUndefined();
    const first = await session.openAnchorsOn([app]);
    expect(first).toBeDefined();
    expect(session.spawnSerial()).toBe(first);

    session.dispose();
    expect(session.spawnSerial()).toBeUndefined();
    const second = await session.openAnchorsOn([app]);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(session.generation()).toBe(0);
    expect(await session.openAnchorsOn([])).toBeUndefined();
  });

  it("re-opens an anchor whose file changed on disk, closing the stale document before opening it again", async () => {
    const app = source("app.ts", "export const app = 1;\n");
    const server = fakeServer({ respond: () => [] });
    const session = sessionOver(server, { root: tmp, config: TSGO, readFile });
    await session.openAnchors([app]);
    const before = server.notifications.length;

    appendFileSync(app, "// added\n");
    expect(await session.openAnchors([app])).toBe(true);

    // The buffer the server holds would otherwise shadow the disk, so the release comes first; the re-open is
    // this call's own business, because this is the call that has to answer with the anchor.
    expect(sequence(server, before)).toEqual([`${CLOSE} ${shown(app)}`, `${OPEN} ${shown(app)}`]);
    expect(openedDocuments(server)).toHaveLength(2);
    expect(openedDocuments(server)[1]?.text).toBe("export const app = 1;\n// added\n");
  });
});
