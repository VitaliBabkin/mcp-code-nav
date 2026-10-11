import { describe, expect, it } from "vitest";
import {
  filenameExcluded,
  knownPorts,
  OS_ARCH_EXCLUDED_LIMIT,
  osArchExcluded,
  parseDistList,
  type TargetPort,
} from "../../src/gopls/os-arch-excluded.js";

/**
 * The filename half of the blind-spot signal: Go's `_GOOS` / `_GOARCH` /
 * `_GOOS_GOARCH` suffix rule as `goodOSArchFile` applies it, driven name by name against a stated host.
 */

const PORTS = knownPorts();

const host = (goos: string, goarch = "amd64"): TargetPort => ({ goos, goarch });

/** Only the base name is read, so every case hangs off one directory. */
const at = (name: string): string => `/mod/${name}`;

/** `[file name, host GOOS, host GOARCH, excluded]` — the host is part of every row. */
const RULE_CASES: readonly (readonly [string, string, string, boolean])[] = [
  // A `_GOOS` suffix on its own.
  ["foo_linux.go", "windows", "amd64", true],
  ["foo_windows.go", "windows", "amd64", false],
  ["foo_plan9.go", "windows", "amd64", true],
  ["y_zos.go", "windows", "amd64", true],
  ["foo_nacl.go", "windows", "amd64", true],
  // A `_GOARCH` suffix on its own.
  ["foo_amd64.go", "windows", "amd64", false],
  ["foo_arm64.go", "windows", "amd64", true],
  ["foo_386.go", "windows", "amd64", true],
  // The pair, which needs a name before it: the first underscore-segment is never a GOOS token.
  ["foo_linux_amd64.go", "windows", "amd64", true],
  ["foo_windows_amd64.go", "windows", "amd64", false],
  ["foo_windows_386.go", "windows", "amd64", true],
  ["foo_plan9_mips.go", "windows", "amd64", true],
  ["foo_linux_amd64.go", "linux", "amd64", false],
  ["foo_darwin_arm64.go", "linux", "amd64", true],
  ["linux_amd64.go", "windows", "amd64", false],
  ["windows_amd64.go", "windows", "amd64", false],
  ["linux_amd64.go", "linux", "arm64", true],
  ["darwin_arm64.go", "windows", "amd64", true],
  ["darwin_arm64.go", "windows", "arm64", false],
  // No underscore, no constraint — however the name reads.
  ["linux.go", "windows", "amd64", false],
  ["amd64.go", "windows", "amd64", false],
  ["mips.go", "windows", "amd64", false],
  ["storage.go", "windows", "amd64", false],
  // A token that is not one of Go's lists constrains nothing.
  ["foo_unknown_token.go", "windows", "amd64", false],
  ["run_sh.go", "windows", "amd64", false],
  ["foo_sh64.go", "windows", "amd64", false],
  ["foo_mipsn32.go", "windows", "amd64", false],
  // The last segment is what counts; a token in the middle of the name does not.
  ["foo_linux_extra.go", "windows", "amd64", false],
  ["foo__linux.go", "windows", "amd64", true],
  // `_test` comes off first, then the rule applies to the rest.
  ["foo_test.go", "windows", "amd64", false],
  ["foo_linux_test.go", "windows", "amd64", true],
  ["foo_windows_test.go", "windows", "amd64", false],
  ["foo_linux_amd64_test.go", "windows", "amd64", true],
  // The name is cut at the FIRST dot, which is what makes a generated `.pb.go` a constrained file.
  ["x_linux.pb.go", "windows", "amd64", true],
  ["x_windows.pb.go", "windows", "amd64", false],
  ["a.b_amd64.go", "windows", "amd64", false],
  ["a.b_linux.go", "windows", "amd64", false],
];

describe("filenameExcluded", () => {
  it.each(RULE_CASES)("excludes %s on %s/%s: %s", (name, goos, goarch, excluded) => {
    expect(filenameExcluded(at(name), host(goos, goarch), PORTS)).toBe(excluded);
  });

  it("honours the aliases, one way only", () => {
    const android = host("android");
    expect(filenameExcluded(at("foo_linux.go"), android, PORTS)).toBe(false);
    expect(filenameExcluded(at("foo_android.go"), android, PORTS)).toBe(false);
    expect(filenameExcluded(at("foo_darwin.go"), android, PORTS)).toBe(true);
    expect(filenameExcluded(at("foo_android.go"), host("linux"), PORTS)).toBe(true);

    expect(filenameExcluded(at("foo_solaris.go"), host("illumos"), PORTS)).toBe(false);
    expect(filenameExcluded(at("foo_linux.go"), host("illumos"), PORTS)).toBe(true);
    expect(filenameExcluded(at("foo_android.go"), host("solaris"), PORTS)).toBe(true);

    const ios = host("ios", "arm64");
    expect(filenameExcluded(at("foo_darwin.go"), ios, PORTS)).toBe(false);
    expect(filenameExcluded(at("foo_ios.go"), ios, PORTS)).toBe(false);
    expect(filenameExcluded(at("foo_linux.go"), ios, PORTS)).toBe(true);
  });

  it("applies the alias to the GOOS half of a _GOOS_GOARCH pair too", () => {
    expect(filenameExcluded(at("foo_linux_arm64.go"), host("android", "arm64"), PORTS)).toBe(false);
    expect(filenameExcluded(at("foo_linux_arm64.go"), host("android", "amd64"), PORTS)).toBe(true);
  });
});

