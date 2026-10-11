import { isAbsolute } from "node:path";
import { takeModuleSnapshot } from "../gopls/module-snapshot.js";
import { tsLanguageId } from "../tsgo/language.js";
import { takeWorkspaceSnapshot, workspaceSnapshotReason } from "../tsgo/workspace-snapshot.js";
import { fileUri } from "./document-uri.js";
import type { ModuleSnapshotFn } from "./module-freshness.js";
import { takeIndexSnapshot, type IndexSnapshotFn } from "../paths/index-drift.js";
import type { TsgoBinary } from "../tsgo/binary.js";

/** Everything that differs between language servers. Anything not here is shared by construction. */
export interface LanguageServerConfig {
  readonly id: "clangd" | "gopls" | "tsgo";
  /** Two configs of one server that must never share a process; the session key uses it in place of `id`. */
  readonly sessionKind?: string;
  readonly command: string;
  readonly commandEnvOverride: string;
  readonly installHint: string;
  /**
   * The LSP `languageId` a document is opened under. A server for one language answers a constant; tsgo
   * serves TypeScript and JavaScript from one process, so its id follows the file's extension
   * and every other server's text is unchanged.
   */
  readonly languageIdFor: (file: string) => string;
  readonly argv: (root: string) => readonly string[];
  /** Merged over `process.env` for the child. gopls: `GOWORK=off`, `GOTOOLCHAIN=local`. */
  readonly childEnv: Readonly<Record<string, string>>;
  readonly initializeParams: (root: string) => Record<string, unknown>;
  /** The ONLY methods `send()` will issue — lifecycle and query alike. clangd's omits
   *  `textDocument/implementation`; gopls's omits `textDocument/definition`. */
  readonly allowedRequests: ReadonlySet<string>;
  /** clangd only: an empty outline before the first non-empty one is `cold-empty`, never a confident empty. */
  readonly documentSymbolNeedsWarmth: boolean;
  /**
   * Only a server that holds a package graph has one: the bounded walk that proves that
   * graph before a type-aware answer. A config without one is never walked, so a clangd session
   * starts no module scan and proves nothing it cannot use.
   */
  readonly moduleSnapshot?: ModuleSnapshotFn;
  /**
   * Why `moduleSnapshot` answered nothing, for a walk that knows more than the engine it is handed to: tsgo's
   * walk can fail because a config's closure leads to a file that is not there or lies outside the workspace,
   * and a reload that says so is a reload the caller can act on.
   */
  readonly moduleSnapshotReason?: (root: string) => string | undefined;
  /**
   * Only a server whose answers are computed from an index of the sources on disk has a drift signal to
   * report: clangd's shards are built from those files and it hears about an edit from its client alone, so
   * the diff of this walk is pushed before each index-backed call and reported as `scope.index` — as drift,
   * never as currency. Keyed per call by the roots the caller declared, which is why
   * this is a function of a root set rather than the session's own root.
   */
  readonly indexSnapshot?: IndexSnapshotFn;
  /**
   * How this server proves it is ready to answer a type-aware question. `documents-opened` is tsgo's, which
   * sends no progress at all and loads a project inside the `didOpen` of a file in it;
   * absent means today's proof, the end of the initial-load progress token.
   */
  readonly readinessProof?: "initial-load-progress" | "documents-opened";
  /**
   * Answers to the requests the server sends THIS client, keyed by method. A server-to-client request left
   * unregistered is answered `MethodNotFound`, which for tsgo means its `workspace/configuration` question
   * about automatic type acquisition goes unanswered and its default applies.
   */
  readonly serverRequests?: Readonly<Record<string, (params: unknown) => unknown>>;
}

/** The pieces a start failure's text is built from; a located binary has no config until it is found. */
export interface UnavailableReport {
  readonly id: LanguageServerConfig["id"];
  readonly commandEnvOverride: string;
  readonly installHint: string;
}

/** Where the executable handed to `spawn` came from — the pieces the message has to name. */
export interface SpawnAttempt {
  readonly config: LanguageServerConfig | UnavailableReport;
  /** The exact executable passed to `spawn`: the override's value, or the bare command PATH must resolve. */
  readonly attempted: string;
  readonly fromOverride: boolean;
}

/**
 * `tsgo`'s command is an executable this server located itself — an absolute path PATH was never asked to
 * resolve — so the PATH sentence belongs only to a bare command name.
 */
function attemptedText(attempt: SpawnAttempt): string {
  const { attempted, fromOverride, config } = attempt;
  if (fromOverride) return `${config.commandEnvOverride}="${attempted}"`;
  return isAbsolute(attempted) ? `"${attempted}"` : `"${attempted}" on PATH`;
}

