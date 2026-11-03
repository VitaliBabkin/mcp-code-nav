import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install, stampedIdentity } from "../../scripts/deploy.js";

/**
 * The tests below that spawn processes run four or more of them back to back (git, node, tsx); while the rest of
 * the suite runs, each one takes several times its idle cost, which put a 5 s budget out of reach.
 */
const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

/**
 * vitest checks a synchronous test's budget only after it returns, so a hung child would wedge the run instead of
 * failing one test; each spawn carries its own kill deadline, sized so the four spawns of one test fit that budget.
 */
const SPAWN_TIMEOUT_MS = 7_000;

const stamped = (identity: string): string =>
  `// MCPBUILD: mcp-code-nav ${identity}\nconsole.log("server");\n`;

describe("deploy install", () => {
  let base: string;
  let bundle: string;
  let targetDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mcp-code-nav-deploy-"));
    bundle = join(base, "bundle.js");
    targetDir = join(base, "deployed");
    writeFileSync(bundle, stamped("0.1.0+2.gnew"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("reads the identity from below the shebang and nothing from a file without one", () => {
    expect(stampedIdentity(bundle)).toBe("0.1.0+2.gnew");
    writeFileSync(join(base, "plain.js"), "console.log(1);\n");
    expect(stampedIdentity(join(base, "plain.js"))).toBeUndefined();
    expect(stampedIdentity(join(base, "absent.js"))).toBeUndefined();
  });

  it("verifies the new file where it is staged, before the installed one is touched", () => {
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "index.js"), stamped("0.1.0+1.gold"));
    writeFileSync(join(targetDir, "index.js.bak"), stamped("0.1.0+0.gverified"));

    expect(() =>
      install({
        bundle,
        targetDir,
        handshake: (path) => {
          expect(path).not.toBe(join(targetDir, "index.js"));
          expect(path).toMatch(/\.js$/); // node refuses to run a file by any other extension
          throw new Error("no handshake");
        },
      }),
    ).toThrow("no handshake");

    expect(stampedIdentity(join(targetDir, "index.js"))).toBe("0.1.0+1.gold");
    expect(stampedIdentity(join(targetDir, "index.js.bak"))).toBe("0.1.0+0.gverified");
    expect(readdirSync(targetDir).sort()).toEqual(["index.js", "index.js.bak"]);
  });

  it("installs into a directory that does not exist yet, with no backup", () => {
    const done = install({ bundle, targetDir, handshake: () => undefined });

    expect(readFileSync(done.installed, "utf8")).toBe(stamped("0.1.0+2.gnew"));
    expect(done.backup).toBeUndefined();
    expect(readdirSync(targetDir)).toEqual(["index.js"]);
  });

  it("keeps the replaced file as index.js.bak and names its identity", () => {
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "index.js"), stamped("0.1.0+1.gold"));

    const done = install({ bundle, targetDir, handshake: () => undefined });

    expect(done.previous).toBe("0.1.0+1.gold");
    expect(readFileSync(done.backup ?? "", "utf8")).toBe(stamped("0.1.0+1.gold"));
    expect(stampedIdentity(done.installed)).toBe("0.1.0+2.gnew");
    expect(readdirSync(targetDir).sort()).toEqual(["index.js", "index.js.bak"]);
  });

  it("puts the old file back when the handshake fails", () => {
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "index.js"), stamped("0.1.0+1.gold"));

    expect(() =>
      install({
        bundle,
        targetDir,
        handshake: (path) => {
          if (path === join(targetDir, "index.js")) throw new Error("no handshake");
        },
      }),
    ).toThrow(/no handshake; the previous installation was restored/);

    expect(stampedIdentity(join(targetDir, "index.js"))).toBe("0.1.0+1.gold");
  });

  it("leaves nothing installed when a first deploy fails its handshake", () => {
    expect(() =>
      install({
        bundle,
        targetDir,
        handshake: (path) => {
          if (path === join(targetDir, "index.js")) throw new Error("no handshake");
        },
      }),
    ).toThrow("no handshake");

    expect(readdirSync(targetDir)).toEqual([]);
  });
});

describe("deploy install, rollback that fails", () => {
  it("says the installed file is unproven when the previous one cannot be put back", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-code-nav-deploy-"));
    try {
      const bundle = join(base, "bundle.js");
      const targetDir = join(base, "deployed");
      writeFileSync(bundle, stamped("0.1.0+2.gnew"));
      mkdirSync(targetDir);
      writeFileSync(join(targetDir, "index.js"), stamped("0.1.0+1.gold"));

      expect(() =>
        install({
          bundle,
          targetDir,
          handshake: (path) => {
            if (path !== join(targetDir, "index.js")) return;
            rmSync(join(targetDir, "index.js.bak"));
            throw new Error("no handshake");
          },
        }),
      ).toThrow(/no handshake; and the previous file could not be put back/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/** A stdio server that answers the handshake with the version it is given, for `scripts/check-bundle.cjs`. */
function fakeServer(dir: string, version: string): string {
  const file = join(dir, "fake-server.cjs");
  writeFileSync(
    file,
    [
      'process.stdin.on("data", (chunk) => {',
      '  for (const line of String(chunk).split("\\n")) {',
      "    if (line === '') continue;",
      "    const message = JSON.parse(line);",
      `    if (message.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "x", version: ${JSON.stringify(version)} } } }));`,
      '    if (message.id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "t" }] } }));',
      "  }",
      "});",
    ].join("\n"),
  );
  return file;
}

describe("check-bundle expected version", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-code-nav-check-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const check = (server: string, ...expected: string[]) =>
    spawnSync(process.execPath, ["scripts/check-bundle.cjs", server, ...expected], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });

  it(
    "passes when the server reports the expected version, or none is expected",
    () => {
      const server = fakeServer(dir, "1.2.3+g1");
      expect(check(server, "1.2.3+g1").status).toBe(0);
      expect(check(server).status).toBe(0);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "fails when the server reports another version",
    () => {
      const done = check(fakeServer(dir, "1.2.3+g1"), "9.9.9+g9");
      expect(done.status).toBe(1);
      expect(done.stderr).toContain("expected 9.9.9+g9");
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});

describe("deploy of a tree with untracked files", () => {
  it(
    "refuses before bundling or installing anything",
    () => {
      const repo = mkdtempSync(join(tmpdir(), "mcp-code-nav-deploy-repo-"));
      try {
        const git = (...args: string[]) =>
          spawnSync(
            "git",
            ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
            { timeout: SPAWN_TIMEOUT_MS },
          );
        git("init", "-q");
        writeFileSync(join(repo, "a.txt"), "a");
        git("add", ".");
        git("commit", "-q", "-m", "one");
        writeFileSync(join(repo, "untracked.ts"), "export {};");

        const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        const done = spawnSync(
          process.execPath,
          [tsx, join(process.cwd(), "scripts", "deploy.ts")],
          { cwd: repo, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
        );

        expect(done.status).toBe(1);
        expect(done.stderr).toContain("refusing to deploy");
        expect(done.stderr).toContain("untracked.ts");
        expect(existsSync(join(repo, "dist-bundle"))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );
});
