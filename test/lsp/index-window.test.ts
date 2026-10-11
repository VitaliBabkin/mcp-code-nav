import { describe, expect, it } from "vitest";
import { clangdConfig, type LanguageServerConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { fakeServer, type FakeServer } from "../helpers/fake-lsp.js";

/**
 * A session with its server running and warm: the window under test is entered by a request, and a clangd
 * session whose first outline answer is empty takes the cold-empty retry, which is not what these cases
 * are about.
 */
async function running(config: LanguageServerConfig = clangdConfig) {
  const server = fakeServer({
    respond: () => [{ name: "Foo", kind: 5, range: { start: { line: 0 }, end: { line: 1 } } }],
  });
  const session = new LspSession({
    root: "/proj",
    config,
    spawn: () => server.process,
    readFile: () => "class Foo {};\n",
    sleep: async () => {},
  });
  await session.documentSymbol("/proj/a.cpp");
  return { server, session };
}

/** One request's window, with the answer discarded: these cases read the state latched beside it. */
async function stateOver(session: LspSession, during: () => void = () => {}): Promise<string> {
  const { index } = await session.withIndexWindow(async () => {
    during();
    return session.request<unknown>("textDocument/documentSymbol", { textDocument: { uri: "file:///proj/a.cpp" } });
  });
  return index;
}

/**
 * The index state, cell by cell, driven by a fake connection that emits, withholds or
 * leaves open a progress token. The latch rather than the sample is the point: a `begin`/`end` pair that
 * opens and closes inside the window is the case an implementation reading the state at the reply passes
 * wrongly, and the two `isError` cells of the table (an empty answer while `building` or `unknown`) are
 * built on the verdict these tests pin.
 */
describe("the index state latched over a request window", () => {
  it("is unknown for a process that never reported indexing progress, and is not read as idle", async () => {
    const { session } = await running();
    expect(await stateOver(session)).toBe("unknown");
  });

  it("is quiescent once progress has been seen and no token is in flight", async () => {
    const { server, session } = await running();
    await server.createProgress("idx");
    server.sendProgress("idx", { kind: "begin" });
    server.sendProgress("idx", { kind: "end" });

    expect(await stateOver(session)).toBe("quiescent");
  });

  it("is quiescent when the server only ever created a token and never began a round", async () => {
    const { server, session } = await running();
    await server.createProgress("idx");

    expect(await stateOver(session)).toBe("quiescent");
  });

  it("is building while a token opened before the window is still in flight at its reply", async () => {
    const { server, session } = await running();
    await server.createProgress("idx");
    server.sendProgress("idx", { kind: "begin" });

    expect(await stateOver(session)).toBe("building");
  });

  it("is building for a round that began and ended inside the window — what a sample at the reply misses", async () => {
    const { server, session } = await running();
    await server.createProgress("idx");

    expect(
      await stateOver(session, () => {
        server.sendProgress("idx", { kind: "begin" });
        server.sendProgress("idx", { kind: "end" });
      }),
    ).toBe("building");
  });

  it("is building while any of several concurrent rounds is outstanding", async () => {
    const { server, session } = await running();
    await server.createProgress("idx-a");
    await server.createProgress("idx-b");
    server.sendProgress("idx-a", { kind: "begin" });
    server.sendProgress("idx-b", { kind: "begin" });
    server.sendProgress("idx-a", { kind: "end" });

    expect(await stateOver(session)).toBe("building");

    server.sendProgress("idx-b", { kind: "end" });
    expect(await stateOver(session)).toBe("quiescent");
  });

  it("catches the second round of a token clangd re-uses, because its handler outlived the first end", async () => {
    const { server, session } = await running();
    await server.createProgress("idx");
    server.sendProgress("idx", { kind: "begin" });
    server.sendProgress("idx", { kind: "end" });
    expect(await stateOver(session)).toBe("quiescent");

    server.sendProgress("idx", { kind: "begin" });
    expect(await stateOver(session)).toBe("building");
  });

  it("treats a report as no more than progress of a round already counted", async () => {
    const { server, session } = await running();
    await server.createProgress("idx");
    server.sendProgress("idx", { kind: "begin" });
    server.sendProgress("idx", { kind: "end" });

    expect(
      await stateOver(session, () => {
        server.sendProgress("idx", { kind: "report", message: "indexing 40%" });
      }),
    ).toBe("quiescent");
  });

  it("hands the answer back untouched, and a rejected request rejects without inventing a verdict", async () => {
    const { server, session } = await running();
    await server.createProgress("idx");

    const { value } = await session.withIndexWindow(async () => 7);
    expect(value).toBe(7);
    await expect(
      session.withIndexWindow(async () => {
        server.sendProgress("idx", { kind: "begin" });
        throw new Error("the request failed");
      }),
    ).rejects.toThrow("the request failed");

    // The window that failed is closed; the next one answers for its own span, not the last one's.
    server.sendProgress("idx", { kind: "end" });
    expect(await stateOver(session)).toBe("quiescent");
  });

  it("starts over on a replacement process, which has announced nothing of its own", async () => {
    let firstDied = false;
    const first: FakeServer = fakeServer({ alive: () => !firstDied });
    const second: FakeServer = fakeServer();
    let call = 0;
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => (call++ === 0 ? first.process : second.process),
      readFile: () => "class Foo {};\n",
      sleep: async () => {},
    });
    await session.documentSymbol("/proj/a.cpp");
    await first.createProgress("idx");
    first.sendProgress("idx", { kind: "begin" });
    first.sendProgress("idx", { kind: "end" });
    expect(await stateOver(session)).toBe("quiescent");

    firstDied = true;
    await session.documentSymbol("/proj/b.cpp");
    expect(await stateOver(session)).toBe("unknown");

    await second.createProgress("idx");
    second.sendProgress("idx", { kind: "begin" });
    second.sendProgress("idx", { kind: "end" });
    expect(await stateOver(session)).toBe("quiescent");
    session.dispose();
  });

  it("says nothing across a replacement that happened inside the window, rather than blaming the new process for the old one's round", async () => {
    const outline = [{ name: "Foo", kind: 5, range: { start: { line: 0 }, end: { line: 1 } } }];
    let firstDied = false;
    const first: FakeServer = fakeServer({ alive: () => !firstDied, respond: () => outline });
    const second: FakeServer = fakeServer({ respond: () => outline });
    let call = 0;
    const session = new LspSession({
      root: "/proj",
      config: clangdConfig,
      spawn: () => (call++ === 0 ? first.process : second.process),
      readFile: () => "class Foo {};\n",
      sleep: async () => {},
    });
    await session.documentSymbol("/proj/a.cpp");
    await first.createProgress("idx");
    first.sendProgress("idx", { kind: "begin" });

    const { value, index } = await session.withIndexWindow(async () => {
      firstDied = true;
      const answer = await session.documentSymbol("/proj/b.cpp");
      await second.createProgress("idx");
      return answer;
    });

    // The request itself is answered by the replacement and reported as such; only the index state is
    // withheld, because the round that was in flight at the window's start belonged to the child that died.
    expect(value).toMatchObject({ state: "ok" });
    expect(index).toBe("unknown");
    expect(await stateOver(session)).toBe("quiescent");
    session.dispose();
  });

  it("leaves the readiness proof to the first token while counting every one", async () => {
    const { server, session } = await running();
    await server.createProgress("load");
    await server.createProgress("idx");
    server.sendProgress("idx", { kind: "begin" });

    // An indexing round in flight is not a proven initial load, and the state of one does not answer the
    // other: gopls's proof and clangd's counter stay separate questions.
    expect(session.isWorkspaceLoaded()).toBe(false);
    expect(await stateOver(session)).toBe("building");

    server.sendProgress("idx", { kind: "end" });
    server.sendProgress("load", { kind: "end" });
    expect(session.isWorkspaceLoaded()).toBe(true);
    expect(await stateOver(session)).toBe("quiescent");
  });
});
