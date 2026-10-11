import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clangdConfig, goplsConfig } from "../../src/lsp/server-config.js";
import {
  fakeServer,
  pathOfDocumentId,
  pathOfUri,
  sessionOver,
  uriOf,
  type FakeServer,
} from "../helpers/fake-lsp.js";
import { sym } from "../helpers/fake-clangd.js";

const WATCHED = "workspace/didChangeWatchedFiles";
const OPEN = "textDocument/didOpen";
const CLOSE = "textDocument/didClose";

/** LSP's `FileChangeType`, spelled out here so a change to the payload's numbers fails a test. */
const CREATED = 1;
const CHANGED = 2;
const DELETED = 3;

/** A path as it comes back out of the URI this server sends, so both sides are spelled alike. */
const shown = (path: string) => pathOfUri(uriOf(path));

// The `pathKey` match that lets the walk and the caller spell one file differently only exists on a
// case-insensitive filesystem, so the test that pins it is skipped rather than vacuously passed.
const itIfCaseInsensitive = process.platform === "win32" ? it : it.skip;

function sentTo(server: FakeServer, method: string): [string, unknown][] {
  return server.notifications.filter(([sent]) => sent === method);
}

/** The notification order, which is the whole contract: release the shadowing buffer, report once. */
function sequence(server: FakeServer, from = 0): string[] {
  return server.notifications.slice(from).map(([method, params]) => {
    const path = pathOfDocumentId(params);
    return path === undefined ? method : `${method} ${path}`;
  });
}

/** Waits in real time, bounded, until a notification naming that method has been recorded. */
async function awaitNotification(server: FakeServer, method: string, from: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.notifications.length > from || sentTo(server, method).length > 0) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error(`the server never recorded ${method}`);
}

interface Harness {
  server: FakeServer;
  session: ReturnType<typeof sessionOver>;
  setSnapshot(snapshot: Map<string, string> | undefined): void;
  sent(): number;
  walks(): number;
}

/**
 * A gopls session over a module snapshot the test replaces when it wants the walk to see a change. The
 * walk runs at child start as well as on every check, so the snapshot is a variable, not a sequence.
 */
function started(
  snapshot: Map<string, string> | undefined,
  options: {
    kill?: () => void;
    alive?: () => boolean;
    notify?: (method: string, params: unknown) => unknown;
  } = {},
): Harness {
  let current = snapshot;
  let walks = 0;
  const server = fakeServer({
    respond: () => [sym("Foo", 5)],
    kill: options.kill,
    alive: options.alive,
    notify: options.notify,
  });
  const walk = (): Map<string, string> | undefined => {
    walks += 1;
    return current;
  };
  const session = sessionOver(server, { config: { ...goplsConfig, moduleSnapshot: walk } });
  return {
    server,
    session,
    setSnapshot: (value) => {
      current = value;
    },
    sent: () => server.notifications.length,
    walks: () => walks,
  };
}

/** The `changes` array of the nth watched-files notification the push sent, in the order it named files. */
function watchedEvents(server: FakeServer, index = 0): { uri: string; type: number }[] {
  const [, params] = sentTo(server, WATCHED)[index] ?? [];
  if (typeof params !== "object" || params === null || !("changes" in params)) return [];
  return (params as { changes: { uri: string; type: number }[] }).changes;
}

const withEntries = (base: Map<string, string>, extra: [string, string][]): Map<string, string> =>
  new Map<string, string>([...base, ...extra]);

