import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveTsgoBinary,
  type TsgoBinaryDeps,
  type TsExecFn,
  type TsExecResult,
} from "../../src/tsgo/binary.js";
import { TSGO_IDENTITY, unavailableMessage } from "../../src/lsp/server-config.js";

/**
 * Where the native server's executable comes from: the override wins, and otherwise the
 * global `typescript` package is read the way its own launcher reads it. Every case injects `exec`, `readJson`
 * and `exists`, so the suite runs no `npm`, spawns no `tsc.exe`, and never looks at a real node_modules. The
 * temp directory supplies nothing but realistic absolute path spellings.
 */

/** The remedy every miss from `binary.ts` ends with, quoted from that module's `remedy()`. */
const REMEDY =
  "install TypeScript 7 with npm install -g typescript@7, or set MCP_CODE_NAV_TSGO to the native executable's absolute path";

/** A miss's whole text: the reason the location states, then the remedy it must name. */
function missText(reason: string): string {
  return `Cannot start tsgo: ${reason} — ${REMEDY}.`;
}

/** The process ran, printed, and exited 0 — the shape `defaultTsExec` reports for that. */
function ran(stdout: string, stderr = ""): TsExecResult {
  return { stdout, stderr, exitCode: 0 };
}

/** The process ran and exited `code`, which Node reports as a numeric `code` and no string one. */
function exited(code: number, stderr: string): TsExecResult {
  return { stdout: "", stderr, exitCode: code };
}

/** The failure was around the process rather than inside it: a string `code` and no exit code. */
function notStarted(code: string, stderr = code): TsExecResult {
  return { stdout: "", stderr, exitCode: undefined, spawnCode: code };
}

interface TsCall {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

interface Host {
  readonly deps: TsgoBinaryDeps;
  readonly calls: TsCall[];
  /** The environment each call in `calls` was handed, by position; `undefined` where none was. */
  readonly envs: (NodeJS.ProcessEnv | undefined)[];
  /** The first call naming that program, so a case can assert what was asked of it. */
  asked(program: string): TsCall | undefined;
}

/**
 * A host of a test's choosing. An answer is keyed by the program asked; a `readJson` miss is a path absent from
 * `manifests`, and an `exists` miss is a path absent from `present`.
 */
function fakeHost(
  options: {
    answers?: Readonly<Record<string, TsExecResult>>;
    manifests?: Readonly<Record<string, Record<string, unknown>>>;
    present?: readonly string[];
    platform?: string;
    arch?: string;
    override?: string;
  } = {},
): Host {
  const calls: TsCall[] = [];
  const answers = options.answers ?? {};
  const manifests = options.manifests ?? {};
  const present = new Set(options.present ?? []);
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const exec: TsExecFn = async (executable, args, cwd, env) => {
    calls.push({ executable, args, cwd });
    envs.push(env);
    return answers[executable] ?? ran("");
  };
  return {
    deps: {
      exec,
      readJson: (path) => manifests[path],
      exists: (path) => present.has(path),
      platform: options.platform ?? "win32",
      arch: options.arch ?? "x64",
      override: options.override,
    },
    calls,
    envs,
    asked: (program) => calls.find((call) => call.executable === program),
  };
}

const OVERRIDE_NAME = "MCP_CODE_NAV_TSGO";

let tmp: string;
let savedOverride: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-tsgobin-"));
  // The override is read from this variable when the deps state none, so it is cleared around every case: a
  // host that has it set must not change what these tests assert, and the case that sets it puts it back.
  savedOverride = process.env[OVERRIDE_NAME];
  delete process.env[OVERRIDE_NAME];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedOverride === undefined) delete process.env[OVERRIDE_NAME];
  else process.env[OVERRIDE_NAME] = savedOverride;
});

