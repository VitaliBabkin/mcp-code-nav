/**
 * Derives the build identity of a bundle from the repository's annotated release tags, so the
 * version number exists in exactly one place (the tag) rather than in a file that has to be
 * edited in step with it.
 */
import { execFileSync } from "node:child_process";

/** Only plain `vX.Y.Z` tags count; `--exclude` keeps pre-release tags out of the identity. */
const DESCRIBE_ARGS = [
  "describe",
  "--tags",
  "--long",
  "--dirty",
  "--match",
  "v[0-9]*.[0-9]*.[0-9]*",
  "--exclude",
  "*-*",
];

/**
 * `v0.3.1-0-g1a2b3c4` -> `0.3.1+g1a2b3c4` and `v0.3.0-5-g1a2b3c4` -> `0.3.0+5.g1a2b3c4`; a
 * `-dirty` tail is carried over. A distance of 0 is dropped because the commit *is* the tag.
 */
export function formatIdentity(describe: string): string {
  const parts = parseDescribe(describe);
  if (!parts) {
    throw new Error(
      `Cannot read a build identity out of "${describe}" — expected v<major>.<minor>.<patch>-<distance>-g<sha> from \`git describe ${DESCRIBE_ARGS.join(" ")}\`.`,
    );
  }
  const distance = parts.distance === "0" ? "" : `${parts.distance}.`;
  return `${parts.version}+${distance}g${parts.sha}${parts.dirty ? "-dirty" : ""}`;
}

/** The identity of the checkout at `cwd`, or `0.0.0+<commits>.g<sha>` before the first release tag. */
export function readIdentity(cwd: string): string {
  const described = git(cwd, DESCRIBE_ARGS);
  if (described !== undefined) {
    return formatIdentity(described);
  }
  return identityWithoutTag(cwd);
}

interface DescribeParts {
  version: string;
  distance: string;
  sha: string;
  dirty: boolean;
}

function parseDescribe(describe: string): DescribeParts | undefined {
  const match = /^v(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)(-dirty)?$/.exec(describe);
  if (!match) {
    return undefined;
  }
  const [, version, distance, sha, dirty] = match;
  if (version === undefined || distance === undefined || sha === undefined) {
    return undefined;
  }
  return { version, distance, sha, dirty: dirty !== undefined };
}

/**
 * Before any release tag there is no base version to describe against, so the identity is built
 * from the commit count instead; `0.0.0` marks it as never-taggable-without-a-real-tag.
 */
function identityWithoutTag(cwd: string): string {
  const commitCount = git(cwd, ["rev-list", "--count", "HEAD"]);
  const shortSha = git(cwd, ["rev-parse", "--short", "HEAD"]);
  if (commitCount === undefined || shortSha === undefined) {
    throw new Error(
      `No release tag matching v[0-9]*.[0-9]*.[0-9]* in ${cwd}, and git could not count its commits either — a bundle needs an identity, so tag a commit or check that ${cwd} is a git work tree.`,
    );
  }
  const dirty = workingTreeIsDirty(cwd) ? "-dirty" : "";
  return `0.0.0+${commitCount}.g${shortSha}${dirty}`;
}

function workingTreeIsDirty(cwd: string): boolean {
  return git(cwd, ["diff", "--quiet", "HEAD"]) === undefined;
}

/** git's stdout, trimmed; `undefined` when git ran and answered with a non-zero exit. */
function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Building needs git to derive the identity (no bundle without one) and \`git ${args.join(" ")}\` could not be started.`, { cause: error });
    }
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}
