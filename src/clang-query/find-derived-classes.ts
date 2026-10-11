import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { listTranslationUnits } from "./compile-db.js";
import type { SweepCache, TuOutcome } from "./sweep-cache.js";

/** One matched class declaration, and how it reaches the queried base. */
export interface DerivedClassMatch {
  readonly className: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** This declaration names the queried base in its own base-specifier list (`isDirectlyDerivedFrom`). */
  readonly direct: boolean;
}

export interface ClangQueryExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injection seam for tests — real execution shells out to the `clang-query` binary. */
export type ClangQueryExecFn = (args: string[], cwd: string, signal?: AbortSignal) => Promise<ClangQueryExecResult>;

const execFileAsync = promisify(execFile);

export const defaultClangQueryExec: ClangQueryExecFn = async (args, cwd, signal) => {
  try {
    const { stdout, stderr } = await execFileAsync("clang-query", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      signal,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    // Node kills the child and rejects when `signal` fires — that is an interruption, not a compile
    // failure, so it must propagate as a rejection for the sweep's abort handling to recognize it,
    // rather than being folded into a normal (wrong) failedFiles entry below.
    if (signal?.aborted) throw e;
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), exitCode: err.code ?? 1 };
  }
};

/** A genuine `clang-query` failure on one translation unit (compile error) — never "zero matches". */
export interface FailedFile {
  file: string;
  error: string;
}

// Each `match ....bind("derived")` / `bind("direct")` command prints one such note per match; the
// identifier itself is not in this line (the diagnostic text format isn't a stable API
// surface to parse), so this only extracts the location and `extractIdentifierAt` reads the
// name straight from the source, which record-decl locations point at directly. The bind name is a
// closed alternation, so a stray note can never create a row.
// clang-query's diagnostic format depends on the compiler driver recorded in compile_commands.json:
// plain clang++/clang emits GNU-style `path:line:col:`; clang-cl.exe (the MSVC-compatible Windows driver)
// emits MSVC-style `path(line,col):` instead; both forms are tried per line, GNU first.
const BIND_LINE = /^(.+):(\d+):(\d+):\s+note:\s+"(derived|direct)" binds here$/;
const BIND_LINE_MSVC = /^(.+)\((\d+),(\d+)\):\s+note:\s+"(derived|direct)" binds here$/;

// A cxxRecordDecl bind location is the START OF THE FULL DECLARATION, not the identifier token: the
// `class`/`struct` keyword for a plain class, and the `template` keyword that opens the header for every
// class-template form except the primary pattern. The name is found by skipping
// the template header(s), the optional class/struct/union keyword and any attributes; a bind location
// that already points at the identifier passes through untouched.
const IDENTIFIER = /[A-Za-z_]\w*/y;
const CLASS_KEY = /(?:class|struct|union)\b/y;
const ATTRIBUTE_WITH_PARENS = /(?:alignas|__declspec|__attribute__)\s*\(/y;

// A name that is really a leftover declaration keyword means the skip logic lost its way (e.g. a header or
// `requires` clause that never ends) - that is an extraction failure, never a class named `requires`.
const NEVER_A_CLASS_NAME = new Set([
  "alignas",
  "class",
  "concept",
  "enum",
  "requires",
  "struct",
  "template",
  "typename",
  "union",
  "using",
]);

function matchAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

function skipTrivia(text: string, start: number): number {
  let pos = start;
  for (;;) {
    while (pos < text.length && /\s/.test(text[pos] as string)) pos++;
    if (text.startsWith("//", pos)) {
      const eol = text.indexOf("\n", pos);
      pos = eol < 0 ? text.length : eol + 1;
    } else if (text.startsWith("/*", pos)) {
      const end = text.indexOf("*/", pos + 2);
      pos = end < 0 ? text.length : end + 2;
    } else {
      return pos;
    }
  }
}

const CLOSER_OF: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

/** Position just past the literal opening at `pos`, or undefined when it never closes. */
function skipLiteral(text: string, pos: number): number | undefined {
  const quote = text[pos] as string;
  for (let i = pos + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === quote) return i + 1;
    else if (ch === "\n") return undefined;
  }
  return undefined;
}

