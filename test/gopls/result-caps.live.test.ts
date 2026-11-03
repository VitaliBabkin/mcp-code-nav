import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { runGoFindCallers, type FindCallersPayload } from "../../src/tools/go-find-callers.js";
import { runGoFindImplementations } from "../../src/tools/go-find-implementations.js";
import {
  runGoFindReferences,
  type FindReferencesPayload,
} from "../../src/tools/go-find-references.js";
import {
  CALL_BUDGET_MS,
  disposeGoLiveManagers,
  freshManager,
  itIfGoplsAvailable,
  payloadOf,
  removeTree,
} from "../helpers/go-live.js";

/**
 * A server that stops a list answer at a ceiling of its own, without saying so, would hand this tool a short
 * list that reads as complete. Each fixture here is larger than any such ceiling a server is known to apply
 * (clangd's is 1000), so the tool-level totals are exact only if gopls returns every row.
 */
const DISTINCT_CALLERS = 1100;
const BURST_CALLS = 1100;
const IMPLEMENTERS = 1100;

const header = "package caps\n\n";
const CALLEES_GO = `${header}func Tick() {}\n\nfunc Burst() {}\n`;
const callersGo = (): string => {
  const distinct = Array.from(
    { length: DISTINCT_CALLERS },
    (_, i) => `func Caller${String(i)}() {\n\tTick()\n}\n`,
  );
  const burster = `func Burster() {\n${"\tBurst()\n".repeat(BURST_CALLS)}}\n`;
  return `${header}${[...distinct, burster].join("\n")}`;
};
const DOER_GO = `${header}type Doer interface {\n\tDo()\n}\n`;
const implementersGo = (): string => {
  const types = Array.from(
    { length: IMPLEMENTERS },
    (_, i) => `type Impl${String(i)} struct{}\n\nfunc (Impl${String(i)}) Do() {}\n`,
  );
  return `${header}${types.join("\n")}`;
};

/** The two fields the count is read from; the payload type itself is not exported. */
interface ImplementationsAnswer {
  readonly implementations: readonly unknown[];
  readonly truncated: number;
}

describe("go tools on a symbol with more rows than a server-side ceiling", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-go-caps-live-"));
    writeFileSync(join(tmp, "go.mod"), "module example.com/caps\n\ngo 1.21\n");
    writeFileSync(join(tmp, "callees.go"), CALLEES_GO);
    writeFileSync(join(tmp, "callers.go"), callersGo());
    writeFileSync(join(tmp, "doer.go"), DOER_GO);
    writeFileSync(join(tmp, "impls.go"), implementersGo());
  });

  afterAll(async () => {
    disposeGoLiveManagers();
    await removeTree(tmp);
  });

  const question = (file: string, symbol: string) => ({
    sourceRoots: [tmp],
    file: join(tmp, file),
    symbol,
    includeDeclaration: false,
    timeBudgetMs: CALL_BUDGET_MS,
  });

  itIfGoplsAvailable(
    "go_find_references counts every use of a function called from many callers and of one called in a burst",
    async () => {
      for (const symbol of ["Tick", "Burst"]) {
        const result = await runGoFindReferences(freshManager(), question("callees.go", symbol));
        const payload = payloadOf<FindReferencesPayload>(result, "go_find_references");
        expect(payload.totalReferences, symbol).toBe(1100);
        const perFile = payload.files.reduce((sum, file) => sum + file.count, 0);
        expect(perFile, symbol).toBe(1100);
      }
    },
    CALL_BUDGET_MS * 2,
  );

  itIfGoplsAvailable(
    "go_find_callers counts every distinct caller of one function",
    async () => {
      const result = await runGoFindCallers(freshManager(), question("callees.go", "Tick"));
      const payload = payloadOf<FindCallersPayload>(result, "go_find_callers");
      expect(payload.totalCallers).toBe(DISTINCT_CALLERS);
    },
    CALL_BUDGET_MS * 2,
  );

  itIfGoplsAvailable(
    "go_find_callers counts every call site of one caller",
    async () => {
      const result = await runGoFindCallers(freshManager(), question("callees.go", "Burst"));
      const payload = payloadOf<FindCallersPayload>(result, "go_find_callers");
      expect(payload.totalCallers).toBe(1);
      const [row] = payload.callers;
      expect((row?.callSites.length ?? 0) + (row?.callSitesTruncated ?? 0)).toBe(BURST_CALLS);
    },
    CALL_BUDGET_MS * 2,
  );

  itIfGoplsAvailable(
    "go_find_implementations counts every type satisfying one interface",
    async () => {
      const result = await runGoFindImplementations(freshManager(), question("doer.go", "Doer"));
      const payload = payloadOf<ImplementationsAnswer>(result, "go_find_implementations");
      expect(payload.implementations.length + payload.truncated).toBe(IMPLEMENTERS);
    },
    CALL_BUDGET_MS * 2,
  );
});
