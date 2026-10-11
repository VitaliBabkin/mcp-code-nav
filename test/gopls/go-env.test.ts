import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildTagsFromGoFlags,
  makeGoExec,
  readToolchain,
  type GoExecFn,
  type GoToolchain,
} from "../../src/gopls/go-env.js";
import { pathKey } from "../../src/paths/path-containment.js";
import {
  exited,
  fakeGo,
  goEnvJson,
  killed,
  maxBufferExceeded,
  notOnPath,
  ran,
  spawnFailed,
  WINDOWS_AMD64,
  type FakeGo,
} from "../helpers/fake-go.js";

/**
 * The toolchain pass behind the `scope`: what `go` is asked, in which directory, under
 * which overrides, how the pass is cached, and what happens when it cannot be asked. The mocked cases
 * drive the injected `exec`; the `makeGoExec` cases run a real process this server controls, never `go`.
 */

let roots = 0;

/** Only a pass that answered is kept, so a case that fails on purpose still needs a root of its own. */
function nextRoot(): string {
  roots += 1;
  return `/mod/module${roots}`;
}

function passFor(go: FakeGo, root = nextRoot()): Promise<GoToolchain> {
  return readToolchain(root, go.exec);
}

/** The reason one mocked pass gave, failing the test if it answered instead. */
async function reasonOf(go: FakeGo): Promise<string> {
  const { environment } = await passFor(go);
  expect("unavailable" in environment, `expected no answer, got ${JSON.stringify(environment)}`).toBe(true);
  return "unavailable" in environment ? environment.unavailable : "";
}

const envJson = (overrides: Parameters<typeof goEnvJson>[0] = {}) => ran(goEnvJson(overrides));

describe("readToolchain", () => {
  it("asks the toolchain in the module, under the overrides that keep the answer local", async () => {
    const go = fakeGo();
    const root = nextRoot();

    await expect(passFor(go, root)).resolves.toEqual({
      environment: WINDOWS_AMD64,
      ports: expect.objectContaining({ goos: expect.any(Set), goarch: expect.any(Set) }),
    });
    expect(go.asked("env")).toMatchObject({
      args: ["env", "-json"],
      cwd: root,
      env: { GOWORK: "off", GOTOOLCHAIN: "local" },
    });
    expect(go.asked("dist")).toMatchObject({ args: ["tool", "dist", "list"], cwd: root });
    // The workspace question is asked without the override that answers it, or nothing could report one.
    expect(go.asked("work")).toMatchObject({ args: ["env", "GOWORK"], cwd: root, env: { GOTOOLCHAIN: "local" } });
    expect("GOWORK" in (go.asked("work")?.env ?? {})).toBe(false);
  });

  it("takes one pass per module root, whatever number of callers ask for it", async () => {
    const go = fakeGo();
    const late = fakeGo();
    const root = nextRoot();

    const [first, second] = await Promise.all([readToolchain(root, go.exec), readToolchain(root, late.exec)]);
    expect(second).toBe(first); // the later caller was handed the pass already running
    expect(go.calls).toHaveLength(3);
    expect(late.calls).toEqual([]); // whatever `exec` it brought was never run
  });

  it("asks a second module root again, because the answer is about a module", async () => {
    const go = fakeGo();
    const one = nextRoot();
    const two = nextRoot();

    await readToolchain(one, go.exec);
    await readToolchain(two, go.exec);

    expect(go.calls).toHaveLength(6);
    expect(new Set(go.calls.map((call) => call.cwd))).toEqual(new Set([one, two]));
  });

  it("retries a pass that could not be taken and caches one that answered", async () => {
    const broken = fakeGo({ env: notOnPath() });
    const healthy = fakeGo();
    const root = nextRoot();

    expect("unavailable" in (await readToolchain(root, broken.exec)).environment).toBe(true);
    expect(broken.calls).toHaveLength(3);

    const answered = await readToolchain(root, healthy.exec);
    expect("unavailable" in answered.environment).toBe(false);
    expect(healthy.calls).toHaveLength(3);
    // The retry answered, so from here the pass is the process's, not this call's.
    expect(await readToolchain(root, healthy.exec)).toBe(answered);
    expect(healthy.calls).toHaveLength(3);
  });

  it.each([
    ["", []],
    ["-mod=mod", []],
    ["-tags=a,b", ["a", "b"]],
    ["--tags=netgo", ["netgo"]],
    ['-tags="a,b"', ["a", "b"]],
    ["-tags=a -tags=b", ["b"]],
    ["-tags=a,b -tags=c", ["c"]],
    ["-tags=a,,b, ", ["a", "b"]],
    ["-tags=netgo,osusergo -mod=readonly", ["netgo", "osusergo"]],
    ["-tagsx=not", []],
  ])("reads the build tags out of GOFLAGS %s", (goFlags: string, tags: string[]) => {
    expect(buildTagsFromGoFlags(goFlags)).toEqual(tags);
  });

  it("reports the tags and cgo setting a real `go env -json` answer carries", async () => {
    const go = fakeGo({ env: envJson({ GOFLAGS: "-tags=netgo,local -mod=mod", CGO_ENABLED: "0" }) });

    await expect(passFor(go).then((pass) => pass.environment)).resolves.toMatchObject({
      cgoEnabled: false,
      buildTags: ["netgo", "local"],
    });
  });

  it.each([
    ["", null],
    ["off", null],
    ["  off \n", null],
    ["\n", null],
    ["/home/dev/code/go.work", "/home/dev/code/go.work"],
    ["C:\\dev\\go.work\n", "C:\\dev\\go.work"],
  ])("reads a GOWORK answer of %s as %s", async (stdout: string, goWork: string | null) => {
    const go = fakeGo({ work: ran(stdout) });

    await expect(passFor(go).then((pass) => pass.environment)).resolves.toMatchObject({ goWork });
  });

  it("takes the child's overrides from the language-server config, not from a second copy", async () => {
    const go = fakeGo();

    await passFor(go);

    for (const kind of ["env", "work"] as const) {
      expect(go.asked(kind)?.env.GOTOOLCHAIN).toBe("local");
    }
  });
});

