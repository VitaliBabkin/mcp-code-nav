import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clangdConfig } from "../../src/lsp/server-config.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { LspSession } from "../../src/lsp/session.js";
import { runCppFileSymbols } from "../../src/tools/cpp-file-symbols.js";

// clangd is optional on this host in exactly the way gopls is, so the suite skips rather than failing with
// the symptom it exists to detect. `MCP_CODE_NAV_CLANGD` overrides, as it does at runtime.
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
 * One header with a virtual template class and one translation unit per name deriving from it: enough
 * parsing that a background index has real work to do, and a shape whose out-of-line member definition
 * lands in every TU.
 */
function writeProject(sourceDir: string, buildDir: string, tuNames: readonly string[]): void {
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "shape.h"),
    [
      "#pragma once",
      "",
      "/// A drawn thing, with enough members to make the AST worth building.",
      "template <class T>",
      "class Shape {",
      "public:",
      "  virtual T area() const = 0;",
      "  virtual const char *name() const;",
      "  T scale;",
      "};",
      "",
      "template <class T>",
      "const char *Shape<T>::name() const {",
      '  return "shape";',
      "}",
      "",
    ].join("\n"),
  );
  for (const tu of tuNames) {
    writeFileSync(
      join(sourceDir, `${tu}.cpp`),
      [
        '#include "shape.h"',
        "",
        `class ${tu} : public Shape<int> {`,
        "public:",
        "  int area() const override {",
        `    return ${tu.length};`,
        "  }",
        "};",
        "",
        `${tu} instance;`,
        "",
      ].join("\n"),
    );
  }
  writeFileSync(
    join(buildDir, "compile_commands.json"),
    JSON.stringify(
      tuNames.map((tu) => ({
        directory: sourceDir,
        command: `clang++ -std=c++17 -c "${join(sourceDir, `${tu}.cpp`)}" -o ${tu}.o`,
        file: join(sourceDir, `${tu}.cpp`),
      })),
    ),
  );
}

/** Every path under `dir`, POSIX-separated and relative to it, sorted. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const walked: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      walked.push(relative(dir, path).split(sep).join("/"));
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return walked.sort();
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const sleep = async (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Polls `seen` until it answers true, up to the deadline; a disk claim is only worth what it waited for. */
async function settled(seen: () => boolean, deadlineMs: number): Promise<boolean> {
  const stopsAt = Date.now() + deadlineMs;
  while (Date.now() < stopsAt) {
    if (seen()) return true;
    await sleep(300);
  }
  return seen();
}

/**
 * The disk and progress claims this suite must pin before any tool
 * depends on them: where clangd puts the index this server's C++ answers are read from when the build
 * directory is not the source tree, whether that location is relocatable, what it writes beside the
 * shards, that nothing of the caller's own files is touched, and whether a real clangd's indexing
 * progress reaches a client that asked for it well enough to tell "in flight" from "quiescent" — the
 * question the limit codes are built on and ships whichever way it falls.
 */
