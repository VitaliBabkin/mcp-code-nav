import { execFile } from "node:child_process";
import { currentRequestSignal } from "../lsp/request-scope.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { TSGO_IDENTITY, unavailableMessage } from "../lsp/server-config.js";

/**
 * Where the TypeScript 7 native server's executable is. It is not a command PATH can
 * name: `typescript@7`'s single bin is a JS launcher whose `lib/getExePath.js` resolves a platform package,
 * and executing a global package's code in-process is not this server's call — so the same installed-package
 * rule is re-implemented here as a lookup, never as a `require`.
 */

const execFileAsync = promisify(execFile);

/** The program that knows where a global install lives. `MCP_CODE_NAV_TSGO` names the server, never this. */
const NPM_BINARY = "npm";

/** The package manifest every part of this rule reads. */
const PACKAGE_JSON = "package.json";

/** A package whose major version is below this one has no native server at all . */
const MINIMUM_TYPESCRIPT_MAJOR = 7;

const EXEC_TIMEOUT_MS = 30_000;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** A tool's stderr can be a whole backtrace; a reason has to stay readable inside a payload. */
const DETAIL_LIMIT = 300;

/** Why there is no executable, and the path this server would have handed to `spawn` anyway. */
export interface TsgoBinaryMiss {
  readonly unavailable: string;
  readonly attempted: string;
}

/** The located executable, the version it reports for itself, and which rule located it. */
export interface TsgoBinary {
  readonly executable: string;
  readonly version: string;
  readonly source: "override" | "global";
}

/** A miss is reported rather than thrown, so the caller that caches this answer chooses the error to raise. */
export type TsgoBinaryResult = { readonly binary: TsgoBinary } | TsgoBinaryMiss;

/** One executable's outcome: what it printed, and how the process ended. */
export interface TsExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** The exit code of a process that ran to one — Node's numeric `code`. */
  readonly exitCode: number | undefined;
  /** Node's string `code` when the failure was around the process rather than inside it. */
  readonly spawnCode?: string;
}

/**
 * Injection seam for tests, so the default suite never runs `npm` or a real `tsc.exe`: it receives the
 * program, its argv, and the working directory to ask in.
 */
export type TsExecFn = (
  executable: string,
  args: readonly string[],
  cwd: string,
  /** The child's environment; the parent's when omitted. */
  env?: NodeJS.ProcessEnv,
) => Promise<TsExecResult>;

/**
 * The environment `npm` needs to answer `npm root -g` the same way however this process was launched. A
 * launcher such as `npm --prefix <dir> run ...` exports its prefix to every child, and a child npm then reports
 * that directory's `node_modules` as the global root — so a working global install looks missing.
 */
export function withoutNpmPrefix(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dropped = new Set(["npm_config_prefix", "npm_config_global_prefix"]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !dropped.has(key.toLowerCase())));
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A rejected `execFile` folded into the same shape a resolved one has: a numeric `code` means the program ran
 * and said no, a string one means something went wrong around it, and those are not the same fact to a
 * caller. Same reading as the Go toolchain pass, which faces the same two kinds.
 */
function failedExec(e: unknown): TsExecResult {
  const failure = e as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown };
  const stdout = asText(failure.stdout);
  const stderr = asText(failure.stderr);
  if (typeof failure.code === "number") return { stdout, stderr, exitCode: failure.code };
  const code = typeof failure.code === "string" ? failure.code : undefined;
  const note = stderr || code || (failure.killed === true ? "killed before it answered" : "");
  return { stdout, stderr: note, exitCode: undefined, spawnCode: code };
}

/**
 * Runs one program and never throws: whatever the process did comes back as a result. `npm` is a `.cmd`
 * beside `node` on Windows, which `execFile` refuses without a shell, so on that one path the call is given as
 * a single command line with no argument list — Node warns that arguments passed beside a shell are
 * concatenated rather than escaped. The argv behind that line is this module's own two constants on every
 * call, never anything a caller supplies.
 */
export const defaultTsExec: TsExecFn = async (executable, args, cwd, env) => {
  const throughShell = process.platform === "win32" && executable === NPM_BINARY;
  try {
    const { stdout, stderr } = await execFileAsync(
      throughShell ? [executable, ...args].join(" ") : executable,
      throughShell ? [] : [...args],
      {
        cwd,
        env: env ?? process.env,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: EXEC_TIMEOUT_MS,
        signal: currentRequestSignal(),
        shell: throughShell,
      },
    );
    return { stdout, stderr: asText(stderr), exitCode: 0 };
  } catch (e) {
    return failedExec(e);
  }
};

