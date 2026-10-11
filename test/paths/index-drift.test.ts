import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clangdConfig, goplsConfig } from "../../src/lsp/server-config.js";
import { LspSession } from "../../src/lsp/session.js";
import {
  IndexDrift,
  takeIndexSnapshot,
  walkFailure,
  type IndexDriftVerdict,
  type IndexSnapshot,
} from "../../src/paths/index-drift.js";
import { pathKey } from "../../src/paths/path-containment.js";
import { fileUri } from "../../src/lsp/document-uri.js";
import { fakeServer } from "../helpers/fake-lsp.js";

/** One platform's truth about a path's casing is not another's; the consequence test says so. */
const itIfWindows = process.platform === "win32" ? it : it.skip;

/** A walk's output built from the paths a test spells, exactly as the walk folds them. */
const snap = (entries: Record<string, string>): IndexSnapshot => ({
  stamps: new Map(Object.entries(entries).map(([path, stamp]) => [pathKey(path), stamp])),
  paths: new Map(Object.entries(entries).map(([path]) => [pathKey(path), path])),
});

/** One engine whose walk hands out the snapshots a test queues, with every push recorded in order. */
function harness(
  walks: (IndexSnapshot | undefined)[],
  opts: { gate?: Promise<void>; closeGate?: Promise<void> } = {},
) {
  const events: string[] = [];
  const notifications: [string, unknown][] = [];
  const held = new Map<string, string>();
  const state = { notifyFails: false };
  let taken = 0;
  const drift = new IndexDrift({
    takeSnapshot: () => walks[Math.min(taken++, walks.length - 1)],
    notify: async (method, params) => {
      if (opts.gate !== undefined) await opts.gate;
      if (state.notifyFails) throw new Error("the pipe closed");
      events.push("notify");
      notifications.push([method, params]);
    },
    closeOpen: async (path) => {
      if (opts.closeGate !== undefined) await opts.closeGate;
      events.push(`close:${path}`);
    },
    openedAs: (path) => held.get(path),
  });
  return { drift, events, notifications, held, state };
}

