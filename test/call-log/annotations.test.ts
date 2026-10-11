import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  newCallAnnotations,
  noteReadyWait,
  noteSession,
  withCallAnnotations,
} from "../../src/call-log/annotations.js";
import { clangdConfig, goplsConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { fakeServer } from "../helpers/fake-lsp.js";
import { sym } from "../helpers/fake-clangd.js";

describe("the annotation bag", () => {
  it("ignores a note raised outside a tap-opened context", () => {
    expect(() => {
      noteSession(true);
      noteReadyWait(5);
    }).not.toThrow();
    expect(newCallAnnotations()).toEqual({ spawned: null, readyWaitMs: null });
  });

  it("notes into the call that opened the bag and not into the next one", () => {
    const first = newCallAnnotations();
    const second = newCallAnnotations();
    withCallAnnotations(first, () => noteSession(true));
    withCallAnnotations(second, () => noteSession(false));
    expect(first.spawned).toBe(true);
    expect(second.spawned).toBe(false);
  });

  it("lets a creation win over a reuse within one call, because that call paid the spawn", () => {
    const bag = newCallAnnotations();
    withCallAnnotations(bag, () => {
      noteSession(false);
      noteSession(true);
      noteSession(false);
    });
    expect(bag.spawned).toBe(true);
  });

  it("sums the readiness waits of one call and keeps a zero as the answer it is", () => {
    const bag = newCallAnnotations();
    withCallAnnotations(bag, () => {
      noteReadyWait(0);
      noteReadyWait(12.6);
    });
    expect(bag.readyWaitMs).toBe(13);
    expect(newCallAnnotations().readyWaitMs).toBeNull();
  });

  it("drops a wait that is not a duration rather than writing a nonsense number", () => {
    const bag = newCallAnnotations();
    withCallAnnotations(bag, () => {
      noteReadyWait(-2);
      noteReadyWait(Number.NaN);
    });
    expect(bag.readyWaitMs).toBeNull();
  });
});

describe("LspSessionManager.get", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-code-nav-note-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("notes that the call that asked first created the session, and the one after it did not", () => {
    const manager = new LspSessionManager();
    const created = newCallAnnotations();
    const reused = newCallAnnotations();

    const session = withCallAnnotations(created, () => manager.get(root, clangdConfig));
    withCallAnnotations(reused, () => expect(manager.get(root, clangdConfig)).toBe(session));

    expect(created.spawned).toBe(true);
    expect(reused.spawned).toBe(false);
  });

  it("notes nothing at all when no call is open, which is how a background session stays unattributed", () => {
    const manager = new LspSessionManager();
    expect(() => manager.get(root, clangdConfig)).not.toThrow();
  });
});

describe("LspSession.awaitWorkspaceReady", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-code-nav-ready-"));
    file = join(root, "a.cpp");
    writeFileSync(file, "class Foo {};\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("notes the wait it took, including the zero of a session already proven ready", async () => {
    const server = fakeServer({
      respond: async (method) => (method === "initialize" ? {} : [sym("Foo", 5)]),
    });
    const session = new LspSession({
      root: resolve(root),
      config: goplsConfig,
      spawn: () => server.process,
      readFile: () => "class Foo {};\n",
      sleep: async () => {},
    });
    await session.documentSymbol(file);
    await server.createProgress("tok");
    server.sendProgress("tok", { kind: "end", message: "done" });

    const warm = newCallAnnotations();
    expect(await withCallAnnotations(warm, () => session.awaitWorkspaceReady(1_000))).toBe("ready");
    expect(warm.readyWaitMs).toBe(0);

    const cold = new LspSession({
      root: resolve(root),
      config: goplsConfig,
      spawn: () => fakeServer({ respond: async (method) => (method === "initialize" ? {} : []) }).process,
      readFile: () => "class Foo {};\n",
      sleep: async () => {},
    });
    expect(await withCallAnnotations(cold, () => cold.awaitWorkspaceReady(5))).toBe("timed-out");
    expect(typeof cold.readyWaitMs).toBe("number");
    expect(cold.readyWaitMs).toBeLessThan(5_000);
  });

  it("leaves the outcome a caller sees unchanged when nothing noted it", async () => {
    const session = new LspSession({
      root: resolve(root),
      config: clangdConfig,
      spawn: () => fakeServer({ respond: async () => ({}) }).process,
      readFile: () => "",
      sleep: async () => {},
    });
    await expect(session.awaitWorkspaceReady(5)).resolves.toBe("timed-out");
  });
});
