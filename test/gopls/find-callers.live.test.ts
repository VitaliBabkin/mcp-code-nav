import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect } from "vitest";
import type { LspSessionManager } from "../../src/lsp/session-manager.js";
import {
  runGoFindCallers,
  type CallerRow,
  type FindCallersPayload,
} from "../../src/tools/go-find-callers.js";
import {
  CALL_BUDGET_MS,
  disposeGoLiveManagers,
  freshManager,
  hiddenFile,
  itIfGoplsAvailable,
  navRoot,
  payloadOf as okPayloadOf,
  removeTree,
  samePath,
  storageFile,
  subFile,
  textOf,
  usesFile,
} from "../helpers/go-live.js";

type Result = Awaited<ReturnType<typeof runGoFindCallers>>;
type Payload = FindCallersPayload;

/** The boundary a method subject carries over this fixture: exported, nothing filename-excluded, uncapped. */
const METHOD_LIMITS = [
  "one-module",
  "one-port",
  "exported-symbol-importers-invisible",
  "corresponding-interface-methods-included",
  "indirect-dispatch-not-resolved",
];

function ask(manager: LspSessionManager, roots: string[], file: string, symbol: string): Promise<Result> {
  return runGoFindCallers(manager, { sourceRoots: roots, file, symbol, timeBudgetMs: CALL_BUDGET_MS });
}

function payloadOf(result: Result): Payload {
  return okPayloadOf(result, "go_find_callers");
}

/** Caller names sorted: the tool's own order is in-module-first, which is not what these cases compare. */
function callerNames(payload: Payload): string[] {
  return payload.callers.map((row) => String(row.name)).sort();
}

function rowNamed(payload: Payload, name: string): CallerRow | undefined {
  return payload.callers.find((row) => row.name === name);
}

afterEach(disposeGoLiveManagers);

/**
 * Live-binary suite for the `go_find_callers` against a real `gopls` (excluded from `npm test`,
 * run via `npm run test:live`; see CONTRIBUTING.md). The facts only a live run
 * supplies: that gopls computes incoming calls from its reference relation, so a method's callers include
 * the call site that reaches it through the interface method it satisfies — which may serve another
 * implementation at run time — and no sibling implementation's caller; that a call-hierarchy item names a
 * method with the bare member name and a function kind, which is why rows are named from the outline
 * instead; and that a long-lived gopls corrects its answer once the client pushes a new caller.
 */