describe("takeIndexSnapshot", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-code-nav-drift-walk-"));
    writeFileSync(join(root, "widget.cpp"), "class Widget {};\n");
    writeFileSync(join(root, "widget.h"), "#pragma once\n");
    writeFileSync(join(root, "notes.md"), "# not a source\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "other.cc"), "int other() { return 0; }\n");
    mkdirSync(join(root, ".cache", "clangd"), { recursive: true });
    writeFileSync(join(root, ".cache", "clangd", "widget.cpp.AAAABBBB.idx"), "shards");
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, "build", "generated.cpp"), "// generated\n");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep.cpp"), "// vendored\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("collects the sources and headers under a root with a stamp each, and nothing else", () => {
    const snapshot = takeIndexSnapshot([root]);

    expect(snapshot).toBeDefined();
    expect([...(snapshot?.paths.values() ?? [])].sort()).toEqual(
      [join(root, "widget.cpp"), join(root, "widget.h"), join(root, "sub", "other.cc")].sort(),
    );
    expect(snapshot?.stamps.get(pathKey(join(root, "widget.cpp")))).toMatch(/^\d+\|\d+(\.\d+)?$/);
  });

  it("never walks into the directories that hold no source this project compiled", () => {
    const snapshot = takeIndexSnapshot([root]);
    const files = [...(snapshot?.paths.values() ?? [])];

    expect(files.filter((file) => file.includes(".cache"))).toEqual([]);
    expect(files.filter((file) => file.includes("node_modules"))).toEqual([]);
    expect(files.filter((file) => file.includes("build"))).toEqual([]);
  });

  it("walks a declared root whose own name is a skipped one, because a build directory is a normal root", () => {
    const built = join(root, "build");

    expect(takeIndexSnapshot([built])?.stamps.size).toBe(1);
    expect([...(takeIndexSnapshot([built])?.paths.values() ?? [])]).toEqual([join(built, "generated.cpp")]);
  });

  it("reports a bounded walk as no usable look, rather than as a smaller snapshot", () => {
    const bounded = takeIndexSnapshot([root], { maxEntries: 2 });

    expect(walkFailure(bounded)).toBe("entry-bound");
    expect(bounded.account?.bounded).toBe(true);
    // The stamps it did collect stay visible to the caller that reports why it cannot answer, and the
    // drift engine is what refuses to compare them: see the engine case below.
    expect(bounded.account?.walkIncomplete).toBe(false);
  });

  it("reports an unlistable root as no usable look, and walks one root spelled two ways only once", () => {
    expect(walkFailure(takeIndexSnapshot([join(root, "widget.cpp")]))).toBe("unreadable-directory");

    // The same directory as `root` by two spellings that survive any platform: a `..` detour through its
    // parent, and a trailing separator. Each is entered once, so the entry bound is not spent twice.
    const spelledTwice = [root, join(root, "..", basename(root)), `${root}${sep}`];
    expect(takeIndexSnapshot(spelledTwice).stamps.size).toBe(3);
    expect([...(takeIndexSnapshot(spelledTwice).paths?.values() ?? [])]).toContain(join(root, "widget.cpp"));
  });

  it("keeps its account of the sources it visited, for the blind-spot signal beside the drift", () => {
    const snapshot = takeIndexSnapshot([root]);

    expect(snapshot.account?.sources.sort()).toEqual([join(root, "widget.cpp"), join(root, "sub", "other.cc")].sort());
    expect(snapshot.account?.walkIncomplete).toBe(false);
    expect(snapshot.account?.bounded).toBe(false);
    expect(snapshot.account?.unreachableSourceRoots).toEqual([]);
    // A header is stamped but is not a TU: `uncoveredSources` claims only about sources.
    expect(snapshot.stamps.size).toBe(3);
  });

  it("names a declared root it was given but never entered, so no signal claims a file was looked at", () => {
    const hidden = join(root, "build");

    const snapshot = takeIndexSnapshot([root, hidden]);

    // `build` is dropped as contained by `root`, and the outer walk skips that name, so nothing under it
    // was seen: the account has to say so, and `generated.cpp` is not in the source list.
    expect(snapshot.account?.unreachableSourceRoots).toEqual([hidden]);
    expect(snapshot.account?.sources).not.toContain(join(hidden, "generated.cpp"));
  });

  it("keys its stamps on the canonical path and keeps the walked spelling for the report", () => {
    const snapshot = takeIndexSnapshot([root]);

    expect(snapshot?.stamps.size).toBe(3);
    for (const [key, stamp] of snapshot?.stamps ?? []) {
      const walked = snapshot?.paths.get(key);
      expect(walked, `no display path kept for ${key}`).toBeDefined();
      expect(key).toBe(pathKey(walked as string));
      expect(stamp).toMatch(/^\d+\|\d+(\.\d+)?$/);
    }
    expect(snapshot?.paths.get(pathKey(join(root, "widget.cpp")))).toBe(join(root, "widget.cpp"));
  });

  it("drops a declared root that another declared root contains, so no subtree is enumerated twice", () => {
    // What this fixture costs the bound, pinned rather than assumed: the root lists seven entries
    // (three files, `sub`, and the three skipped directories) and `sub` lists one, so the union is eight
    // claims. A nested root walked a second time would need nine and report no snapshot at all — which is
    // how `index-drift-unknown` landed on every call of a project that declares both a tree and a
    // directory inside it.
    expect(walkFailure(takeIndexSnapshot([root], { maxEntries: 7 }))).toBe("entry-bound");
    expect(walkFailure(takeIndexSnapshot([root], { maxEntries: 8 }))).toBeUndefined();
    expect(walkFailure(takeIndexSnapshot([root, join(root, "sub")], { maxEntries: 8 }))).toBeUndefined();

    const nested = takeIndexSnapshot([root, join(root, "sub")]);

    expect(nested.stamps.size).toBe(3);
    expect([...nested.paths.values()].sort()).toEqual(
      [join(root, "widget.cpp"), join(root, "widget.h"), join(root, "sub", "other.cc")].sort(),
    );
  });
});

