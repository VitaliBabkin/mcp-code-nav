import type { GoExecFn, GoExecResult } from "../../src/gopls/go-env.js";

/**
 * A `go` of a test's choosing: the same three calls the real toolchain pass makes, answered however the
 * test says and recorded, so the default suite never runs a Go toolchain
 * (see CONTRIBUTING.md).
 *
 * Every shape here is what `makeGoExec` really returns for that outcome: a process that ran to an exit is
 * `{stdout, stderr, exitCode}`, one that failed around the process carries a `spawnCode` and no exit code,
 * and a kill carries neither.
 */

/** Which of the three calls one `go` argv is. */
export type GoCallKind = "env" | "work" | "dist";

/** A call's answer, or `hang` for one that never returns. */
export type GoAnswer = GoExecResult | "hang";

export interface FakeGoCall {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface FakeGo {
  readonly exec: GoExecFn;
  readonly calls: FakeGoCall[];
  /** The first call of that kind, so a test can assert what the toolchain was asked and in what setting. */
  asked(kind: GoCallKind): FakeGoCall | undefined;
}

export function goCallKind(args: readonly string[]): GoCallKind {
  if (args[0] === "tool") return "dist";
  return args[1] === "GOWORK" ? "work" : "env";
}

/** The process ran, printed, and exited 0. */
export function ran(stdout: string, stderr = ""): GoExecResult {
  return { stdout, stderr, exitCode: 0 };
}

/** The process ran and exited `code` — Node reports that as a numeric `code`, never as a spawn error. */
export function exited(code: number, stderr: string, stdout = ""): GoExecResult {
  return { stdout, stderr, exitCode: code };
}

/** The failure was around the process: `ENOENT`, `EACCES`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. */
export function spawnFailed(code: string, stderr = code, stdout = ""): GoExecResult {
  return { stdout, stderr, exitCode: undefined, spawnCode: code };
}

/** The binary was not there: the one spawn failure whose remedy is stated by name. */
export function notOnPath(stderr = 'spawn go ENOENT'): GoExecResult {
  return spawnFailed("ENOENT", stderr);
}

/** Alias of `spawnFailed`, spelled the way the older suites name it. */
export const notStarted = spawnFailed;

/** The call outgrew the pipe buffer: it ran, and still answered nothing usable. */
export function maxBufferExceeded(stdout = "{"): GoExecResult {
  return spawnFailed("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "stdout maxBuffer length exceeded", stdout);
}

/** Killed before it answered — by this server's timeout or by anything else. */
export function killed(stdout = "", stderr = ""): GoExecResult {
  return { stdout, stderr, exitCode: undefined };
}

const HOST_ENV = { GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "1", GOFLAGS: "" };

/** `go env -json` output for a windows/amd64 host, with whatever fields the test overrides. */
export function goEnvJson(overrides: Partial<typeof HOST_ENV> = {}): string {
  return JSON.stringify({ ...HOST_ENV, ...overrides });
}

/** The `scope.environment` a default answer produces. */
export const WINDOWS_AMD64 = {
  goos: "windows",
  goarch: "amd64",
  cgoEnabled: true,
  buildTags: [],
  goWork: null,
};

/** A host with cgo on, no build tags, no workspace, and nothing new for the filename rule to learn. */
const DEFAULTS: Record<GoCallKind, GoExecResult> = {
  env: ran(goEnvJson()),
  work: ran(""),
  dist: ran("linux/amd64\nwindows/amd64\n"),
};

export function fakeGo(answers: Partial<Record<GoCallKind, GoAnswer>> = {}): FakeGo {
  const calls: FakeGoCall[] = [];
  const exec: GoExecFn = async (args, cwd, env) => {
    const kind = goCallKind(args);
    calls.push({ args, cwd, env });
    const answer = answers[kind] ?? DEFAULTS[kind];
    if (answer === "hang") return new Promise<GoExecResult>(() => {});
    return answer;
  };
  return { exec, calls, asked: (kind) => calls.find((call) => goCallKind(call.args) === kind) };
}