describe("resolveTsgoBinary's override", () => {
  it("uses the override as the executable and asks --version of it when no package beside it states one", async () => {
    const override = join(tmp, "native", "tsc.exe");
    const host = fakeHost({ override, present: [override], answers: { [override]: ran("Version 7.0.2\n") } });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      binary: { executable: override, version: "7.0.2", source: "override" },
    });
    expect(host.calls).toEqual([{ executable: override, args: ["--version"], cwd: process.cwd() }]);
  });

  it("takes the version from the package the override sits in, which costs no process at all", async () => {
    const override = join(tmp, "node_modules", "@typescript", "typescript-win32-x64", "lib", "tsc.exe");
    const packageDir = dirname(dirname(override));
    const host = fakeHost({
      override,
      present: [override],
      manifests: { [join(packageDir, "package.json")]: { name: "@typescript/typescript-win32-x64", version: "7.0.2" } },
    });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      binary: { executable: override, version: "7.0.2", source: "override" },
    });
    expect(host.calls).toEqual([]);
  });

  it.each([
    ["Version 7.0.2\n", "7.0.2"],
    ["tsgo version 7.0.2\n", "7.0.2"],
    ["7.0.2-insiders.3\n", "7.0.2-insiders.3"],
  ])("falls back to --version, reading a print of %s as %s", async (stdout: string, version: string) => {
    const override = join(tmp, "native", "tsc.exe");
    const host = fakeHost({ override, present: [override], answers: { [override]: ran(stdout) } });

    await expect(resolveTsgoBinary(host.deps)).resolves.toMatchObject({ binary: { version } });
  });

  it("reads the version from what the override printed on stderr as readily as on stdout", async () => {
    const override = join(tmp, "native", "tsc");
    const host = fakeHost({ override, present: [override], answers: { [override]: ran("", "Version 7.0.2\n") } });

    await expect(resolveTsgoBinary(host.deps)).resolves.toMatchObject({ binary: { version: "7.0.2" } });
  });

  it("refuses an override that states no version beside it and none to --version", async () => {
    const override = join(tmp, "node_modules", ".bin", "tsc");
    const host = fakeHost({ override, present: [override], answers: { [override]: ran("") } });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      unavailable: missText(`${OVERRIDE_NAME}="${override}" states no version beside it or to --version`),
      attempted: override,
    });
  });

  it("takes the override from MCP_CODE_NAV_TSGO when the deps state none", async () => {
    const override = join(tmp, "bin", "tsc.exe");
    process.env[OVERRIDE_NAME] = override;
    const host = fakeHost({ present: [override], answers: { [override]: ran("Version 7.0.2\n") } });

    await expect(resolveTsgoBinary(host.deps)).resolves.toMatchObject({
      binary: { executable: override, version: "7.0.2", source: "override" },
    });
    expect(host.asked("npm")).toBeUndefined();
  });

  it("does not treat an override set to the empty string as an executable named", async () => {
    const root = join(tmp, "node_modules");
    const host = fakeHost({ override: "", answers: { npm: ran(root) }, present: [root] });

    await expect(resolveTsgoBinary(host.deps)).resolves.toMatchObject({ unavailable: expect.any(String) });
    expect(host.calls).toEqual([{ executable: "npm", args: ["root", "-g"], cwd: process.cwd() }]);
  });

  it("reports an override naming no existing path as the start failure the spawn would have raised, with no search", async () => {
    const override = join(tmp, "absent", "tsc.exe");
    const host = fakeHost({ override, present: [] });

    const expected = unavailableMessage(
      { config: TSGO_IDENTITY, attempted: override, fromOverride: true },
      "ENOENT",
    );
    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({ unavailable: expected, attempted: override });
    // The same sentence a failed spawn of the located binary carries, so a miss and a start failure cannot
    // name different fixes; and nothing was execed — neither a version question nor an `npm root -g` fallback.
    expect(expected).toBe(
      `Cannot start tsgo: ${OVERRIDE_NAME}="${override}" was not found (ENOENT) — ` +
        "install TypeScript 7 with npm install -g typescript@7, or point " +
        `${OVERRIDE_NAME} at an existing absolute path.`,
    );
    expect(host.calls).toEqual([]);
  });
});

