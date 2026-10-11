// The scaffolding the live Go suites share: the optional-binary gate, the fixture module, the session
// managers a run leaves behind, and the result accessors.

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";

/** A live result, as far as these accessors care. */
export interface LiveResult {
  readonly content: readonly { readonly text?: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** gopls is optional on this host in exactly the way clangd is, so the suite skips rather than failing
 *  with the symptom it is meant to detect. `MCP_CODE_NAV_GOPLS` overrides, as it does at runtime. */
function isGoplsAvailable(): boolean {
  try {
    execFileSync(process.env.MCP_CODE_NAV_GOPLS ?? "gopls", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const itIfGoplsAvailable = isGoplsAvailable() ? it : it.skip;

export const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const navRoot = join(fixtures, "go-navigation");
export const storageFile = join(navRoot, "storage.go");
export const usesFile = join(navRoot, "uses.go");
export const genericFile = join(navRoot, "generic.go");
export const hiddenFile = join(navRoot, "hidden.go");
export const subFile = join(navRoot, "sub", "sub.go");

/** A gopls cold load on a module that pulls in `fmt`/`strings` is measured in tens of seconds. */
export const CALL_BUDGET_MS = 240_000;

const managers: LspSessionManager[] = [];

/** No wiring: `goplsConfig` names the module walk that proves its package graph, exactly as in
 *  `src/index.ts`. */
export function freshManager(): LspSessionManager {
  const manager = new LspSessionManager();
  managers.push(manager);
  return manager;
}

/** Disposes every manager the live suites made; each file calls this from its own `afterEach`. */
export function disposeGoLiveManagers(): void {
  while (managers.length > 0) managers.pop()?.disposeAll();
}

/** Paths as gopls spelled them after `fileURLToPath`, compared on the footing the OS compares them. */
export function samePath(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const normalise = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  return normalise(a) === normalise(b);
}

export function textOf(result: LiveResult): string {
  return result.content[0]?.text ?? "";
}

/** The structured answer, with the failure text named after `tool` if there is one. */
export function payloadOf<T>(result: LiveResult, tool: string): T {
  expect(result.isError, `${tool} failed: ${textOf(result)}`).toBeFalsy();
  return result.structuredContent as T;
}

/** `child.kill()` does not wait for the exit, and on Windows the module root is gopls's working
 *  directory, so the OS keeps the handle locked briefly after `disposeAll()`. */
export async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= 9) throw e;
      await new Promise((done) => setTimeout(done, 300));
    }
  }
}
