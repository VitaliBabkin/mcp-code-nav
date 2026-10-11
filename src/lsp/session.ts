import { readFileSync } from "node:fs";
import { ProgressType, type ProgressToken } from "vscode-jsonrpc/node";
import type { LspDocumentSymbol } from "../clangd/outline.js";
import { noteReadyWait } from "../call-log/annotations.js";
import { pathKey } from "../paths/path-containment.js";
import { fileUri, textDocumentId } from "./document-uri.js";
import { fileStamp } from "./file-stamp.js";
import { ModuleFreshness, type FreshnessOutcome, type SnapshotDiff } from "./module-freshness.js";
import { IndexDrift, type IndexDriftReading, type IndexDriftVerdict } from "../paths/index-drift.js";
import { defaultSpawnLsp, type LspConnection, type LspProcess, type SpawnLsp } from "./process.js";
import { RequestAbortedError, RequestTimeoutError, DEFAULT_REQUEST_TIMEOUT_MS, sendWithControl } from "./request-control.js";
import { currentRequestSignal } from "./request-scope.js";
import { LanguageServerUnavailableError, type LanguageServerConfig } from "./server-config.js";
import { stderrNote } from "./stderr-tail.js";

/** How long a failed request waits for the dead child's stderr to finish before reporting what it has. */
const STDERR_SETTLE_MS = 250;

export type { FreshnessOutcome, ModuleSnapshotFn, SnapshotDiff } from "./module-freshness.js";

export type DocumentSymbolState =
  | { state: "ok"; symbols: LspDocumentSymbol[] }
  | { state: "empty" }
  | { state: "cold-empty" };

