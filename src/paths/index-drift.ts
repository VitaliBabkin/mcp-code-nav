// The files a C++ index was built from, and what has moved since. clangd learns about on-disk changes from
// its client and from nothing else, so an index-backed answer needs the same question asked of it that
// is asked of a package graph. The two answers are not the same kind of fact: a push to clangd
// enqueues re-indexing and gates nothing, so what comes out of this walk is a drift signal and never a
// currency proof — which is why C++ carries no `freshness` field and why a walk that cannot complete is
// reported as unknown instead of disposing a warm process.
//
// This module holds the walk and the verdict only: which files under which roots count as sources, and what
// moved between two looks at them. It names no server, opens no document and sends no notification — the
// push it decides the timing of is `module-freshness`'s `pushFileChanges`, and the session owns the wiring.

import { readdirSync, type Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileStamp } from "../lsp/file-stamp.js";
import { diffSnapshots, pushFileChanges, type FileChangePush, type SnapshotDiff } from "../lsp/module-freshness.js";
import { isCppSourceName, isCppTrackedName, isSkippedDirName } from "./cpp-sources.js";
import { isEscapingRelative, pathKey } from "./path-containment.js";
import { messageOf } from "../error-message.js";

/** Entries one walk may enumerate before it gives up: counted over every entry seen, so its own cost is
 *  bounded whatever the tree contains. An incomplete walk yields no snapshot at all. */
const MAX_SNAPSHOT_ENTRIES = 20_000;

/** A file that cannot be stat'ed is recorded as such rather than dropped: it must still count as a change
 *  if it becomes readable, the way the fingerprint and the module walk record one. */
const UNSTATTABLE = "unreadable";

/**
 * What one walk saw about the tree besides the stamps: the TU-extension sources it visited, whether a
 * directory could not be listed, whether the entry bound was reached, and which declared roots it never
 * entered because another declared root contained them. The C++ blind-spot signal is read off this account
 * so a call pays for one bounded walk, not two.
 */
export interface IndexWalkAccount {
  readonly sources: readonly string[];
  readonly walkIncomplete: boolean;
  readonly bounded: boolean;
  readonly unreachableSourceRoots: readonly string[];
}

/**
 * One look at the sources: `stamps` keyed by the canonical form of each path, `paths` keyed the same way and
 * holding the spelling the walk actually saw. Two looks are compared on the canonical key — one caller's
 * `sourceRoots` casing must not turn every unchanged file into a create beside a delete — and everything a
 * report or a notification names comes from `paths`, because that is the spelling the server was given.
 * `account` is what the same pass learned about the tree; a hand-built snapshot has none, and a caller
 * reading the account treats that as "not determined" rather than as an empty set.
 */
export interface IndexSnapshot {
  readonly stamps: Map<string, string>;
  readonly paths: Map<string, string>;
  readonly account?: IndexWalkAccount;
}

interface SnapshotWalk {
  readonly maxEntries: number;
  readonly stamps: Map<string, string>;
  readonly paths: Map<string, string>;
  /** The TU-extension sources this pass visited, in walked spelling. */
  readonly sources: string[];
  /** Declared roots the containment fold dropped, keyed for the "never entered" report. */
  readonly droppedKeys: Map<string, string>;
  /** Dropped roots whose directory the walk did enter; they are reachable and so are not reported. */
  readonly reached: Set<string>;
  scanned: number;
  unreadable: boolean;
  bounded: boolean;
  incomplete: boolean;
}

function visitFile(state: SnapshotWalk, dir: string, name: string): void {
  if (!isCppTrackedName(name)) return;
  const path = join(dir, name);
  const key = pathKey(path);
  state.stamps.set(key, fileStamp(path) ?? UNSTATTABLE);
  state.paths.set(key, path);
  if (isCppSourceName(name)) state.sources.push(path);
}

function visitEntry(state: SnapshotWalk, dir: string, entry: Dirent): void {
  // A symlink is neither a file nor a directory to `readdir(withFileTypes)`, so nothing behind one is
  // stat'ed through or named to the server as a file this project owns.
  if (entry.isSymbolicLink()) return;
  const path = join(dir, entry.name);
  if (entry.isDirectory()) {
    if (!isSkippedDirName(entry.name)) visitDir(state, path);
    return;
  }
  if (entry.isFile()) visitFile(state, dir, entry.name);
}

