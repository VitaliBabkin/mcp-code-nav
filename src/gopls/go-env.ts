import { execFile } from "node:child_process";
import { currentRequestSignal } from "../lsp/request-scope.js";
import { promisify } from "node:util";
import { goplsConfig } from "../lsp/server-config.js";
import { pathKey } from "../paths/path-containment.js";
import { knownPorts, parseDistList, type DistTokens, type KnownPorts } from "./os-arch-excluded.js";
import { messageOf } from "../error-message.js";

/**
 * What the toolchain a Go answer was computed under actually is: GOOS, GOARCH, CGO_ENABLED, the build
 * tags in `GOFLAGS`, and whether a `go.work` exists that the answer deliberately does not span
 *. Asked from `go` rather than inferred from `process.platform`, which a
 * cross-compiling environment, `GOFLAGS`, `CGO_ENABLED` or `GOWORK` all make wrong.
 */

const execFileAsync = promisify(execFile);

/** The program a pass runs. `MCP_CODE_NAV_GOPLS` names the language server, never this. */
const GO_BINARY = "go";

/** A `go` call that has not answered by now is not going to answer this call usefully. */
const GO_TIMEOUT_MS = 30_000;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** A toolchain's stderr can be a whole backtrace; a reason has to stay readable inside a payload. */
const DETAIL_LIMIT = 300;

/** One `go` invocation's outcome: what it printed, and how the process ended. */
export interface GoExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** The exit code of a process that ran to one — Node's numeric `code`. */
  readonly exitCode: number | undefined;
  /** Node's string `code` (`ENOENT`, `EACCES`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) when the failure was
   *  around the process rather than inside it; `undefined` for a clean run and for a kill. */
  readonly spawnCode?: string;
}

/**
 * Injection seam for tests, so the default suite never runs `go`: it receives the argv, the working
 * directory to ask in, and the environment overlay to merge over the parent's.
 */
export type GoExecFn = (
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
) => Promise<GoExecResult>;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A rejected `execFile` folded into the same shape a resolved one has. The two failure kinds are told
 * apart by the type of Node's `code`: a number means the program ran and said no, a string means
 * something went wrong around it, and neither means the same thing to the caller.
 */
function failedExec(e: unknown): GoExecResult {
  const failure = e as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown };
  const stdout = asText(failure.stdout);
  const stderr = asText(failure.stderr);
  if (typeof failure.code === "number") return { stdout, stderr, exitCode: failure.code };
  const code = typeof failure.code === "string" ? failure.code : undefined;
  const note = stderr || code || (failure.killed === true ? "killed before it answered" : "");
  return { stdout, stderr: note, exitCode: undefined, spawnCode: code };
}

/** Runs `binary` with `execFile` and never throws: whatever the process did comes back as a result. */
export function makeGoExec(binary: string = GO_BINARY): GoExecFn {
  return async (args, cwd, env) => {
    try {
      const { stdout, stderr } = await execFileAsync(binary, [...args], {
        cwd,
        env: { ...process.env, ...env },
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: GO_TIMEOUT_MS,
        signal: currentRequestSignal(),
      });
      return { stdout, stderr: asText(stderr), exitCode: 0 };
    } catch (e) {
      return failedExec(e);
    }
  };
}

/** The executor a real pass runs: `go`, found on PATH. */
export const defaultGoExec: GoExecFn = makeGoExec();

/** The GOOS/GOARCH, cgo setting, build tags and workspace a Go answer was computed under. */
export interface GoEnvironment {
  readonly goos: string;
  readonly goarch: string;
  /** `CGO_ENABLED=0` removes every `import "C"` file from the graph, a narrowing as real as the GOOS one. */
  readonly cgoEnabled: boolean;
  readonly buildTags: readonly string[];
  /** The `go.work` in effect, or `null` when there is none — reported although the answer does not span it. */
  readonly goWork: string | null;
}

/** Why the toolchain could not be asked, in words a caller can branch on. */
export interface GoEnvironmentUnavailable {
  readonly unavailable: string;
}

/**
 * The build tags `GOFLAGS` carries: `-tags=a,b` or `--tags=a,b` inside a space-separated flag list. A
 * repeated flag replaces rather than accumulates, so the last one is the one the toolchain uses.
 */
