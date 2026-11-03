import { resolve } from "node:path";
import { noteSession } from "../call-log/annotations.js";
import { pathKey } from "../paths/path-containment.js";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_SESSIONS,
  EVICT_GRACE_MS,
  type SessionLimits,
} from "./resource-limits.js";
import type { LanguageServerConfig } from "./server-config.js";
import { LspSession, type LspSessionOptions } from "./session.js";

/** Starts a one-shot timer and returns its cancel function. */
export type ScheduleTimer = (run: () => void, ms: number) => () => void;

/** The manager's time source; injectable so a test owns the clock. */
export interface ManagerClock {
  now(): number;
  schedule: ScheduleTimer;
}

/** The real clock. The timer is unref'd: an idle server must not be kept alive by a child's countdown. */
const realClock: ManagerClock = {
  now: () => Date.now(),
  schedule: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref();
    return () => {
      clearTimeout(handle);
    };
  },
};

interface Entry {
  readonly session: LspSession;
  /** Sessions of one server share a cap, whatever their config variant. */
  readonly serverId: string;
  /** Clock reading of the last use, for the eviction grace. */
  lastUsedAt: number;
  /** Position in the manager's use order; the larger, the more recent. */
  useSeq: number;
  cancelIdle: (() => void) | undefined;
}

/**
 * One `LspSession` per `(server kind, resolved root)`, created lazily on first use. A session is kept for the
 * life of the manager but its child is not: an idle one is disposed after `idleMs`, and starting a call beyond
 * `maxSessions` live children of one server disposes the least recently used idle ones. The next call on a
 * disposed session starts a fresh child through the same path as a crash recovery, so it is cold again and says so.
 */
export class LspSessionManager {
  private readonly entries = new Map<string, Entry>();
  private tick = 0;

  constructor(
    private readonly sessionOptions: Omit<LspSessionOptions, "root" | "config" | "onActivity"> = {},
    private readonly limits: SessionLimits = {
      idleMs: DEFAULT_IDLE_MS,
      maxSessions: DEFAULT_MAX_SESSIONS,
    },
    private readonly clock: ManagerClock = realClock,
  ) {}

  /**
   * The key is `pathKey`, not `resolve`: two spellings of one root would otherwise start two
   * children, each paying its own cold load. The session keeps `resolve`'s
   * original-case path, which is what the child and its URIs are built from.
   */
  get(root: string, config: LanguageServerConfig): LspSession {
    const key = `${config.sessionKind ?? config.id}\0${pathKey(root)}`;
    let entry = this.entries.get(key);
    const created = entry === undefined;
    if (entry === undefined) {
      entry = this.create(key, root, config);
      this.entries.set(key, entry);
    }
    noteSession(created);
    this.noteUse(entry);
    return entry.session;
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      entry.cancelIdle?.();
      entry.session.dispose();
    }
    this.entries.clear();
  }

  private create(key: string, root: string, config: LanguageServerConfig): Entry {
    const session = new LspSession({
      ...this.sessionOptions,
      root: resolve(root),
      config,
      onActivity: () => {
        const entry = this.entries.get(key);
        if (entry !== undefined) this.noteUse(entry);
      },
    });
    return {
      session,
      serverId: config.id,
      lastUsedAt: this.clock.now(),
      useSeq: 0,
      cancelIdle: undefined,
    };
  }

  /** The most recent use; a busy session is about to hold a child, so that is where the cap is enforced. */
  private noteUse(entry: Entry): void {
    entry.lastUsedAt = this.clock.now();
    entry.useSeq = ++this.tick;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    if (entry.session.inFlight() > 0) {
      this.enforceCap(entry);
      return;
    }
    if (this.limits.idleMs > 0) this.armCountdown(entry, this.limits.idleMs);
    this.shortenBeyondCap(entry.serverId);
  }

  private armCountdown(entry: Entry, delayMs: number): void {
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    entry.cancelIdle = this.clock.schedule(() => {
      this.expire(entry);
    }, delayMs);
  }

  private expire(entry: Entry): void {
    entry.cancelIdle = undefined;
    if (entry.session.inFlight() === 0 && entry.session.isLive()) entry.session.retire();
  }

  private liveOf(serverId: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.serverId === serverId && e.session.isLive());
  }

  /**
   * Makes room for `entry` to hold a child. Only an idle session unused for `EVICT_GRACE_MS` is ever disposed, so
   * when every other live one is busy or recent the cap is exceeded rather than a request failed or made to wait.
   */
  private enforceCap(entry: Entry): void {
    const { maxSessions } = this.limits;
    if (maxSessions === 0) return;
    const others = this.liveOf(entry.serverId).filter((e) => e !== entry);
    const surplus = others.length - maxSessions + 1;
    if (surplus <= 0) return;
    const now = this.clock.now();
    const victims = others
      .filter((e) => e.session.inFlight() === 0 && now - e.lastUsedAt >= EVICT_GRACE_MS)
      .sort((a, b) => a.useSeq - b.useSeq)
      .slice(0, surplus);
    for (const victim of victims) {
      victim.cancelIdle?.();
      victim.cancelIdle = undefined;
      victim.session.retire();
    }
  }

  /**
   * A call finished: children beyond the cap (an earlier burst found every one busy) go after the grace instead
   * of the full idle window, the most recently used being the ones kept.
   */
  private shortenBeyondCap(serverId: string): void {
    const { maxSessions, idleMs } = this.limits;
    if (maxSessions === 0) return;
    const beyond = this.liveOf(serverId)
      .sort((a, b) => b.useSeq - a.useSeq)
      .slice(maxSessions)
      .filter((e) => e.session.inFlight() === 0);
    const window = idleMs > 0 ? Math.min(idleMs, EVICT_GRACE_MS) : EVICT_GRACE_MS;
    const now = this.clock.now();
    for (const e of beyond) this.armCountdown(e, Math.max(0, e.lastUsedAt + window - now));
  }
}