/** `true` while this entry is still inside the walk's bound. */
function claimEntry(state: SnapshotWalk): boolean {
  if (state.scanned >= state.maxEntries) {
    state.incomplete = true;
    state.bounded = true;
    return false;
  }
  state.scanned++;
  return true;
}

function visitDir(state: SnapshotWalk, dir: string): void {
  state.reached.add(pathKey(dir));
  let listed: Dirent[];
  try {
    listed = readdirSync(dir, { withFileTypes: true });
  } catch {
    state.incomplete = true;
    state.unreadable = true;
    return;
  }
  for (const entry of listed) {
    if (!claimEntry(state)) return;
    visitEntry(state, dir, entry);
  }
}

/**
 * The roots worth entering, with the dropped ones reported: every declared root folded to one spelling per
 * physical directory, minus a root that another declared root strictly contains. A caller may well declare
 * both a tree and a directory inside it, and entering the inner one as well would enumerate the same files
 * twice — spending the entry bound on work already done. A dropped root whose directory the walk never
 * entered (because the outer walk skipped it by name) is reported, so a signal never claims a file was
 * looked at when it was not. (The fingerprint walk folds its roots the same way, for the same reason.)
 */
function foldRoots(roots: readonly string[]): { readonly entered: string[]; readonly dropped: Map<string, string> } {
  const unique = new Map<string, string>();
  for (const root of roots) {
    const key = pathKey(root);
    if (!unique.has(key)) unique.set(key, resolve(root));
  }
  const all = [...unique.values()];
  const entered: string[] = [];
  const dropped = new Map<string, string>();
  for (const candidate of all) {
    const contained = all.some((other) => {
      if (other === candidate) return false;
      // Strictly inside only: an empty `relative` is one directory in two spellings, folded above.
      const rel = relative(other, candidate);
      return rel !== "" && !isEscapingRelative(rel);
    });
    if (contained) dropped.set(pathKey(candidate), candidate);
    else entered.push(candidate);
  }
  return { entered, dropped };
}

/**
 * Every C++ source and header under `roots`, as one look at the tree, with the account of what the pass
 * saw. Headers count because a header edit moves what every translation unit including it means, which is
 * exactly what a shard can be behind. A walk that hit its entry bound or could not list a directory still
 * returns its stamps and its account, and it is the caller's decision that such a look proves nothing —
 * `bounded` and `walkIncomplete` say which of the two happened.
 *
 * A root's own name is never skipped — a declared root may be a build directory — while a directory reached
 * through a parent is, and the skipped names are the fingerprint's, so the two walks cannot drift apart
 * about what counts as a project's source.
 */
export function takeIndexSnapshot(
  roots: readonly string[],
  options?: { readonly maxEntries?: number },
): IndexSnapshot {
  const folded = foldRoots(roots);
  const state: SnapshotWalk = {
    maxEntries: options?.maxEntries ?? MAX_SNAPSHOT_ENTRIES,
    stamps: new Map(),
    paths: new Map(),
    sources: [],
    droppedKeys: folded.dropped,
    reached: new Set(),
    scanned: 0,
    unreadable: false,
    bounded: false,
    incomplete: false,
  };
  for (const root of folded.entered) visitDir(state, root);
  const unreachable = [...folded.dropped].filter(([key]) => !state.reached.has(key)).map(([, path]) => path);
  return {
    stamps: state.stamps,
    paths: state.paths,
    account: {
      sources: state.sources,
      walkIncomplete: state.unreadable,
      bounded: state.bounded,
      unreachableSourceRoots: unreachable,
    },
  };
}

/** Why one look at the tree cannot support a drift verdict. */
export type IndexWalkFailure = "entry-bound" | "unreadable-directory";

/** The reason a walk yields no verdict at all, or `undefined` when it is usable. */
export function walkFailure(snapshot: IndexSnapshot | undefined): IndexWalkFailure | undefined {
  if (snapshot === undefined) return "entry-bound";
  if (snapshot.account === undefined) return undefined;
  if (snapshot.account.bounded) return "entry-bound";
  if (snapshot.account.walkIncomplete) return "unreadable-directory";
  return undefined;
}

/** What the baseline walk covers, and what it costs to retake it. */
export type IndexSnapshotFn = (roots: readonly string[]) => IndexSnapshot | undefined;