/** `'` between two hex digits is a digit separator (`1'000`), not the start of a character literal. */
function isDigitSeparator(text: string, pos: number): boolean {
  return /[0-9a-fA-F]/.test(text[pos - 1] ?? "") && /[0-9a-fA-F]/.test(text[pos + 1] ?? "");
}

/**
 * Position just past the bracket that closes the one at `open`, or undefined when it never closes.
 * Only `opener`/`closer` count toward the depth: every other bracket kind is skipped as a whole, and
 * comments and string/character literals are skipped, so a `>` inside `(N > 0)` or `"x>y"` cannot close a
 * `<...>` header.
 */
function skipBalanced(text: string, open: number, opener: string, closer: string): number | undefined {
  let depth = 0;
  let pos = open;
  while (pos < text.length) {
    const ch = text[pos] as string;
    const afterTrivia = skipTrivia(text, pos);
    if (afterTrivia !== pos) {
      pos = afterTrivia;
    } else if (text.startsWith("->", pos)) {
      pos += 2;
    } else if (ch === '"' || (ch === "'" && !isDigitSeparator(text, pos))) {
      const end = skipLiteral(text, pos);
      if (end === undefined) return undefined;
      pos = end;
    } else if (ch === opener) {
      depth++;
      pos++;
    } else if (ch === closer && --depth === 0) {
      return pos + 1;
    } else if (ch in CLOSER_OF && ch !== opener) {
      const end = skipBalanced(text, pos, ch, CLOSER_OF[ch] as string);
      if (end === undefined) return undefined;
      pos = end;
    } else {
      pos++;
    }
  }
  return undefined;
}

/**
 * Position of the `class`/`struct`/`union` key, or of the next `template` head, that ends the
 * constraint-expression starting at `start` (just past `requires`); undefined when there is none. A
 * constraint never holds a depth-0 class key: brackets, `<...>` (an unparenthesized `<` in a requires-clause
 * is always a template argument list), comments and literals are skipped whole, and a `template` right after
 * `::` or `.` is a dependent-name disambiguator, not a head.
 */
function skipRequiresClause(text: string, start: number): number | undefined {
  let pos = start;
  let last = "";
  while (pos < text.length) {
    const afterTrivia = skipTrivia(text, pos);
    if (afterTrivia !== pos) {
      pos = afterTrivia;
      continue;
    }
    const word = matchAt(IDENTIFIER, text, pos)?.[0];
    if (word !== undefined) {
      const endsClause = word === "class" || word === "struct" || word === "union" ||
        (word === "template" && last !== ":" && last !== ".");
      if (endsClause) return pos;
      pos += word.length;
      last = "w";
      continue;
    }
    const ch = text[pos] as string;
    let end: number | undefined = pos + 1;
    if (ch === '"' || (ch === "'" && !isDigitSeparator(text, pos))) end = skipLiteral(text, pos);
    else if (ch === "<") end = skipBalanced(text, pos, "<", ">");
    else if (ch in CLOSER_OF) end = skipBalanced(text, pos, ch, CLOSER_OF[ch] as string);
    if (end === undefined) return undefined;
    pos = end;
    last = ch;
  }
  return undefined;
}

/**
 * Position of the first token after `template <...>` and its optional `requires` clause, or undefined when
 * `pos` is not at a header or the header or clause never ends.
 */
function skipTemplateHeader(text: string, pos: number): number | undefined {
  const keyword = matchAt(IDENTIFIER, text, pos);
  if (keyword?.[0] !== "template") return undefined;
  const open = skipTrivia(text, pos + keyword[0].length);
  if (text[open] !== "<") return undefined;
  const end = skipBalanced(text, open, "<", ">");
  if (end === undefined) return undefined;
  const next = skipTrivia(text, end);
  const clause = matchAt(IDENTIFIER, text, next)?.[0];
  return clause === "requires" ? skipRequiresClause(text, next + clause.length) : next;
}

