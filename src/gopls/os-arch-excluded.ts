import { basename } from "node:path";
import { rankPaths, ranksFile, summariseRanked, type CappedList } from "../paths/ranked-paths.js";

/**
 * The `.go` files under a module root whose FILENAME excludes them from the package graph under the
 * resolved GOOS/GOARCH: Go's `_GOOS.go` / `_GOARCH.go` / `_GOOS_GOARCH.go` suffix
 * rule, applied lexically to the paths the module snapshot already holds, so no directory walk and no
 * file read happens here.
 */

/** Capped like `uncoveredSources`: `count` stays exact while `files` cannot flood the payload. */
export const OS_ARCH_EXCLUDED_LIMIT = 20;

/**
 * The part of a resolved toolchain this rule reads. Declared here rather than imported from `go-env.ts`,
 * which imports these tokens: `GoEnvironment` satisfies it structurally.
 */
export interface TargetPort {
  readonly goos: string;
  readonly goarch: string;
}

/** Go's `internal/syslist.KnownOS`, the operating systems the filename rule recognises. */
const GOOS_TOKENS: readonly string[] = [
  "aix",
  "android",
  "darwin",
  "dragonfly",
  "freebsd",
  "hurd",
  "illumos",
  "ios",
  "js",
  "linux",
  "nacl",
  "netbsd",
  "openbsd",
  "plan9",
  "solaris",
  "wasip1",
  "windows",
  "zos",
];

/** Go's `internal/syslist.KnownArch`, the architectures the same rule recognises. */
const GOARCH_TOKENS: readonly string[] = [
  "386",
  "amd64",
  "amd64p32",
  "arm",
  "armbe",
  "arm64",
  "arm64be",
  "loong64",
  "mips",
  "mipsle",
  "mips64",
  "mips64le",
  "mips64p32",
  "mips64p32le",
  "ppc",
  "ppc64",
  "ppc64le",
  "riscv",
  "riscv64",
  "s390",
  "s390x",
  "sparc",
  "sparc64",
  "wasm",
];

/**
 * A host GOOS that also compiles another port's files: `GOOS=android` takes `_linux.go`, `illumos` takes
 * `_solaris.go`, `ios` takes `_darwin.go`. Without these the rule over-reports exclusion on exactly those
 * three hosts. The relation is one-way: a linux host does not take `_android.go`.
 */
const ALSO_COMPILES: Readonly<Record<string, string>> = {
  android: "linux",
  illumos: "solaris",
  ios: "darwin",
};

/** The GOOS and GOARCH tokens the filename rule knows, compiled-in list first. */
export interface KnownPorts {
  readonly goos: ReadonlySet<string>;
  readonly goarch: ReadonlySet<string>;
}

/** The ports `go tool dist list` named, split by side of the `GOOS/GOARCH` line. */
export interface DistTokens {
  readonly goos: readonly string[];
  readonly goarch: readonly string[];
}

/** `go tool dist list` prints one `GOOS/GOARCH` line per port; anything that is not one is ignored. */
export function parseDistList(stdout: string): DistTokens {
  const goos = new Set<string>();
  const goarch = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const port = /^([a-z0-9_]+)\/([a-z0-9_]+)$/.exec(line.trim());
    if (port === null) continue;
    if (port[1] !== undefined) goos.add(port[1]);
    if (port[2] !== undefined) goarch.add(port[2]);
  }
  return { goos: [...goos], goarch: [...goarch] };
}

/**
 * The compiled-in tokens are the primary source and `go tool dist list` only ADDS to them: dist list
 * reports currently-supported ports, so it under-reports the tokens the filename rule actually
 * recognises, and under-reporting a blind spot is the direction that hurts.
 */
export function knownPorts(added?: DistTokens): KnownPorts {
  return {
    goos: new Set([...GOOS_TOKENS, ...(added?.goos ?? [])]),
    goarch: new Set([...GOARCH_TOKENS, ...(added?.goarch ?? [])]),
  };
}

function hostTakesGoos(token: string, goos: string): boolean {
  return token === goos || ALSO_COMPILES[goos] === token;
}

/**
 * The name the suffix rule reads: everything before the FIRST `.` — so `x_linux.pb.go` still carries the
 * `_linux` constraint while `a.b_amd64.go` carries no constraint from its `.b_amd64.go` tail — with one
 * trailing `_test` off.
 */
function ruleBaseName(path: string): string {
  const name = basename(path);
  const dot = name.indexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  return stem.endsWith("_test") ? stem.slice(0, -"_test".length) : stem;
}

type PortSuffix = { readonly goos?: string; readonly goarch?: string };

/**
 * The port constraint a base name carries, matching Go's `goodOSArchFile`: everything up to and including
 * the FIRST underscore is dropped, so the first underscore-segment is never a GOOS token and a name with
 * no underscore carries no constraint. The last segment is the architecture when it is a known arch, and
 * the segment before it also names the operating system only when the name has at least three segments —
 * which is why `linux_amd64.go` requires amd64 alone while `foo_linux_amd64.go` requires linux too.
 * Otherwise a last segment that is a known OS is an OS constraint.
 */
function portSuffix(base: string, known: KnownPorts): PortSuffix | undefined {
  const segments = base.split("_");
  if (segments.length < 2) return undefined;
  const last = segments[segments.length - 1] ?? "";
  if (known.goarch.has(last)) {
    const beforeLast = segments[segments.length - 2] ?? "";
    if (segments.length >= 3 && known.goos.has(beforeLast)) return { goos: beforeLast, goarch: last };
    return { goarch: last };
  }
  return known.goos.has(last) ? { goos: last } : undefined;
}

/**
 * Whether `path`'s FILENAME keeps it out of the package graph under `port`'s GOOS/GOARCH. A file excluded
 * by a `//go:build` line instead is invisible to this test — that is the limit the tool's description
 * states, not a case this function misses quietly.
 */
export function filenameExcluded(path: string, port: TargetPort, known: KnownPorts): boolean {
  const suffix = portSuffix(ruleBaseName(path), known);
  if (suffix === undefined) return false;
  if (suffix.goos !== undefined && !hostTakesGoos(suffix.goos, port.goos)) return true;
  return suffix.goarch !== undefined && suffix.goarch !== port.goarch;
}

/** The blind-spot block that sits beside `environment` in `scope`. */
export interface OsArchExcluded extends CappedList {
  readonly namedFileExcluded: boolean;
}

/**
 * The filename-excluded subset of `goFiles`, counted exactly and capped at
 * `OS_ARCH_EXCLUDED_LIMIT` — the same ranking `uncoveredSources` emits, for the same reason.
 * `namedFileExcluded` says the caller's own `file` is in the set, which matters because the two directions
 * disagree about such a file: gopls still answers an outline and an `interfaces-implemented-by-type` query
 * for it, while it is absent from every other interface's implementer set.
 */
export function osArchExcluded(
  goFiles: readonly string[],
  port: TargetPort,
  known: KnownPorts,
  namedFile?: string,
): OsArchExcluded {
  const ranked = rankPaths(goFiles.filter((file) => filenameExcluded(file, port, known)));
  return {
    ...summariseRanked(ranked, OS_ARCH_EXCLUDED_LIMIT),
    namedFileExcluded: namedFile === undefined ? false : ranksFile(ranked, namedFile),
  };
}
