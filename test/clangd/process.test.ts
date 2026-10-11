import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachLifecycleHandlers } from "../../src/lsp/process.js";
import { clangdConfig } from "../../src/lsp/server-config.js";

/** What `attachLifecycleHandlers` is told the spawn attempted; the error text is built from it. */
const attempt = { config: clangdConfig, attempted: "clangd", fromOverride: false };

describe("attachLifecycleHandlers", () => {
  it("marks the process dead and disposes the connection on an 'error' event", () => {
    const child = new EventEmitter();
    const dispose = vi.fn();
    const { isAlive } = attachLifecycleHandlers(child, { dispose }, attempt);
    expect(isAlive()).toBe(true);
    child.emit("error", new Error("spawn clangd ENOENT"));
    expect(isAlive()).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("marks the process dead and disposes the connection on an 'exit' event", () => {
    const child = new EventEmitter();
    const dispose = vi.fn();
    const { isAlive } = attachLifecycleHandlers(child, { dispose }, attempt);
    child.emit("exit", 1, null);
    expect(isAlive()).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the connection only once even if both 'error' and 'exit' fire", () => {
    const child = new EventEmitter();
    const dispose = vi.fn();
    attachLifecycleHandlers(child, { dispose }, attempt);
    child.emit("error", new Error("boom"));
    child.emit("exit", 1, null);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

/**
 * The arguments the clangd child is started with. `--background-index` is clangd's own default today and
 * is written here anyway: the project-wide C++ answers are computed from that index, so a build that is
 * one upstream default away from answering a different question is not a contract.
 */
describe("clangdConfig.argv", () => {
  it("asks for the background index by flag instead of inheriting it, and names the database directory", () => {
    expect(clangdConfig.argv("C:/build")).toEqual([
      "--compile-commands-dir=C:/build",
      "--background-index=true",
      "--log=error",
    ]);
  });
});