function skipAttributes(text: string, start: number): number {
  let pos = start;
  for (;;) {
    if (text.startsWith("[[", pos)) {
      const end = skipBalanced(text, pos, "[", "]");
      if (end === undefined) return pos;
      pos = skipTrivia(text, end);
      continue;
    }
    const withParens = matchAt(ATTRIBUTE_WITH_PARENS, text, pos);
    if (!withParens) return pos;
    const end = skipBalanced(text, pos + withParens[0].length - 1, "(", ")");
    if (end === undefined) return pos;
    pos = skipTrivia(text, end);
  }
}

function classNameAt(text: string, start: number): string | undefined {
  let pos = skipTrivia(text, start);
  for (let next = skipTemplateHeader(text, pos); next !== undefined; next = skipTemplateHeader(text, pos)) {
    pos = next;
  }
  pos = skipAttributes(text, pos);
  const key = matchAt(CLASS_KEY, text, pos);
  if (key) pos = skipAttributes(text, skipTrivia(text, pos + key[0].length));
  const name = matchAt(IDENTIFIER, text, pos)?.[0];
  return name === undefined || NEVER_A_CLASS_NAME.has(name) ? undefined : name;
}

const NON_ASCII = /[^\x00-\x7f]/;

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

/**
 * clang counts columns in UTF-8 bytes; `text` is UTF-16. Returns the string offset of the 1-based byte
 * `column` on the line starting at `lineStart`, or undefined when it lies past the line or inside a
 * multi-byte sequence.
 */
function columnOffset(text: string, lineStart: number, column: number): number | undefined {
  const target = column - 1;
  if (!NON_ASCII.test(text.slice(lineStart, lineStart + target))) return lineStart + target;
  let bytes = 0;
  let pos = lineStart;
  while (bytes < target) {
    const codePoint = text.codePointAt(pos);
    if (codePoint === undefined || codePoint === 0x0a) return undefined;
    bytes += utf8Length(codePoint);
    pos += codePoint > 0xffff ? 2 : 1;
  }
  return bytes === target ? pos : undefined;
}

function offsetOf(content: string, line: number, column: number): number | undefined {
  let lineStart = 0;
  for (let l = 1; l < line; l++) {
    const eol = content.indexOf("\n", lineStart);
    if (eol < 0) return undefined;
    lineStart = eol + 1;
  }
  return columnOffset(content, lineStart, column);
}

function extractIdentifierAt(
  readFile: (path: string) => string,
  file: string,
  line: number,
  column: number,
): string | undefined {
  let content: string;
  try {
    content = readFile(file);
  } catch {
    return undefined;
  }
  const offset = offsetOf(content, line, column);
  return offset === undefined || offset > content.length ? undefined : classNameAt(content, offset);
}

/** Tuning constant, not a contract: clamp(availableParallelism() - 1, 1, 8). */
function defaultMaxParallel(): number {
  return Math.min(8, Math.max(1, availableParallelism() - 1));
}

/** Sized above a whole sweep of any measured project, so hitting it means something is wrong — not that the work is large. */
export const DEFAULT_SWEEP_CEILING_MS = 300_000;

/** What one resolved translation unit adds to the sweep. Units, cadence and transport are the caller's choice. */
export interface SweepProgress {
  readonly sweptTus: number;
  readonly totalTus: number;
  readonly elapsedMs: number;
}

export interface FindDerivedClassesOptions {
  projectRoot: string;
  qualifiedName: string;
  /** Absolute translation-unit paths to sweep; omitted sweeps every TU in compile_commands.json. */
  translationUnits?: string[];
  exec?: ClangQueryExecFn;
  readFile?: (path: string) => string;
  /** Omit either `cache` or `fingerprint` to run uncached (the mocked unit suite does). */
  cache?: SweepCache;
  fingerprint?: string;
  /** Default clamp(os.availableParallelism() - 1, 1, 8) — a host-resource tuning constant, not a contract. */
  maxParallel?: number;
  /** Ceiling for this one call, default `DEFAULT_SWEEP_CEILING_MS`. Not a chunk — the sweep is not resumed by design. */
  timeBudgetMs?: number;
  /** The MCP request's signal; aborting kills in-flight clang-query children. */
  signal?: AbortSignal;
  /** Called once per resolved (non-aborted) TU, after its outcome is cached. */
  onProgress?: (info: SweepProgress) => void;
}