export interface LspSessionOptions {
  root: string;
  config: LanguageServerConfig;
  spawn?: SpawnLsp;
  readFile?: (path: string) => string;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
  /** Longest one request may stay unanswered; defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
}

/** How a readiness wait ended, so a caller never blames the budget for a server that was replaced. */
export type ReadinessOutcome = "ready" | "timed-out" | "restarted";

/**
 * What a server's background index was doing across one request's window.
 * `quiescent` is latched, not sampled: no token was in flight at any point in the window. `unknown` means
 * this process never reported indexing progress at all, which is a fact about the client's inability to
 * see, not about the index being idle.
 */
export type IndexState = "quiescent" | "building" | "unknown";

/** One open request window, told about activity as it happens so the verdict covers the whole span. */
interface IndexWindow {
  beganDuring: boolean;
}

/**
 * What a caller may do while the session holds one document transiently: ask the process that holds it,
 * about the path the document was opened under. A differently spelled path would ask about a document the
 * server has never seen.
 */
export interface TransientAsking {
  readonly openedAs: string;
  send<R>(method: string, params: unknown): Promise<R>;
}

/** The `$/progress` value, restricted to the field readiness depends on. */
interface ProgressValue {
  kind?: string;
}

/** The `window/workDoneProgress/create` params — `token` optional because that payload is the server's. */
interface WorkDoneProgressCreateParams {
  token?: ProgressToken;
}

interface ReadinessWaiter {
  resolve: (outcome: ReadinessOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One language-server child process per `(config, root)`, plus the readiness/crash-recovery state
 * The requirements describe: warm/cold tracking for `documentSymbol`, and
 * respawn-and-retry-once when the process has died since the last call. Every request this session
 * issues to the server goes through the single private `send` below, which admits only the methods
 * `config.allowedRequests` lists.
 */
export class LspSession {
  private readonly root: string;
  private readonly config: LanguageServerConfig;
  private readonly spawnFn: SpawnLsp;
  private readonly readFile: (path: string) => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly freshness: ModuleFreshness | undefined;
  /** Absent unless the config names an index of the sources on disk to compare against. */
  private readonly drift: IndexDrift | undefined;

  /** The process the handshake completed against — never a half-initialised one. */
  private process: LspProcess | undefined;
  /**
   * What the process that is currently live answered `initialize` with, so an answer can report the server
   * version of the process that produced it and never of one that has since been replaced.
   */
  private initializeAnswer: unknown;
  /**
   * Bumped every time a live child is abandoned, so a caller can tell whether the process it began
   * measuring is the process that answered. `dispose()` leaves it alone: a session thrown away and
   * started again is not a replacement any in-flight request could be waiting on.
   */
  private processGeneration = 0;
  /**
   * One number per spawn, unlike the generation, which only a replaced live child moves: a session disposed and
   * started again holds a different process at the same generation, and a proof made on the old one says
   * nothing about the new one.
   */
  private spawnCount = 0;
  private readonly spawnSerials = new WeakMap<LspProcess, number>();
  /** Children killed for a timed-out request; a call that was talking to one is not retried on a new child. */
  private readonly discarded = new WeakSet<LspProcess>();
  /** The in-flight handshake every concurrent caller waits on instead of spawning its own child. */
  private starting: Promise<LspProcess> | undefined;
  /** Set once this process has produced any non-empty `documentSymbol` response. */
  private warm = false;
  /**
   * Documents `didOpen`'d against the CURRENT process instance, keyed by `pathKey` and valued by the path
   * the server was given — one file has two spellings on Windows, and a second `didOpen` for the other
   * one would hand the server two buffers for the same document. Cleared on respawn.
   */
  private openInProcess = new Map<string, string>();
  /** Files ever opened this session, across respawns — backs `cpp_find_symbol`'s unscoped search. */
  private everOpenedFiles = new Set<string>();
  /** `size|mtimeMs` at each open document's `didOpen`, keyed like `openInProcess`. */
  private readonly openedStamps = new Map<string, string>();
  private initialProgressToken: ProgressToken | undefined;
  /**
   * Tokens this process has subscribed to. A token keeps its handler after its `end` on purpose: clangd
   * re-uses one indexing token across rounds, so dropping the subscription at the end of the first round
   * would miss the beginning of the next, which is exactly what the latch must not miss.
   */
  private readonly watchedProgress = new Set<ProgressToken>();
  /** Tokens that began and have not ended: the re-entrant case gopls's one-shot load proof is not. */
  private readonly tokensInFlight = new Set<ProgressToken>();
  /** Whether this process announced or reported any progress; without it the index state is not known. */
  private progressObserved = false;
  /** The request windows currently latching that activity, each answering for its own request. */
  private readonly indexWindows = new Set<IndexWindow>();
  private workspaceLoaded = false;
  private readonly readyWaiters = new Set<ReadinessWaiter>();

  constructor(options: LspSessionOptions) {
    this.root = options.root;
    this.config = options.config;
    this.spawnFn = options.spawn ?? defaultSpawnLsp;
    this.readFile = options.readFile ?? ((p) => readFileSync(p, "utf-8"));
    this.sleep = options.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.freshness = this.buildFreshness();
    this.drift = this.buildDrift();
  }

  /** The narrow surface the freshness engine is handed; absent unless the config has a walk. */
  private buildFreshness(): ModuleFreshness | undefined {
    const takeSnapshot = this.config.moduleSnapshot;
    if (takeSnapshot === undefined) return undefined;
    return new ModuleFreshness({
      root: this.root,
      takeSnapshot,
      reasonForMissingSnapshot: () => this.config.moduleSnapshotReason?.(this.root),
      notify: (method, params) => this.liveProcess().connection.sendNotification(method, params),
      closeOpen: (path) => this.closeOpenFile(this.liveProcess(), path),
      openedAs: (path) => this.openInProcess.get(pathKey(path)),
      isLive: () => this.process !== undefined && this.process.isAlive(),
      dispose: () => this.dispose(),
    });
  }

  /** The same three services, handed to the engine that compares an index against the sources on disk. */
  private buildDrift(): IndexDrift | undefined {
    const takeSnapshot = this.config.indexSnapshot;
    if (takeSnapshot === undefined) return undefined;
    return new IndexDrift({
      takeSnapshot,
      notify: (method, params) => this.liveProcess().connection.sendNotification(method, params),
      closeOpen: (path) => this.closeOpenFile(this.liveProcess(), path),
      openedAs: (path) => this.openInProcess.get(pathKey(path)),
    });
  }

  /** Files opened via `cpp_file_symbols` in this session, across any server respawn. */
  getOpenedFiles(): string[] {
    return Array.from(this.everOpenedFiles);
  }

  /**
   * The process to talk to: a live one, the one another caller is still handshaking, or a new one.
   * Sharing `starting` is what makes one root cost one child *and* one handshake — a caller whose
   * request overtakes `initialized` is not something a language server is obliged to answer.
   */
  private async ensureProcess(): Promise<LspProcess> {
    if (this.process?.isAlive()) return this.process;
    if (this.starting) return this.starting;
    const starting = this.startProcess();
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  /** The child a freshness push is addressing; `ModuleFreshness` asks for the push only while one lives. */
  private liveProcess(): LspProcess {
    const proc = this.process;
    if (proc === undefined || !proc.isAlive()) throw new Error(`${this.config.id} has no live process to notify`);
    return proc;
  }

  private async startProcess(): Promise<LspProcess> {
    // Either first use, or the previous process died — a fresh process has no open documents and
    // no indexing progress, so it is cold again regardless of whether the prior process was warm,
    // and anything waiting on the old process's readiness is waiting on a proof it can no longer get.
    // That last part is only true of a replacement: a first spawn takes nothing away from anyone.
    this.abandonReadiness(this.process !== undefined);
    this.openInProcess.clear();
    this.openedStamps.clear();
    this.warm = false;
    // Before the spawn, not after it: the child is about to read the disk as it is now, and a baseline
    // taken later would be newer than the graph and hide every change since the load.
    this.freshness?.snapshotAtStart();
    const proc = this.spawnFn(this.root, this.config);
    this.spawnSerials.set(proc, ++this.spawnCount);
    this.watchWorkDoneProgress(proc.connection);
    this.answerServerRequests(proc.connection);
    try {
      const initialized = await this.send<unknown>(proc, "initialize", this.config.initializeParams(this.root));
      await proc.connection.sendNotification("initialized", {});
      this.initializeAnswer = initialized;
    } catch (e) {
      // Never published, so nothing else holds this child: a live one whose handshake failed has to
      // be killed here or `dispose()` can never reach it.
      proc.kill();
      throw proc.spawnFailure() ?? e;
    }
    this.process = proc;
    return proc;
  }

  /**
   * The allow-list, in the one place that states it. `send` enforces it on every request,
   * and a caller that would otherwise have to start a child to learn its method is refused checks it
   * first — same predicate, same error, so nothing can slip between the two.
   */
  private assertAllowed(method: string): void {
    if (!this.config.allowedRequests.has(method)) {
      throw new Error(
        `${this.config.id} will not be asked for "${method}": this server only ever sends ` +
          `${[...this.config.allowedRequests].join(", ")}.`,
      );
    }
  }

  /**
   * The one route to `connection.sendRequest`: a method the config does not allow is refused before
   * the connection is touched, so no call site can grow a capability the config denies. The process
   * comes from the caller because the document being `didOpen`ed belongs to it: sending the request
   * over a different process would ask one that never saw the file.
   */
  private async send<R>(proc: LspProcess, method: string, params: unknown): Promise<R> {
    this.assertAllowed(method);
    try {
      return await sendWithControl<R>(proc.connection, method, params, {
        serverId: this.config.id,
        timeoutMs: this.requestTimeoutMs,
        signal: currentRequestSignal(),
      });
    } catch (e) {
      if (e instanceof RequestTimeoutError) this.discardProcess(proc);
      throw await this.withServerStderr(proc, e);
    }
  }

  /**
   * A child that stopped answering is thrown away so the next call starts a fresh one instead of waiting
   * the full timeout again. `kill()` does not flip `isAlive()` until the exit event arrives, so the
   * reference is dropped here too.
   */
  private discardProcess(proc: LspProcess): void {
    this.discarded.add(proc);
    if (this.process === proc) this.process = undefined;
    this.abandonReadiness(true);
    proc.kill();
  }

  /**
   * A failure that left the child dead, or that is a timeout, carries what the child last wrote to stderr: that is
   * where a server says why it stopped. A cancelled call and an unavailable binary already say everything.
   */
  private async withServerStderr(proc: LspProcess, error: unknown): Promise<unknown> {
    if (!(error instanceof Error) || error instanceof RequestAbortedError || error instanceof LanguageServerUnavailableError) {
      return error;
    }
    if (proc.isAlive() && !(error instanceof RequestTimeoutError)) return error;
    // The exit that failed the request can be seen before the child's last stderr bytes are read.
    if (proc.stderrSettled !== undefined) await Promise.race([proc.stderrSettled(), this.sleep(STDERR_SETTLE_MS)]);
    const note = stderrNote(this.config.id, proc.stderrTail?.());
    return note === "" ? error : new Error(error.message + note, { cause: error });
  }

  /**
   * Answers the server's `window/workDoneProgress/create` request and subscribes to the token it
   * names. A client that registers no handler answers `MethodNotFound`, and gopls then never emits
   * `$/progress` at all, so readiness could never be proven.
   */
  private watchWorkDoneProgress(connection: LspConnection): void {
    connection.onRequest("window/workDoneProgress/create", (params: WorkDoneProgressCreateParams = {}): null => {
      if (params.token !== undefined) this.trackProgress(connection, params.token);
      return null;
    });
  }

  /**
   * Answers the requests the server sends this client, from the table its config carries. A method left
   * unregistered is answered `MethodNotFound`, which for one server is not a refusal but a default: tsgo's
   * `workspace/configuration` question is where automatic type acquisition gets turned off, and a client that
   * never answers it is agreeing to the server's own behaviour.
   */
  private answerServerRequests(connection: LspConnection): void {
    for (const [method, answer] of Object.entries(this.config.serverRequests ?? {})) {
      connection.onRequest(method, (params: unknown) => answer(params));
    }
  }

  /**
   * Subscribes to one progress token and remembers the FIRST token the process asked for as the initial
   * workspace load, which is the only token gopls's readiness proof depends on. Every token a
   * process creates is watched, because the index state an index-backed answer carries is counted from
   * them; a repeated create for one token subscribes nothing new, since a second subscription for the same
   * token throws inside jsonrpc.
   */
  private trackProgress(connection: LspConnection, token: ProgressToken): void {
    this.progressObserved = true;
    if (this.initialProgressToken === undefined) this.initialProgressToken = token;
    if (this.watchedProgress.has(token)) return;
    this.watchedProgress.add(token);
    connection.onProgress(new ProgressType<ProgressValue>(), token, (value: ProgressValue) =>
      this.countProgress(token, value),
    );
  }

  /**
   * One `$/progress` value: `begin` puts its token in flight, `end` takes it out, and a `report` changes
   * nothing about whether work is outstanding. The end of the first token is the load proof; the end of any
   * later one is a re-index that proves nothing about the graph, so it must not stand in for it.
   */
  private countProgress(token: ProgressToken, value: ProgressValue): void {
    this.progressObserved = true;
    if (value?.kind === "begin") {
      this.tokensInFlight.add(token);
      for (const window of this.indexWindows) window.beganDuring = true;
      return;
    }
    if (value?.kind === "end") {
      this.tokensInFlight.delete(token);
      if (token === this.initialProgressToken) this.markWorkspaceLoaded();
    }
  }

  /**
   * Runs one request with the server's progress activity latched across its whole window — from the moment
   * the request is issued to the moment its reply arrives — and hands the verdict back with the value, so a
   * caller cannot publish a state it did not watch the answer through. `building` covers a token already in
   * flight when the window opened and one that began and finished inside it, which is the case a sample
   * taken at the reply reads as idle.
   */
  async withIndexWindow<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly index: IndexState }> {
    const window: IndexWindow = { beganDuring: false };
    const inFlightAtStart = this.tokensInFlight.size;
    const measuring = this.processGeneration;
    this.indexWindows.add(window);
    try {
      const value = await work();
      // A request that took the child away and retried against a replacement would otherwise read the dead
      // process's tokens as work still in flight, and a genuinely empty answer from the one that replied
      // would be refused as incomplete. The verdict is only ever about the process that answered, so a
      // window that spans a replacement says nothing — the choice over re-running the request, which the
      // answer already in hand does not need.
      const index =
        measuring === this.processGeneration ? this.indexState(inFlightAtStart, window.beganDuring) : "unknown";
      return { value, index };
    } finally {
      this.indexWindows.delete(window);
    }
  }

  private indexState(inFlightAtStart: number, beganDuring: boolean): IndexState {
    if (!this.progressObserved) return "unknown";
    if (inFlightAtStart > 0 || beganDuring) return "building";
    return "quiescent";
  }

  private markWorkspaceLoaded(): void {
    this.workspaceLoaded = true;
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve("ready");
    }
    this.readyWaiters.clear();
  }

  /**
   * Forgets which token proved the load and what the process said about itself. `replacingProcess` states
   * whether the process being abandoned is one a readiness wait could have been standing on: when it is,
   * every pending wait ends as "restarted", because only that process could answer it and a waiter told
   * nothing would blame its budget for a server taken away from it. A first spawn replaces nothing, so its
   * waits stay standing for that process's own proof.
   */
  private abandonReadiness(replacingProcess: boolean): void {
    this.initialProgressToken = undefined;
    this.workspaceLoaded = false;
    // A process that no longer exists is not the one any answer may describe, so neither is what it said
    // about itself: `serverInfo` is only ever about the process that answers.
    this.initializeAnswer = undefined;
    // A replacement process has announced nothing yet and holds no document, so everything the last one's
    // progress said — including an indexing round still running inside it — died with it. Anything that was
    // measuring the old one is told so by the generation, not by a verdict it cannot stand behind.
    if (this.process !== undefined) this.processGeneration++;
    this.watchedProgress.clear();
    this.tokensInFlight.clear();
    this.progressObserved = false;
    // Every drift baseline describes the disk a process that no longer exists read, so there is nothing to
    // compare a new one against until a call over these roots takes one.
    this.drift?.reset();
    // A wait that began before any process existed is waiting on this spawn's own process, which will answer
    // it with its load proof; only a wait standing on a process being taken away can never be answered.
    if (!replacingProcess) return;
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve("restarted");
    }
    this.readyWaiters.clear();
  }