/** What one index-backed call's walk says about the disk behind the index it answered from. */
export type IndexDriftVerdict =
  /** Nothing moved since the baseline, so nothing is known to be behind. */
  | { readonly kind: "current" }
  /** The exact paths that moved since the baseline and were pushed with this call, in the spelling the walk
   *  saw them in. The listing a response carries is capped; this array is not, because the count beside it
   *  has to stay exact. */
  | { readonly kind: "stale"; readonly files: readonly string[] }
  /** Whether the index is behind could not be determined — and a signal that proves nothing is reported as
   *  unproven, never as current. `cause` names which of the four reasons it is, so the blind-spot signal
   *  beside it can say the same thing rather than a vaguer one. */
  | { readonly kind: "unknown"; readonly reason: string; readonly cause: IndexUnknownCause };

/** Why no drift verdict could be given: the walk's two failures, and the engine's three. */
export type IndexUnknownCause =
  | IndexWalkFailure
  | "no-baseline"
  | "push-failed"
  /** The check was still running when its process was replaced, so its verdict is about nobody. */
  | "superseded";

export interface IndexDriftDeps extends FileChangePush {
  readonly takeSnapshot: IndexSnapshotFn;
}

/** The key one baseline belongs to: the call's declared roots, normalised and sorted, so two spellings of
 *  one root set — or two orders of the same roots — share one baseline. */
function rootsKey(roots: readonly string[]): string {
  const keys = new Set<string>();
  for (const root of roots) keys.add(pathKey(root));
  return [...keys].sort().join("\n");
}

const quoted = (roots: readonly string[]): string => roots.map((root) => `"${root}"`).join(", ");

/** The paths a diff names, in the spelling each look saw them in: a deleted file is only in the old one. */
function namedPaths(diff: SnapshotDiff, current: IndexSnapshot, previous: IndexSnapshot): SnapshotDiff {
  const shown = (map: Map<string, string>) => (key: string) => map.get(key) ?? key;
  return {
    created: diff.created.map(shown(current.paths)),
    changed: diff.changed.map(shown(current.paths)),
    deleted: diff.deleted.map(shown(previous.paths)),
  };
}

/** A running check, tagged with the generation it began under, so a replacement process cannot inherit it. */
interface RunningCheck {
  readonly generation: number;
  readonly verdict: Promise<IndexDriftVerdict>;
  /** Filled in by the check itself as soon as its walk has been taken — the one walk's other signal. */
  readonly seen: { account?: IndexWalkAccount };
}

/** One index-backed call's two readings from the same walk: how far behind, and what was never indexed. */
export interface IndexDriftReading {
  readonly verdict: IndexDriftVerdict;
  readonly account?: IndexWalkAccount;
}

/**
 * The drift signal one session keeps per declared root set. Keyed by the root set rather than by the
 * session because `projectRoot` is the build directory and the answer's sources are under `sourceRoots`:
 * two callers asking one session about different roots get two baselines and never each other's, and a
 * first call over a root set has nothing to compare against.
 *
 * The baseline is deliberately NOT taken before the spawn the way gopls's is: this proves no currency, so
 * it has nothing to be newer than. Nothing here disposes anything — a walk that
 * cannot be taken costs a signal, not a warm process.
 */
export class IndexDrift {
  private readonly baselines = new Map<string, IndexSnapshot>();
  /** One check per root set at a time: a concurrent caller must not diff against a baseline being replaced. */
  private readonly running = new Map<string, RunningCheck>();
  /** Bumped when the process is replaced: every closure this engine holds is a question to *that* process. */
  private generation = 0;

  constructor(private readonly deps: IndexDriftDeps) {}

  /** What the index-backed call about to run is possibly behind, pushing what changed on the way. */
  check(roots: readonly string[]): Promise<IndexDriftVerdict> {
    return this.begin(roots).then((reading) => reading.verdict);
  }

  /** The same call, with the other thing that one walk answers: which sources it never saw indexed. */
  checkWithAccount(roots: readonly string[]): Promise<IndexDriftReading> {
    return this.begin(roots);
  }

  private begin(roots: readonly string[]): Promise<IndexDriftReading> {
    const key = rootsKey(roots);
    const generation = this.generation;
    const started = this.running.get(key);
    if (started !== undefined && started.generation === generation) {
      return started.verdict.then((verdict) => ({ verdict, account: started.seen.account }));
    }
    const seen: { account?: IndexWalkAccount } = {};
    const verdict = this.diff(key, roots, generation, seen).finally(() => {
      if (this.running.get(key)?.verdict === verdict) this.running.delete(key);
    });
    this.running.set(key, { generation, verdict, seen });
    return verdict.then((settled) => ({ verdict: settled, account: seen.account }));
  }