describe("LspSession.refreshModuleSnapshot", () => {
  it("sends nothing when the module still matches the state the child started from", async () => {
    const h = started(new Map([["/mod/a.go", "10|100"]]));
    await h.session.documentSymbol("/mod/a.go");
    const sentBefore = h.sent();

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "unchanged" });
    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "unchanged" });
    expect(h.server.notifications).toHaveLength(sentBefore);
  });

  it("proves a session that has not started its child yet, without pushing anything", async () => {
    const { server, session } = started(new Map([["/mod/a.go", "1|1"]]));
    expect(await session.refreshModuleSnapshot()).toEqual({ kind: "unchanged" });
    expect(server.methods).toEqual([]);
  });

  it("does not push to a child that already died, because the next request loads the module afresh", async () => {
    const h = started(new Map([["/mod/a.go", "1|1"]]), { alive: () => false });
    await h.session.documentSymbol("/mod/a.go");
    h.setSnapshot(new Map([["/mod/a.go", "2|2"]]));

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "unchanged" });
    expect(sentTo(h.server, WATCHED)).toHaveLength(0);
    expect(sentTo(h.server, CLOSE)).toHaveLength(0);
  });

  it("walks nothing and proves nothing it cannot use for a config with no module walk", async () => {
    // The walk lives on the config, so "clangd never scans a Go module" is decided by there being
    // nothing to call — and a session with no walk must not dispose or report anything either.
    expect(clangdConfig.moduleSnapshot).toBeUndefined();
    expect(goplsConfig.moduleSnapshot).toBeDefined();

    const kill = vi.fn();
    const server = fakeServer({ respond: () => [sym("Foo", 5)], kill });
    const session = sessionOver(server, { root: "/proj", config: clangdConfig });
    await session.documentSymbol("/proj/a.cpp");

    expect(await session.refreshModuleSnapshot()).toEqual({ kind: "unchanged" });
    expect(kill).not.toHaveBeenCalled();
    expect(sentTo(server, WATCHED)).toHaveLength(0);
    // The clangd session's whole traffic is the handshake and the document it was asked to outline.
    expect(sequence(server)).toEqual(["initialized", `${OPEN} ${shown("/proj/a.cpp")}`]);
  });

  it("measures a change against the disk state the child started from, without a prior check", async () => {
    const atStart = new Map([["/mod/a.go", "1|1"]]);
    const h = started(atStart);
    await h.session.documentSymbol("/mod/a.go");
    const beforePush = h.sent();
    h.setSnapshot(withEntries(atStart, [["/mod/new.go", "2|2"]]));

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "pushed", changedFiles: 1 });
    expect(watchedEvents(h.server)).toEqual([{ uri: uriOf("/mod/new.go"), type: CREATED }]);
    // One notification is the whole push: no document is opened or closed to deliver it.
    expect(sequence(h.server, beforePush)).toEqual([WATCHED]);
  });

  it("releases the buffer that would shadow a changed file, then reports the diff once", async () => {
    const atStart = new Map<string, string>([
      ["/mod/a.go", "10|100"],
      ["/mod/b.go", "1|2"],
    ]);
    const h = started(atStart);
    await h.session.documentSymbol("/mod/a.go");
    const beforePush = h.sent();
    h.setSnapshot(
      new Map<string, string>([
        ["/mod/a.go", "11|100"],
        ["/mod/b.go", "1|2"],
        ["/mod/new.go", "5|5"],
      ]),
    );

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "pushed", changedFiles: 2 });
    expect(sequence(h.server, beforePush)).toEqual([`${CLOSE} ${shown("/mod/a.go")}`, WATCHED]);
    expect(watchedEvents(h.server)).toEqual([
      { uri: uriOf("/mod/new.go"), type: CREATED },
      { uri: uriOf("/mod/a.go"), type: CHANGED },
    ]);
    // The released document is not opened again by the push, and the re-read never entered the set.
    expect(sentTo(h.server, OPEN)).toHaveLength(1);
    expect(h.session.getOpenedFiles()).toEqual(["/mod/a.go"]);
  });

  it("drops a pushed file from the opened set, so the next outline re-sends its current text", async () => {
    const atStart = new Map([["/mod/a.go", "10|100"]]);
    const h = started(atStart);
    await h.session.documentSymbol("/mod/a.go");
    h.setSnapshot(new Map([["/mod/a.go", "99|200"]]));
    await h.session.refreshModuleSnapshot();

    await h.session.documentSymbol("/mod/a.go");
    const didOpens = sentTo(h.server, OPEN);
    expect(didOpens).toHaveLength(2);
    expect(didOpens[1]?.[1]).toMatchObject({ textDocument: { uri: uriOf("/mod/a.go"), text: "package main\n" } });
  });

  it("reports a changed file it never opened without closing anything it never opened", async () => {
    const atStart = new Map([["/mod/other.go", "1|1"]]);
    const h = started(atStart);
    await h.session.documentSymbol("/mod/a.go");
    const beforePush = h.sent();
    h.setSnapshot(withEntries(atStart, [["/mod/other.go", "2|2"]]));

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "pushed", changedFiles: 1 });
    expect(sequence(h.server, beforePush)).toEqual([WATCHED]);
    expect(watchedEvents(h.server)).toEqual([{ uri: uriOf("/mod/other.go"), type: CHANGED }]);
    expect(h.session.getOpenedFiles()).toEqual(["/mod/a.go"]);
  });

  it("reports a deleted file in the same notification and keeps the session running", async () => {
    const atStart = new Map<string, string>([
      ["/mod/a.go", "10|100"],
      ["/mod/gone.go", "1|2"],
    ]);
    const kill = vi.fn();
    const h = started(atStart, { kill });
    await h.session.documentSymbol("/mod/a.go");
    const beforePush = h.sent();
    h.setSnapshot(new Map([["/mod/a.go", "10|100"]]));

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "pushed", changedFiles: 1 });
    expect(watchedEvents(h.server)).toEqual([{ uri: uriOf("/mod/gone.go"), type: DELETED }]);
    expect(sequence(h.server, beforePush)).toEqual([WATCHED]);
    expect(kill).not.toHaveBeenCalled();
    // The baseline moved with the push, so the same state again is unchanged rather than a second report.
    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "unchanged" });
  });

  it("carries a creation and a deletion in one notification", async () => {
    const atStart = new Map<string, string>([
      ["/mod/old.go", "1|1"],
      ["/mod/keep.go", "2|2"],
    ]);
    const h = started(atStart);
    await h.session.documentSymbol("/mod/keep.go");
    h.setSnapshot(
      new Map<string, string>([
        ["/mod/new.go", "1|1"],
        ["/mod/keep.go", "2|2"],
      ]),
    );

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "pushed", changedFiles: 2 });
    expect(watchedEvents(h.server)).toEqual([
      { uri: uriOf("/mod/new.go"), type: CREATED },
      { uri: uriOf("/mod/old.go"), type: DELETED },
    ]);
    expect(sentTo(h.server, OPEN)).toHaveLength(1);
    expect(sentTo(h.server, CLOSE)).toHaveLength(0);
  });

  it("reloads a live child whose start-time walk failed, because nothing proves its graph", async () => {
    const kill = vi.fn();
    const h = started(undefined, { kill });
    await h.session.documentSymbol("/mod/a.go");

    const outcome = await h.session.refreshModuleSnapshot();
    expect(outcome.kind).toBe("reloaded");
    expect(outcome.reason).toMatch(/no module snapshot was taken .* before the server started/);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(sentTo(h.server, WATCHED)).toHaveLength(0);

    // With a walk that can finish, the respawned child is provable again.
    h.setSnapshot(new Map([["/mod/a.go", "1|1"]]));
    await h.session.documentSymbol("/mod/a.go");
    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "unchanged" });
  });

  it("proves a respawned child against its own start, so a later change still pushes", async () => {
    const atStart = new Map([["/mod/a.go", "1|1"]]);
    let failNextReport = true;
    const h = started(atStart, {
      notify: (method) => {
        if (method !== WATCHED) return undefined;
        if (failNextReport) {
          failNextReport = false;
          throw new Error("EPIPE: the child stopped reading");
        }
        return undefined;
      },
    });
    await h.session.documentSymbol("/mod/a.go");
    h.setSnapshot(withEntries(atStart, [["/mod/broken.go", "2|2"]]));
    expect((await h.session.refreshModuleSnapshot()).kind).toBe("reloaded");

    // The respawn walks again, and the state it walked is what the next check measures against — not
    // the baseline the failed report abandoned.
    await h.session.documentSymbol("/mod/a.go");
    const beforePush = h.sent();
    h.setSnapshot(withEntries(atStart, [["/mod/broken.go", "2|2"], ["/mod/late.go", "3|3"]]));

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "pushed", changedFiles: 1 });
    expect(sequence(h.server, beforePush)).toEqual([WATCHED]);
    // Index 1: the first report is the one that failed and was recorded before the pipe died.
    expect(watchedEvents(h.server, 1)).toEqual([{ uri: uriOf("/mod/late.go"), type: CREATED }]);
  });

  it("disposes the session instead of serving an unproved graph, and settles on the next call", async () => {
    const kill = vi.fn();
    const h = started(new Map([["/mod/a.go", "1|1"]]), { kill });
    await h.session.documentSymbol("/mod/a.go");
    h.setSnapshot(undefined);

    const outcome = await h.session.refreshModuleSnapshot();
    expect(outcome.kind).toBe("reloaded");
    expect(outcome.reason).toMatch(/bound/);
    expect(outcome.reason).toContain("/mod");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(sentTo(h.server, WATCHED)).toHaveLength(0);

    h.setSnapshot(new Map([["/mod/a.go", "1|1"]]));
    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "unchanged" });
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("reloads rather than advancing the baseline when the report fails", async () => {
    const kill = vi.fn();
    const h = started(new Map([["/mod/a.go", "1|1"]]), {
      kill,
      notify: (method, params) => {
        if (method === WATCHED && JSON.stringify(params)?.includes("new.go")) {
          throw new Error("EPIPE: the child stopped reading");
        }
      },
    });
    await h.session.documentSymbol("/mod/a.go");
    h.setSnapshot(withEntries(new Map([["/mod/a.go", "1|1"]]), [["/mod/new.go", "2|2"]]));

    const outcome = await h.session.refreshModuleSnapshot();
    expect(outcome.kind).toBe("reloaded");
    expect(outcome.reason).toMatch(/push for "\/mod" failed after it had begun/);
    expect(outcome.reason).toContain("EPIPE");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("leaves no diff behind for a graph it threw away, so no caller reads a dead child's comparison", async () => {
    const atStart = new Map([["/mod/a.go", "1|1"]]);
    const h = started(atStart);
    await h.session.documentSymbol("/mod/a.go");
    h.setSnapshot(withEntries(atStart, [["/mod/new.go", "2|2"]]));

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "pushed", changedFiles: 1 });
    expect(h.session.snapshotDiff()).toMatchObject({ created: ["/mod/new.go"] });

    // The reload abandoned the graph that diff described. A caller asking what the last check compared after
    // it would get the PREVIOUS child's answer, and a project map is rebuilt on exactly that question
    //, so the stale half has to go with the baseline it belonged to.
    h.setSnapshot(undefined);
    expect((await h.session.refreshModuleSnapshot()).kind).toBe("reloaded");
    expect(h.session.snapshotDiff()).toBeUndefined();
  });

  it("serialises concurrent checks so no caller answers while the report is still being written", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const h = started(new Map<string, string>(), {
      notify: (method) => (method === WATCHED ? held : undefined),
    });
    await h.session.documentSymbol("/mod/a.go");
    const beforePush = h.sent();
    h.setSnapshot(new Map([["/mod/new.go", "2|2"]]));

    let settled = 0;
    const both = Promise.all([h.session.refreshModuleSnapshot(), h.session.refreshModuleSnapshot()]).then(
      (outcomes) => {
        settled += 1;
        return outcomes;
      },
    );
    await awaitNotification(h.server, WATCHED, beforePush);
    // Both are still waiting on the notification they just made. Unsynchronised, the second check would
    // have diffed against the baseline the first one replaced, answered `unchanged`, and let its caller
    // ask its type-aware query before the report had reached the server.
    expect(settled).toBe(0);

    release();
    expect(await both).toEqual([
      { kind: "pushed", changedFiles: 1 },
      { kind: "pushed", changedFiles: 1 },
    ]);
    // One walk for the pair, on top of the one that started the child.
    expect(h.walks()).toBe(2);
    expect(sequence(h.server, beforePush)).toEqual([WATCHED]);
  }, 10_000);

  it("pushes through the notification route only, and issues no request the config denies", async () => {
    const atStart = new Map([["/mod/a.go", "1|1"]]);
    const h = started(atStart);
    await h.session.documentSymbol("/mod/a.go");
    h.setSnapshot(withEntries(atStart, [["/mod/new.go", "2|2"]]));
    await h.session.refreshModuleSnapshot();

    expect(h.server.methods).toEqual(["initialize", "textDocument/documentSymbol"]);
    await expect(h.session.request(WATCHED, {})).rejects.toThrow(
      /gopls will not be asked for "workspace\/didChangeWatchedFiles"/,
    );
    expect(h.server.methods).toEqual(["initialize", "textDocument/documentSymbol"]);
  });

  itIfCaseInsensitive("matches an open file by path, not by spelling, when the walk spells it differently", async () => {
    const h = started(new Map([["/MOD/A.GO", "1|1"]]));
    await h.session.documentSymbol("/mod/a.go");
    const beforePush = h.sent();
    h.setSnapshot(new Map([["/MOD/A.GO", "2|2"]]));

    expect(await h.session.refreshModuleSnapshot()).toEqual({ kind: "pushed", changedFiles: 1 });
    // The release names the document the server was given, which only a path match — not a string
    // match — could work out from the walk's other spelling.
    expect(sequence(h.server, beforePush)).toEqual([`${CLOSE} ${shown("/mod/a.go")}`, WATCHED]);
    expect(watchedEvents(h.server)).toEqual([{ uri: uriOf("/MOD/A.GO"), type: CHANGED }]);
  });
});

