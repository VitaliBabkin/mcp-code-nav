import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect } from "vitest";
import type { LspSessionManager } from "../../src/lsp/session-manager.js";
import {
  runGoFindReferences,
  type FindReferencesPayload,
  type ReferenceFile,
} from "../../src/tools/go-find-references.js";
import {
  CALL_BUDGET_MS,
  disposeGoLiveManagers,
  freshManager,
  genericFile,
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

type Result = Awaited<ReturnType<typeof runGoFindReferences>>;
type Payload = FindReferencesPayload;

function ask(
  manager: LspSessionManager,
  roots: string[],
  file: string,
  symbol: string,
  includeDeclaration = false,
): Promise<Result> {
  return runGoFindReferences(
    manager,
    { sourceRoots: roots, file, symbol, includeDeclaration, timeBudgetMs: CALL_BUDGET_MS },
  );
}

function payloadOf(result: Result): Payload {
  return okPayloadOf(result, "go_find_references");
}

function groupNamed(payload: Payload, path: string): ReferenceFile | undefined {
  return payload.files.find((group) => samePath(group.file, path));
}

/** Every named site of every group, as `file:in` pairs. */
function namedSites(payload: Payload): string[] {
  return payload.files.flatMap((group) =>
    group.sites.map((site) => `${basename(group.file)}:${site.in ?? "<unnamed>"}`),
  );
}

afterEach(disposeGoLiveManagers);

/**
 * Live-binary suite for the `go_find_references` against a real `gopls` (excluded from `npm test`,
 * run via `npm run test:live`; see CONTRIBUTING.md). It exists for the facts no mock
 * can supply: that gopls's `references` answers for the identifier rather than the text, that the
 * package-private case really is complete for a loaded module, that a use inside a method is named by the
 * transient outline fan-out, and that a long-lived gopls corrects its answer once the client pushes the
 * change. Fixtures live under `test/fixtures/go-navigation`; the module a test mutates is copied first.
 */
describe("go_find_references against a real gopls binary", () => {
  itIfGoplsAvailable(
    "answers every use of a package-private helper from two files, and calls itself complete",
    async () => {
      // `normaliseKey` is used in `Memory.Read`, in `Trim` and in `Store.Get`: three uses, two files.
      const payload = payloadOf(await ask(freshManager(), [navRoot], storageFile, "normaliseKey"));

      expect(payload.resolved).toMatchObject({ name: "normaliseKey", kind: "function" });
      expect(payload.totalReferences).toBe(3);
      expect(payload.files).toHaveLength(2);
      expect(payload.filesTruncated).toBe(0);
      expect(groupNamed(payload, storageFile)).toMatchObject({ external: false, count: 1 });
      expect(groupNamed(payload, usesFile)).toMatchObject({ external: false, count: 2 });
      // Naming happened for every site, so nothing in the answer is an unnamed placeholder.
      expect(namedSites(payload).filter((site) => site.endsWith(":<unnamed>"))).toEqual([]);
      expect(namedSites(payload).some((site) => /storage\.go:.*Memory.*Read/.test(site))).toBe(true);
      expect(namedSites(payload).some((site) => /uses\.go:.*Trim/.test(site))).toBe(true);

      // The promise: for a package-private identifier there is no invisible importer.
      expect(payload.scope.visibility).toBe("package-private");
      expect(samePath(payload.scope.moduleRoot, resolve(navRoot))).toBe(true);
      expect(payload.scope.limits).toEqual(["one-module", "one-port"]);
    },
    600_000,
  );

  itIfGoplsAvailable("marks an exported subject with the code for the importers it cannot see", async () => {
    const payload = payloadOf(await ask(freshManager(), [navRoot], storageFile, "Reader"));

    expect(payload.resolved.kind).toBe("interface");
    expect(payload.scope.visibility).toBe("exported");
    expect(payload.scope.limits).toContain("exported-symbol-importers-invisible");
    expect(payload.totalReferences).toBeGreaterThanOrEqual(1);
    // `Serve`'s parameter is the only in-module use, so the listing is nowhere near a cap.
    expect(payload.filesTruncated).toBe(0);
    expect(payload.files.flatMap((group) => group.sites).every((site) => site.in !== null)).toBe(true);
  }, 600_000);

  itIfGoplsAvailable(
    "answers a helper nobody uses with a scoped empty, which is what proves readiness was observed",
    async () => {
      // A fresh session, because the claim under test is that the FIRST type-aware call can prove the
      // initial load: without the readiness wiring this call would fail at its budget instead of answering.
      const result = await ask(freshManager(), [navRoot], storageFile, "loneHelper");
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(textOf(result)).not.toMatch(/initial workspace load/);

      const payload = result.structuredContent as Payload;
      expect(payload.totalReferences).toBe(0);
      expect(payload.files).toEqual([]);
      expect(payload.filesTruncated).toBe(0);
      expect(payload.scope.visibility).toBe("package-private");
      expect(payload.scope.limits).toEqual(["one-module", "one-port"]);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "counts the declaration itself only when includeDeclaration asks for it, on one warm session",
    async () => {
      const manager = freshManager();

      const uses = payloadOf(await ask(manager, [navRoot], storageFile, "normaliseKey"));
      const withDeclaration = payloadOf(
        await ask(manager, [navRoot], storageFile, "normaliseKey", true),
      );

      expect(uses.totalReferences).toBe(3);
      expect(withDeclaration.totalReferences).toBe(4);
      const declared = groupNamed(withDeclaration, storageFile);
      expect(declared?.count).toBe(2);
      // The declaration row is the one whose site is the helper's own name.
      expect(declared?.sites.some((site) => site.in === "normaliseKey")).toBe(true);
      expect(uses.files.flatMap((group) => group.sites).some((site) => site.in === "normaliseKey")).toBe(false);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "corrects one warm session when a use appears on disk, and says so in scope.freshness",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-goref-"));
      const mod = join(tmp, "go-navigation");
      cpSync(navRoot, mod, { recursive: true });
      const file = join(mod, "storage.go");
      const manager = freshManager();
      try {
        const before = payloadOf(await ask(manager, [mod], file, "normaliseKey"));
        expect(before.totalReferences).toBe(3);
        expect(before.files).toHaveLength(2);
        expect(before.scope.freshness.kind).toBe("unchanged");

        writeFileSync(
          join(mod, "extra.go"),
          [
            "package gonav",
            "",
            "// ExtraUse is written after the session loaded the package.",
            "func ExtraUse(key string) string {",
            "\treturn normaliseKey(key)",
            "}",
            "",
          ].join("\n"),
        );
        const after = payloadOf(await ask(manager, [mod], file, "normaliseKey"));
        expect(after.totalReferences).toBe(4);
        expect(after.files).toHaveLength(3);
        expect(after.scope.freshness).toMatchObject({ kind: "pushed", changedFiles: 1 });
        // The new file is not only counted, it is named: the fan-out read the file it had never opened.
        expect(namedSites(after).some((site) => /extra\.go:ExtraUse/.test(site))).toBe(true);
        expect(after.scope.visibility).toBe("package-private");
      } finally {
        manager.disposeAll();
        await removeTree(tmp);
      }
    },
    900_000,
  );

  itIfGoplsAvailable(
    "lists the interface use among a method's references, and states that the listing over-reports",
    async () => {
      // `Serve`'s use at `uses.go:8` goes through a `Reader` value, and gopls's reference relation still
      // links it to `(*Memory).Read` — the same relation the call hierarchy answers from.
      const payload = payloadOf(await ask(freshManager(), [navRoot], storageFile, "(*Memory).Read"));

      expect(payload.resolved).toMatchObject({ name: "(*Memory).Read", kind: "method" });
      expect(groupNamed(payload, usesFile)?.sites.some((site) => site.line === 8)).toBe(true);
      expect(payload.scope.limits).toContain("corresponding-interface-methods-included");
      expect(payload.scope.limits).not.toContain("indirect-dispatch-not-resolved");
    },
    600_000,
  );

  itIfGoplsAvailable(
    "addresses a method whose receiver carries two type parameters",
    async () => {
      // The pointer spelling is the one gopls's outline reports for `func (c *Cache[K, V]) Get`, and
      // `Cache.Get` is the spelling the tool's own input promises to accept: both must land on one
      // declaration, and `Index.Get` must stay a different one. If the reported spelling is wrong, the
      // failure names what gopls actually answered.
      const manager = freshManager();

      const pointer = payloadOf(await ask(manager, [navRoot], genericFile, "(*Cache[K, V]).Get"));
      expect(pointer.resolved.kind).toBe("method");
      expect(pointer.resolved.name).toMatch(/Cache\[K,\s*V\]\)\.Get$/);
      expect(pointer.totalReferences).toBe(1);
      const group = groupNamed(pointer, genericFile);
      expect(group?.sites).toHaveLength(1);
      expect(group?.sites[0]?.in).toBe("LoadValue");

      const promised = payloadOf(await ask(manager, [navRoot], genericFile, "Cache.Get"));
      expect(promised.resolved).toEqual(pointer.resolved);

      const other = payloadOf(await ask(manager, [navRoot], genericFile, "Index.Get"));
      expect(other.resolved.name).toMatch(/Index\[K,\s*V\]\)\.Get$/);
      // Index.Get is never called: a generic subject with no uses is still a proven scoped empty, which is
      // what `payloadOf` above has already asserted by rejecting nothing.
      expect(other.totalReferences).toBe(0);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "counts an exported method of an unexported type as exported, with its cross-package use",
    async () => {
      const payload = payloadOf(await ask(freshManager(), [navRoot], hiddenFile, "(*hidden).Ping"));

      expect(payload.resolved.kind).toBe("method");
      expect(payload.scope.visibility).toBe("exported");
      expect(payload.scope.limits).toContain("exported-symbol-importers-invisible");
      // The executable proof that an exported method of an unexported type is reachable: a use of that
      // identifier written in another package, inside the same module.
      expect(groupNamed(payload, subFile)).toBeDefined();
      expect(payload.files.every((group) => !group.external)).toBe(true);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "answers an unexported method as package-private, with no use outside its package",
    async () => {
      const payload = payloadOf(await ask(freshManager(), [navRoot], hiddenFile, "(*hidden).ping"));

      expect(payload.scope.visibility).toBe("package-private");
      expect(payload.scope.limits).toEqual([
        "one-module",
        "one-port",
        "corresponding-interface-methods-included",
      ]);
      expect(namedSites(payload).some((site) => site.endsWith(":pingTwice"))).toBe(true);
      expect(groupNamed(payload, subFile)).toBeUndefined();
    },
    600_000,
  );

  itIfGoplsAvailable(
    "answers an unexported method of an exported type with no site in the embedding package",
    async () => {
      // `sub.Wrapped` satisfies `gonav.sealed` through this method and never names it, so the sealed
      // pattern adds no occurrence of the identifier: the mirror case, decided by the answer.
      const payload = payloadOf(await ask(freshManager(), [navRoot], hiddenFile, "(*Gauge).sample"));

      expect(payload.scope.visibility).toBe("package-private");
      expect(payload.scope.limits).not.toContain("exported-symbol-importers-invisible");
      expect(groupNamed(payload, subFile)).toBeUndefined();
      // The one selector that names `sample`: the interface's own method is not a use of this declaration.
      expect(payload.totalReferences).toBe(1);
      expect(groupNamed(payload, hiddenFile)?.sites.map((site) => site.line)).toEqual([26]);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "addresses an unexported generic receiver by its base type, both spellings one declaration",
    async () => {
      const manager = freshManager();

      const byBase = payloadOf(await ask(manager, [navRoot], hiddenFile, "cache.Load"));
      expect(byBase.resolved.kind).toBe("method");
      expect(byBase.scope.visibility).toBe("exported");

      const byName = payloadOf(await ask(manager, [navRoot], hiddenFile, byBase.resolved.name));
      expect(byName.resolved).toEqual(byBase.resolved);
    },
    600_000,
  );
});