describe("clangd's own index on disk, against a real clangd binary", () => {
  let tmp: string;
  const managers: LspSessionManager[] = [];
  const sessions: LspSession[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-cpp-index-"));
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    while (managers.length > 0) managers.pop()?.disposeAll();
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

  function freshManager(): LspSessionManager {
    const manager = new LspSessionManager();
    managers.push(manager);
    return manager;
  }

  itIfClangd("puts its index under the directory the client is rooted at, not the source tree", async () => {
    const buildDir = join(tmp, "out", "build");
    const sourceDir = join(tmp, "src");
    writeProject(sourceDir, buildDir, ["Alpha", "Beta", "Gamma", "Delta"]);
    const source = join(sourceDir, "Alpha.cpp");
    const database = join(buildDir, "compile_commands.json");
    const before = { source: digest(source), database: digest(database), sources: tree(sourceDir), build: tree(buildDir) };

    const outlined = await runCppFileSymbols(freshManager(), {
      projectRoot: buildDir,
      file: source,
      sourceRoots: [sourceDir],
      depth: 2,
    });
    expect(outlined.isError).toBeFalsy();

    const appearedInBuild = await settled(() => existsSync(join(buildDir, ".cache", "clangd")), 45_000);
    const appearedInSource = existsSync(join(sourceDir, ".cache", "clangd"));

    expect(appearedInBuild, "no .cache/clangd appeared under the build directory").toBe(true);
    expect(appearedInSource, "clangd wrote an index into the source tree as well").toBe(false);
    // Whatever appeared is the index directory and nothing else: no object files, no lock, no stray.
    expect(tree(buildDir).filter((p) => !before.build.includes(p)).map((p) => p.split("/")[0]))
      .toEqual(expect.arrayContaining([".cache"]));
    expect(tree(buildDir).filter((p) => !before.build.includes(p) && !p.startsWith(".cache"))).toEqual([]);
    expect(tree(sourceDir).filter((p) => !before.sources.includes(p))).toEqual([]);
    // The caller's own bytes are untouched: a compile database and a source that came back identical.
    expect(digest(source)).toBe(before.source);
    expect(digest(database)).toBe(before.database);
  }, 120_000);

  itIfClangd("writes shards and its own .gitignore beside them, which is what keeps the caller's status clean", async () => {
    const project = join(tmp, "in-tree");
    writeProject(project, project, ["Alpha", "Beta", "Gamma"]);

    const outlined = await runCppFileSymbols(freshManager(), {
      projectRoot: project,
      file: join(project, "Alpha.cpp"),
      sourceRoots: [project],
      depth: 2,
    });
    expect(outlined.isError).toBeFalsy();

    // Waits for the shard this case then names: clangd indexes its TUs in its own order, so waiting for any
    // shard to appear and asserting afterwards that Alpha's is among them races the very next line. `tree`
    // answers relative to the directory it was given, so the predicate matches on the name alone.
    const indexed = await settled(
      () => tree(join(project, ".cache")).some((p) => p.endsWith(".idx") && p.includes("Alpha.cpp.")),
      45_000,
    );
    const entries = tree(project).filter((p) => p.startsWith(".cache"));
    const shards = entries.filter((p) => p.endsWith(".idx"));
    const ignoreFile = entries.find((p) => p.endsWith(".gitignore"));

    expect(indexed, `no Alpha.cpp index shard appeared; .cache held ${JSON.stringify(entries)}`).toBe(true);
    expect(shards.length).toBeGreaterThan(0);
    // The layout, and the name a shard carries: one file per source, hashed.
    expect(shards.every((shard) => shard.startsWith(".cache/clangd/index/"))).toBe(true);
    expect(shards.some((shard) => shard.startsWith(".cache/clangd/index/Alpha.cpp."))).toBe(true);
    expect(ignoreFile, `no .gitignore beside the shards: ${JSON.stringify(entries)}`).toMatch(
      /^\.cache\/clangd\/.*\.gitignore$/,
    );
    expect(readFileSync(join(project, ignoreFile as string), "utf-8")).toContain("*");
  }, 120_000);

  itIfClangd("lets a client that asked for progress tell in-flight from quiescent", async () => {
    const project = join(tmp, "progress");
    writeProject(project, project, ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]);
    const session = new LspSession({ root: project, config: clangdConfig });
    sessions.push(session);

    const verdicts: string[] = [];
    // Opening every TU inside its own window is what gives the background index work to report, and each
    // window is answered by the request it holds the documents for — clangd answers no request about a
    // document this client never opened, which this suite pins.
    for (const tu of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]) {
      const { index } = await session.withIndexWindow(() => session.documentSymbol(join(project, `${tu}.cpp`)));
      verdicts.push(index);
    }
    const stopAt = Date.now() + 60_000;
    while (Date.now() < stopAt && verdicts[verdicts.length - 1] !== "quiescent") {
      const { index } = await session.withIndexWindow(() => session.documentSymbol(join(project, "Alpha.cpp")));
      verdicts.push(index);
      await sleep(400);
    }
    // Reaching `quiescent` is the whole question: clangd's progress reaches this client, so
    // "in flight" and "idle" are tellable apart and the `unknown` branch of the table is not the one this
    // host settles on. A run that never leaves `unknown` is the other branch — every
    // index-backed answer would carry `index-state-unknown` and an empty one would fail loudly. The exact
    // sequence a real clangd produces here is recorded in the slice report; it is timing-dependent, so it
    // is not what this case asserts.
    const firstIdle = verdicts.indexOf("quiescent");
    expect(firstIdle, `verdicts: ${JSON.stringify(verdicts)}`).toBeGreaterThanOrEqual(0);
    expect(verdicts[verdicts.length - 1], `verdicts: ${JSON.stringify(verdicts)}`).toBe("quiescent");
    // Once a process has seen progress it never claims to know nothing again: `unknown` can only precede
    // the first idle reading, which is what lets a caller read the state as about this answer's window.
    expect(verdicts.slice(firstIdle)).toEqual(verdicts.slice(firstIdle).filter((v) => v !== "unknown"));
  }, 120_000);
});