describe("go_find_callers against a real gopls binary", () => {
  itIfGoplsAvailable(
    "reports the direct call and the interface dispatch alike, and states that the list over-reports",
    async () => {
      const payload = payloadOf(await ask(freshManager(), [navRoot], storageFile, "(*Memory).Read"));

      expect(payload.resolved).toMatchObject({ name: "(*Memory).Read", kind: "method" });
      expect(samePath(payload.scope.moduleRoot, resolve(navRoot))).toBe(true);
      expect(callerNames(payload)).toEqual(["Fetch", "Serve"]);
      expect(payload.totalCallers).toBe(2);
      expect(payload.callersTruncated).toBe(0);
      for (const name of ["Fetch", "Serve"] as const) {
        const row = rowNamed(payload, name);
        expect(row, `no caller named ${name}`).toMatchObject({ external: false, kind: "function" });
        expect(row?.callSites).toHaveLength(1);
      }
      expect(rowNamed(payload, "Fetch")?.callSites[0]?.line).toBe(13);
      expect(rowNamed(payload, "Serve")?.callSites[0]?.line).toBe(8);
      expect(payload.scope.limits).toEqual(METHOD_LIMITS);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "names every caller the way its own declaration is spelled, not as the item spelled it",
    async () => {
      // gopls hands back `{name: "Read", kind: function}` for a method caller; the row must read the way
      // `go_find_callers`'s own `symbol` input would name that declaration.
      const payload = payloadOf(await ask(freshManager(), [navRoot], storageFile, "normaliseKey"));

      expect(callerNames(payload)).toEqual(["(*Memory).Read", "(*Store).Get", "Trim"]);
      expect(payload.totalCallers).toBe(3);
      expect(rowNamed(payload, "(*Memory).Read")?.kind).toBe("method");
      expect(rowNamed(payload, "(*Store).Get")?.kind).toBe("method");
      expect(rowNamed(payload, "Trim")?.kind).toBe("function");
      expect(payload.callers.every((row) => !row.external && row.name !== null)).toBe(true);
      expect(payload.callers.every((row) => row.callSites.length > 0)).toBe(true);
      // A function subject: no correspondence code, and `normaliseKey` is package-private.
      expect(payload.scope.limits).toEqual([
        "one-module",
        "one-port",
        "indirect-dispatch-not-resolved",
      ]);
    },
    600_000,
  );

  itIfGoplsAvailable("carries the dispatch code but not the correspondence code for a function", async () => {
    const payload = payloadOf(await ask(freshManager(), [navRoot], usesFile, "Trim"));

    expect(payload.resolved).toMatchObject({ name: "Trim", kind: "function" });
    expect(payload.scope.visibility).toBe("exported");
    expect(payload.scope.limits).toContain("exported-symbol-importers-invisible");
    expect(payload.scope.limits).toContain("indirect-dispatch-not-resolved");
    expect(payload.scope.limits).not.toContain("corresponding-interface-methods-included");
  }, 600_000);

  itIfGoplsAvailable("answers a function nobody calls with a scoped empty, not with a failure", async () => {
    const result = await ask(freshManager(), [navRoot], storageFile, "loneHelper");
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(textOf(result)).not.toMatch(/initial workspace load/);

    const payload = result.structuredContent as Payload;
    expect(payload.totalCallers).toBe(0);
    expect(payload.callers).toEqual([]);
    expect(payload.callersTruncated).toBe(0);
    expect(payload.scope.limits).toEqual(["one-module", "one-port", "indirect-dispatch-not-resolved"]);
  }, 600_000);

  itIfGoplsAvailable("refuses a kind that is never called, naming it with the right article", async () => {
    const manager = freshManager();

    const struct = await ask(manager, [navRoot], usesFile, "Store");
    expect(struct.isError).toBe(true);
    expect(textOf(struct)).toContain("is a struct");
    expect(textOf(struct)).toMatch(/only a function or a method has callers/);

    const iface = await ask(manager, [navRoot], storageFile, "Reader");
    expect(iface.isError).toBe(true);
    expect(textOf(iface)).toContain("is an interface");
  }, 600_000);

  itIfGoplsAvailable(
    "corrects one warm session when a caller appears on disk, and says so in scope.freshness",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-gocall-"));
      const mod = join(tmp, "go-navigation");
      cpSync(navRoot, mod, { recursive: true });
      const file = join(mod, "storage.go");
      const manager = freshManager();
      try {
        const before = payloadOf(await ask(manager, [mod], file, "(*Memory).Read"));
        expect(callerNames(before)).toEqual(["Fetch", "Serve"]);
        expect(before.totalCallers).toBe(2);
        expect(before.scope.freshness.kind).toBe("unchanged");

        writeFileSync(
          join(mod, "extra.go"),
          [
            "package gonav",
            "",
            "// ExtraCaller is written after the session loaded the package.",
            "func ExtraCaller(m *Memory) error {",
            "\t_, err := m.Read(\"late\")",
            "\treturn err",
            "}",
            "",
          ].join("\n"),
        );
        const after = payloadOf(await ask(manager, [mod], file, "(*Memory).Read"));
        expect(callerNames(after)).toEqual(["ExtraCaller", "Fetch", "Serve"]);
        expect(after.totalCallers).toBe(3);
        expect(after.scope.freshness).toMatchObject({ kind: "pushed", changedFiles: 1 });
        expect(samePath(rowNamed(after, "ExtraCaller")?.file, join(mod, "extra.go"))).toBe(true);
      } finally {
        manager.disposeAll();
        await removeTree(tmp);
      }
    },
    900_000,
  );

  itIfGoplsAvailable("does not reach a sibling implementation of the interface", async () => {
    // `FetchDisk` calls `(*Disk).Read`, a sibling implementation of the same interface. gopls's
    // correspondence covers the interface method the subject satisfies and stops there, so the answer is
    // still the two call sites that name `Read` through `Reader` or through `(*Memory).Read` itself.
    const payload = payloadOf(await ask(freshManager(), [navRoot], storageFile, "(*Memory).Read"));

    expect(callerNames(payload)).toEqual(["Fetch", "Serve"]);
    expect(callerNames(payload)).not.toContain("FetchDisk");
    expect(payload.totalCallers).toBe(2);
    expect(payload.scope.limits).toContain("corresponding-interface-methods-included");
  }, 600_000);

  itIfGoplsAvailable("reports a cross-package caller of an exported method on an unexported type", async () => {
    // `sub.Ping` calls it through a value `gonav.NewHidden` returned, so the static call edge exists in
    // another package even though nothing outside `gonav` can name the receiver's type.
    const payload = payloadOf(await ask(freshManager(), [navRoot], hiddenFile, "(*hidden).Ping"));

    expect(callerNames(payload)).toEqual(["Ping"]);
    expect(payload.totalCallers).toBe(1);
    const row = rowNamed(payload, "Ping");
    expect(samePath(row?.file, subFile)).toBe(true);
    expect(row).toMatchObject({ external: false, kind: "function" });
    expect(row?.callSites).toHaveLength(1);
    expect(payload.scope.visibility).toBe("exported");
    expect(payload.scope.limits).toEqual(METHOD_LIMITS);
  }, 600_000);

  itIfGoplsAvailable("keeps an unexported method's callers inside its package", async () => {
    const payload = payloadOf(await ask(freshManager(), [navRoot], hiddenFile, "(*hidden).ping"));

    expect(callerNames(payload)).toEqual(["pingTwice"]);
    expect(payload.scope.visibility).toBe("package-private");
    expect(payload.scope.limits).toEqual([
      "one-module",
      "one-port",
      "corresponding-interface-methods-included",
      "indirect-dispatch-not-resolved",
    ]);
    expect(rowNamed(payload, "pingTwice")).toMatchObject({ external: false });
    expect(samePath(rowNamed(payload, "pingTwice")?.file, hiddenFile)).toBe(true);
  }, 600_000);
});
