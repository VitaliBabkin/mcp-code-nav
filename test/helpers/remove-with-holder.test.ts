import { describe, expect, it, vi } from "vitest";
import { holdersOf, removeFileNamingHolder } from "./remove-with-holder.js";

const OPTIONS = { maxRetries: 25, retryDelay: 200 };

function eperm(): Error {
  return Object.assign(new Error("EPERM: operation not permitted, rm 'D:\\mod\\disk.go'"), { code: "EPERM" });
}

describe("removeFileNamingHolder", () => {
  it("passes the retry budget through unchanged and says nothing when the delete succeeds", () => {
    const remove = vi.fn();
    const holders = vi.fn(() => "x (pid 1)");

    removeFileNamingHolder("D:\\mod\\disk.go", OPTIONS, { remove, holders });

    expect(remove).toHaveBeenCalledWith("D:\\mod\\disk.go", OPTIONS);
    expect(holders).not.toHaveBeenCalled();
  });

  it("names the holder after the final failure, keeping the original error first and as the cause", () => {
    const original = eperm();
    const thrown = catchError(() =>
      removeFileNamingHolder("D:\\mod\\disk.go", OPTIONS, {
        remove: () => {
          throw original;
        },
        holders: () => "gopls.exe (pid 4242); gopls.exe (pid 4243)",
      }),
    );

    expect(thrown.message.split("\n")[0]).toBe(original.message);
    expect(thrown.message).toContain('"D:\\mod\\disk.go" is held by: gopls.exe (pid 4242); gopls.exe (pid 4243)');
    expect(thrown.cause).toBe(original);
  });

  it("says the hold ended when no process is registered any more", () => {
    const thrown = catchError(() =>
      removeFileNamingHolder("D:\\mod\\disk.go", OPTIONS, {
        remove: () => {
          throw eperm();
        },
        holders: () => "",
      }),
    );

    expect(thrown.message).toContain("no process holds");
  });

  it("never lets a failed lookup mask the delete's own error", () => {
    const original = eperm();
    const thrown = catchError(() =>
      removeFileNamingHolder("D:\\mod\\disk.go", OPTIONS, {
        remove: () => {
          throw original;
        },
        holders: () => {
          throw new Error("powershell is not available");
        },
      }),
    );

    expect(thrown.message.split("\n")[0]).toBe(original.message);
    expect(thrown.message).toContain("could not be determined: powershell is not available");
    expect(thrown.cause).toBe(original);
  });
});

describe("the wrapped error", () => {
  it("keeps the fields a caller could branch on", () => {
    const original = eperm();
    const thrown = catchError(() =>
      removeFileNamingHolder("D:\\mod\\disk.go", OPTIONS, {
        remove: () => {
          throw original;
        },
        holders: () => "",
      }),
    ) as Error & { code?: string };

    expect(thrown.code).toBe("EPERM");
  });
});

describe("holdersOf", () => {
  const windowsOnly = process.platform === "win32" ? it : it.skip;
  const answering = (stdout: string, stderr = "") => () => ({ stdout, stderr });

  windowsOnly("reads the holders after the success sentinel, and an empty list as none", () => {
    expect(holdersOf("D:\\x", answering("OK:gopls.exe (pid 7)\r\n"))).toBe("gopls.exe (pid 7)");
    expect(holdersOf("D:\\x", answering("OK:\r\n"))).toBe("");
  });

  windowsOnly("treats output without the sentinel as a failed lookup, never as no holder", () => {
    expect(() => holdersOf("D:\\x", answering("", "Add-Type : error CS0103"))).toThrow(/Add-Type/);
    expect(() => holdersOf("D:\\x", answering("RmGetList failed: 5"))).toThrow(/RmGetList failed: 5/);
  });
});

function catchError(run: () => void): Error & { cause?: unknown } {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("the call was expected to throw");
}