  /**
   * Whether the process a call is about to use has proven its own initial load. A waiter's answer is
   * only ever about the process that was live when it asked, so this is checked again after a request
   * that may have respawned in the middle.
   */
  isWorkspaceLoaded(): boolean {
    return this.workspaceLoaded;
  }

  /**
   * Resolves `"ready"` once the initial workspace load's progress `end` has been seen, `"timed-out"` once
   * `timeoutMs` has passed without it, and `"restarted"` if the process that was asked is replaced while
   * waiting. Nothing else proves a server ready for a type-aware query: a non-empty answer can be a
   * partial one.
   */
  async awaitWorkspaceReady(timeoutMs: number): Promise<ReadinessOutcome> {
    const askedAt = performance.now();
    const outcome = await this.waitForWorkspaceReady(timeoutMs);
    noteReadyWait(performance.now() - askedAt);
    return outcome;
  }

  private async waitForWorkspaceReady(timeoutMs: number): Promise<ReadinessOutcome> {
    if (this.workspaceLoaded) return "ready";
    const signal = currentRequestSignal();
    if (signal?.aborted) return "timed-out";
    return new Promise<ReadinessOutcome>((resolve) => {
      const giveUp = (): void => {
        this.readyWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        resolve("timed-out");
      };
      const waiter: ReadinessWaiter = {
        resolve: (outcome) => {
          signal?.removeEventListener("abort", giveUp);
          resolve(outcome);
        },
        timer: setTimeout(giveUp, timeoutMs),
      };
      signal?.addEventListener("abort", giveUp, { once: true });
      this.readyWaiters.add(waiter);
    });
  }