export interface SweepStats {
  readonly totalTus: number;
  readonly cachedTus: number;
  readonly elapsedMs: number;
  readonly cache: "hit" | "partial" | "miss" | "disabled";
  readonly cacheReason?: string;
}

/** Every translation unit that ran, ran and failed the same way — a whole-sweep failure, not an empty hierarchy. */
export interface UniformSweepFailure {
  readonly error: string;
  readonly failedTus: number;
}

export interface FindDerivedClassesResult {
  matches: DerivedClassMatch[];
  failedFiles: FailedFile[];
  /** Present only when the sweep did not cover its whole scope. */
  incomplete?: { readonly sweptTus: number; readonly totalTus: number; readonly reason: "time-budget" | "cancelled" };
  /** Present only on a complete sweep whose every translation unit failed with one identical error. */
  uniformFailure?: UniformSweepFailure;
  sweep: SweepStats;
}

/** One bind location within a TU, with `direct` OR-ed from every note that reported that location. */
interface TuLocation {
  file: string;
  line: number;
  column: number;
  direct: boolean;
}

// Measured against clang-query 22.1.3: a matcher parse error is written to STDOUT, after the commands that
// did parse have printed their own output, and stderr stays empty. These are the only lines that say why.
const DIAGNOSTIC_LINE = /error|not found/i;

/**
 * Why `clang-query` failed on this TU: stderr when it has anything, else the stdout diagnostics (the first
 * two lines — one bad matcher costs an `Error parsing argument` line plus a `Matcher not found` line), else
 * the last stdout line, else the fixed fallback.
 */
function failureText(result: ClangQueryExecResult): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const diagnostics = lines.filter((line) => DIAGNOSTIC_LINE.test(line));
  if (diagnostics.length > 0) return diagnostics.slice(0, 2).join(" ");
  return lines.at(-1) ?? "non-zero exit, no stderr captured";
}

/**
 * `clang-query` ran cleanly on this TU — its own matches, minus any bind whose identifier could not
 * be read from source. That narrower failure is NOT part of the cached outcome (it is a source-read
 * anomaly at the moment of the call, not a stable property of the TU worth invalidating a whole cache
 * entry over) — it is still surfaced in `failedFiles` on the fresh computation that found it, exactly
 * as before this cache existed; a later cache hit for this TU simply won't recompute it.
 */
function computeFreshOutcome(
  readFile: (path: string) => string,
  projectRoot: string,
  result: ClangQueryExecResult,
): { outcome: TuOutcome; extractionFailures: FailedFile[] } {
  if (result.exitCode !== 0) {
    return { outcome: { kind: "failed", error: failureText(result) }, extractionFailures: [] };
  }
  const locations = new Map<string, TuLocation>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = BIND_LINE.exec(line) ?? BIND_LINE_MSVC.exec(line);
    if (!m) continue;
    // clang-query echoes back whatever spelling the compile command used for this TU — a relative
    // spelling produces a relative note-path here, which is meaningless against this process's own
    // cwd. resolve() is a no-op when rawFile is already absolute, matching compile-db.ts's existing
    // pattern for the compile database's own directory/file pairs.
    const rawFile = m[1] as string;
    const file = resolve(projectRoot, rawFile);
    const lineNo = Number(m[2] as string);
    const column = Number(m[3] as string);
    const direct = m[4] === "direct";
    const key = `${file}:${lineNo}:${column}`;
    const known = locations.get(key);
    if (known) known.direct ||= direct;
    else locations.set(key, { file, line: lineNo, column, direct });
  }

  const matches: DerivedClassMatch[] = [];
  const extractionFailures: FailedFile[] = [];
  // One read of the source per location, after every note was consumed, so a location both commands
  // reported still yields one row and an unreadable one still yields exactly one failedFiles entry.
  for (const location of locations.values()) {
    const className = extractIdentifierAt(readFile, location.file, location.line, location.column);
    if (className) {
      matches.push({ ...location, className });
    } else {
      extractionFailures.push({
        file: location.file,
        error:
          `clang-query reported a match at ${location.file}:${location.line}:${location.column}, but the ` +
          "identifier there could not be read (source unreadable, or unexpected content at that location) — " +
          "the match was not silently dropped.",
      });
    }
  }
  return { outcome: { kind: "matches", matches }, extractionFailures };
}

