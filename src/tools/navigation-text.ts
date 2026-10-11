// What a navigation answer that refused looks like, in either language: the union that carries the refusal,
// and the texts that phrase one. Nothing here names a language server or a language — a C++ tool and a Go
// tool refuse the same kinds of thing (an ambiguous candidate, a kind that cannot answer the question) and
// each has to say so in the caller's words, so neither should import the other's prelude to do it.

import { dirname, relative, sep } from "node:path";
import type { FreshnessOutcome } from "../lsp/session.js";

/** Either the answer, or the text this tool fails with. Never both, and never a silent narrowing. */
export type Step<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** The gate a tool that refuses no kind passes to a prelude that expects one. */
export function acceptAnyDeclaration(): Step<void> {
  return { ok: true, value: undefined };
}

/** One candidate the caller has to choose between, in the shape both listing refusals print. */
export function candidateText(name: string, kind: string, file: string, line: number | string): string {
  return `  - ${name} (${kind}) at ${file}:${line}`;
}

/** `a` or `an`, chosen on the kind name a refusal text quotes. */
export function withArticle(kind: string): string {
  return /^[aeiou]/i.test(kind) ? `an ${kind}` : `a ${kind}`;
}

/**
 * What the answering server's graph was proved against: the change set pushed to the
 * running process, a session thrown away because the disk could not be proved, or nothing to correct. The
 * phrase is the same whichever language the answer is about, because the outcome the caller reads is the
 * engine's, not a server's.
 */
export function freshnessText(freshness: FreshnessOutcome): string {
  if (freshness.kind === "pushed") return `pushed ${freshness.changedFiles} changed file(s)`;
  if (freshness.kind === "reloaded") return `reloaded - ${freshness.reason}`;
  return "unchanged";
}

/**
 * The declaration's container: its file's directory relative to the root the answer is scoped to (a Go
 * module, a TypeScript workspace), POSIX-separated, `"."` for a file in the root itself. Derived from two
 * paths the call already holds, so no server answer is read into it — a server's own `containerName` arrives
 * for only some lookups and spells a container in its own scheme, not this payload's.
 */
export function containerOf(file: string, root: string): string {
  const directory = relative(root, dirname(file));
  return directory === "" ? "." : directory.split(sep).join("/");
}

/** The `; a and b` tail a summary adds when a cap dropped something, empty when it dropped nothing. */
export function capsText(parts: readonly (string | undefined)[]): string {
  const dropped = parts.filter((part): part is string => part !== undefined);
  return dropped.length === 0 ? "" : `; ${dropped.join(" and ")}`;
}