export interface TsgoBinaryDeps {
  exec: TsExecFn;
  /** A `package.json`'s parsed object, or `undefined` when it is absent or unreadable. */
  readJson: (path: string) => Record<string, unknown> | undefined;
  exists: (path: string) => boolean;
  platform: string;
  arch: string;
  override: string | undefined;
}

type ResolvedDeps = Required<TsgoBinaryDeps>;

function readPackageJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveDeps(deps: Partial<TsgoBinaryDeps>): ResolvedDeps {
  return {
    exec: deps.exec ?? defaultTsExec,
    readJson: deps.readJson ?? readPackageJson,
    exists: deps.exists ?? existsSync,
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    override: deps.override ?? process.env[TSGO_IDENTITY.commandEnvOverride],
  };
}

function clip(text: string): string {
  return text.trim().slice(0, DETAIL_LIMIT);
}

/** The remedy every miss states: the install that puts a native server here, or the override that names one. */
function remedy(): string {
  const { installHint, commandEnvOverride } = TSGO_IDENTITY;
  return `${installHint}, or set ${commandEnvOverride} to the native executable's absolute path`;
}

function miss(reason: string, attempted: string): TsgoBinaryMiss {
  return { unavailable: `Cannot start ${TSGO_IDENTITY.id}: ${reason} — ${remedy()}.`, attempted };
}

/** A call this server runs on the way to the executable; its detail is only ever a clipped fragment. */
function describeCall(result: TsExecResult): string {
  const detail = clip(result.stderr || result.stdout);
  const tail = detail === "" ? "" : `: ${detail}`;
  if (result.spawnCode !== undefined) return `did not answer (${result.spawnCode}${tail})`;
  if (result.exitCode !== undefined && result.exitCode !== 0) return `exited with code ${result.exitCode}${tail}`;
  return `answered nothing usable${tail}`;
}

/** The major of a `package.json`'s `version`, or `undefined` when it states no number this rule can read. */
function majorOf(version: unknown): number | undefined {
  const match = /^(\d+)\./.exec(asText(version).trim());
  return match === null ? undefined : Number(match[1]);
}

/** The package that carries the executable for this platform and architecture. */
function platformPackage(deps: ResolvedDeps): readonly string[] {
  return ["@typescript", `typescript-${deps.platform}-${deps.arch}`];
}

/** The executable inside that package — a PE binary on win32, an ELF one elsewhere. */
function nativeExecutableName(platform: string): string {
  return platform === "win32" ? "tsc.exe" : "tsc";
}

/**
 * `<dir>/node_modules/<package>` for `dir` and every ancestor of it, in the order node's own resolver tries:
 * a platform package nested under the `typescript` package (how `npm install -g typescript@7` lays it out,
 * the measured server behaviour) is found before a hoisted sibling of it.
 */
