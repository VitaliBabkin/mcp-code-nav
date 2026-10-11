import { describe, expect, it } from "vitest";
import { resolveCallLogConfig } from "../../src/call-log/config.js";

describe("resolveCallLogConfig", () => {
  it("is off when the variable is unset, so nothing is recorded unless a directory is named", () => {
    expect(resolveCallLogConfig({})).toEqual({ kind: "off" });
    expect(resolveCallLogConfig({ MCP_CODE_NAV_OTHER: "1" })).toEqual({ kind: "off" });
  });

  it("stays off on `off`, which creates nothing anywhere", () => {
    expect(resolveCallLogConfig({ MCP_CODE_NAV_CALL_LOG: "off" })).toEqual({ kind: "off" });
  });

  it("turns on for an absolute directory the caller named", () => {
    expect(resolveCallLogConfig({ MCP_CODE_NAV_CALL_LOG: "D:\\scratch\\calls" })).toEqual({
      kind: "on",
      dir: "D:\\scratch\\calls",
    });
  });

  it("refuses a relative directory, which would mean whatever directory the client started us in", () => {
    expect(resolveCallLogConfig({ MCP_CODE_NAV_CALL_LOG: "scratch/calls" })).toEqual({
      kind: "invalid",
      value: "scratch/calls",
    });
  });

  it("refuses an empty value rather than reading it as `off`", () => {
    expect(resolveCallLogConfig({ MCP_CODE_NAV_CALL_LOG: "" })).toEqual({ kind: "invalid", value: "" });
  });

  it("refuses a drive-relative path, which resolves against the drive's current directory", () => {
    expect(resolveCallLogConfig({ MCP_CODE_NAV_CALL_LOG: "C:calls" })).toEqual({
      kind: "invalid",
      value: "C:calls",
    });
  });

  it("reads the switch from the environment it was handed, never from the live process", () => {
    const env: NodeJS.ProcessEnv = { MCP_CODE_NAV_CALL_LOG: "off" };
    resolveCallLogConfig(env);
    expect(env.MCP_CODE_NAV_CALL_LOG).toBe("off");
  });
});