describe("the reason a pass could not state the environment", () => {
  it("says go is not on PATH when the binary was not there", async () => {
    const reason = await reasonOf(fakeGo({ env: notOnPath() }));

    expect(reason).toMatch(/^go is not on PATH, so the toolchain's GOOS, GOARCH and build tags/);
    expect(reason).toContain("ENOENT");
  });

  it("reports a non-zero exit as the exit it was", async () => {
    const reason = await reasonOf(fakeGo({ env: exited(2, "go: unknown env var") }));

    expect(reason).toMatch(/exited with code 2 while asked about/);
    expect(reason).toContain("go: unknown env var");
  });

  it.each([
    ["EPERM", spawnFailed("EPERM")],
    ["the stdout ceiling", maxBufferExceeded()],
  ])("names a failure around the process (%s) without claiming the binary is missing", async (_name, result) => {
    const reason = await reasonOf(fakeGo({ env: result }));

    expect(reason).toMatch(/the go call about .* did not answer/);
    expect(reason).not.toMatch(/is not on PATH|could not be started|exited with code/);
  });

  it("names a call that produced no answer and no exit code", async () => {
    expect(await reasonOf(fakeGo({ env: killed("", "signal: killed") }))).toMatch(
      /never reported an exit code: signal: killed/,
    );
  });

  it.each([
    ["not json at all", /did not answer with JSON this server can read/],
    ["[1,2]", /did not answer with JSON this server can read/],
    ["null", /did not answer with JSON this server can read/],
    ['{"GOOS":"linux"}', /without a GOOS and GOARCH value/],
    ['{"GOOS":"","GOARCH":"amd64","CGO_ENABLED":"1"}', /without a GOOS and GOARCH value/],
    ['{"GOOS":"linux","GOARCH":"amd64","CGO_ENABLED":"maybe"}', /CGO_ENABLED=maybe/],
    ['{"GOOS":"linux","GOARCH":"amd64"}', /CGO_ENABLED=undefined/],
  ])("refuses to guess from the answer %s", async (stdout: string, reason: RegExp) => {
    expect(await reasonOf(fakeGo({ env: ran(stdout) }))).toMatch(reason);
  });

  it("says which question went unanswered when only the workspace read fails", async () => {
    const reason = await reasonOf(fakeGo({ work: exited(1, "go: error reading go.work") }));

    expect(reason).toMatch(/while asked about whether a go\.work is in effect/);
  });

  it("carries the reason an exec threw, instead of failing the call with it", async () => {
    const throwing: GoExecFn = async () => {
      throw new Error("spawn blew up");
    };
    const { environment } = await readToolchain(nextRoot(), throwing);

    expect("unavailable" in environment && environment.unavailable).toContain("spawn blew up");
    expect("unavailable" in environment && environment.unavailable).toMatch(/could not run go to ask about/);
  });
});

describe("the port list of a pass", () => {
  it("adds what dist list named to the compiled-in tokens", async () => {
    const go = fakeGo({ dist: ran("linux/amd64\nnewos/newarch\n") });
    const { ports } = await passFor(go);

    expect(ports.goos.has("newos")).toBe(true);
    expect(ports.goarch.has("newarch")).toBe(true);
  });

  it("keeps the compiled-in tokens when dist list cannot be run, in the same pass that answers the environment", async () => {
    const go = fakeGo({ dist: exited(1, "dist: unknown command") });
    const { ports, environment } = await passFor(go);

    expect(ports.goos.has("plan9")).toBe(true);
    expect(ports.goarch.has("wasm")).toBe(true);
    expect(ports.goos.has("unknown")).toBe(false);
    expect("unavailable" in environment).toBe(false);
  });
});

describe("makeGoExec against real processes", () => {
  it("reports a real non-zero exit as an exit code, with nothing failed around it", async () => {
    const result = await makeGoExec(process.execPath)(["-e", "process.exit(2)"], tmpdir(), {});

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 2 });
  });

  it("reports a missing binary as a spawn code and no exit code", async () => {
    const result = await makeGoExec("mcp-code-nav-no-such-binary")(["env", "-json"], tmpdir(), {});

    expect(result.exitCode).toBeUndefined();
    expect(result.spawnCode).toBe("ENOENT");
  });

  it("runs where it was told to, with its overlay merged over the parent environment", async () => {
    const script = 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), tag: process.env.MCP_CODE_NAV_TEST_TAG }))';
    const result = await makeGoExec(process.execPath)(["-e", script], tmpdir(), {
      MCP_CODE_NAV_TEST_TAG: "local",
    });

    expect(result.exitCode).toBe(0);
    const answered = JSON.parse(result.stdout) as { cwd: string; tag: string };
    expect(pathKey(answered.cwd)).toBe(pathKey(tmpdir()));
    expect(answered.tag).toBe("local");
  });
});
