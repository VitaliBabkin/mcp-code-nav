import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { itIfClangd } from "../helpers/clangd-live.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { runCppFindCallers, type CppFindCallersPayload } from "../../src/tools/cpp-find-callers.js";
import {
  runCppFindReferences,
  type CppFindReferencesPayload,
} from "../../src/tools/cpp-find-references.js";

/**
 * clangd truncates a reference answer at `--limit-references` (1000 unless told otherwise) and says nothing
 * about it, so a symbol used more often than that would come back short with a count that reads as exact.
 * One function is called once from each of more callers than that default, and another is called more often
 * than that default from a single caller.
 */
const DISTINCT_CALLERS = 1100;
const BURST_CALLS = 1100;

const CALLEES_H = "#pragma once\nvoid tick();\nvoid burst();\n";
const CALLEES_CPP = '#include "callees.h"\nvoid tick() {}\nvoid burst() {}\n';
const usesCpp = (): string => {
  const distinct = Array.from(
    { length: DISTINCT_CALLERS },
    (_, i) => `void caller${String(i)}() {\n  tick();\n}\n`,
  );
  const burster = `void burster() {\n${"  burst();\n".repeat(BURST_CALLS)}}\n`;
  return `#include "callees.h"\n${[...distinct, burster].join("")}`;
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
    header = join(sourceDir, "callees.h");
    writeFileSync(header, CALLEES_H);
    const units = { "callees.cpp": CALLEES_CPP, "uses.cpp": usesCpp() };
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

  const input = (name: string) => ({
    projectRoot: buildDir,
    sourceRoots: [sourceDir],
    name,
    file: header,
  });

  itIfClangd(
    "counts every reference, past the 1000 clangd would stop at by default",
    async () => {
      for (const name of ["tick", "burst"]) {
        const payload = await settled(
          () =>
            runCppFindReferences(manager, input(name) as never) as Promise<
              Answer<CppFindReferencesPayload>
            >,
        );
        // The out-of-line definition in callees.cpp is a declaration, so the count is the call sites alone.
        expect(payload.totalReferences, name).toBe(1100);
      }
    },
    120_000,
  );

  itIfClangd(
    "counts every distinct caller of one function",
    async () => {
      const payload = await settled(
        () =>
          runCppFindCallers(manager, input("tick") as never) as Promise<
            Answer<CppFindCallersPayload>
          >,
      );
      expect(payload.totalCallers).toBe(DISTINCT_CALLERS);
    },
    120_000,
  );

  itIfClangd(
    "counts every call site of one caller",
    async () => {
      const payload = await settled(
        () =>
          runCppFindCallers(manager, input("burst") as never) as Promise<
            Answer<CppFindCallersPayload>
          >,
      );
      expect(payload.totalCallers).toBe(1);
      const [row] = payload.callers;
      expect((row?.callSites.length ?? 0) + (row?.callSitesTruncated ?? 0)).toBe(BURST_CALLS);
    },
    120_000,
  );
});
