import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runGoFindImplementations } from "../../src/tools/go-find-implementations.js";
import { IMPLEMENTATIONS_LIMIT } from "../../src/tools/navigation-limits.js";
import { removeFileNamingHolder } from "../helpers/remove-with-holder.js";

// gopls is optional on this host in exactly the way clangd is, so the suite skips rather than failing
// with the symptom it is meant to detect. `MCP_CODE_NAV_GOPLS` overrides, as it does at runtime.
function isGoplsAvailable(): boolean {
  try {
    execFileSync(process.env.MCP_CODE_NAV_GOPLS ?? "gopls", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const itIfGoplsAvailable = isGoplsAvailable() ? it : it.skip;

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const implRoot = join(fixtures, "go-implementations");
const implFile = join(implRoot, "storage.go");
const aliasFile = join(implRoot, "alias.go");
const reporterFile = join(implRoot, "reporter.go");
const siblingRoot = join(fixtures, "go-sibling-modules");
const freshnessFixture = join(fixtures, "go-freshness");
const workspaceRoot = join(fixtures, "go-workspace");

/** A gopls cold load on a module that pulls in `net/http` is measured in tens of seconds. */
const CALL_BUDGET_MS = 240_000;

type Result = Awaited<ReturnType<typeof runGoFindImplementations>>;

interface ImplRow {
  name: string | null;
  kind: string | null;
  file: string;
  line: number;
  external: boolean;
  reason?: string;
}

interface Environment {
  goos: string;
  goarch: string;
  cgoEnabled: boolean;
  buildTags: string[];
  goWork: string | null;
}

interface ExcludedFiles {
  count: number;
  files: string[];
  namedFileExcluded: boolean;
}

interface Payload {
  resolved: { name: string; kind: string; file: string; line: number };
  direction: string;
  implementations: ImplRow[];
  truncated: number;
  scope: {
    moduleRoot: string;
    freshness: { kind: string; changedFiles?: number; reason?: string };
    environment?: Environment;
    environmentUnavailable?: string;
    osArchExcluded?: ExcludedFiles;
    osArchExcludedUnavailable?: string;
  };
}

const managers: LspSessionManager[] = [];

function freshManager(): LspSessionManager {
  // No wiring: `goplsConfig` names the module walk that proves its package graph, exactly as in
  // `src/index.ts`.
  const manager = new LspSessionManager();
  managers.push(manager);
  return manager;
}

function ask(manager: LspSessionManager, roots: string[], file: string, symbol: string): Promise<Result> {
  return runGoFindImplementations(manager, { sourceRoots: roots, file, symbol, timeBudgetMs: CALL_BUDGET_MS });
}

function textOf(result: Result): string {
  return result.content[0]?.text ?? "";
}

function payloadOf(result: Result): Payload {
  expect(result.isError, `go_find_implementations failed: ${textOf(result)}`).toBeFalsy();
  return result.structuredContent as Payload;
}

/** Paths as gopls spelled them after `fileURLToPath`, compared on the footing the OS compares them. */
function samePath(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const normalise = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  return normalise(a) === normalise(b);
}

function namedRows(payload: Payload): string[] {
  return payload.implementations.map((row) => row.name).filter((name): name is string => name !== null).sort();
}

/** Whether a `files` list names `path`, compared the way the OS compares paths. */
function namesPath(files: readonly string[] | undefined, path: string): boolean {
  return (files ?? []).some((file) => samePath(file, path));
}

/** `child.kill()` does not wait for the exit, and on Windows the module root is gopls's working
 * directory, so the OS keeps the handle locked briefly after `disposeAll()`. */
async function removeTree(dir: string): Promise<void> {
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

afterEach(() => {
  while (managers.length > 0) managers.pop()?.disposeAll();
});

/**
 * Live-binary suite for the `go_find_implementations` against a real `gopls` (excluded from
 * `npm test`, run via `npm run test:live`; see CONTRIBUTING.md). It exists for the
 * facts no mock can supply: that interface satisfaction in Go is implicit and only the type checker sees
 * it, that a long-lived gopls is wrong in both directions about disk changes until the client pushes them,
 * that an out-of-module query returns a plausible partial rather than an empty, and that the
 * `window/workDoneProgress/create` subscription is what makes readiness provable at all.
 * Fixtures live under `test/fixtures/`; the module a test mutates is copied to a temp directory first.
 */
describe("go_find_implementations against a real gopls binary", () => {
  itIfGoplsAvailable(
    "returns the implementer that never names the interface, which no text search could find",
    async () => {
      const payload = payloadOf(await ask(freshManager(), [implRoot], implFile, "Storage"));

      expect(payload.direction).toBe("implementers-of-interface");
      expect(samePath(payload.scope.moduleRoot, resolve(implRoot))).toBe(true);
      const memory = payload.implementations.find((row) => row.name === "MemoryStorage");
      expect(memory, `expected MemoryStorage in: ${JSON.stringify(payload.implementations)}`).toMatchObject({
        kind: "struct",
        external: false,
      });
      expect(samePath(memory?.file, join(implRoot, "storage.go"))).toBe(true);
      expect(payload.truncated).toBe(0);

      // Whether that implementer is in the graph at all is a fact about the toolchain that answered, read
      // off this payload rather than assumed from the OS the test suite happens to run on.
      const environment = payload.scope.environment;
      expect(environment, `scope had no environment: ${JSON.stringify(payload.scope)}`).toBeDefined();
      const linuxFile = join(implRoot, "disk_linux.go");
      const excluded = payload.scope.osArchExcluded;
      expect(excluded, `scope had no exclusion set: ${JSON.stringify(payload.scope)}`).toBeDefined();
      if (environment?.goos === "linux" || environment?.goos === "android") {
        expect(namedRows(payload)).toContain("LinuxStorage");
        expect(namesPath(excluded?.files, linuxFile)).toBe(false);
      } else {
        expect(payload.implementations.filter((row) => row.file.includes("disk_linux"))).toEqual([]);
        expect(namedRows(payload)).not.toContain("LinuxStorage");
        // The blind spot is visible in the same payload that is narrowed by it.
        expect(namesPath(excluded?.files, linuxFile)).toBe(true);
        expect(excluded?.count).toBeGreaterThan(0);
        expect(excluded?.namedFileExcluded).toBe(false);
      }
    },
    300_000,
  );

  itIfGoplsAvailable(
    "reports the go.work it stands outside of, and answers for one module anyway",
    async () => {
      // `SiblingSink` satisfies `Storage` structurally without importing it, so a gopls that used the
      // workspace would report it — measured, and the reason `GOWORK=off` is set on the child.
      const file = join(workspaceRoot, "mod-a", "store.go");
      const payload = payloadOf(await ask(freshManager(), [workspaceRoot], file, "Storage"));

      expect(payload.direction).toBe("implementers-of-interface");
      expect(samePath(payload.scope.moduleRoot, join(workspaceRoot, "mod-a"))).toBe(true);
      const environment = payload.scope.environment;
      expect(environment, `scope had no environment: ${JSON.stringify(payload.scope)}`).toBeDefined();
      expect(samePath(environment?.goWork ?? "", join(workspaceRoot, "go.work"))).toBe(true);
      expect(payload.scope.osArchExcluded).toBeDefined();

      expect(namedRows(payload)).toEqual(expect.arrayContaining(["LocalSink"]));
      expect(namedRows(payload)).not.toContain("SiblingSink");
      expect(payload.implementations.filter((row) => row.file.includes("mod-b"))).toEqual([]);
      expect(payload.truncated).toBe(0);
    },
    300_000,
  );

  itIfGoplsAvailable(
    "answers a zero-implementer interface with a scoped empty, which is what proves readiness was observed",
    async () => {
      // A fresh session, because the claim under test is that the FIRST type-aware call can prove the
      // initial load: without the server-request handler gopls emits no `$/progress`, readiness is never
      // proven, and this call would fail at its budget instead of answering.
      const result = await ask(freshManager(), [implRoot], implFile, "Lone");
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(textOf(result)).not.toMatch(/initial workspace load/);

      const payload = result.structuredContent as Payload;
      expect(payload.direction).toBe("implementers-of-interface");
      expect(payload.implementations).toEqual([]);
      expect(payload.truncated).toBe(0);
    },
    300_000,
  );

  itIfGoplsAvailable(
    "answers the kind table: a direction for an interface and for a named type, a refusal for the rest",
    async () => {
      const manager = freshManager();

      const iface = payloadOf(await ask(manager, [implRoot], implFile, "Storage"));
      expect(iface.direction).toBe("implementers-of-interface");
      expect(iface.resolved.kind).toBe("interface");

      const named = payloadOf(await ask(manager, [implRoot], implFile, "MemoryStorage"));
      expect(named.direction).toBe("interfaces-implemented-by-type");
      expect(named.resolved.kind).toBe("struct");
      expect(named.implementations.map((row) => row.name)).toContain("Storage");

      const noDirection = await ask(manager, [implRoot], implFile, "Helper");
      expect(noDirection.isError).toBe(true);
      expect(textOf(noDirection)).toMatch(/named func type/);

      for (const [symbolName, kindName] of [
        ["Table", "variable"],
        ["Version", "constant"],
        ["MemoryStorage.Get", "method"],
      ] as const) {
        const refused = await ask(manager, [implRoot], implFile, symbolName);
        expect(refused.isError, `${symbolName} has no direction to answer`).toBe(true);
        expect(textOf(refused)).toContain(`is a ${kindName}`);
      }
    },
    600_000,
  );

  itIfGoplsAvailable("reports the direction its kind table actually produced for an alias to a stdlib interface", async () => {
    const result = await ask(freshManager(), [implRoot], aliasFile, "Reader");

    if (result.isError) {
      // gopls gave the alias a kind with no direction: the refusal has to name that kind, and the
      // observation belongs in the report rather than in an assumed assertion.
      expect(textOf(result)).toMatch(/only named types and interfaces have a direction|named func type/);
      return;
    }
    const payload = result.structuredContent as Payload;
    expect(["interface", "struct", "class"]).toContain(payload.resolved.kind);
    expect(payload.direction).toBe(
      payload.resolved.kind === "interface" ? "implementers-of-interface" : "interfaces-implemented-by-type",
    );
    expect(payload.implementations.filter((row) => row.external && row.name !== null)).toEqual([]);
  }, 300_000);

  itIfGoplsAvailable(
    "caps the fan-out, counts what it dropped, and never names a row from outside the module",
    async () => {
      // `Reporter` is structurally `error`, so the answer spans everything gopls loaded for this module.
      const payload = payloadOf(await ask(freshManager(), [implRoot], reporterFile, "Reporter"));

      expect(payload.direction).toBe("implementers-of-interface");
      expect(payload.implementations).toHaveLength(IMPLEMENTATIONS_LIMIT);
      expect(payload.truncated).toBeGreaterThan(0);
      expect(payload.implementations.filter((row) => row.external && row.name !== null)).toEqual([]);
      expect(payload.implementations.some((row) => row.name === "reportError" && !row.external)).toBe(true);
      // In-module rows are kept ahead of external ones, so the first row is never an unnamed one.
      expect(payload.implementations[0]).toMatchObject({ external: false });
    },
    600_000,
  );

  itIfGoplsAvailable(
    "roots each answer at the queried file's own module, not at a sibling declaring the same interface",
    async () => {
      const manager = freshManager();
      const inA = payloadOf(await ask(manager, [siblingRoot], join(siblingRoot, "mod-a", "store.go"), "Storage"));
      const inB = payloadOf(await ask(manager, [siblingRoot], join(siblingRoot, "mod-b", "store.go"), "Storage"));

      expect(inA.scope.moduleRoot.replace(/\\/g, "/")).toMatch(/go-sibling-modules\/mod-a$/);
      expect(inB.scope.moduleRoot.replace(/\\/g, "/")).toMatch(/go-sibling-modules\/mod-b$/);
      // Complete for its own module: both of this module's implementers, and neither of the sibling's.
      expect(namedRows(inA)).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
      expect(namedRows(inB)).toEqual(expect.arrayContaining(["Gamma"]));
      expect(namedRows(inA)).not.toContain("Gamma");
      expect(namedRows(inB)).not.toContain("Alpha");
      // A widened view would answer across the workspace and name the sibling's types; either way a row
      // from the other module means the scope the payload claims is not the scope it computed.
      expect(inA.implementations.filter((row) => row.file.includes("mod-b"))).toEqual([]);
      expect(inB.implementations.filter((row) => row.file.includes("mod-a"))).toEqual([]);
    },
    600_000,
  );

  itIfGoplsAvailable(
    "corrects one warm session when the module changes on disk, in both staleness directions",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-gofresh-"));
      const mod = join(tmp, "go-freshness");
      cpSync(freshnessFixture, mod, { recursive: true });
      const file = join(mod, "store.go");
      const manager = freshManager();
      try {
        const names = (payload: Payload) => payload.implementations.map((row) => row.name);

        const first = payloadOf(await ask(manager, [mod], file, "Sink"));
        expect(names(first)).toEqual(expect.arrayContaining(["ChannelSink"]));
        expect(names(first)).not.toContain("DiskSink");
        expect(first.scope.freshness.kind).toBe("unchanged");

        writeFileSync(
          join(mod, "disk.go"),
          [
            "package gofresh",
            "",
            "// DiskSink is written after the session loaded the package.",
            "type DiskSink struct {",
            "\tsaved string",
            "}",
            "",
            "func (d *DiskSink) Take(value string) {",
            "\td.saved = value",
            "}",
            "",
          ].join("\n"),
        );
        const added = payloadOf(await ask(manager, [mod], file, "Sink"));
        expect(names(added)).toEqual(expect.arrayContaining(["ChannelSink", "DiskSink"]));
        expect(added.scope.freshness).toMatchObject({ kind: "pushed", changedFiles: 1 });

        // ChannelSink stops satisfying Sink in a file this session already holds open — the direction a
        // long-lived gopls keeps reporting the old answer for.
        writeFileSync(
          file,
          [
            "package gofresh",
            "",
            "type Sink interface {",
            "\tTake(value string)",
            "}",
            "",
            "type ChannelSink struct {",
            "\tfed string",
            "}",
            "",
            "func (c *ChannelSink) TakeAll(value string) {",
            "\tc.fed = value",
            "}",
            "",
          ].join("\n"),
        );
        const removed = payloadOf(await ask(manager, [mod], file, "Sink"));
        expect(names(removed)).toContain("DiskSink");
        expect(names(removed)).not.toContain("ChannelSink");
        expect(removed.scope.freshness.kind).toBe("pushed");

        // One watched-files notification naming the deleted path is enough: the answer must stop
        // reporting the implementer without the graph being reloaded. Which row it names instead is not
        // asserted — a location in a file that is gone cannot be named, and this case is about absence.
        // A process in gopls's activity briefly holds the file open without delete sharing right after the last
        // response, which Windows reports as `EPERM`, so the
        // delete retries for five seconds. No `force`, so a path that never went away still fails this case; and
        // when the last attempt fails too, the error names the process holding the file.
        removeFileNamingHolder(join(mod, "disk.go"), { maxRetries: 25, retryDelay: 200 });
        const afterDelete = payloadOf(await ask(manager, [mod], file, "Sink"));
        expect(afterDelete.scope.freshness.kind).toBe("pushed");
        expect(names(afterDelete)).not.toContain("DiskSink");
      } finally {
        manager.disposeAll();
        await removeTree(tmp);
      }
    },
    900_000,
  );
});