describe("the one-file staleness check behind go_file_symbols", () => {
  let tmp: string;

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("re-opens a file that changed on disk since its didOpen, from one stat and no walk", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-stale-"));
    const file = join(tmp, "a.go");
    writeFileSync(file, "package a\n");
    const server = fakeServer({ respond: () => [sym("Foo", 5)] });
    const realWalk = goplsConfig.moduleSnapshot ?? ((): Map<string, string> => new Map());
    let walks = 0;
    const session = sessionOver(server, {
      root: tmp,
      config: {
        ...goplsConfig,
        moduleSnapshot: (root) => {
          walks += 1;
          return realWalk(root);
        },
      },
      readFile: (path) => readFileSync(path, "utf-8"),
    });

    await session.documentSymbol(file);
    await session.documentSymbol(file);
    expect(sentTo(server, OPEN)).toHaveLength(1);
    // The only walk this session did was the one that starts a child; an outline is corrected by one
    // `stat` per call, not by a traversal.
    expect(walks).toBe(1);

    appendFileSync(file, "// added\n");
    await session.documentSymbol(file);

    const didOpens = sentTo(server, OPEN);
    expect(didOpens).toHaveLength(2);
    expect(sentTo(server, CLOSE)).toHaveLength(1);
    expect(didOpens[1]?.[1]).toMatchObject({ textDocument: { text: "package a\n// added\n" } });
    expect(walks).toBe(1);
  });
});