export function buildTagsFromGoFlags(goFlags: string): string[] {
  let last: string | undefined;
  for (const token of goFlags.split(/\s+/)) {
    const value = /^-{1,2}tags=(.*)$/.exec(token)?.[1];
    if (value !== undefined) last = value;
  }
  if (last === undefined) return [];
  const tags = last
    .replace(/^["']|["']$/g, "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  return [...new Set(tags)];
}

/**
 * The overrides the gopls child itself runs under, taken from its config rather than restated:
 * `GOWORK=off` is what makes one answer describe one module, and `GOTOOLCHAIN=local` what keeps a
 * `go.mod` demanding a newer toolchain from turning a read-only lookup into a download.
 */
const SINGLE_MODULE_ENV: Readonly<Record<string, string>> = goplsConfig.childEnv;

/** The workspace question cannot be asked under the override that answers it. */
const LOCAL_TOOLCHAIN_ENV: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(goplsConfig.childEnv).filter(([name]) => name !== "GOWORK"),
);

function clip(text: string): string {
  return text.trim().slice(0, DETAIL_LIMIT);
}

/** `undefined` when the call answered; otherwise the reason, naming which question went unanswered. */
function callFailure(asking: string, moduleRoot: string, result: GoExecResult): string | undefined {
  const detail = clip(result.stderr) || clip(result.stdout);
  const tail = detail === "" ? "" : `: ${detail}`;
  if (result.spawnCode === "ENOENT") {
    return `go is not on PATH, so ${asking} could not be asked for the module "${moduleRoot}" (ENOENT${tail})`;
  }
  if (result.spawnCode !== undefined) {
    return `the go call about ${asking} for the module "${moduleRoot}" did not answer (${result.spawnCode}${tail})`;
  }
  if (result.exitCode === undefined) {
    return `go gave no answer about ${asking} for the module "${moduleRoot}" and never reported an exit code${tail}`;
  }
  if (result.exitCode !== 0) {
    return `go exited with code ${result.exitCode} while asked about ${asking} for the module "${moduleRoot}"${tail}`;
  }
  return undefined;
}

function couldNotAsk(asking: string, moduleRoot: string, cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return `this server could not run go to ask about ${asking} for the module "${moduleRoot}" (${reason})`;
}

type EnvFields = Omit<GoEnvironment, "goWork">;

/** A `go env -json` answer this server cannot use; `cause` is what the parser said, when there was one. */
function unparsable(stdout: string, moduleRoot: string, cause?: string): GoEnvironmentUnavailable {
  const detail = cause === undefined ? "" : ` (${cause})`;
  return {
    unavailable: `go env -json for the module "${moduleRoot}" did not answer with JSON this server can read: ${clip(stdout)}${detail}`,
  };
}

/**
 * The fields `go env -json` answers with. `buildTags` is not one of them — it comes out of `GOFLAGS`,
 * which is the only place a `-tags` setting set outside the toolchain is visible.
 */
function readEnvFields(stdout: string, moduleRoot: string): EnvFields | GoEnvironmentUnavailable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    return unparsable(stdout, moduleRoot, messageOf(e));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unparsable(stdout, moduleRoot);
  const { GOOS, GOARCH, CGO_ENABLED, GOFLAGS } = parsed as Record<string, unknown>;
  if (typeof GOOS !== "string" || GOOS === "" || typeof GOARCH !== "string" || GOARCH === "") {
    return {
      unavailable:
        `go env -json for the module "${moduleRoot}" answered without a GOOS and GOARCH value, so the port ` +
        `this answer describes is unknown: ${clip(stdout)}`,
    };
  }
  if (CGO_ENABLED !== "0" && CGO_ENABLED !== "1") {
    return {
      unavailable:
        `go env -json for the module "${moduleRoot}" answered CGO_ENABLED=${String(CGO_ENABLED)}, which is ` +
        "neither on nor off, so whether cgo files are in the graph is unknown",
    };
  }
  return {
    goos: GOOS,
    goarch: GOARCH,
    cgoEnabled: CGO_ENABLED === "1",
    buildTags: buildTagsFromGoFlags(typeof GOFLAGS === "string" ? GOFLAGS : ""),
  };
}

