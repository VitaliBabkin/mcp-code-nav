import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_REASONS, isRetryable, reasonFields, type ErrorReason } from "../src/error-reason.js";

/** Every reason with the retryable flag it carries, as the README's table states them. */
const SPEC: Readonly<Record<ErrorReason, boolean>> = {
  "input-invalid": false,
  "tool-unknown": false,
  "path-escape": false,
  "path-ambiguous": false,
  "path-ignored": false,
  "file-not-found": false,
  "no-module": false,
  "compile-db-missing": false,
  "compile-db-invalid": false,
  "server-unavailable": false,
  "symbol-not-found": false,
  "symbol-ambiguous": false,
  "symbol-kind-unsupported": false,
  "not-ready": true,
  "budget-exceeded": true,
  "request-timeout": true,
  "session-lost": true,
  cancelled: true,
  "sweep-failed": false,
  "unexpected-answer": false,
  internal: false,
};

const README = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");

/** The rows of the README's "Reading errors" table, each as its reason and its retryable flag. */
function readmeReasonRows(): { reason: string; retryable: string }[] {
  const text = readFileSync(README, "utf8");
  const start = text.indexOf("\n## Reading errors\n");
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end);
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const [reason = "", retryable = ""] = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      return { reason: reason.replaceAll("`", ""), retryable: retryable.replaceAll("`", "") };
    });
}

describe("the reason set", () => {
  it("is exactly the reasons the table in this file lists, each once", () => {
    expect([...ERROR_REASONS].sort()).toEqual(Object.keys(SPEC).sort());
    expect(new Set(ERROR_REASONS).size).toBe(ERROR_REASONS.length);
  });

  it.each(ERROR_REASONS.map((reason) => [reason] as const))(
    "decides the retryable flag %s carries, as the table states it",
    (reason) => {
      expect(typeof isRetryable(reason)).toBe("boolean");
      expect(isRetryable(reason)).toBe(SPEC[reason]);
    },
  );

  it("marks readiness, budgets, restarts and cancellation retryable, and every input or configuration fault not", () => {
    expect(ERROR_REASONS.filter((reason) => isRetryable(reason)).sort()).toEqual(
      ["budget-exceeded", "cancelled", "not-ready", "request-timeout", "session-lost"].sort(),
    );
  });

  it("pairs a reason with the flag it always carries", () => {
    expect(reasonFields("not-ready")).toEqual({ reason: "not-ready", retryable: true });
    expect(reasonFields("symbol-not-found")).toEqual({
      reason: "symbol-not-found",
      retryable: false,
    });
  });
});

describe("the README's Reading errors table", () => {
  it("lists exactly ERROR_REASONS, each once", () => {
    const rows = readmeReasonRows();
    expect(rows.map((row) => row.reason).sort()).toEqual([...ERROR_REASONS].sort());
  });

  it("states the retryable flag each reason carries", () => {
    for (const row of readmeReasonRows()) {
      const reason = row.reason as ErrorReason;
      expect(row.retryable, row.reason).toBe(String(isRetryable(reason)));
    }
  });
});