/**
 * What the sweep accumulates as translation units are accounted for — the cached replay and the pool
 * both write through it, so it is one named state rather than parallel locals.
 */
interface SweepAccumulator {
  readonly locations: Map<string, DerivedClassMatch>;
  readonly failedFiles: FailedFile[];
  /** Error of every TU whose outcome is `kind: "failed"`; one identical string across all of them is the uniform-failure signal. */
  readonly failureErrors: string[];
}

function mergeOutcome(acc: SweepAccumulator, tu: string, outcome: TuOutcome): void {
  if (outcome.kind === "failed") {
    acc.failedFiles.push({ file: tu, error: outcome.error });
    acc.failureErrors.push(outcome.error);
    return;
  }
  for (const match of outcome.matches) {
    const key = `${match.file}:${match.line}:${match.column}`;
    const alreadySeen = acc.locations.get(key);
    // OR-ed rather than first-wins, so the answer does not depend on which TU completed first. Re-setting
    // an existing key keeps its position, so a merged row never moves either.
    acc.locations.set(key, alreadySeen ? { ...alreadySeen, direct: alreadySeen.direct || match.direct } : match);
  }
}

/**
 * A complete sweep whose every TU failed with one identical error answered the wrong question: an empty
 * `matches` would read as "nothing derives from it" while the query itself never ran. The uniformity is
 * the signal, so nothing matches on `clang-query`'s stderr wording.
 */
function uniformSweepFailure(
  failureErrors: readonly string[],
  totalTus: number,
): UniformSweepFailure | undefined {
  if (totalTus === 0 || failureErrors.length !== totalTus) return undefined;
  const shared = failureErrors[0];
  if (shared === undefined || !failureErrors.every((error) => error === shared)) return undefined;
  return { error: shared, failedTus: failureErrors.length };
}

/**
 * The two `clang-query` commands one sweep issues per TU, both in the same invocation: the parse is the
 * cost, so the second traversal is effectively free and one stored outcome carries both views.
 */
function derivationMatchers(qualifiedName: string): readonly [transitive: string, direct: string] {
  return [
    `match cxxRecordDecl(isDerivedFrom(hasName("${qualifiedName}"))).bind("derived")`,
    `match cxxRecordDecl(isDirectlyDerivedFrom(hasName("${qualifiedName}"))).bind("direct")`,
  ];
}

/**
 * Runs `clang-query`'s `isDerivedFrom` and `isDirectlyDerivedFrom` matchers across every named
 * translation unit and unions the results, deduped by source location. Which of the two views a caller
 * wants is not this function's concern — it always computes both. A real `clang-query` failure on one TU
 * (a compile error) does NOT abort the sweep: it is recorded in `failedFiles` and the remaining TUs are
 * still swept.
 *
 * Pending (non-cached) TUs run through a bounded-parallel pool. The pool's
 * wall-clock bound is a ceiling for this one call, not a chunk of it. A TU interrupted by the ceiling or
 * by `signal` is never recorded in `failedFiles` and never cached — `failedFiles` keeps its
 * meaning exactly (a TU that ran and genuinely failed), so "we ran out of time" can never be confused
 * with "this TU is broken".
 *
 * A complete sweep in which every TU failed with the same error also reports `uniformFailure`, which
 * tells the caller the empty `matches` is that failure rather than an empty hierarchy. A TU that failed is
 * never cached, whatever else the sweep stores — its cause may be the environment, not the source.
 */