function packageDirs(startDir: string, parts: readonly string[]): string[] {
  const dirs: string[] = [];
  let dir = startDir;
  for (;;) {
    dirs.push(join(dir, "node_modules", ...parts));
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

/** The executable `getExePath.js` resolves: a readable platform package's `lib/tsc`, inside the TS package's tree. */
function findNativeExecutable(
  typescriptDir: string,
  deps: ResolvedDeps,
): { readonly executable: string } | TsgoBinaryMiss {
  const parts = platformPackage(deps);
  for (const dir of packageDirs(typescriptDir, parts)) {
    if (deps.readJson(join(dir, PACKAGE_JSON)) === undefined) continue;
    const executable = join(dir, "lib", nativeExecutableName(deps.platform));
    // A package that resolves without its executable is a broken install, and a layout this rule does not
    // know is a different one; naming the path tried is what tells them apart from the outside.
    return deps.exists(executable)
      ? { executable }
      : miss(`the native package at "${dir}" has no executable at "${executable}"`, executable);
  }
  const tried = join(typescriptDir, "node_modules", ...parts);
  return miss(
    `the typescript package at "${typescriptDir}" has no native package for ${deps.platform}-${deps.arch} at ` +
      `"${tried}", or in any node_modules above it`,
    tried,
  );
}

/** The global `typescript@7` package directory and the version it states, or the reason there is neither. */
function typescriptPackage(root: string, deps: ResolvedDeps): { dir: string; version: string } | TsgoBinaryMiss {
  const dir = join(root, "typescript");
  const manifestPath = join(dir, PACKAGE_JSON);
  const manifest = deps.readJson(manifestPath);
  if (manifest === undefined) {
    return miss(`the global package directory "${root}" has no readable typescript/package.json`, manifestPath);
  }
  const version = asText(manifest.version).trim();
  const major = majorOf(version);
  if (major === undefined) {
    return miss(`the typescript package at "${dir}" states no version this server can read`, dir);
  }
  if (major < MINIMUM_TYPESCRIPT_MAJOR) {
    return miss(
      `the typescript package at "${dir}" is version ${version}, which is below the ${MINIMUM_TYPESCRIPT_MAJOR}.x ` +
        "native server",
      dir,
    );
  }
  return { dir, version };
}

/** `npm root -g`, or the miss naming how that question went unanswered. */
async function askGlobalRoot(deps: ResolvedDeps): Promise<{ directory: string } | TsgoBinaryMiss> {
  const result = await deps.exec(NPM_BINARY, ["root", "-g"], process.cwd(), withoutNpmPrefix(process.env));
  const directory = result.stdout.trim();
  if (directory !== "" && deps.exists(directory)) return { directory };
  if (directory !== "") {
    return miss(
      `\`npm root -g\` answered "${directory}", which is not a directory this server can read`,
      join(directory, "typescript"),
    );
  }
  return miss(`\`npm root -g\` ${describeCall(result)}`, join("npm root -g", "typescript"));
}

/**
 * The version the located executable's own package states: `lib/tsc.exe` sits one directory below the
 * platform package that declares it, and two above are tried for the same cost in case it does not.
 */
function versionBeside(executable: string, deps: ResolvedDeps): string | undefined {
  let dir = dirname(executable);
  for (let depth = 0; depth < 3; depth++) {
    const manifest = deps.readJson(join(dir, PACKAGE_JSON));
    const version = manifest === undefined ? "" : asText(manifest.version).trim();
    if (version !== "") return version;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** What the executable states for itself when no package beside it does — the last label available for it. */
async function askVersion(executable: string, deps: ResolvedDeps): Promise<string | undefined> {
  const result = await deps.exec(executable, ["--version"], process.cwd());
  return /(\d+\.\d+\.\d+\S*)/.exec(`${result.stdout}${result.stderr}`)?.[1];
}

/**
 * The override names the executable outright, so its version is read from the package it is installed in and
 * asked of the binary only when that package states nothing. Location itself stays a lookup: the server this
 * rule finds is started by `spawn` later, never required here.
 */
async function fromOverride(override: string, deps: ResolvedDeps): Promise<TsgoBinaryResult> {
  if (!deps.exists(override)) {
    return {
      unavailable: unavailableMessage({ config: TSGO_IDENTITY, attempted: override, fromOverride: true }, "ENOENT"),
      attempted: override,
    };
  }
  const version = await versionBeside(override, deps) ?? await askVersion(override, deps);
  if (version === undefined) {
    return miss(`${TSGO_IDENTITY.commandEnvOverride}="${override}" states no version beside it or to --version`, override);
  }
  return { binary: { executable: override, version, source: "override" } };
}

async function fromGlobal(deps: ResolvedDeps): Promise<TsgoBinaryResult> {
  const root = await askGlobalRoot(deps);
  if ("unavailable" in root) return root;
  const typescript = typescriptPackage(root.directory, deps);
  if ("unavailable" in typescript) return typescript;
  const native = findNativeExecutable(typescript.dir, deps);
  if ("unavailable" in native) return native;
  return { binary: { executable: native.executable, version: typescript.version, source: "global" } };
}

/**
 * Where this host's TypeScript 7 native server is: `MCP_CODE_NAV_TSGO` wins, and otherwise the global
 * `typescript` package is read the way its own launcher reads it. The caller caches one answer for the life
 * of the process; a miss is asked again by the next call, because a search that failed
 * once is not a fact about the host.
 */
export async function resolveTsgoBinary(deps: Partial<TsgoBinaryDeps> = {}): Promise<TsgoBinaryResult> {
  const resolved = resolveDeps(deps);
  const override = resolved.override;
  if (override !== undefined && override !== "") return fromOverride(override, resolved);
  return fromGlobal(resolved);
}