/** `off` and empty are both "no workspace in effect"; anything else is the path of one. */
function goWorkValue(stdout: string): string | null {
  const value = stdout.trim();
  return value === "" || value === "off" ? null : value;
}

type GoCall = { readonly ok: true; readonly result: GoExecResult } | { readonly ok: false; readonly reason: string };

/** One `go` call folded into either its result or the reason this server has to give for it. */
async function askGo(
  exec: GoExecFn,
  args: readonly string[],
  moduleRoot: string,
  env: Readonly<Record<string, string>>,
  asking: string,
): Promise<GoCall> {
  try {
    const result = await exec(args, moduleRoot, env);
    const reason = callFailure(asking, moduleRoot, result);
    return reason === undefined ? { ok: true, result } : { ok: false, reason };
  } catch (e) {
    return { ok: false, reason: couldNotAsk(asking, moduleRoot, e) };
  }
}

async function askEnvironment(moduleRoot: string, exec: GoExecFn): Promise<GoEnvironment | GoEnvironmentUnavailable> {
  const [build, workspace] = await Promise.all([
    askGo(exec, ["env", "-json"], moduleRoot, SINGLE_MODULE_ENV, "the toolchain's GOOS, GOARCH and build tags"),
    // Run without the `GOWORK=off` the other calls use, so a workspace the child never sees is still named.
    askGo(exec, ["env", "GOWORK"], moduleRoot, LOCAL_TOOLCHAIN_ENV, "whether a go.work is in effect"),
  ]);
  if (!build.ok) return { unavailable: build.reason };
  if (!workspace.ok) return { unavailable: workspace.reason };
  const fields = readEnvFields(build.result.stdout, moduleRoot);
  if ("unavailable" in fields) return fields;
  return { ...fields, goWork: goWorkValue(workspace.result.stdout) };
}

/** A failure to list the ports is ignored: the compiled-in token list is primary and stands on its own. */
async function askDistTokens(moduleRoot: string, exec: GoExecFn): Promise<DistTokens | undefined> {
  const listed = await askGo(
    exec,
    ["tool", "dist", "list"],
    moduleRoot,
    SINGLE_MODULE_ENV,
    "the supported GOOS/GOARCH ports",
  );
  return listed.ok ? parseDistList(listed.result.stdout) : undefined;
}

/** What one toolchain pass produced: the port an answer describes, and the tokens its filename rule knows. */
export interface GoToolchain {
  readonly environment: GoEnvironment | GoEnvironmentUnavailable;
  readonly ports: KnownPorts;
}

/** One pass per module root for the life of the process — kept only for a pass that actually answered. */
const passes = new Map<string, Promise<GoToolchain>>();

async function runPass(moduleRoot: string, exec: GoExecFn): Promise<GoToolchain> {
  const [environment, tokens] = await Promise.all([
    askEnvironment(moduleRoot, exec),
    askDistTokens(moduleRoot, exec),
  ]);
  return { environment, ports: knownPorts(tokens) };
}

/**
 * Every `go` failure is folded into `environment.unavailable`, so a pass resolves whatever happened and a
 * caller can start one early without a handler for a rejection that cannot arrive.
 */
function cachedPass(moduleRoot: string, exec: GoExecFn): Promise<GoToolchain> {
  const key = pathKey(moduleRoot);
  const running = passes.get(key);
  if (running !== undefined) return running;
  const started = runPass(moduleRoot, exec);
  passes.set(key, started);
  void started.then(
    (pass) => {
      // A toolchain that could not be asked once is asked again by the next call: a failure is not a fact
      // about the module, and keeping it would make every later Go call in the process restate it.
      if ("unavailable" in pass.environment) passes.delete(key);
    },
    () => passes.delete(key),
  );
  return started;
}

/** The toolchain pass behind `scope`: asked once per module root, and never re-asked after it answered. */
export function readToolchain(moduleRoot: string, exec: GoExecFn = defaultGoExec): Promise<GoToolchain> {
  return cachedPass(moduleRoot, exec);
}