  private async ensureOpen(proc: LspProcess, file: string): Promise<void> {
    const key = pathKey(file);
    if (this.openInProcess.has(key)) await this.closeIfStale(proc, file);
    if (this.openInProcess.has(key)) return;
    await this.openDocument(proc, file, true);
  }

  /**
   * `didOpen` with the file's current text. `tracked` is what puts the file in the sets a later call
   * reads from — the long-lived opened set, the ever-opened set behind `cpp_find_symbol`, and the stamp the
   * staleness check compares against — so an untracked open leaves no trace behind.
   */
  private async openDocument(proc: LspProcess, file: string, tracked: boolean): Promise<void> {
    const key = pathKey(file);
    // The stamp is taken before the read: text and stamp must describe the same moment, or a write that
    // lands between them leaves a stamp that reports this text as stale the moment it is sent.
    const stamp = fileStamp(file);
    const text = this.readFile(file);
    await proc.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri: fileUri(file), languageId: this.config.languageIdFor(file), version: 1, text },
    });
    // A process replaced or disposed while the write was in flight took its held set with it; recording this
    // file now would claim the replacement holds a document that only the dead child was given.
    if (this.process !== proc) return;
    this.openInProcess.set(key, file);
    if (!tracked) return;
    this.everOpenedFiles.add(file);
    if (stamp !== undefined) this.openedStamps.set(key, stamp);
  }

  /**
   * The one-file check, which is all a syntactic outline needs: one `stat`, no traversal. A
   * file with no recorded stamp — one this session could not stat when it opened it — has nothing to
   * compare against and stays open.
   */
  private async closeIfStale(proc: LspProcess, file: string): Promise<void> {
    const key = pathKey(file);
    const recorded = this.openedStamps.get(key);
    if (recorded === undefined) return;
    if (fileStamp(file) === recorded) return;
    await this.closeOpenFile(proc, file);
  }

  /**
   * Drops the document held for `file` and tells the server, which is what makes the next `didOpen`
   * carry the file's current text: a server re-reads from disk only once it holds no buffer for it. The
   * release names the spelling the document was opened under, not the one that asked for the close.
   */
  private async closeOpenFile(proc: LspProcess, file: string): Promise<void> {
    const key = pathKey(file);
    const opened = this.openInProcess.get(key);
    if (opened === undefined) return;
    await proc.connection.sendNotification("textDocument/didClose", { textDocument: textDocumentId(opened) });
    this.openInProcess.delete(key);
    this.openedStamps.delete(key);
  }

  /** Proves the server's package graph current before a type-aware call. */
  async refreshModuleSnapshot(): Promise<FreshnessOutcome> {
    if (this.freshness === undefined) return { kind: "unchanged" };
    return this.freshness.refresh();
  }

  /**
   * The files the module's package graph was just proved against — the module's own tree, with the
   * directories that are not in the graph already left out — or `undefined` while nothing is proved. A
   * config that names no walk never proves anything, so it never has a file set to hand out.
   */
  moduleSnapshotPaths(): readonly string[] | undefined {
    return this.freshness?.provedPaths();
  }

  /**
   * What the live process stated about itself in `initialize` — the only server version an answer may report,
   * because a version read from the disk may name an install that is not the one answering (this host has two
   * global TypeScript 7 installs and which one is found depends on PATH order). `undefined` until a handshake
   * has completed and again after a respawn, which is a fact a caller states rather than fills in.
   */
  serverInfo(): { readonly name: string; readonly version: string } | undefined {
    const info = (this.initializeAnswer as { serverInfo?: { name?: unknown; version?: unknown } } | undefined)
      ?.serverInfo;
    if (typeof info?.name !== "string" || typeof info.version !== "string") return undefined;
    return { name: info.name, version: info.version };
  }

  /**
   * Opens each anchor and holds it, which is a server with no progress to wait for being told which projects
   * an answer must cover. tsgo loads a project inside the `didOpen` of a file
   * in it and never drops one it was given, so a held anchor is the whole of the readiness proof this backend
   * can make; an anchor a freshness push closed is re-opened here, because this call is the one that has to
   * answer with it.
   *
   * The answer says whether the proof was made, and opens alone make it: nothing opened proves nothing, and a process replaced partway through the loop holds only some
   * of the documents, so the mark stays off and the next call opens everything again. A caller that needs a
   * loaded project and gets `false` says so rather than returning an empty answer.
   */
  async openAnchors(files: readonly string[]): Promise<boolean> {
    return (await this.openAnchorsOn(files)) !== undefined;
  }

  /**
   * `openAnchors`, answering which spawn the proof was made on (`undefined` when none was), read at the moment
   * of the proof. A caller that goes on to ask the process a question compares it with `spawnSerial()` after
   * the reply: the answer is only about the anchors when the same process still answers.
   */
  async openAnchorsOn(files: readonly string[]): Promise<number | undefined> {
    const proc = await this.ensureProcess();
    const serial = this.spawnSerials.get(proc);
    for (const file of files) {
      if (this.process !== proc) return undefined;
      await this.ensureOpen(proc, file);
    }
    if (this.config.readinessProof !== "documents-opened") return undefined;
    if (files.length === 0 || this.process !== proc) return undefined;
    this.markWorkspaceLoaded();
    return serial;
  }

  /** The spawn serving requests now, or `undefined` while no process is live. */
  spawnSerial(): number | undefined {
    return this.process === undefined ? undefined : this.spawnSerials.get(this.process);
  }

  /**
   * Which live child this session is on. A map, a baseline or a proof belonging to an earlier number describes
   * a process that no longer exists.
   */
  generation(): number {
    return this.processGeneration;
  }

  /** What the last freshness check compared, so a caller can tell a structural change from a content edit. */
  snapshotDiff(): SnapshotDiff | undefined {
    return this.freshness?.lastSnapshotDiff();
  }

  /**
   * What the index this call is about to read may be behind, pushing the changed sources on the way. The
   * roots are the caller's declared `sourceRoots`, never `projectRoot`: that is the directory the compile
   * database lives in, which for an out-of-tree build is the build tree and says nothing about the sources
   * the answer depends on. This is a signal about the shards, not a proof about the answer — after the push
   * clangd still has to do the re-indexing, which is why the C++ scope reports drift where the Go one
   * reports freshness.
   */
  async indexDrift(sourceRoots: readonly string[]): Promise<IndexDriftVerdict> {
    return (await this.indexDriftReading(sourceRoots)).verdict;
  }

  /**
   * The same reading with the walk's other signal: which TU sources under these roots the walk saw, which
   * is what the C++ `scope.uncoveredSources` pair is computed from. One call's two questions are answered
   * by one bounded walk, so a tool never pays twice to know how far behind and how wide the index is.
   */
  async indexDriftReading(sourceRoots: readonly string[]): Promise<IndexDriftReading> {
    if (this.drift === undefined) {
      return {
        verdict: {
          kind: "unknown",
          cause: "no-baseline",
          reason: `${this.config.id} answers no question from an index of the sources on disk, so there is no drift to state`,
        },
      };
    }
    return this.drift.checkWithAccount(sourceRoots);
  }

  /**
   * The path the document is held under, which is the one its URI was built from. A request naming a
   * differently spelled path would ask about a document the server has never seen.
   */
  private openedPath(file: string): string {
    return this.openInProcess.get(pathKey(file)) ?? file;
  }

  private async requestDocumentSymbol(proc: LspProcess, file: string): Promise<LspDocumentSymbol[] | null> {
    await this.ensureOpen(proc, file);
    const result = await this.send<LspDocumentSymbol[] | null>(proc, "textDocument/documentSymbol", {
      textDocument: textDocumentId(this.openedPath(file)),
    });
    return result ?? null;
  }

  /**
   * Fetches `file`'s document-symbol outline. Applies the cold/warm split when
   * `config.documentSymbolNeedsWarmth` says this server's empty outline is ambiguous: an empty result
   * before this process has ever produced a non-empty one gets one retry after `retryDelayMs`, then
   * reports "cold-empty" instead of a confident empty. Also applies the crash-and-respawn recovery:
   * a request against a dead process respawns the server and retries exactly once
   * before the caller sees a rejection.
   */
  async documentSymbol(file: string): Promise<DocumentSymbolState> {
    let proc = await this.ensureProcess();
    let symbols: LspDocumentSymbol[] | null;
    try {
      symbols = await this.requestDocumentSymbol(proc, file);
    } catch (e) {
      if (proc.isAlive() || this.discarded.has(proc)) throw e;
      proc = await this.ensureProcess();
      symbols =await this.requestDocumentSymbol(proc, file);
    }

    if (symbols && symbols.length > 0) {
      this.warm = true;
      return { state: "ok", symbols };
    }
    if (this.warm || !this.config.documentSymbolNeedsWarmth) {
      return { state: "empty" };
    }

    await this.sleep(this.retryDelayMs);
    symbols = await this.requestDocumentSymbol(proc, file);
    if (symbols && symbols.length > 0) {
      this.warm = true;
      return { state: "ok", symbols };
    }
    return { state: "cold-empty" };
  }

  /**
   * Holds `file` open for exactly as long as `ask` runs — `didOpen` with the text on disk, the request sent
   * against the path the document was opened under, then `didClose` — so a server can be asked about a
   * document it holds without that document ever joining the session's long-lived opened set. A file
   * already held for good is left held: closing it would be the change of state the caller did not ask for.
   * Every transient read of a document goes through here, so the hold-and-release discipline is stated once.
   */
  async withTransientDocument<T>(file: string, ask: (asking: TransientAsking) => Promise<T>): Promise<T> {
    const proc = await this.ensureProcess();
    const heldOpen = this.openInProcess.has(pathKey(file));
    if (!heldOpen) await this.openDocument(proc, file, false);
    const asking: TransientAsking = {
      openedAs: this.openedPath(file),
      send: <R>(method: string, params: unknown): Promise<R> => this.send<R>(proc, method, params),
    };
    try {
      return await ask(asking);
    } finally {
      // A child that died or was discarded needs no `didClose`; the set it was in is cleared when it is replaced.
      if (!heldOpen && proc.isAlive() && !this.discarded.has(proc)) await this.closeOpenFile(proc, file);
    }
  }

  /**
   * Reads one file's outline without the server ever being told it is a document this client holds.
   * The naming fan-out needs the declaration at a location the server just reported, and the snapshot logic only
   * corrects documents held open for good, so those files must not join the opened or ever-opened sets.
   */
  async documentSymbolTransient(file: string): Promise<LspDocumentSymbol[] | null> {
    return this.withTransientDocument<LspDocumentSymbol[] | null>(file, (asking) =>
      asking.send<LspDocumentSymbol[] | null>("textDocument/documentSymbol", {
        textDocument: textDocumentId(asking.openedAs),
      }),
    );
  }

  /**
   * Sends `method` with `params` through the same guard and the same respawn-once recovery as
   * `documentSymbol`, so a method outside `config.allowedRequests` is refused rather than reaching
   * the server.
   */
  async request<T>(method: string, params: unknown): Promise<T> {
    this.assertAllowed(method);
    let proc = await this.ensureProcess();
    try {
      return await this.send<T>(proc, method, params);
    } catch (e) {
      if (proc.isAlive() || this.discarded.has(proc)) throw e;
      proc = await this.ensureProcess();
      return this.send<T>(proc, method, params);
    }
  }

  dispose(): void {
    const proc = this.process;
    this.process = undefined;
    // No child is left to answer a wait that is standing, so its waits end here; the generation is left
    // alone because a session thrown away and started again is not a replacement a request is measuring.
    this.abandonReadiness(true);
    proc?.kill();
  }
}
