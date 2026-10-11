import { fileUri } from "./document-uri.js";
import { messageOf } from "../error-message.js";

/**
 * How one freshness check went: the module matches what was last proved, the
 * change set was pushed to the running server, or the graph could not be proved and the session was
 * dropped so the next call reloads it from scratch.
 */
export type FreshnessOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "pushed"; readonly changedFiles: number }
  | { readonly kind: "reloaded"; readonly reason: string };

/** The module walk: absolute path to `size|mtimeMs`, or `undefined` when it cannot complete. */
export type ModuleSnapshotFn = (root: string) => Map<string, string> | undefined;

/** LSP's `FileChangeType`, inlined because this server depends on `vscode-jsonrpc`, not the protocol types. */
export const FILE_CHANGE_TYPE = { created: 1, changed: 2, deleted: 3 } as const;

type FileChangeType = (typeof FILE_CHANGE_TYPE)[keyof typeof FILE_CHANGE_TYPE];

export interface SnapshotDiff {
  readonly created: string[];
  readonly changed: string[];
  readonly deleted: string[];
}

export function diffSnapshots(previous: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): SnapshotDiff {
  const created: string[] = [];
  const changed: string[] = [];
  for (const [path, stamp] of current) {
    const before = previous.get(path);
    if (before === undefined) created.push(path);
    else if (before !== stamp) changed.push(path);
  }
  const deleted: string[] = [];
  for (const path of previous.keys()) {
    if (!current.has(path)) deleted.push(path);
  }
  return { created, changed, deleted };
}

/** What a push needs from the session it is correcting, and nothing else. */
export interface FileChangePush {
  /** A client-to-server notification: the same route `didOpen` takes, so no request allow-list is touched. */
  readonly notify: (method: string, params: unknown) => Promise<void>;
  /** Close the document held for `path`, under the spelling it was opened with. */
  readonly closeOpen: (path: string) => Promise<void>;
  /** The path the session holds a document for under `path`'s spelling, or `undefined` when it holds none. */
  readonly openedAs: (path: string) => string | undefined;
}

/**
 * Releases any buffer held for a changed path, then reports the whole diff — created, changed and deleted —
 * in one notification, so the server re-reads each path from disk before answering again. The close comes
 * first because that buffer would otherwise shadow the disk. A throw partway through leaves half the paths
 * reported, and what that costs is the caller's policy, not this function's: a package graph has to be
 * reloaded to be whole again, while an index that may be behind is only ever reported as behind.
 */
export async function pushFileChanges(deps: FileChangePush, diff: SnapshotDiff): Promise<void> {
  for (const path of [...diff.changed, ...diff.deleted]) {
    const opened = deps.openedAs(path);
    if (opened !== undefined) await deps.closeOpen(opened);
  }
  const event = (type: FileChangeType) => (path: string) => ({ uri: fileUri(path), type });
  await deps.notify("workspace/didChangeWatchedFiles", {
    changes: [
      ...diff.created.map(event(FILE_CHANGE_TYPE.created)),
      ...diff.changed.map(event(FILE_CHANGE_TYPE.changed)),
      ...diff.deleted.map(event(FILE_CHANGE_TYPE.deleted)),
    ],
  });
}

/** What the engine may ask of the session it belongs to, and nothing else. */
export interface ModuleFreshnessDeps extends FileChangePush {
  readonly root: string;
  /** Retake the walk over the module. */
  takeSnapshot: ModuleSnapshotFn;
  /**
   * Why the walk returns nothing, when the walk itself knows better than this engine. A tree that overflows
   * its entry bound and a config whose closure leads outside the workspace are different failures, and a
   * caller that has to reload deserves the one that actually happened.
   */
  reasonForMissingSnapshot?: () => string | undefined;
  /** Whether there is a live server at all — the only one a push could correct. */
  isLive: () => boolean;
  dispose: () => void;
}

/**
 * The proof required before a type-aware answer may be served from a language
 * server's loaded package graph: nothing else tells a long-lived server about the disk, and both
 * staleness directions are silent. It is deliberately not part of `LspSession` — the session owns the
 * child, the documents and the allow-list; this owns the walk, the diff and what is pushed.
 *
 * Two rules the server's behaviour sets:
 * - One `workspace/didChangeWatchedFiles` carrying every created, changed and deleted path is applied
 *   before the next request, so no document has to be opened to deliver a change. A file the client
 *   holds a buffer for is closed first, because that buffer would otherwise shadow the disk.
 * - The baseline a check compares against is taken before the child starts, because the child reads the
 *   disk as it is at that moment; a live child with no baseline is unprovable, not unaffected.
 */