describe("the drift verdict one index-backed call is preceded by", () => {
  it("is unknown for the first call over a root set, which is also the call that takes the baseline", async () => {
    const { drift, events } = harness([snap({ "/a/widget.cpp": "10|1" })]);

    expect(await drift.check(["/a"])).toMatchObject({ kind: "unknown" });
    expect(events).toEqual([]);
    expect(await drift.check(["/a"])).toEqual({ kind: "current" });
  });

  it("names the sources that moved, releases the document held for one, and reports the whole set once", async () => {
    const before = snap({ "/a/widget.cpp": "10|1", "/a/widget.h": "20|2", "/a/gone.cpp": "30|3" });
    const after = snap({ "/a/widget.cpp": "99|9", "/a/widget.h": "20|2", "/a/new.cpp": "40|4" });
    const { drift, events, notifications, held } = harness([before, after]);
    held.set("/a/widget.cpp", "/a/widget.cpp");
    held.set("/a/gone.cpp", "/a/gone.cpp");
    await drift.check(["/a"]);

    const verdict = await drift.check(["/a"]);
    expect(verdict).toEqual({
      kind: "stale",
      files: ["/a/new.cpp", "/a/widget.cpp", "/a/gone.cpp"],
    });
    // The close comes first: a buffer this client holds would otherwise shadow the disk it is told about.
    expect(events).toEqual(["close:/a/widget.cpp", "close:/a/gone.cpp", "notify"]);
    expect(notifications[0]?.[0]).toBe("workspace/didChangeWatchedFiles");
    expect(notifications[0]?.[1]).toEqual({
      changes: [
        { uri: fileUri("/a/new.cpp"), type: 1 },
        { uri: fileUri("/a/widget.cpp"), type: 2 },
        { uri: fileUri("/a/gone.cpp"), type: 3 },
      ],
    });
  });

  it("keeps the baseline it has when the walk cannot complete, and says so without disposing anything", async () => {
    const { drift, events } = harness([snap({ "/a/widget.cpp": "10|1" }), undefined, snap({ "/a/widget.cpp": "99|9" })]);
    await drift.check(["/a"]);

    const failed = await drift.check(["/a"]);
    expect(failed).toMatchObject({ kind: "unknown" });
    expect((failed as { reason: string }).reason).toMatch(/did not complete within its entry bound/);
    expect(events).toEqual([]);

    // Nothing was learned and nothing was forgotten, so the change the failed walk missed is still named.
    expect(await drift.check(["/a"])).toMatchObject({ kind: "stale", files: ["/a/widget.cpp"] });
  });

  it("names the cause of an unusable walk and still hands over what it saw", async () => {
    // A real walk over a real tree, given a bound it cannot fit: the drift verdict is refused, and the
    // account still comes back, because "these are the sources I reached" is a separate fact from "I
    // cannot say what the index is behind".
    const dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-drift-bound-"));
    try {
      writeFileSync(join(dir, "a.cpp"), "int a();\n");
      writeFileSync(join(dir, "b.cpp"), "int b();\n");
      writeFileSync(join(dir, "c.cpp"), "int c();\n");
      const drift = new IndexDrift({
        takeSnapshot: (roots) => takeIndexSnapshot(roots, { maxEntries: 1 }),
        notify: async () => {},
        closeOpen: async () => {},
        openedAs: () => undefined,
      });

      const reading = await drift.checkWithAccount([dir]);

      expect(reading.verdict).toMatchObject({ kind: "unknown", cause: "entry-bound" });
      expect(reading.account?.bounded).toBe(true);
      expect(reading.account?.sources.length).toBeGreaterThan(0);

      const usable = new IndexDrift({
        takeSnapshot: (roots) => takeIndexSnapshot(roots),
        notify: async () => {},
        closeOpen: async () => {},
        openedAs: () => undefined,
      });
      const second = await usable.checkWithAccount([dir]);

      expect(second.verdict).toMatchObject({ kind: "unknown", cause: "no-baseline" });
      expect(second.account?.bounded).toBe(false);
      expect([...(second.account?.sources ?? [])].sort()).toEqual(
        [join(dir, "a.cpp"), join(dir, "b.cpp"), join(dir, "c.cpp")].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an unlanded push as unknown and offers the same paths to the server again", async () => {
    const { drift, notifications, state } = harness([snap({ "/a/widget.cpp": "10|1" }), snap({ "/a/widget.cpp": "99|9" })]);
    await drift.check(["/a"]);
    state.notifyFails = true;

    const failed = await drift.check(["/a"]);
    expect(failed).toMatchObject({ kind: "unknown" });
    expect((failed as { reason: string }).reason).toMatch(/could not be reported to the server \(the pipe closed\)/);
    expect(notifications).toEqual([]);

    state.notifyFails = false;
    const retried = await drift.check(["/a"]);
    expect(retried).toMatchObject({ kind: "stale", files: ["/a/widget.cpp"] });
    expect(notifications).toHaveLength(1);
  });

  it("keys the baseline on the root set, so two callers asking different roots never share one", async () => {
    const inA = snap({ "/a/widget.cpp": "10|1" });
    const inB = snap({ "/b/widget.cpp": "10|1" });
    const both = snap({ "/a/widget.cpp": "10|1", "/b/widget.cpp": "10|1" });
    const { drift } = harness([inA, inB, inA, both, both]);

    expect(await drift.check(["/a"])).toMatchObject({ kind: "unknown" });
    // A second root set gets its own baseline and does not disturb the first one's.
    expect(await drift.check(["/b"])).toMatchObject({ kind: "unknown" });
    expect(await drift.check(["/a"])).toEqual({ kind: "current" });
    // The pair is a third key, and one key however its roots are ordered.
    expect(await drift.check(["/b", "/a"])).toMatchObject({ kind: "unknown" });
    expect(await drift.check(["/a", "/b"])).toEqual({ kind: "current" });
  });

  it("shares one check with a concurrent caller instead of diffing against a baseline being replaced", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { drift, events } = harness([snap({ "/a/widget.cpp": "10|1" }), snap({ "/a/widget.cpp": "99|9" })], { gate });
    await drift.check(["/a"]);

    const first = drift.check(["/a"]);
    const second = drift.check(["/a"]);
    release();
    const verdicts = await Promise.all([first, second]);

    expect(verdicts[0]).toEqual(verdicts[1]);
    expect(events).toEqual(["notify"]);
  });

  it("publishes no verdict from a check whose process was replaced while it was reporting", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const moved = snap({ "/a/widget.cpp": "99|9" });
    const { drift, events, notifications } = harness([snap({ "/a/widget.cpp": "10|1" }), moved, moved], { gate });
    await drift.check(["/a"]);

    const inFlight = drift.check(["/a"]);
    drift.reset();
    const afterReplacement = drift.check(["/a"]);
    release();
    const oldVerdict = await inFlight;

    expect(oldVerdict).toMatchObject({ kind: "unknown" });
    expect((oldVerdict as { reason: string }).reason).toMatch(/the server was replaced while this call/);
    // The caller that arrived after the replacement got its own check and took its own baseline, instead
    // of inheriting the dead process's verdict — which is what it would have done, reported as `stale`.
    const fresh = await afterReplacement;
    expect(fresh).toMatchObject({ kind: "unknown" });
    expect((fresh as { reason: string }).reason).toMatch(/first index-backed answer/);
    expect(events).toEqual(["notify"]);
    expect(notifications).toHaveLength(1);
  });

  it("stops a push mid-way when the process is replaced, so the replacement is not told the rest of it", async () => {
    let release: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { drift, events, held } = harness(
      [snap({ "/a/a.cpp": "10|1", "/a/b.cpp": "10|1" }), snap({ "/a/a.cpp": "99|9", "/a/b.cpp": "99|9" })],
      { closeGate },
    );
    held.set("/a/a.cpp", "/a/a.cpp");
    held.set("/a/b.cpp", "/a/b.cpp");
    await drift.check(["/a"]);

    const inFlight = drift.check(["/a"]);
    drift.reset();
    release();
    const verdict = await inFlight;

    // One release happened before the replacement; the second was refused, and no watched-files
    // notification went to a process this check cannot name.
    expect(events).toEqual(["close:/a/a.cpp"]);
    expect(verdict).toMatchObject({ kind: "unknown" });
  });

  it("starts over when told the process was replaced, which has read the disk for itself", async () => {
    const { drift } = harness([snap({ "/a/widget.cpp": "10|1" }), snap({ "/a/widget.cpp": "10|1" })]);
    await drift.check(["/a"]);
    expect(await drift.check(["/a"])).toEqual({ kind: "current" });

    drift.reset();
    expect(await drift.check(["/a"])).toMatchObject({ kind: "unknown" });
  });
});

