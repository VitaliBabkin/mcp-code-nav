import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultTsExec, resolveTsgoBinary, withoutNpmPrefix, type TsgoBinary } from "../../src/tsgo/binary.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runTsFileSymbols } from "../../src/tools/ts-file-symbols.js";
import {
  CALL_BUDGET_MS,
  itIfTsgoAvailable,
  requireTsgo,
  textOf,
  tsFixtureRoot,
  tsgoAvailable,
  tsgoMiss,
} from "../helpers/tsgo-live.js";

/**
 * Where the native server actually is on this host, located by the documented rule and by no
 * test-side copy of it: the override wins, and otherwise the global `typescript` package is read the way its
 * own launcher reads it. The mocked suite injects every one of these seams, so this is the only place the rule
 * meets a real `npm` and a real install.
 */

const OVERRIDE_NAME = "MCP_CODE_NAV_TSGO";
const storageFile = join(tsFixtureRoot, "src", "storage.ts");
const savedOverride = process.env[OVERRIDE_NAME];

afterEach(() => {
  if (savedOverride === undefined) delete process.env[OVERRIDE_NAME];
  else process.env[OVERRIDE_NAME] = savedOverride;
});

function withoutOverride(): void {
  delete process.env[OVERRIDE_NAME];
}

function requireLocated(located: Awaited<ReturnType<typeof resolveTsgoBinary>>): TsgoBinary {
  if ("unavailable" in located) throw new Error(located.unavailable);
  return located.binary;
}

describe("resolveTsgoBinary against this host", () => {
  // A skipped tsgo suite reads as a pass. When the host does have a global TypeScript 7, the suite skipping means
  // the resolver missed it — as it did when a launcher's `npm --prefix` redirected `npm root -g` — so that is a
  // failure here rather than a silent skip everywhere else.
  it("is not skipping the tsgo suites on a host that has a global typescript@7", async () => {
    const root = (await defaultTsExec("npm", ["root", "-g"], process.cwd(), withoutNpmPrefix(process.env))).stdout.trim();
    const manifestPath = join(root, "typescript", "package.json");
    if (root === "" || !existsSync(manifestPath)) return;
    const version: unknown = (JSON.parse(readFileSync(manifestPath, "utf-8")) as { version?: unknown }).version;
    if (typeof version !== "string" || Number(version.split(".")[0]) < 7) return;

    expect(tsgoAvailable, `a global typescript@${version} is installed at ${root}, but: ${tsgoMiss}`).toBe(true);
  }, CALL_BUDGET_MS);

  itIfTsgoAvailable("finds the global 7 native server by the installed-package rule, with no override set", async () => {
    withoutOverride();
    const started = Date.now();
    const binary = requireLocated(await resolveTsgoBinary());
    const ms = Date.now() - started;

    expect(binary.source).toBe("global");
    expect(isAbsolute(binary.executable)).toBe(true);
    expect(existsSync(binary.executable)).toBe(true);
    expect(binary.version.split(".")[0]).toBe("7");
    // The one location cost every later TS call avoids by being cached for the process.
    console.info(`located in ${ms} ms: ${binary.executable} version ${binary.version}`);
  }, CALL_BUDGET_MS);

  itIfTsgoAvailable("the override wins over the global search, naming the executable it was given", async () => {
    const located = requireTsgo();
    process.env[OVERRIDE_NAME] = located.executable;

    const binary = requireLocated(await resolveTsgoBinary());

    expect(binary.source).toBe("override");
    expect(binary.executable).toBe(located.executable);
    // The version a located executable states for itself, which is what `--version` and the package beside it
    // are two ways of reading the same fact.
    const stated = await defaultTsExec(located.executable, ["--version"], tsFixtureRoot);
    console.info(`--version printed: ${JSON.stringify(stated.stdout.trim())} exit ${stated.exitCode}`);
    expect(stated.stdout).toContain(binary.version);
  }, CALL_BUDGET_MS);

  it("refuses an override that names no executable, in the sentence a failed spawn would have carried", async () => {
    const missing = join(tsFixtureRoot, "no-such-tsc.exe");
    process.env[OVERRIDE_NAME] = missing;

    const located = await resolveTsgoBinary();

    if (!("unavailable" in located)) throw new Error(`"${missing}" was located as ${JSON.stringify(located.binary)}`);
    expect(located.attempted).toBe(missing);
    expect(located.unavailable).toContain(`${OVERRIDE_NAME}="${missing}"`);
    expect(located.unavailable).toContain("was not found (ENOENT)");
    expect(located.unavailable).toContain("npm install -g typescript@7");
    console.info(located.unavailable);
  });

  it("reaches ts_file_symbols as that same refusal, before any file is opened", async () => {
    const missing = join(tsFixtureRoot, "no-such-tsc.exe");
    process.env[OVERRIDE_NAME] = missing;
    const manager = new LspSessionManager();
    try {
      const out = await runTsFileSymbols(
        manager,
        { sourceRoots: [tsFixtureRoot], file: storageFile, depth: 1, timeBudgetMs: CALL_BUDGET_MS },
        { resolveBinary: () => resolveTsgoBinary() },
      );

      expect(out.isError).toBe(true);
      const text = textOf(out);
      expect(text).toContain(`${OVERRIDE_NAME}="${missing}" was not found (ENOENT)`);
      expect(text).toContain("install TypeScript 7 with npm install -g typescript@7");
    } finally {
      manager.disposeAll();
    }
  });
});
