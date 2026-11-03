import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clangdConfig, goplsConfig } from "../../src/lsp/server-config.js";
import { cachedProjectMap, dropProjectMap } from "../../src/tsgo/project-map.js";
import type { TsgoBinary } from "../../src/tsgo/binary.js";
import { EVICT_GRACE_MS } from "../../src/lsp/resource-limits.js";
import { LspSessionManager, type ScheduleTimer } from "../../src/lsp/session-manager.js";
import { fakeServer } from "../helpers/fake-lsp.js";

/** A clock the test owns: timers fire only when `advance` passes their due time. */
function manualClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { run: () => void; at: number }>();
  const schedule: ScheduleTimer = (run, ms) => {
    const id = ++next;
    timers.set(id, { run, at: now + ms });
    return () => {
      timers.delete(id);
    };
  };
  return {
    schedule,
    now: () => now,
    pending: () => timers.size,
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now || !timers.has(id)) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

const IDLE_MS = 1000;

interface Deferred {
  readonly promise: Promise<unknown>;
  release(): void;
}

function deferred(): Deferred {
  let release = (): void => {};
  const promise = new Promise<unknown>((res) => {
    release = () => res([]);
  });
  return { promise, release };
}

describe("LspSessionManager child lifetime", () => {
  let base: string;
  let roots: string[];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mcp-code-nav-life-"));
    roots = ["a", "b", "c", "d"].map((name) => join(base, name));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** One fake server per spawn, so each child can be told apart and its kill counted. */
  function harness(
    limits: { idleMs: number; maxSessions: number },
    respond?: (method: string, params: unknown) => unknown,
  ) {
    const clock = manualClock();
    const kills: number[] = [];
    let spawned = 0;
    const spawn = vi.fn(() => {
      const id = ++spawned;
      return fakeServer({ kill: () => kills.push(id), respond }).process;
    });
    const manager = new LspSessionManager(
      { spawn, sleep: async () => {}, readFile: () => "x" },
      limits,
      clock,
    );
    return { clock, kills, spawn, manager };
  }

  const refs = (session: ReturnType<LspSessionManager["get"]>, tag?: string) =>
    session.request("textDocument/references", { tag });

  it("disposes a child after the idle period and starts a fresh one on the next call", async () => {
    const { clock, kills, spawn, manager } = harness({ idleMs: IDLE_MS, maxSessions: 0 });
    const session = manager.get(roots[0]!, clangdConfig);
    await refs(session);
    clock.advance(IDLE_MS - 1);
    expect(kills).toEqual([]);

    clock.advance(1);
    expect(kills).toEqual([1]);

    expect(manager.get(roots[0]!, clangdConfig)).toBe(session);
    await refs(session);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("starts the countdown over on every request", async () => {
    const { clock, kills, manager } = harness({ idleMs: IDLE_MS, maxSessions: 0 });
    const session = manager.get(roots[0]!, clangdConfig);
    await refs(session);
    clock.advance(IDLE_MS - 1);
    await refs(session);
    clock.advance(IDLE_MS - 1);
    expect(kills).toEqual([]);
    clock.advance(1);
    expect(kills).toEqual([1]);
  });

  it("never disposes a session that has a request in flight, and counts from its end", async () => {
    const gate = deferred();
    const { clock, kills, manager } = harness({ idleMs: IDLE_MS, maxSessions: 0 }, (method) =>
      method === "textDocument/references" ? gate.promise : [],
    );
    const session = manager.get(roots[0]!, clangdConfig);
    const pending = refs(session);
    await vi.waitFor(() => expect(session.inFlight()).toBe(1));

    clock.advance(IDLE_MS * 5);
    expect(kills).toEqual([]);

    gate.release();
    await pending;
    clock.advance(IDLE_MS - 1);
    expect(kills).toEqual([]);
    clock.advance(1);
    expect(kills).toEqual([1]);
  });

  it("advances the generation on an idle restart and on a cap restart, but not on a plain reuse", async () => {
    const { clock, manager } = harness({ idleMs: IDLE_MS, maxSessions: 1 });
    const idle = manager.get(roots[0]!, clangdConfig);
    await refs(idle);
    const first = idle.generation();
    await refs(idle);
    expect(idle.generation()).toBe(first);

    clock.advance(IDLE_MS);
    await refs(idle);
    const afterIdle = idle.generation();
    expect(afterIdle).toBeGreaterThan(first);

    clock.advance(AFTER_GRACE);
    await refs(manager.get(roots[1]!, clangdConfig));
    expect(idle.isLive()).toBe(false);
    await refs(idle);
    expect(idle.generation()).toBeGreaterThan(afterIdle);
  });

  it("rebuilds a TypeScript project map after an idle restart, so a project added meanwhile is not missed", async () => {
    const binary: TsgoBinary = {
      executable: "C:/fake/lib/tsc.exe",
      version: "7.0.2",
      source: "global",
    };
    const root = roots[0]!;
    mkdirSync(root, { recursive: true });
    const config = join(root, "tsconfig.json");
    writeFileSync(config, "{}");
    let listed = 0;
    const exec = async () => {
      listed++;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const { clock, manager } = harness({ idleMs: IDLE_MS, maxSessions: 0 });
    const session = manager.get(root, clangdConfig);
    await refs(session);
    try {
      await cachedProjectMap(root, [config], binary, session.generation(), exec);
      await cachedProjectMap(root, [config], binary, session.generation(), exec);
      expect(listed).toBe(1);

      clock.advance(IDLE_MS);
      await refs(session);
      await cachedProjectMap(root, [config], binary, session.generation(), exec);
      expect(listed).toBe(2);
    } finally {
      dropProjectMap(root);
    }
  });

  it("answers cold again on the fresh child, so a restart never claims the old child's readiness", async () => {
    let warm = true;
    const { clock, manager } = harness({ idleMs: IDLE_MS, maxSessions: 0 }, (method) =>
      method === "textDocument/documentSymbol" && warm ? [{ name: "f", kind: 12 }] : [],
    );
    const session = manager.get(roots[0]!, clangdConfig);
    await expect(session.documentSymbol(join(roots[0]!, "a.cpp"))).resolves.toMatchObject({
      state: "ok",
    });

    clock.advance(IDLE_MS);
    warm = false;
    await expect(session.documentSymbol(join(roots[0]!, "a.cpp"))).resolves.toEqual({
      state: "cold-empty",
    });
  });

  it("does not shut down when the idle period is 0", async () => {
    const { clock, kills, manager } = harness({ idleMs: 0, maxSessions: 0 });
    await refs(manager.get(roots[0]!, clangdConfig));
    expect(clock.pending()).toBe(0);
    clock.advance(10 ** 9);
    expect(kills).toEqual([]);
  });

  const AFTER_GRACE = EVICT_GRACE_MS + 10_000;

  it("disposes the least recently used idle session when one more would exceed the cap", async () => {
    const { clock, kills, manager } = harness({ idleMs: 0, maxSessions: 2 });
    for (const i of [0, 1, 0]) {
      await refs(manager.get(roots[i]!, clangdConfig));
      clock.advance(AFTER_GRACE);
    }
    expect(kills).toEqual([]);

    await refs(manager.get(roots[2]!, clangdConfig));
    expect(kills).toEqual([2]);
  });

  it("evicts a newer idle session and keeps an older busy one", async () => {
    const gate = deferred();
    const { clock, kills, manager } = harness({ idleMs: 0, maxSessions: 2 }, (method, params) =>
      method === "textDocument/references" && (params as { tag?: string }).tag === "hold"
        ? gate.promise
        : [],
    );
    const older = manager.get(roots[0]!, clangdConfig);
    const held = refs(older, "hold");
    await vi.waitFor(() => expect(older.inFlight()).toBe(1));
    await refs(manager.get(roots[1]!, clangdConfig));
    clock.advance(AFTER_GRACE);

    await refs(manager.get(roots[2]!, clangdConfig));
    expect(kills).toEqual([2]);
    expect(older.isLive()).toBe(true);

    gate.release();
    await held;
  });

  it("never evicts a session used within the grace, so the gap between two calls of one operation is safe", async () => {
    const { clock, kills, manager } = harness({ idleMs: 0, maxSessions: 1 });
    const first = manager.get(roots[0]!, clangdConfig);
    await refs(first);
    clock.advance(5_000);

    await refs(manager.get(roots[1]!, clangdConfig));
    expect(kills).toEqual([]);
    expect(first.isLive()).toBe(true);
  });

  it("restarts a session evicted by the cap cold on its next call", async () => {
    let warm = true;
    const { clock, manager } = harness({ idleMs: 0, maxSessions: 1 }, (method) =>
      method === "textDocument/documentSymbol" && warm ? [{ name: "f", kind: 12 }] : [],
    );
    const evicted = manager.get(roots[0]!, clangdConfig);
    await expect(evicted.documentSymbol(join(roots[0]!, "a.cpp"))).resolves.toMatchObject({
      state: "ok",
    });
    clock.advance(AFTER_GRACE);
    await manager.get(roots[1]!, clangdConfig).documentSymbol(join(roots[1]!, "a.cpp"));
    expect(evicted.isLive()).toBe(false);

    warm = false;
    await expect(evicted.documentSymbol(join(roots[0]!, "a.cpp"))).resolves.toEqual({
      state: "cold-empty",
    });
  });

  it("allows the extra session when every live one is busy", async () => {
    const gate = deferred();
    const { kills, manager } = harness({ idleMs: 0, maxSessions: 2 }, (method) =>
      method === "textDocument/references" ? gate.promise : [],
    );
    const busy = [manager.get(roots[0]!, clangdConfig), manager.get(roots[1]!, clangdConfig)];
    const pending = busy.map((s) => refs(s));
    await vi.waitFor(() => expect(busy.map((s) => s.inFlight())).toEqual([1, 1]));

    const extra = manager.get(roots[2]!, clangdConfig);
    const third = refs(extra);
    await vi.waitFor(() => expect(extra.inFlight()).toBe(1));
    expect(kills).toEqual([]);
    expect(busy.every((s) => s.isLive())).toBe(true);

    gate.release();
    await Promise.all([...pending, third]);
  });

  it.each([0, IDLE_MS * 1000])(
    "restores the cap once a burst of busy calls ends, after the grace (idleMs %i)",
    async (idleMs) => {
      const gate = deferred();
      const { clock, kills, manager } = harness({ idleMs, maxSessions: 1 }, (method) =>
        method === "textDocument/references" ? gate.promise : [],
      );
      const sessions = [manager.get(roots[0]!, clangdConfig), manager.get(roots[1]!, clangdConfig)];
      const pending = sessions.map((s) => refs(s));
      await vi.waitFor(() => expect(sessions.map((s) => s.inFlight())).toEqual([1, 1]));

      gate.release();
      await Promise.all(pending);
      expect(sessions.filter((s) => s.isLive())).toHaveLength(2);

      clock.advance(EVICT_GRACE_MS);
      expect(sessions.filter((s) => s.isLive())).toHaveLength(1);
      expect(kills).toHaveLength(1);
    },
  );

  it("counts each server kind on its own", async () => {
    const { clock, kills, manager } = harness({ idleMs: 0, maxSessions: 1 });
    await refs(manager.get(roots[0]!, clangdConfig));
    await manager.get(roots[0]!, goplsConfig).request("textDocument/references", {});
    clock.advance(AFTER_GRACE);
    expect(kills).toEqual([]);

    await refs(manager.get(roots[1]!, clangdConfig));
    expect(kills).toEqual([1]);
  });

  it("does not cap when the limit is 0", async () => {
    const { clock, kills, manager } = harness({ idleMs: 0, maxSessions: 0 });
    for (const root of roots) {
      await refs(manager.get(root, clangdConfig));
      clock.advance(AFTER_GRACE);
    }
    expect(kills).toEqual([]);
  });

  it("cancels every countdown on disposeAll", async () => {
    const { clock, manager } = harness({ idleMs: IDLE_MS, maxSessions: 0 });
    await refs(manager.get(roots[0]!, clangdConfig));
    expect(clock.pending()).toBe(1);
    manager.disposeAll();
    expect(clock.pending()).toBe(0);
  });
});
