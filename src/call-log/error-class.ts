/**
 * The class a call-log record gives a failure. A result this server built names its reason where its text is
 * written, and the log prefers that; this table classifies what carries none: the MCP SDK's own refusals, and
 * every result read back from a transcript, which holds the text and nothing else.
 */
import { ERROR_REASONS, type ErrorReason } from "../error-reason.js";

/**
 * Matched top-down, first hit wins, so an anchor always states the more specific cause of the two a text
 * could belong to: `compile_commands.json not found or unreadable` before any `not found`, the cold-index
 * refusal before the `no declaration named` refusal it also contains, the readiness timeout before the
 * generic `<n> ms budget` it also names.
 *
 * Each anchor is a phrase its own producer emits — not a paraphrase — which is what makes a reworded error
 * fail a test instead of drifting into `internal`. A class here is always an {@link ERROR_REASONS} member, and
 * a producer that names a reason beside its text names the class its anchor gives.
 */
const ERROR_CLASS_TABLE: readonly {
  readonly errorClass: ErrorReason;
  readonly anchors: readonly RegExp[];
}[] = [
  { errorClass: "compile-db-missing", anchors: [/compile_commands\.json not found or unreadable/] },
  {
    errorClass: "compile-db-invalid",
    anchors: [
      /compile_commands\.json is not valid JSON/,
      /compile_commands\.json is not a compile database/,
    ],
  },
  {
    errorClass: "input-invalid",
    anchors: [
      /Input validation error:/,
      /is neither a file nor a directory/,
      /is not a TypeScript or JavaScript source/,
      /has no package metadata for/,
      /no project anchor could be opened/,
    ],
  },
  { errorClass: "tool-unknown", anchors: [/Tool \S+ not found/] },
  {
    errorClass: "path-escape",
    anchors: [/escapes every declared root/, /outside every declared source/],
  },
  { errorClass: "path-ambiguous", anchors: [/exists under more than one declared root/] },
  { errorClass: "path-ignored", anchors: [/is pre-excluded by this project's/] },
  // The locator text echoes npm's stderr, which can itself say `no such file or directory`, so it is matched
  // before the class that phrase belongs to.
  {
    errorClass: "server-unavailable",
    anchors: [/Cannot start (clangd|gopls|tsgo):/, /failed to spawn /],
  },
  {
    errorClass: "file-not-found",
    anchors: [/no such file or directory/, /does not exist, so nothing was searched/],
  },
  {
    errorClass: "no-module",
    anchors: [/is not inside a Go module/, /is not inside an npm package/],
  },
  {
    errorClass: "session-lost",
    anchors: [/has no live process to notify/, /restarted during the query about/],
  },
  {
    errorClass: "not-ready",
    anchors: [
      /was not yet confirmed warm/,
      /not reportable as an answer/,
      /never reported the initial workspace load/,
      /could not prove within its \d+ ms budget that the documents/,
    ],
  },
  {
    errorClass: "symbol-kind-unsupported",
    anchors: [
      /is not called, so no one calls it/,
      /only a function or a method has callers/,
      /only named types and interfaces have a direction/,
      /the direction of this question cannot be decided/,
      /so it is not callable/,
      /only an interface, class, method or property has implementations/,
      /\(it is an? [^)]*\), and only those four hold addressable members/,
    ],
  },
  { errorClass: "sweep-failed", anchors: [/translation units with the same error/] },
  {
    errorClass: "budget-exceeded",
    anchors: [/\d+ ms budget/, /\d+ ms ceiling/, /ran out of the call's/],
  },
  {
    errorClass: "symbol-ambiguous",
    anchors: [
      /is ambiguous/,
      /matches \d+ top-level declarations in/,
      /picking one would be a guess/,
      /will not pick between them/,
    ],
  },
  {
    errorClass: "symbol-not-found",
    anchors: [
      /no symbol "/,
      /no top-level declaration named "/,
      /no declaration named "/,
      /matched nothing in /,
      /declares nothing named "/,
      /cannot be addressed in "/,
    ],
  },
];

const HEAD_MAX_CHARS = 80;
const HEAD_SCAN_CHARS = 512;

/** The reason a value names, when it is one of {@link ERROR_REASONS}; anything else names none. */
export function reasonOf(value: unknown): ErrorReason | null {
  return ERROR_REASONS.find((reason) => reason === value) ?? null;
}

export function classifyError(text: string): { errorClass: ErrorReason; errorHead: string } {
  const entry = ERROR_CLASS_TABLE.find((candidate) =>
    candidate.anchors.some((anchor) => anchor.test(text)),
  );
  return {
    errorClass: entry?.errorClass ?? "internal",
    errorHead: errorHead(text),
  };
}

/**
 * The text's first line with every `"…"` segment folded, then every absolute path — a drive path or a
 * slash-rooted one — and then every digit run, so the report can group unclassified failures without carrying
 * a path, a symbol name or a count. A rooted path is only a path at a word boundary, so `and/or/other` and
 * `a/b/c` stay prose; a token ends at whitespace, so a path containing a space folds only up to that space.
 * The line is cut to a scanned bound before the masks run, because a slash-heavy token of any length costs
 * this a linear pass, not a backtracking one.
 */
function errorHead(text: string): string {
  const [firstLine = ""] = text.split("\n", 1);
  return firstLine
    .slice(0, HEAD_SCAN_CHARS)
    .replaceAll(/"[^"]*"/g, `"…"`)
    .replaceAll(/([A-Za-z]:[\\/]|(?<!\w)\/)[^\s"'`]*/g, (path: string) =>
      isRootedPath(path) ? "…" : path,
    )
    .replaceAll(/\d+/g, "#")
    .slice(0, HEAD_MAX_CHARS);
}

/** A drive path is rooted by shape; a slash path has to be slash-rooted and hold a second slash. */
function isRootedPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || (path.startsWith("/") && path.includes("/", 1));
}
