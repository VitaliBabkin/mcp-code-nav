import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runCppFindCallers, type CppFindCallersPayload } from "../../src/tools/cpp-find-callers.js";
import {
  runCppFindReferences,
  type CppFindReferencesPayload,
} from "../../src/tools/cpp-find-references.js";

function isClangdAvailable(): boolean {
  try {
    execFileSync(process.env.MCP_CODE_NAV_CLANGD ?? "clangd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const itIfClangd = isClangdAvailable() ? it : it.skip;

/**
 * clangd truncates a reference answer at `--limit-references` (1000 unless told otherwise) and says nothing
 * about it, so a symbol used more often than that would come back short with a count that reads as exact.
 * The fixture calls one function from more sites than that default.
 */
const CALLERS = 11;
const CALLS_PER_CALLER = 100;
const TOTAL_CALLS = CALLERS * CALLS_PER_CALLER;

const TICK_H = "#pragma once\nvoid tick();\n";
const TICK_CPP = '#include "tick.h"\nvoid tick() {}\n';
const usesCpp = (): string => {
  const body = "  tick();\n".repeat(CALLS_PER_CALLER);
  const fns = Array.from({ length: CALLERS }, (_, i) => `void caller${String(i)}() {\n${body}}\n`);
  return `#include "tick.h"\n${fns.join("")}`;
};

type Answer<P> = { isError?: boolean; content: { text: string }[]; structuredContent?: P };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a symbol used more often than clangd's default reference limit", () => {
  let tmp: string;
  let buildDir: string;
  let sourceDir: string;
  let header: string;
  const manager = new LspSessionManager();

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-ref-limit-live-"));
    buildDir = join(tmp, "build");
    sourceDir = join(tmp, "src");
    mkdirSync(buildDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    header = join(sourceDir, "tick.h");
    writeFileSync(header, TICK_H);
    const units = { "tick.cpp": TICK_CPP, "uses.cpp": usesCpp() };
    for (const [name, text] of Object.entries(units)) writeFileSync(join(sourceDir, name), text);
    writeFileSync(
      join(buildDir, "compile_commands.json"),
      JSON.stringify(
        Object.keys(units).map((name) => ({
          directory: sourceDir,
          command: `clang++ -std=c++17 -c "${join(sourceDir, name)}" -o ${name}.o`,
          file: join(sourceDir, name),
        })),
      ),
    );
  });

  afterAll(async () => {
    manager.disposeAll();
    // The clangd child's cwd is the directory it was rooted at, so Windows keeps that handle locked briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        return;
      } catch {
        if (attempt >= 9) throw new Error(`could not remove ${tmp}`);
        await sleep(300);
      }
    }
  });

  /** Asks until clangd's index is settled across the answer's window; any other error ends the test. */
  async function settled<P>(ask: () => Promise<Answer<P>>): Promise<P> {
    const stopAt = Date.now() + 90_000;
    for (;;) {
      const answer = await ask();
      const text = answer.content.map((block) => block.text).join("\n");
      const state = (
        answer.structuredContent as { scope?: { index?: { state?: string } } } | undefined
      )?.scope?.index?.state;
      if (answer.isError !== true && state === "quiescent" && answer.structuredContent)
        return answer.structuredContent;
      if (answer.isError === true && !/indexing has settled|confirmed warm/.test(text))
        throw new Error(text);
      expect(Date.now(), text).toBeLessThan(stopAt);
      await sleep(400);
    }
  }

  const input = () => ({
    projectRoot: buildDir,
    sourceRoots: [sourceDir],
    name: "tick",
    file: header,
  });

  itIfClangd(
    "counts every reference, past the 1000 clangd would stop at by default",
    async () => {
      const payload = await settled(
        () =>
          runCppFindReferences(manager, input() as never) as Promise<
            Answer<CppFindReferencesPayload>
          >,
      );
      // The out-of-line definition in tick.cpp is a declaration, so the count is the call sites alone.
      expect(payload.totalReferences).toBe(TOTAL_CALLS);
    },
    120_000,
  );

  itIfClangd(
    "counts every call site across every caller",
    async () => {
      const payload = await settled(
        () =>
          runCppFindCallers(manager, input() as never) as Promise<Answer<CppFindCallersPayload>>,
      );
      expect(payload.totalCallers).toBe(CALLERS);
      const sites = payload.callers.reduce(
        (sum, row) => sum + row.callSites.length + row.callSitesTruncated,
        0,
      );
      expect(sites).toBe(TOTAL_CALLS);
    },
    120_000,
  );
});
