// The scaffolding the live Go suites share: the optional-binary gate, the fixture module, the session
// managers a run leaves behind, and the result accessors.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";

/** gopls is optional on this host in exactly the way clangd is, so the suite skips rather than failing
 *  with the symptom it is meant to detect. `MCP_CODE_NAV_GOPLS` overrides, as it does at runtime. */
export function isGoplsAvailable(): boolean {
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

export { removeTree, samePath } from "./fixture-text.js";
