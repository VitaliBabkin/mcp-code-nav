import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runTsFindCallers, type TsFindCallersPayload } from "../../src/tools/ts-find-callers.js";
import {
  runTsFindImplementations,
  type TsFindImplementationsPayload,
} from "../../src/tools/ts-find-implementations.js";
import {
  runTsFindReferences,
  type TsFindReferencesPayload,
} from "../../src/tools/ts-find-references.js";
import { removeTree } from "../helpers/go-live.js";
import { CALL_BUDGET_MS, itIfTsgoAvailable, payloadOf } from "../helpers/tsgo-live.js";

/**
 * A server that stops a list answer at a ceiling of its own, without saying so, would hand this tool a short
 * list that reads as complete. Each fixture here is larger than any such ceiling a server is known to apply
 * (clangd's is 1000), so the tool-level totals are exact only if tsgo returns every row.
 */
const DISTINCT_CALLERS = 1100;
const BURST_CALLS = 1100;
const IMPLEMENTERS = 1100;

const PACKAGE_JSON = JSON.stringify({
  name: "fixture-ts-result-caps",
  version: "0.0.0",
  private: true,
});
const TSCONFIG_JSON = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    noEmit: true,
  },
  include: ["src"],
});
const CALLEES_TS = "export function tick(): void {}\n\nexport function burst(): void {}\n";
const callersTs = (): string => {
  const distinct = Array.from(
    { length: DISTINCT_CALLERS },
    (_, i) => `export function caller${String(i)}(): void {\n  tick();\n}\n`,
  );
  const burster = `export function burster(): void {\n${"  burst();\n".repeat(BURST_CALLS)}}\n`;
  return `import { burst, tick } from "./callees.js";\n\n${[...distinct, burster].join("\n")}`;
};
const HANDLER_TS = "export interface Handler {\n  handle(): void;\n}\n";
const implementersTs = (): string => {
  const classes = Array.from(
    { length: IMPLEMENTERS },
    (_, i) => `export class Impl${String(i)} implements Handler {\n  handle(): void {}\n}\n`,
  );
  return `import type { Handler } from "./handler.js";\n\n${classes.join("\n")}`;
};

describe("ts tools on a symbol with more rows than a server-side ceiling", () => {
  let tmp: string;
  const managers: LspSessionManager[] = [];

  const freshManager = (): LspSessionManager => {
    const manager = new LspSessionManager();
    managers.push(manager);
    return manager;
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-ts-caps-live-"));
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "package.json"), PACKAGE_JSON);
    writeFileSync(join(tmp, "tsconfig.json"), TSCONFIG_JSON);
    writeFileSync(join(tmp, "src", "callees.ts"), CALLEES_TS);
    writeFileSync(join(tmp, "src", "callers.ts"), callersTs());
    writeFileSync(join(tmp, "src", "handler.ts"), HANDLER_TS);
    writeFileSync(join(tmp, "src", "impls.ts"), implementersTs());
  });

  afterEach(() => {
    while (managers.length > 0) managers.pop()?.disposeAll();
  });

  afterAll(async () => {
    await removeTree(tmp);
  });

  const question = (file: string, symbol: string) => ({
    sourceRoots: [tmp],
    file: join(tmp, "src", file),
    symbol,
    includeDeclaration: false,
    timeBudgetMs: CALL_BUDGET_MS,
  });

  itIfTsgoAvailable(
    "ts_find_references counts every use of a function called from many callers and of one called in a burst",
    async () => {
      for (const symbol of ["tick", "burst"]) {
        const result = await runTsFindReferences(freshManager(), question("callees.ts", symbol));
        const payload = payloadOf<TsFindReferencesPayload>(result, "ts_find_references");
        // The import specifier in callers.ts is always listed beside the call sites.
        const importLines = 1;
        expect(payload.totalReferences, symbol).toBe(1100 + importLines);
        const perFile = payload.files.reduce((sum, file) => sum + file.count, 0);
        expect(perFile, symbol).toBe(1100 + importLines);
      }
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "ts_find_callers counts every distinct caller of one function",
    async () => {
      const result = await runTsFindCallers(freshManager(), question("callees.ts", "tick"));
      const payload = payloadOf<TsFindCallersPayload>(result, "ts_find_callers");
      expect(payload.totalCallers).toBe(DISTINCT_CALLERS);
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "ts_find_callers counts every call site of one caller",
    async () => {
      const result = await runTsFindCallers(freshManager(), question("callees.ts", "burst"));
      const payload = payloadOf<TsFindCallersPayload>(result, "ts_find_callers");
      expect(payload.totalCallers).toBe(1);
      const [row] = payload.callers;
      expect((row?.callSites.length ?? 0) + (row?.callSitesTruncated ?? 0)).toBe(BURST_CALLS);
    },
    CALL_BUDGET_MS * 2,
  );

  itIfTsgoAvailable(
    "ts_find_implementations counts every class implementing one interface",
    async () => {
      const result = await runTsFindImplementations(
        freshManager(),
        question("handler.ts", "Handler"),
      );
      const payload = payloadOf<TsFindImplementationsPayload>(result, "ts_find_implementations");
      expect(payload.implementations.length + payload.truncated).toBe(IMPLEMENTERS);
    },
    CALL_BUDGET_MS * 2,
  );
});