describe("resolveTsgoBinary's global typescript@7 lookup", () => {
  it("asks npm for the global root, and asks nothing else on the way", async () => {
    const root = join(tmp, "node_modules");
    const host = fakeHost({ answers: { npm: ran(`${root}\n`) }, present: [root] });

    // No `typescript` package.json here, so the answer is a miss; what matters is the one question it cost.
    await expect(resolveTsgoBinary(host.deps)).resolves.toMatchObject({ unavailable: expect.any(String) });
    expect(host.calls).toEqual([{ executable: "npm", args: ["root", "-g"], cwd: process.cwd() }]);
  });

  it("asks for the global root without the prefix a launcher such as `npm --prefix` exports to its children", async () => {
    const saved = { lower: process.env.npm_config_prefix, global: process.env.npm_config_global_prefix };
    process.env.npm_config_prefix = join(tmp, "worktree");
    process.env.npm_config_global_prefix = join(tmp, "worktree");
    try {
      const host = fakeHost({ answers: { npm: ran(`${join(tmp, "node_modules")}\n`) } });
      await resolveTsgoBinary(host.deps);

      const env = host.envs[0];
      expect(env).toBeDefined();
      expect(Object.keys(env ?? {}).map((key) => key.toLowerCase())).not.toContain("npm_config_prefix");
      expect(Object.keys(env ?? {}).map((key) => key.toLowerCase())).not.toContain("npm_config_global_prefix");
      // Only those two are dropped: the rest of the environment is what `npm` needs to run at all.
      expect(env?.PATH ?? env?.Path).toBe(process.env.PATH ?? process.env.Path);
    } finally {
      if (saved.lower === undefined) delete process.env.npm_config_prefix;
      else process.env.npm_config_prefix = saved.lower;
      if (saved.global === undefined) delete process.env.npm_config_global_prefix;
      else process.env.npm_config_global_prefix = saved.global;
    }
  });

  it("resolves the platform package's native executable and takes the version from typescript/package.json", async () => {
    const root = join(tmp, "npm", "node_modules");
    const typescriptDir = join(root, "typescript");
    const platformDir = join(typescriptDir, "node_modules", "@typescript", "typescript-win32-x64");
    const executable = join(platformDir, "lib", "tsc.exe");
    const host = fakeHost({
      answers: { npm: ran(`${root}\n`) },
      present: [root, executable],
      manifests: {
        [join(typescriptDir, "package.json")]: { name: "typescript", version: "7.0.2" },
        [join(platformDir, "package.json")]: { name: "@typescript/typescript-win32-x64" },
      },
    });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      binary: { executable, version: "7.0.2", source: "global" },
    });
    // A global install's version is read from its manifest, so the located executable is never run for it.
    expect(host.calls).toEqual([{ executable: "npm", args: ["root", "-g"], cwd: process.cwd() }]);
  });

  it("names the platform package and its executable by the host's platform and architecture", async () => {
    const root = join(tmp, "npm", "node_modules");
    const typescriptDir = join(root, "typescript");
    const platformDir = join(typescriptDir, "node_modules", "@typescript", "typescript-linux-arm64");
    const executable = join(platformDir, "lib", "tsc");
    const host = fakeHost({
      platform: "linux",
      arch: "arm64",
      answers: { npm: ran(`${root}\n`) },
      present: [root, executable],
      manifests: {
        [join(typescriptDir, "package.json")]: { name: "typescript", version: "7.0.2" },
        [join(platformDir, "package.json")]: { name: "@typescript/typescript-linux-arm64" },
      },
    });

    await expect(resolveTsgoBinary(host.deps)).resolves.toMatchObject({
      binary: { executable, source: "global" },
    });
  });

  it("prefers the platform package nested in the typescript package to a hoisted sibling of it", async () => {
    const root = join(tmp, "npm", "node_modules");
    const typescriptDir = join(root, "typescript");
    const nestedDir = join(typescriptDir, "node_modules", "@typescript", "typescript-win32-x64");
    const hoistedDir = join(root, "@typescript", "typescript-win32-x64");
    const host = fakeHost({
      answers: { npm: ran(`${root}\n`) },
      present: [root, join(nestedDir, "lib", "tsc.exe"), join(hoistedDir, "lib", "tsc.exe")],
      manifests: {
        [join(typescriptDir, "package.json")]: { name: "typescript", version: "7.0.2" },
        [join(nestedDir, "package.json")]: { name: "@typescript/typescript-win32-x64" },
        [join(hoistedDir, "package.json")]: { name: "@typescript/typescript-win32-x64" },
      },
    });

    await expect(resolveTsgoBinary(host.deps)).resolves.toMatchObject({
      binary: { executable: join(nestedDir, "lib", "tsc.exe") },
    });
  });

  it("walks up from the typescript package, so a platform package hoisted at the global root is found", async () => {
    const root = join(tmp, "npm", "node_modules");
    const typescriptDir = join(root, "typescript");
    const hoistedDir = join(root, "@typescript", "typescript-win32-x64");
    const host = fakeHost({
      answers: { npm: ran(`${root}\n`) },
      present: [root, join(hoistedDir, "lib", "tsc.exe")],
      manifests: {
        [join(typescriptDir, "package.json")]: { name: "typescript", version: "7.0.2" },
        [join(hoistedDir, "package.json")]: { name: "@typescript/typescript-win32-x64" },
      },
    });

    await expect(resolveTsgoBinary(host.deps)).resolves.toMatchObject({
      binary: { executable: join(hoistedDir, "lib", "tsc.exe"), version: "7.0.2" },
    });
  });

  it("keeps walking past the global root, so a platform package in an ancestor's node_modules is found", async () => {
    const root = join(tmp, "npm", "node_modules");
    const typescriptDir = join(root, "typescript");
    // Two directories above the global root (`npm root -g` answers `<tmp>/npm/node_modules`), so this is the
    // fourth candidate the walk reaches, not the nested one or the hoisted sibling of `typescript`.
    const ancestorDir = join(dirname(dirname(root)), "node_modules", "@typescript", "typescript-win32-x64");
    const host = fakeHost({
      answers: { npm: ran(`${root}\n`) },
      present: [root, join(ancestorDir, "lib", "tsc.exe")],
      manifests: {
        [join(typescriptDir, "package.json")]: { name: "typescript", version: "7.0.2" },
        [join(ancestorDir, "package.json")]: { name: "@typescript/typescript-win32-x64" },
      },
    });

    await expect(resolveTsgoBinary(host.deps)).resolves.toMatchObject({
      binary: { executable: join(ancestorDir, "lib", "tsc.exe") },
    });
  });

  it("reports a global root answered nothing usable, attempting the path that placeholder names", async () => {
    const host = fakeHost({ answers: { npm: ran("") } });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      unavailable: missText("`npm root -g` answered nothing usable"),
      attempted: join("npm root -g", "typescript"),
    });
  });

  it("reports a non-zero exit from npm as the exit it was, with the detail it printed", async () => {
    const host = fakeHost({ answers: { npm: exited(127, "npm ERR! code ENOENT\n") } });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      unavailable: missText("`npm root -g` exited with code 127: npm ERR! code ENOENT"),
      attempted: join("npm root -g", "typescript"),
    });
  });

  it("names a failure around npm without claiming an install is missing", async () => {
    const host = fakeHost({ answers: { npm: notStarted("ENOENT", "spawn npm ENOENT") } });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      unavailable: missText("`npm root -g` did not answer (ENOENT: spawn npm ENOENT)"),
      attempted: join("npm root -g", "typescript"),
    });
  });

  it("reports a global root npm printed that is not on disk as the answer it did not give", async () => {
    const gone = join(tmp, "gone", "node_modules");
    const host = fakeHost({ answers: { npm: ran(`${gone}\n`) }, present: [] });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      unavailable: missText(`\`npm root -g\` answered "${gone}", which is not a directory this server can read`),
      attempted: join(gone, "typescript"),
    });
  });

  it("reports a global root with no readable typescript/package.json, naming the manifest it wanted", async () => {
    const root = join(tmp, "npm", "node_modules");
    const host = fakeHost({ answers: { npm: ran(`${root}\n`) }, present: [root] });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      unavailable: missText(`the global package directory "${root}" has no readable typescript/package.json`),
      attempted: join(root, "typescript", "package.json"),
    });
  });

  it("refuses a global typescript@5.9.3, naming the package, its version, and the 7 requirement", async () => {
    const root = join(tmp, "npm", "node_modules");
    const typescriptDir = join(root, "typescript");
    const host = fakeHost({
      answers: { npm: ran(`${root}\n`) },
      present: [root],
      manifests: { [join(typescriptDir, "package.json")]: { name: "typescript", version: "5.9.3" } },
    });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      unavailable: missText(
        `the typescript package at "${typescriptDir}" is version 5.9.3, which is below the 7.x native server`,
      ),
      attempted: typescriptDir,
    });
  });

  it.each(["", "next", "7"])(
    "refuses a typescript package whose version %s states no readable major",
    async (version: string) => {
      const root = join(tmp, "npm", "node_modules");
      const typescriptDir = join(root, "typescript");
      const host = fakeHost({
        answers: { npm: ran(`${root}\n`) },
        present: [root],
        manifests: { [join(typescriptDir, "package.json")]: { name: "typescript", version } },
      });

      await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
        unavailable: missText(`the typescript package at "${typescriptDir}" states no version this server can read`),
        attempted: typescriptDir,
      });
    },
  );

  it("names the executable it tried when the platform package resolves without one", async () => {
    const root = join(tmp, "npm", "node_modules");
    const typescriptDir = join(root, "typescript");
    const platformDir = join(typescriptDir, "node_modules", "@typescript", "typescript-win32-x64");
    const executable = join(platformDir, "lib", "tsc.exe");
    const host = fakeHost({
      answers: { npm: ran(`${root}\n`) },
      present: [root],
      manifests: {
        [join(typescriptDir, "package.json")]: { name: "typescript", version: "7.0.2" },
        [join(platformDir, "package.json")]: { name: "@typescript/typescript-win32-x64" },
      },
    });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      unavailable: missText(
        `the native package at "${platformDir}" has no executable at "${executable}"`,
      ),
      attempted: executable,
    });
  });

  it("names the platform package it looked for when none resolves for this platform and architecture", async () => {
    const root = join(tmp, "npm", "node_modules");
    const typescriptDir = join(root, "typescript");
    const tried = join(typescriptDir, "node_modules", "@typescript", "typescript-win32-x64");
    const host = fakeHost({
      answers: { npm: ran(`${root}\n`) },
      present: [root],
      manifests: { [join(typescriptDir, "package.json")]: { name: "typescript", version: "7.0.2" } },
    });

    await expect(resolveTsgoBinary(host.deps)).resolves.toEqual({
      unavailable: missText(
        `the typescript package at "${typescriptDir}" has no native package for win32-x64 at "${tried}", ` +
          "or in any node_modules above it",
      ),
      attempted: tried,
    });
  });
});