  /** A replacement process read the disk as it is and has reported nothing of its own, so every baseline
   *  it would be compared against describes a process that is gone — and so does a check still running. */
  reset(): void {
    this.generation++;
    this.baselines.clear();
    this.running.clear();
  }

  /**
   * A check that outlived its process is answered with `unknown`, and its push is dropped: the change is
   * real, but the process it would be reported to is a replacement that read the disk when it started, and
   * a verdict about the dead one must not be published as a verdict about the answering one.
   */
  private superseded(generation: number): boolean {
    return this.generation !== generation;
  }

  private unknown(cause: IndexUnknownCause, reason: string): IndexDriftVerdict {
    return { kind: "unknown", cause, reason };
  }

  /**
   * A check that outlived its process: its push is dropped and its verdict withheld. The change it found is
   * real, but the process it would be reported to is a replacement that read the disk when it started, and
   * a verdict about the dead one must not be published as a verdict about the answering one.
   */
  private unknownSuperseded(): IndexDriftVerdict {
    return this.unknown(
      "superseded",
      "the server was replaced while this call was deciding what had changed, so what its index is " +
        "behind is not known and its own first answer takes a fresh baseline",
    );
  }

  private async diff(
    key: string,
    roots: readonly string[],
    generation: number,
    seen: { account?: IndexWalkAccount },
  ): Promise<IndexDriftVerdict> {
    const current = this.deps.takeSnapshot(roots);
    seen.account = current?.account;
    const failed = walkFailure(current);
    if (current === undefined || failed !== undefined) {
      return failed === "unreadable-directory"
        ? this.unknown(
            failed,
            `a directory under ${quoted(roots)} could not be listed, so which of these sources the index this ` +
              "answer reads is behind is not known",
          )
        : this.unknown(
            "entry-bound",
            `the source walk over ${quoted(roots)} did not complete within its entry bound, so which of these ` +
              "sources the index this answer reads is behind is not known",
          );
    }
    if (this.superseded(generation)) return this.unknownSuperseded();
    const previous = this.baselines.get(key);
    if (previous === undefined) {
      this.baselines.set(key, current);
      return this.unknown(
        "no-baseline",
        `this is the first index-backed answer over ${quoted(roots)}, so nothing has been recorded to ` +
          "compare the index against yet",
      );
    }

    const diff = namedPaths(diffSnapshots(previous.stamps, current.stamps), current, previous);
    const moved = [...diff.created, ...diff.changed, ...diff.deleted];
    if (this.superseded(generation)) return this.unknownSuperseded();
    if (moved.length === 0) {
      this.baselines.set(key, current);
      return { kind: "current" };
    }
    try {
      await pushFileChanges(this.attributed(generation), diff);
    } catch (e) {
      if (this.superseded(generation)) return this.unknownSuperseded();
      // The baseline stays where it was, so the next call reports these paths again: a push that did not
      // land is a correction that was not made.
      return this.unknown(
        "push-failed",
        `the changed sources could not be reported to the server (${messageOf(e)}), so this ` +
          "answer may be behind them and the next call names them again",
      );
    }
    if (this.superseded(generation)) return this.unknownSuperseded();
    this.baselines.set(key, current);
    return { kind: "stale", files: moved };
  }

  /**
   * The session's services, held to one check's generation: every step of a push is a question to the
   * process the verdict was computed for, and a replacement that has already read the disk must not be
   * told about a change some older check decided on its own behalf. The guard sits at each send rather
   * than once before the push, because the process can go away in the middle of one.
   */
  private attributed(generation: number): IndexDriftDeps {
    const held = (): void => {
      if (this.superseded(generation)) {
        throw new Error("the server was replaced while this change set was being reported");
      }
    };
    return {
      takeSnapshot: this.deps.takeSnapshot,
      openedAs: this.deps.openedAs,
      closeOpen: async (path) => {
        held();
        await this.deps.closeOpen(path);
      },
      notify: async (method, params) => {
        held();
        await this.deps.notify(method, params);
      },
    };
  }
}
