import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TsExecFn } from "../../src/tsgo/binary.js";
import type { TsgoBinary } from "../../src/tsgo/binary.js";
import { dropProjectMap } from "../../src/tsgo/project-map.js";
import { budgetOf } from "../../src/tools/budget.js";
import { tsgoConfig } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { anchorProjects, type TsWorkspaceOpen } from "../../src/tools/ts-navigation-shared.js";
import { fakeServer } from "../helpers/fake-lsp.js";

const BINARY: TsgoBinary = {
  executable: "C:/fake/lib/tsc.exe",
  version: "7.0.2",
  source: "global",
};
const IDLE_MS = 1000;

describe("anchorProjects when the child is retired while the project map is listed", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-code-nav-anchor-retire-"));
  });

  afterEach(() => {
    dropProjectMap(root);
    rmSync(root, { recursive: true, force: true });
  });

  function write(path: string, body: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  }

  it("remakes the proof on the new child, so a project created meanwhile is anchored", async () => {
    const rootConfig = write(join(root, "tsconfig.json"), "{}");
    const rootSource = write(join(root, "src", "a.ts"), "export const a = 1;\n");

    let now = 0;
    let timer: (() => void) | undefined;
    const spawn = vi.fn(() => fakeServer().process);
    const manager = new LspSessionManager(
      { spawn, sleep: async () => {}, readFile: () => "x" },
      { idleMs: IDLE_MS, maxSessions: 0 },
      {
        now: () => now,
        schedule: (run) => {
          timer = run;
          return () => {
            if (timer === run) timer = undefined;
          };
        },
      },
    );
    const session = manager.get(root, tsgoConfig(BINARY));

    let added: string | undefined;
    let listings = 0;
    const exec: TsExecFn = async (_executable, args) => {
      listings++;
      if (listings === 1) {
        // The idle period elapses while the first listing runs, and a project appears in the gap.
        added = write(join(root, "pkg", "tsconfig.json"), "{}");
        write(join(root, "pkg", "b.ts"), "export const b = 1;\n");
        now += IDLE_MS;
        timer?.();
      }
      const listed = args[2] === rootConfig ? [rootSource] : [join(root, "pkg", "b.ts")];
      return { stdout: listed.join("\n"), stderr: "", exitCode: 0 };
    };

    const opened: TsWorkspaceOpen = {
      session,
      budget: budgetOf(30_000),
      binary: BINARY,
      workspaceRoot: root,
      enclosingWorkspace: null,
      freshness: { kind: "unchanged" },
    };
    const generation = session.generation();
    const result = await anchorProjects("ts_find_symbol", opened, exec, "a", [rootSource]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(session.generation()).toBeGreaterThan(generation);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(added).toBeDefined();
    expect(result.value.mapped.projects.map((project) => project.config)).toEqual(
      expect.arrayContaining([rootConfig, added]),
    );
    expect(result.value.anchorsProvenOn).toBe(session.spawnSerial());
  });
});