describe("the drift signal through a session", () => {
  let root: string;
  let source: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-code-nav-drift-live-"));
    source = join(root, "widget.cpp");
    writeFileSync(source, "class Widget {};\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function sessionWith(config: typeof clangdConfig) {
    const server = fakeServer({
      respond: () => [{ name: "Widget", kind: 5, range: { start: { line: 0 }, end: { line: 1 } } }],
    });
    const session = new LspSession({
      root,
      config,
      spawn: () => server.process,
      readFile: () => "class Widget {};\n",
      sleep: async () => {},
    });
    return { server, session };
  }

  it("pushes the changed source clangd holds a buffer for, once, as a notification", async () => {
    const { server, session } = sessionWith(clangdConfig);
    await session.documentSymbol(source);
    const first = await session.indexDrift([root]);
    expect(first).toMatchObject({ kind: "unknown" });

    // A longer body is enough to move the stamp: size is half of it, so no clock granularity is trusted.
    writeFileSync(source, "class Widget { void paint(); };\n");
    const second: IndexDriftVerdict = await session.indexDrift([root]);

    expect(second).toMatchObject({ kind: "stale", files: [source] });
    const changes = server.notifications.filter(([method]) => method === "workspace/didChangeWatchedFiles");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.[1]).toEqual({ changes: [{ uri: fileUri(source), type: 2 }] });
    // The held document is released so the notification can reach the disk behind it, and the release
    // precedes the report. Nothing else was sent: the drift push is one notification for the whole diff.
    expect(server.notifications.map(([method]) => method)).toEqual([
      "initialized",
      "textDocument/didOpen",
      "textDocument/didClose",
      "workspace/didChangeWatchedFiles",
    ]);
    // A notification, not a request: the drift push needs nothing the method allow-list admits.
    expect(server.methods).toEqual(["initialize", "textDocument/documentSymbol"]);
    session.dispose();
  });

  itIfWindows("folds one caller's casing into the other's baseline instead of reporting the tree as moved", async () => {
    const { session } = sessionWith(clangdConfig);
    expect(await session.indexDrift([root])).toMatchObject({ kind: "unknown" });

    // The same directory spelled with another casing: the baseline key folds casings already, so the
    // snapshot has to be keyed the same way, or every unchanged file arrives as a create beside a delete,
    // watched-file changes go out for nothing, and the call reports itself stale.
    const spelled = root.toUpperCase();
    expect(spelled).not.toBe(root);
    expect(await session.indexDrift([spelled])).toEqual({ kind: "current" });
    session.dispose();
  });

  it("asks nothing of a server that answers no question from an index of the sources", async () => {
    const { server, session } = sessionWith(goplsConfig);

    const verdict = await session.indexDrift([root]);

    expect(verdict).toMatchObject({ kind: "unknown" });
    expect((verdict as { reason: string }).reason).toMatch(/gopls answers no question from an index/);
    expect(server.methods).toEqual([]);
    expect(server.notifications).toEqual([]);
    session.dispose();
  });
});