export async function findDerivedClasses(options: FindDerivedClassesOptions): Promise<FindDerivedClassesResult> {
  const run = resolveSweepRun(options, Date.now());
  const totalTus = run.translationUnits.length;
  const acc: SweepAccumulator = {
    locations: new Map<string, DerivedClassMatch>(),
    failedFiles: [],
    failureErrors: [],
  };
  const { pending, cachedTus } = replayCachedTus(run, acc);

  const { sweptCount, abortReason } =
    pending.length > 0
      ? await sweepPendingTus(run, acc, pending, cachedTus)
      : { sweptCount: 0, abortReason: undefined };

  const sweptTus = cachedTus + sweptCount;
  const incomplete =
    sweptTus < totalTus ? { sweptTus, totalTus, reason: abortReason ?? ("time-budget" as const) } : undefined;
  const uniformFailure = incomplete ? undefined : uniformSweepFailure(acc.failureErrors, totalTus);

  return {
    matches: Array.from(acc.locations.values()),
    failedFiles: acc.failedFiles,
    ...(incomplete ? { incomplete } : {}),
    ...(uniformFailure ? { uniformFailure } : {}),
    sweep: {
      totalTus,
      cachedTus,
      elapsedMs: Date.now() - run.startedAt,
      cache: cacheStatus(run.cacheReady, cachedTus, totalTus),
    },
  };
}

/** Why a sweep stopped before covering its scope. */
type AbortReason = "time-budget" | "cancelled";

/** One resolved sweep: the config every stage shares, derived once from the caller's options. */
interface SweepRun {
  readonly projectRoot: string;
  readonly qualifiedName: string;
  readonly exec: ClangQueryExecFn;
  readonly readFile: (path: string) => string;
  readonly translationUnits: string[];
  readonly matchers: readonly [transitive: string, direct: string];
  readonly cache: SweepCache | undefined;
  readonly fingerprint: string | undefined;
  readonly cacheReady: boolean;
  readonly maxParallel: number;
  readonly timeBudgetMs: number;
  readonly signal: AbortSignal | undefined;
  readonly onProgress: ((info: SweepProgress) => void) | undefined;
  readonly startedAt: number;
}

function resolveSweepRun(options: FindDerivedClassesOptions, startedAt: number): SweepRun {
  return {
    projectRoot: options.projectRoot,
    qualifiedName: options.qualifiedName,
    exec: options.exec ?? defaultClangQueryExec,
    readFile: options.readFile ?? ((p: string) => readFileSync(p, "utf-8")),
    translationUnits: options.translationUnits ?? listTranslationUnits(options.projectRoot),
    matchers: derivationMatchers(options.qualifiedName),
    cache: options.cache,
    fingerprint: options.fingerprint,
    cacheReady: options.cache !== undefined && options.fingerprint !== undefined,
    maxParallel: options.maxParallel ?? defaultMaxParallel(),
    timeBudgetMs: options.timeBudgetMs ?? DEFAULT_SWEEP_CEILING_MS,
    signal: options.signal,
    onProgress: options.onProgress,
    startedAt,
  };
}

/** argv for one TU: `-p <projectRoot> <tu>` plus one `-c` per matcher, transitive first. */
function clangQueryArgv(projectRoot: string, tu: string, matchers: readonly [string, string]): string[] {
  return ["-p", projectRoot, tu, "-c", matchers[0], "-c", matchers[1]];
}

function cachedOutcomesFor(run: SweepRun): ReadonlyMap<string, TuOutcome> {
  if (!run.cacheReady || run.cache === undefined || run.fingerprint === undefined) {
    return new Map<string, TuOutcome>();
  }
  return run.cache.lookup(run.projectRoot, run.qualifiedName, run.fingerprint);
}

