import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_SESSIONS,
  resolveClangdJobs,
  resolveSessionLimits,
} from "../../src/lsp/resource-limits.js";

describe("resolveSessionLimits", () => {
  it("uses the defaults for an unset or empty variable, silently", () => {
    const warn = vi.fn();
    const expected = { idleMs: DEFAULT_IDLE_MS, maxSessions: DEFAULT_MAX_SESSIONS };
    expect(resolveSessionLimits({}, warn)).toEqual(expected);
    expect(
      resolveSessionLimits({ MCP_CODE_NAV_IDLE_MS: "", MCP_CODE_NAV_MAX_SESSIONS: "" }, warn),
    ).toEqual(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads positive values and treats 0 as 'off' for both limits", () => {
    const warn = vi.fn();
    expect(
      resolveSessionLimits({ MCP_CODE_NAV_IDLE_MS: "5000", MCP_CODE_NAV_MAX_SESSIONS: "7" }, warn),
    ).toEqual({
      idleMs: 5000,
      maxSessions: 7,
    });
    expect(
      resolveSessionLimits({ MCP_CODE_NAV_IDLE_MS: "0", MCP_CODE_NAV_MAX_SESSIONS: "0" }, warn),
    ).toEqual({
      idleMs: 0,
      maxSessions: 0,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["abc", "-1", "1.5", " 5", "1e3", "0x10", "99999999999"])(
    "falls back and names the variable for %j",
    (value) => {
      const warn = vi.fn();
      expect(
        resolveSessionLimits(
          { MCP_CODE_NAV_IDLE_MS: value, MCP_CODE_NAV_MAX_SESSIONS: value },
          warn,
        ),
      ).toEqual({
        idleMs: DEFAULT_IDLE_MS,
        maxSessions: DEFAULT_MAX_SESSIONS,
      });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toContain("MCP_CODE_NAV_IDLE_MS");
      expect(warn.mock.calls[1]?.[0]).toContain("MCP_CODE_NAV_MAX_SESSIONS");
    },
  );
});

describe("resolveClangdJobs", () => {
  it.each([
    [1, 1],
    [2, 1],
    [4, 2],
    [8, 4],
    [64, 4],
  ])("derives min(4, max(1, cores / 2)) from %i cores: %i", (cores, jobs) => {
    expect(resolveClangdJobs({}, vi.fn(), cores)).toBe(jobs);
  });

  it("takes the operator's value", () => {
    expect(resolveClangdJobs({ MCP_CODE_NAV_CLANGD_JOBS: "12" }, vi.fn(), 2)).toBe(12);
  });

  it.each(["0", "-2", "many", " "])("falls back to the derived value for %j", (value) => {
    const warn = vi.fn();
    expect(resolveClangdJobs({ MCP_CODE_NAV_CLANGD_JOBS: value }, warn, 8)).toBe(4);
    expect(warn.mock.calls[0]?.[0]).toContain("MCP_CODE_NAV_CLANGD_JOBS");
  });
});

describe("clangd argv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("carries the worker count the operator named, resolved once per process", async () => {
    vi.stubEnv("MCP_CODE_NAV_CLANGD_JOBS", "7");
    vi.resetModules();
    const { clangdConfig, clangdNoDatabaseConfig } = await import("../../src/lsp/server-config.js");
    for (const config of [clangdConfig, clangdNoDatabaseConfig]) {
      expect(config.argv("/p")).toContain("-j=7");
      expect(config.argv("/p")).toContain("--pch-storage=disk");
    }

    vi.stubEnv("MCP_CODE_NAV_CLANGD_JOBS", "9");
    expect(clangdConfig.argv("/p")).toContain("-j=7");
  });

  it("warns once for an invalid value however many children start", async () => {
    vi.stubEnv("MCP_CODE_NAV_CLANGD_JOBS", "many");
    vi.resetModules();
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { clangdConfig } = await import("../../src/lsp/server-config.js");
      clangdConfig.argv("/p");
      clangdConfig.argv("/q");
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });
});