describe("the compiled-in port lists", () => {
  it("knows every operating system and architecture Go's syslist names", () => {
    for (const goos of ["aix", "hurd", "js", "nacl", "plan9", "wasip1", "zos", "illumos", "dragonfly"]) {
      expect(PORTS.goos.has(goos)).toBe(true);
    }
    for (const goarch of ["386", "wasm", "mips64p32le", "s390x", "riscv64", "loong64", "armbe", "arm64be"]) {
      expect(PORTS.goarch.has(goarch)).toBe(true);
    }
  });

  it("does not know the names Go's list never carried", () => {
    for (const token of ["sh", "sh64", "mipsn32", "mipsn32le", "android_386", "wasm32"]) {
      expect(PORTS.goos.has(token)).toBe(false);
      expect(PORTS.goarch.has(token)).toBe(false);
    }
  });
});

describe("parseDistList and knownPorts", () => {
  it("takes one GOOS/GOARCH pair per line and ignores anything else", () => {
    const tokens = parseDistList("linux/amd64\nwindows/arm64\n\nnot a port\nandroid/386 extra\n");
    expect(tokens).toEqual({ goos: ["linux", "windows"], goarch: ["amd64", "arm64"] });
  });

  it("only ever adds tokens to the compiled-in list", () => {
    const narrowed = knownPorts(parseDistList("linux/amd64\n"));
    expect(narrowed.goos.has("plan9")).toBe(true);
    expect(narrowed.goarch.has("mips64p32le")).toBe(true);
    const widened = knownPorts(parseDistList("newos/newarch\nlinux/amd64\n"));
    expect(widened.goos.has("newos")).toBe(true);
    expect(widened.goarch.has("newarch")).toBe(true);
  });

  it("lets a port only dist list names constrain a file", () => {
    const ports = knownPorts(parseDistList("newos/amd64\n"));
    expect(filenameExcluded(at("foo_newos.go"), host("windows"), PORTS)).toBe(false);
    expect(filenameExcluded(at("foo_newos.go"), host("windows"), ports)).toBe(true);
  });
});

describe("osArchExcluded", () => {
  it("counts every excluded file exactly and caps only the list", () => {
    const files = Array.from({ length: OS_ARCH_EXCLUDED_LIMIT + 5 }, (_unused, index) =>
      at(`f${String(index).padStart(3, "0")}_linux.go`),
    );
    const block = osArchExcluded([...files, at("keep.go"), at("disk_windows.go")], host("windows"), PORTS);
    expect(block.count).toBe(files.length);
    expect(block.files).toHaveLength(OS_ARCH_EXCLUDED_LIMIT);
    expect(block.namedFileExcluded).toBe(false);
  });

  it("reports a module with nothing filename-excluded as a real empty", () => {
    const files = [at("storage.go"), at("storage_windows.go"), at("gen.pb.go")];
    expect(osArchExcluded(files, host("windows"), PORTS)).toEqual({
      count: 0,
      files: [],
      namedFileExcluded: false,
    });
  });

  it("names one file once and lists the prefix in normalised order", () => {
    const files = [at("z_linux.go"), at("a_linux.go"), at("a_linux.go"), at("m_linux.go")];
    const block = osArchExcluded(files, host("windows"), PORTS);
    expect(block.count).toBe(3);
    expect(block.files).toEqual([at("a_linux.go"), at("m_linux.go"), at("z_linux.go")]);
  });

  it("says when the caller's own file is in the set, and when it is not", () => {
    const files = [at("storage.go"), at("disk_linux.go")];
    expect(osArchExcluded(files, host("windows"), PORTS, at("disk_linux.go")).namedFileExcluded).toBe(true);
    expect(osArchExcluded(files, host("windows"), PORTS, at("storage.go")).namedFileExcluded).toBe(false);
    // A file the module walk never reported is not in the set, whatever its name looks like.
    expect(osArchExcluded(files, host("windows"), PORTS, at("elsewhere_linux.go")).namedFileExcluded).toBe(false);
  });
});