/**
 * Only a clean outcome is stored. A failed one may come from the environment — `clang-query` missing from
 * PATH fails every TU identically — and replaying it after the caller fixed that is a stale answer, so a
 * failed TU is cheap to re-run instead.
 */
function storeCleanOutcome(run: SweepRun, tu: string, outcome: TuOutcome): void {
  if (!run.cacheReady || run.cache === undefined || run.fingerprint === undefined) return;
  if (outcome.kind !== "matches") return;
  run.cache.store(run.projectRoot, run.qualifiedName, run.fingerprint, tu, outcome);
}

/** Merges every already-cached TU and returns the translation units still needing a run. */
function replayCachedTus(run: SweepRun, acc: SweepAccumulator): { pending: string[]; cachedTus: number } {
  const cachedOutcomes = cachedOutcomesFor(run);
  const pending: string[] = [];
  let cachedTus = 0;
  for (const tu of run.translationUnits) {
    const cached = cachedOutcomes.get(tu);
    if (cached) {
      cachedTus++;
      mergeOutcome(acc, tu, cached);
    } else {
      pending.push(tu);
    }
  }
  return { pending, cachedTus };
}

/**
 * Runs every pending TU through a bounded-parallel pool under this call's wall-clock ceiling. A TU
 * interrupted by the ceiling or by `signal` is never checked, never counted and never stored.
 */
async function sweepPendingTus(
  run: SweepRun,
  acc: SweepAccumulator,
  pending: string[],
  cachedTus: number,
): Promise<{ sweptCount: number; abortReason: AbortReason | undefined }> {
  const controller = new AbortController();
  let sweptCount = 0;
  let abortReason: AbortReason | undefined;

  const timer = setTimeout(() => {
    abortReason = "time-budget";
    controller.abort();
  }, run.timeBudgetMs);

  const onCallerAbort = () => {
    abortReason = "cancelled";
    controller.abort();
  };
  if (run.signal?.aborted) {
    abortReason = "cancelled";
    controller.abort();
  } else if (run.signal) {
    run.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let nextIndex = 0;

  const runOne = async (tu: string): Promise<void> => {
    let result: ClangQueryExecResult;
    try {
      result = await run.exec(clangQueryArgv(run.projectRoot, tu, run.matchers), run.projectRoot, controller.signal);
    } catch {
      if (controller.signal.aborted) return; // interrupted — not a genuine clang-query failure
      // An exec implementation that throws for a reason other than the abort this sweep issued:
      // record it as a TU failure rather than letting one bad exec crash the whole sweep, matching
      // this function's own failure-isolation rule for a non-zero exit code.
      result = { exitCode: 1, stdout: "", stderr: "clang-query invocation threw unexpectedly" };
    }
    if (controller.signal.aborted) return; // settled after the budget/cancel fired — never checked
    const { outcome, extractionFailures } = computeFreshOutcome(run.readFile, run.projectRoot, result);
    mergeOutcome(acc, tu, outcome);
    acc.failedFiles.push(...extractionFailures);
    storeCleanOutcome(run, tu, outcome);
    sweptCount++;
    run.onProgress?.({
      sweptTus: cachedTus + sweptCount,
      totalTus: run.translationUnits.length,
      elapsedMs: Date.now() - run.startedAt,
    });
  };

  const poolSize = Math.min(run.maxParallel, pending.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < poolSize; w++) {
    workers.push(
      (async () => {
        while (!controller.signal.aborted) {
          const i = nextIndex++;
          if (i >= pending.length) return;
          await runOne(pending[i] as string);
        }
      })(),
    );
  }
  await Promise.all(workers);

  clearTimeout(timer);
  if (run.signal) run.signal.removeEventListener("abort", onCallerAbort);

  return { sweptCount, abortReason };
}

function cacheStatus(cacheReady: boolean, cachedTus: number, totalTus: number): SweepStats["cache"] {
  if (!cacheReady) return "disabled";
  if (totalTus > 0 && cachedTus === totalTus) return "hit";
  if (cachedTus > 0) return "partial";
  return "miss";
}
