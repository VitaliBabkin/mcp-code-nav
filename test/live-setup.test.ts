import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import setup from "./live-setup.js";

const MISSING = join(process.cwd(), "no-such-gopls-binary");
const saved = { gopls: process.env.MCP_CODE_NAV_GOPLS, require: process.env.MCP_CODE_NAV_LIVE_REQUIRE };

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("MCP_CODE_NAV_GOPLS", saved.gopls);
  restore("MCP_CODE_NAV_LIVE_REQUIRE", saved.require);
  vi.restoreAllMocks();
});

describe("the live suite's global setup", () => {
  it("states which tools it found and does not fail when nothing is required", async () => {
    process.env.MCP_CODE_NAV_GOPLS = MISSING;
    delete process.env.MCP_CODE_NAV_LIVE_REQUIRE;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(setup()).resolves.toBeUndefined();

    expect(String(info.mock.calls[0]?.[0])).toContain("gopls: NOT FOUND");
  }, 60_000);

  it("fails the run when a required tool is missing, instead of letting its files skip", async () => {
    process.env.MCP_CODE_NAV_GOPLS = MISSING;
    process.env.MCP_CODE_NAV_LIVE_REQUIRE = "gopls";
    vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(setup()).rejects.toThrow("requires gopls");
  }, 60_000);

  it("fails the run on a tool name it does not know, so a typo requires nothing silently", async () => {
    process.env.MCP_CODE_NAV_LIVE_REQUIRE = "goplz";
    vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(setup()).rejects.toThrow("unknown tools: goplz");
  }, 60_000);
});
