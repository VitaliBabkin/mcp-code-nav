import { describe, expect, it } from "vitest";
import { CompileDbInvalidError, CompileDbNotFoundError } from "../../src/clang-query/compile-db.js";
import type { ErrorReason } from "../../src/error-reason.js";
import {
  RequestAbortedError,
  RequestTimeoutError,
  ServerExitedError,
} from "../../src/lsp/request-control.js";
import { clangdConfig, LanguageServerUnavailableError } from "../../src/lsp/server-config.js";
import { AmbiguousRelativePathError, PathEscapeError } from "../../src/paths/resolve-safe-path.js";
import { reasonOfError } from "../../src/tools/reason-of-error.js";
import { IgnoredPathError } from "../../src/tools/shared.js";

/** A Node system error, as the fs layer throws it: an `Error` with a `code`. */
function systemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("reasonOfError, read from the type of the failure", () => {
  const cases: readonly {
    readonly name: string;
    readonly failure: unknown;
    readonly reason: ErrorReason;
  }[] = [
    {
      name: "PathEscapeError",
      failure: new PathEscapeError(["D:/root"], "D:/elsewhere/a.cpp"),
      reason: "path-escape",
    },
    {
      name: "AmbiguousRelativePathError",
      failure: new AmbiguousRelativePathError("dup.cpp", ["D:/one/dup.cpp", "D:/two/dup.cpp"]),
      reason: "path-ambiguous",
    },
    {
      name: "IgnoredPathError",
      failure: new IgnoredPathError("gen/a.cpp"),
      reason: "path-ignored",
    },
    {
      name: "CompileDbNotFoundError",
      failure: new CompileDbNotFoundError("D:/build"),
      reason: "compile-db-missing",
    },
    {
      name: "CompileDbInvalidError",
      failure: new CompileDbInvalidError("compile_commands.json is not valid JSON"),
      reason: "compile-db-invalid",
    },
    {
      name: "LanguageServerUnavailableError",
      failure: new LanguageServerUnavailableError(
        { config: clangdConfig, attempted: "clangd", fromOverride: false },
        { code: "ENOENT" },
      ),
      reason: "server-unavailable",
    },
    {
      name: "RequestTimeoutError",
      failure: new RequestTimeoutError("gopls", "textDocument/references", 1000),
      reason: "request-timeout",
    },
    {
      name: "RequestAbortedError",
      failure: new RequestAbortedError("gopls", "textDocument/references"),
      reason: "cancelled",
    },
    {
      name: "ServerExitedError",
      failure: new ServerExitedError("gopls exited", new Error("Connection is closed.")),
      reason: "session-lost",
    },
  ];

  for (const one of cases) {
    it(`maps ${one.name} to ${one.reason}`, () => {
      expect(reasonOfError(one.failure)).toBe(one.reason);
    });
  }

  it("maps a Node error whose code is ENOENT to file-not-found, and any other code to internal", () => {
    expect(
      reasonOfError(systemError("ENOENT", "ENOENT: no such file or directory, open 'a.ts'")),
    ).toBe("file-not-found");
    expect(reasonOfError(systemError("EACCES", "EACCES: permission denied, open 'a.ts'"))).toBe(
      "internal",
    );
  });

  it("maps a plain Error, which names no type, to internal", () => {
    expect(reasonOfError(new Error("something unexpected"))).toBe("internal");
  });

  it("maps a thrown value that is not an Error to internal, unless it carries an ENOENT code", () => {
    expect(reasonOfError("boom")).toBe("internal");
    expect(reasonOfError(42)).toBe("internal");
    expect(reasonOfError(undefined)).toBe("internal");
    expect(reasonOfError(null)).toBe("internal");
    expect(reasonOfError({ code: "ENOENT" })).toBe("file-not-found");
    expect(reasonOfError({ message: "no code here" })).toBe("internal");
  });
});

describe("reasonOfError through the cause chain a wrapper leaves", () => {
  it("reads a timeout wrapped in a plain Error, which is how a stderr tail is appended", () => {
    const wrapped = new Error("gopls did not answer textDocument/references within 1000 ms", {
      cause: new RequestTimeoutError("gopls", "textDocument/references", 1000),
    });

    expect(reasonOfError(wrapped)).toBe("request-timeout");
  });

  it("reads through more than one wrapper", () => {
    const deep = new Error("outer", {
      cause: new Error("middle", { cause: new PathEscapeError(["D:/root"], "D:/x/a.cpp") }),
    });

    expect(reasonOfError(deep)).toBe("path-escape");
  });

  it("reads an ENOENT under a wrapper as file-not-found", () => {
    const wrapped = new Error("could not read", {
      cause: systemError("ENOENT", "ENOENT: no such file or directory"),
    });

    expect(reasonOfError(wrapped)).toBe("file-not-found");
  });

  it("answers the outermost type that names a reason, not one further in", () => {
    const outer = new RequestTimeoutError("gopls", "textDocument/references", 1000);
    const wrapped = new Error("outer", {
      cause: systemError("ENOENT", "ENOENT: no such file or directory"),
    });
    Object.assign(outer, { cause: wrapped });

    expect(reasonOfError(outer)).toBe("request-timeout");
  });

  it("answers internal for a chain that names no reason", () => {
    expect(reasonOfError(new Error("a", { cause: new Error("b", { cause: "c" }) }))).toBe(
      "internal",
    );
  });

  it("stops at a cause chain that loops back on itself, and answers internal", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    Object.assign(first, { cause: second });

    expect(reasonOfError(first)).toBe("internal");
  });
});