/** The start failure's text for one attempt; exported because a located binary can fail before a config exists. */
export function unavailableMessage(attempt: SpawnAttempt, code: string | undefined): string {
  const { config, fromOverride } = attempt;
  const why = code === "ENOENT" ? "was not found" : "could not be started";
  const remedy = fromOverride
    ? `${config.installHint}, or point ${config.commandEnvOverride} at an existing absolute path`
    : `${config.installHint}, or set ${config.commandEnvOverride} to an absolute path`;
  return `Cannot start ${config.id}: ${attemptedText(attempt)} ${why}${code ? ` (${code})` : ""} — ${remedy}.`;
}

/** The binary named by `config` could not be spawned; the message carries the override name and install hint. */
export class LanguageServerUnavailableError extends Error {
  readonly attempted: string;
  readonly code?: string;

  constructor(
    attempt: SpawnAttempt,
    details: { readonly code?: string; readonly cause?: unknown; readonly message?: string } = {},
  ) {
    // A binary located per call can fail the search before any config exists to describe the attempt, so the
    // location writes its own sentence and this carries it unchanged.
    super(
      details.message ?? unavailableMessage(attempt, details.code),
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "LanguageServerUnavailableError";
    this.attempted = attempt.attempted;
    this.code = details.code;
  }
}

/**
 * Without `hierarchicalDocumentSymbolSupport` a server answers `textDocument/documentSymbol` with the
 * FLAT `SymbolInformation[]` shape (a `location.range`, a `containerName`, no children) instead of the
 * nested `DocumentSymbol[]` shape `src/clangd/outline.ts`'s `toOutline`/`flattenOutline` assume —
 * confirmed via a live clangd 22.1.3 smoke test against this exact capabilities object.
 */
const CLIENT_CAPABILITIES = {
  textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
};

/**
 * clangd decides a `hover` answer's format by what its client says it can read and answers plaintext to a
 * client that said nothing — and a plaintext answer has no code block, so the declaration and the prose
 * around it arrive as one undifferentiated string and no signature can be read out of it without guessing.
 * `window.workDoneProgress` is the other half of what this server needs from clangd: a client that never
 * asks for progress gets no `$/progress` at all, and the index state an index-backed answer carries is
 * latched over those tokens. `documentSymbol` capabilities are inherited unchanged;
 * gopls answers markdown unasked, so its config keeps the shared object.
 */
const CLANGD_CAPABILITIES = {
  ...CLIENT_CAPABILITIES,
  textDocument: {
    ...CLIENT_CAPABILITIES.textDocument,
    hover: { contentFormat: ["markdown", "plaintext"] },
  },
  window: { workDoneProgress: true },
};

/**
 * `--compile-commands-dir` is how clangd is told where the database is, so it is derived from the root.
 * `--background-index=true` is clangd's own default today and is passed anyway: the project-wide C++
 * reference and caller answers are computed from that index, so a future clangd
 * whose default flips must not silently change what this server's answers cover. A flag that decides the
 * scope of an answer belongs in the argv this server writes.
 */
const clangdArgv = (root: string): readonly string[] => [
  `--compile-commands-dir=${root}`,
  "--background-index=true",
  "--log=error",
];

/**
 * Annotating rather than `satisfies` is what makes `allowedRequests` a `ReadonlySet`: the config
 * objects are module-level and shared, so a mutable set would let any file reactivate a method
 * the config denies. Both constants stay structurally identical to before the annotation.
 */
export const clangdConfig: LanguageServerConfig = {
  id: "clangd",
  command: "clangd",
  commandEnvOverride: "MCP_CODE_NAV_CLANGD",
  installHint: "install LLVM/clangd and put it on PATH",
  languageIdFor: () => "cpp",
  argv: clangdArgv,
  childEnv: {},
  initializeParams: (root) => ({
    processId: process.pid,
    rootUri: fileUri(root),
    capabilities: CLANGD_CAPABILITIES,
    initializationOptions: { compilationDatabasePath: root },
  }),
  allowedRequests: new Set([
    "initialize",
    "shutdown",
    "textDocument/documentSymbol",
    // what a declaration IS, read from the declaration this server already
    // located by name.
    "textDocument/hover",
    // the use-site and caller questions, from clangd's index.
    // `textDocument/implementation` stays out — the project rules keeps the C++ hierarchy question
    // clang-query's alone — and so does `textDocument/definition` and `callHierarchy/outgoingCalls`:
    // no tool issues them.
    "textDocument/references",
    "textDocument/prepareCallHierarchy",
    "callHierarchy/incomingCalls",
    // a declaration named without a file is looked for in the index clangd
    // already keeps, which is where the unscoped branch looks. It costs no work to build: the
    // shards exist because `--background-index=true` asked for them above.
    "workspace/symbol",
  ]),
  documentSymbolNeedsWarmth: true,
  // The one server whose project-wide answers are read from an index of the sources on disk.
  indexSnapshot: takeIndexSnapshot,
};

/**
 * the clangd that outlines one file when `projectRoot` holds no compile database. Background
 * indexing is off, so nothing is written under `projectRoot`; only the outline is asked, so no answer can lean on
 * an index it does not have; and it never shares a process with a database-backed session, so a database built
 * later is picked up by the normal one. `id` stays `clangd`, so start errors read as they always have.
 */
export const clangdNoDatabaseConfig: LanguageServerConfig = {
  ...clangdConfig,
  sessionKind: "clangd-no-db",
  argv: (root) => [`--compile-commands-dir=${root}`, "--background-index=false", "--log=error"],
  allowedRequests: new Set(["initialize", "shutdown", "textDocument/documentSymbol"]),
  indexSnapshot: undefined,
};

export const goplsConfig: LanguageServerConfig = {
  id: "gopls",
  command: "gopls",
  commandEnvOverride: "MCP_CODE_NAV_GOPLS",
  installHint: "run go install golang.org/x/tools/gopls@latest",
  languageIdFor: () => "go",
  argv: () => [],
  // GOWORK=off keeps one answer inside one module; GOTOOLCHAIN=local keeps a
  // `go.mod` that demands a newer toolchain from turning a read-only lookup into a download.
  childEnv: { GOWORK: "off", GOTOOLCHAIN: "local" },
  initializeParams: (root) => ({
    processId: process.pid,
    rootUri: fileUri(root),
    // gopls only creates the initial-load progress token for a client that declares `workDoneProgress`;
    // without it no `$/progress` ever arrives and readiness can never be proven.
    capabilities: { ...CLIENT_CAPABILITIES, window: { workDoneProgress: true } },
  }),
  allowedRequests: new Set([
    "initialize",
    "shutdown",
    "textDocument/documentSymbol",
    "textDocument/implementation",
    // the use-site and caller questions. `textDocument/definition` and
    // `callHierarchy/outgoingCalls` stay out — no tool issues them.
    "textDocument/references",
    "textDocument/prepareCallHierarchy",
    "callHierarchy/incomingCalls",
    // the declaration question. `hover` reads the signature and doc of a declaration this
    // server already located by name, and `workspace/symbol` searches the graph gopls loaded anyway.
    "textDocument/hover",
    "workspace/symbol",
  ]),
  documentSymbolNeedsWarmth: false,
  // The only server kind whose answer is a loaded package graph, so the only one that is walked.
  moduleSnapshot: takeModuleSnapshot,
};

/**
 * What tsgo is called, where it is overridden, and how to get it — the three pieces both the config and the
 * search that precedes it state, kept in one place so a miss and a start failure cannot name different fixes.
 */
export const TSGO_IDENTITY: UnavailableReport = {
  id: "tsgo",
  commandEnvOverride: "MCP_CODE_NAV_TSGO",
  installHint: "install TypeScript 7 with npm install -g typescript@7",
};

/**
 * The answer one section carries. `disableAutomaticTypeAcquisition` turns tsgo's automatic type acquisition
 * off, under the spelling a VS Code-shaped client answers for the `typescript` and `javascript` sections.
 * `maximumHoverLength` is the key tsgo 7.0.2 reads for how long a hover's printed type may grow before the
 * printer elides it (`...;`); measured on a real function, the value alone lifts the elision, and the 32-bit
 * ceiling is the largest value it took. A key tsgo does not read changes nothing, so the neighbouring spellings
 * (`hover.maximumLength`, `preferences.maximumHoverLength`) are not sent.
 */
const TSGO_SECTION_ANSWER = { disableAutomaticTypeAcquisition: true, maximumHoverLength: 2_147_483_647 };

/**
 * The sections tsgo asks about whose answer can hold automatic type acquisition off. It asks for `editor`
 * too; nothing there is ours to answer, so that item gets `null` and keeps the server's own default.
 */
const TSGO_TYPE_ACQUISITION_SECTIONS = new Set(["js/ts", "typescript", "javascript"]);

/** One item of a `workspace/configuration` request, in either spelling the server was seen to use. */
interface ConfigurationItem {
  /** What tsgo 7.0.2 sends, measured against a large real-world workspace: `{"items":[{"section":"js/ts"}, ...]}`. */
  readonly section?: string;
  /** The name the LSP specification gives the same field, which no server is obliged to use. */
  readonly configurationSection?: string;
}

/** One value per requested item, in the order requested: type acquisition off where a section can carry it. */
function answerTsgoConfiguration(params: unknown): unknown[] {
  const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
  return items.map((value) => {
    const item = value as ConfigurationItem | undefined;
    const section = item?.section ?? item?.configurationSection;
    return section !== undefined && TSGO_TYPE_ACQUISITION_SECTIONS.has(section) ? TSGO_SECTION_ANSWER : null;
  });
}

/**
 * Automatic type acquisition is tsgo running `cmd /c npm install --ignore-scripts types-registry@latest` as
 * its own child on a project that compiles JavaScript  — a read-only navigation call reaching the
 * network and writing a package cache, which is exactly what `GOTOOLCHAIN=local` refuses for Go
 *. The server asks this client whether acquisition is allowed before it starts, so the
 * answer is where the rule belongs; a client that leaves the request to `MethodNotFound` gets the default.
 * `client/registerCapability` is answered `null` because this client declines the file-watching registration
 * it would carry and sends the changes itself anyway.
 */
const TSGO_SERVER_REQUESTS: LanguageServerConfig["serverRequests"] = {
  "workspace/configuration": answerTsgoConfiguration,
  "client/registerCapability": () => null,
};

/**
 * tsgo's client capabilities are the ones its answers depend on, and two are deliberately absent:
 * `window.workDoneProgress`, because a client that asks for progress is a client that will wait for a
 * `$/progress` tsgo never sends , and `workspace.didChangeWatchedFiles.dynamicRegistration`,
 * because declaring it tells tsgo its client is watching the disk, which this server is not — the freshness
 * push is sent without any capability behind it and is processed anyway (the measured server behaviour).
 *
 * `workspace.configuration` is declared because it is what makes the server ASK. Measured on 7.0.2 against
 * a large real-world workspace: a client that declares nothing receives no `workspace/configuration` request at all, so
 * the answer that holds automatic type acquisition off would never be delivered — the answer below is only a
 * rule if there is a question it can answer.
 */
const TSGO_CAPABILITIES = {
  ...CLIENT_CAPABILITIES,
  textDocument: {
    ...CLIENT_CAPABILITIES.textDocument,
    hover: { contentFormat: ["markdown"] },
    callHierarchy: {},
  },
  workspace: { configuration: true },
};

/**
 * One `tsc.exe --lsp --stdio` per workspace root. `command` is the executable the caller located for this
 * process, so the argv is fixed and the root reaches the server only as `rootUri`.
 */
export function tsgoConfig(binary: TsgoBinary): LanguageServerConfig {
  return {
    ...TSGO_IDENTITY,
    command: binary.executable,
    languageIdFor: tsLanguageId,
    argv: () => ["--lsp", "--stdio"],
    childEnv: {},
    initializeParams: (root) => ({
      processId: process.pid,
      rootUri: fileUri(root),
      capabilities: TSGO_CAPABILITIES,
    }),
    allowedRequests: new Set([
      "initialize",
      "shutdown",
      // The allow-list. `callHierarchy/outgoingCalls` stays out — no tool issues it
      //.
      "textDocument/documentSymbol",
      "textDocument/references",
      "textDocument/implementation",
      "textDocument/prepareCallHierarchy",
      "callHierarchy/incomingCalls",
      "textDocument/hover",
      "workspace/symbol",
      // asked at an import binding, to find the declaration it binds. Its one call site
      // is `ts_find_references`' alias branch; no tool exposes it.
      "textDocument/definition",
    ]),
    // tsgo's `documentSymbol` is syntactic and correct on the first call , so an empty outline is
    // the file's own answer and never a cold index, exactly as with gopls.
    documentSymbolNeedsWarmth: false,
    readinessProof: "documents-opened",
    serverRequests: TSGO_SERVER_REQUESTS,
    // The module-freshness engine over a workspace instead of a module: the walk, and
    // the reason it could not finish, which is a config's name rather than this server's guess.
    moduleSnapshot: takeWorkspaceSnapshot,
    moduleSnapshotReason: workspaceSnapshotReason,
  };
}

/**
 * Never called; the compiler checking it is the point. That no code path can reactivate a
 * denied method holds only while a config's request set cannot be widened, so if either constant
 * stops being typed through `LanguageServerConfig` this directive goes unused and `tsc` fails.
 */
function allowedRequestsCannotBeWidened(): void {
  // @ts-expect-error `allowedRequests` is a `ReadonlySet`, which is the whole reason these are annotated
  clangdConfig.allowedRequests.add("textDocument/implementation");
}