export class ModuleFreshness {
  /** The state the live child's graph was proved against; `undefined` while nothing has been proved. */
  private baseline: Map<string, string> | undefined;
  private running: Promise<FreshnessOutcome> | undefined;
  /** The diff the last check settled on, so a caller can tell a structural change from a content edit. */
  private lastDiff: SnapshotDiff | undefined;

  constructor(private readonly deps: ModuleFreshnessDeps) {}

  /** What the last check found changed, or `undefined` while nothing has been compared yet. */
  lastSnapshotDiff(): SnapshotDiff | undefined {
    return this.lastDiff;
  }

  /**
   * Why no snapshot could be taken. The walk is asked first because it is the one that knows: an overflowed
   * entry bound and an unprovable config closure are different facts, and the caller that has to reload the
   * server is told the one that happened. The consequence is named either way, in the words every reload of
   * this session has always used.
   */
  private missingSnapshot(fallback: string): string {
    const stated = this.deps.reasonForMissingSnapshot?.();
    return stated === undefined ? fallback : `${stated} — this session was disposed and the next call reloads it`;
  }

  /**
   * Records the disk state a child about to start will load. Called before the spawn, so the baseline can
   * never be newer than the graph built from it — which is the only ordering that cannot hide a change.
   */
  snapshotAtStart(): void {
    this.baseline = this.deps.takeSnapshot(this.deps.root);
  }

  /**
   * The paths the baseline was taken over, read-only, or `undefined` while nothing is proved. After a
   * `refresh()` that proved the graph these are exactly the module's current files, which is what lets a
   * caller read this walk instead of paying for a second traversal of the same tree.
   */
  provedPaths(): readonly string[] | undefined {
    return this.baseline === undefined ? undefined : [...this.baseline.keys()];
  }

  /**
   * One check at a time: a concurrent caller awaits the in-flight check and receives its outcome rather
   * than diffing against the baseline that check replaced, which would report `unchanged` while the
   * notification is still being written and let the query overtake it.
   */
  refresh(): Promise<FreshnessOutcome> {
    if (this.running !== undefined) return this.running;
    const running = this.check().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private async check(): Promise<FreshnessOutcome> {
    const { root } = this.deps;
    if (!this.deps.isLive()) return { kind: "unchanged" };
    if (this.baseline === undefined) {
      // The start-time walk failed, so this child's graph has no proof behind it.
      return this.reloadFromScratch(
        this.missingSnapshot(
          `no module snapshot was taken for "${root}" before the server started, so its loaded package graph ` +
            "is not proven current — this session was disposed and the next call reloads it",
        ),
      );
    }
    const current = this.deps.takeSnapshot(root);
    if (current === undefined) {
      return this.reloadFromScratch(
        this.missingSnapshot(
          `the module snapshot walk under "${root}" did not complete within its entry bound, so the loaded ` +
            "package graph is not proven current — this session was disposed and the next call reloads it",
        ),
      );
    }

    const diff = diffSnapshots(this.baseline, current);
    this.lastDiff = diff;
    const changedFiles = diff.created.length + diff.changed.length + diff.deleted.length;
    if (changedFiles === 0) {
      this.baseline = current;
      return { kind: "unchanged" };
    }
    try {
      await this.pushDiff(diff);
    } catch (e) {
      // Half a push is worse than none: some paths were reported and the rest were not, and only a
      // reloaded graph makes that whole again. Reported rather than rethrown, so a caller branches on
      // the outcome instead of catching a notification failure it cannot act on.
      return this.reloadFromScratch(
        `the freshness push for "${root}" failed after it had begun (${messageOf(e)}), so the ` +
          "package graph is only partly corrected — this session was disposed and the next call reloads it",
      );
    }
    this.baseline = current;
    return { kind: "pushed", changedFiles };
  }

  /** The fallback every unprovable state takes: no baseline survives the graph it described. */
  private reloadFromScratch(reason: string): FreshnessOutcome {
    this.baseline = undefined;
    // Nor does the comparison that was made against it. A caller asking what the last check found is asking
    // about the child that is gone — and a project map is rebuilt on exactly that answer, so the dead child's diff left in place is a fact about a graph no longer being asked about.
    this.lastDiff = undefined;
    this.deps.dispose();
    return { kind: "reloaded", reason };
  }

  /** The shared push: release what this session holds a buffer for, then report the whole diff once. */
  private pushDiff(diff: SnapshotDiff): Promise<void> {
    return pushFileChanges(this.deps, diff);
  }
}
