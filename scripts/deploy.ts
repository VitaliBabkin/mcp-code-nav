/**
 * `npm run deploy`: bundles the server and installs it as `~/.mcp/mcp-code-nav/index.js`, the copy MCP clients
 * run, so a branch switch or a half-finished build in this checkout never changes a connected server.
 *
 * It refuses a tree with uncommitted or untracked files (the identity would name no commit), proves the new file
 * by an MCP handshake that must report the identity just built, keeps the file it replaces as `index.js.bak`, and
 * puts that file back when the installed copy fails the handshake. `-- --allow-dirty` deploys a dirty tree anyway,
 * with a warning.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readIdentity } from "./build-identity.js";

const SERVER_NAME = "mcp-code-nav";
const BUNDLE = join("dist-bundle", "index.js");
const MARKER = /^\/\/ MCPBUILD: \S+ (\S+)/m;
/** The marker sits in the first lines; this much of the file is enough to find it. */
const HEAD_BYTES = 8192;

interface Install {
  /** The freshly built file. */
  readonly bundle: string;
  /** The directory MCP clients run the server from. */
  readonly targetDir: string;
  /** Throws unless the file at the given path answers an MCP handshake as the identity just built. */
  readonly handshake: (installed: string) => void;
}

/** The identity stamped near the top of a bundle (below its shebang), or `undefined` for a file with none. */
export function stampedIdentity(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const fd = openSync(file, "r");
  try {
    const prefix = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, prefix, 0, HEAD_BYTES, 0);
    const head = prefix.toString("utf8", 0, read).split("\n", 4).join("\n");
    return MARKER.exec(head)?.[1];
  } finally {
    closeSync(fd);
  }
}

/**
 * Installs the bundle as `<targetDir>/index.js` without ever putting an unproven file in the way of a proven one:
 * the new file is staged beside the old and handshaken there, only then does the old one become `index.js.bak` and
 * the new one take its name, and a handshake of the installed name that fails puts the old one back.
 */
export function install({ bundle, targetDir, handshake }: Install): {
  readonly installed: string;
  readonly previous: string | undefined;
  readonly backup: string | undefined;
} {
  const installed = join(targetDir, "index.js");
  const backup = `${installed}.bak`;
  // Node runs a file by its extension, so the staged copy must still end in `.js` to be handshaken.
  const staging = join(targetDir, "index.staged.js");
  const previous = stampedIdentity(installed);
  const hadPrevious = existsSync(installed);

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(bundle, staging);
  try {
    handshake(staging);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  if (hadPrevious) copyFileSync(installed, backup);
  renameSync(staging, installed);
  const kept = hadPrevious ? backup : undefined;
  try {
    handshake(installed);
  } catch (error) {
    throw restore(error, installed, kept);
  }
  return { installed, previous, backup: kept };
}

/** Puts the previous file back after a failed handshake; the error returned says what state the install is in. */
function restore(cause: unknown, installed: string, backup: string | undefined): Error {
  const failure = cause instanceof Error ? cause.message : String(cause);
  try {
    if (backup === undefined) rmSync(installed, { force: true });
    else renameSync(backup, installed);
  } catch (restoreError) {
    return new Error(
      `${failure}; and the previous file could not be put back (${restoreError instanceof Error ? restoreError.message : String(restoreError)}): ${installed} is the unproven build`,
      { cause },
    );
  }
  return new Error(`${failure}; the previous installation was restored`, { cause });
}

function handshakeOf(identity: string): (installed: string) => void {
  return (installed) => {
    const done = spawnSync(
      process.execPath,
      [join("scripts", "check-bundle.cjs"), installed, identity],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (done.status !== 0) throw new Error(`the handshake against ${installed} failed`);
  };
}

/** Every path git sees as changed or untracked: `describe --dirty` misses the untracked ones a build may import. */
function uncommittedFiles(cwd: string): string[] {
  const listed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  return listed.split("\n").filter((line) => line.trim() !== "");
}

async function main(): Promise<void> {
  const identity = readIdentity(process.cwd());
  const uncommitted = uncommittedFiles(process.cwd());
  if (identity.endsWith("-dirty") || uncommitted.length > 0) {
    if (!process.argv.includes("--allow-dirty")) {
      console.error(
        `deploy: refusing to deploy ${identity}: the tree has uncommitted or untracked files, so the build names no ` +
          `commit (${uncommitted.slice(0, 5).join("; ")}). Commit them, or run \`npm run deploy -- --allow-dirty\`.`,
      );
      process.exitCode = 1;
      return;
    }
    console.warn(`deploy: WARNING: deploying ${identity}, a build no commit can reproduce.`);
  }

  await import("./bundle.js");
  const stamped = stampedIdentity(BUNDLE);
  if (stamped !== identity) {
    throw new Error(`the bundle is stamped ${stamped ?? "nothing"}, expected ${identity}`);
  }

  const targetDir = join(homedir(), ".mcp", SERVER_NAME);
  const done = install({ bundle: BUNDLE, targetDir, handshake: handshakeOf(identity) });
  console.log(
    `deploy: ${SERVER_NAME} ${identity} is installed at ${done.installed}\n` +
      (done.backup === undefined
        ? "deploy: there was no earlier copy\n"
        : `deploy: replaced ${done.previous ?? "an unstamped build"}, kept as ${done.backup}\n`) +
      "deploy: running sessions pick it up when they restart",
  );
}

/** True when this file is the script node was started with, also through a junction or symlink. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error(`deploy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
