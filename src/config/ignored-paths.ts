import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod";

/**
 * Bounds on `ignoredPaths`. The patterns come from the project being read and run synchronously through
 * minimatch on every call, so a pattern with many wildcards, braces or numeric ranges can pin the process.
 */
export const IGNORED_PATH_LIMITS = {
  maxPatterns: 100,
  maxPatternLength: 200,
  maxStars: 6,
  maxBraces: 2,
  maxExtglobParens: 2,
} as const;

function countOf(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** The first limit `pattern` breaks, as a sentence naming the rule, or `undefined` when it is within all of them. */
function limitViolation(pattern: string): string | undefined {
  const L = IGNORED_PATH_LIMITS;
  if (pattern.includes("\0")) return "must not contain NUL";
  if (countOf(pattern, "*") > L.maxStars) return `may contain at most ${L.maxStars} '*' characters`;
  if (countOf(pattern, "{") > L.maxBraces) return `may contain at most ${L.maxBraces} '{' characters`;
  if (/\{[^}]*\.\./.test(pattern)) return "must not use a numeric or alphabetic range inside braces";
  if (countOf(pattern, "(") > L.maxExtglobParens) return `may contain at most ${L.maxExtglobParens} '(' characters`;
  return undefined;
}

const PatternSchema = z
  .string()
  .min(1)
  .max(IGNORED_PATH_LIMITS.maxPatternLength)
  .superRefine((pattern, ctx) => {
    const violation = limitViolation(pattern);
    if (violation !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ignoredPaths pattern ${violation}` });
  });

const ConfigSchema = z.object({
  ignoredPaths: z.array(PatternSchema).max(IGNORED_PATH_LIMITS.maxPatterns).default([]),
});

const CONFIG_FILE_NAME = "mcp-code-nav.config.json";

/**
 * Loads `mcp-code-nav.config.json` from `projectRoot`. Absent file means no
 * pre-excluded paths — this is the only case this
 * function treats as non-fatal; a present-but-malformed file is a caller
 * misconfiguration and throws.
 */
export function loadIgnoredPaths(projectRoot: string): string[] {
  const configPath = join(projectRoot, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`failed to read ${configPath}`, { cause: e });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${configPath} is not valid JSON`, { cause: e });
  }
  return ConfigSchema.parse(parsed).ignoredPaths;
}

/**
 * `ignoredPaths` for a signal that filters the sources it names: a config this call cannot read costs the
 * field, not the call, so the failure is a value rather than a throw. An absent config is `loadIgnoredPaths`'s
 * own empty answer, which is a real "nothing is pre-excluded", not a failure to look.
 */
export function readIgnoredPatterns(projectRoot: string): string[] | undefined {
  try {
    return loadIgnoredPaths(resolve(projectRoot));
  } catch {
    return undefined;
  }
}

/** Matches `absoluteFile` (already validated within `projectRoot`) against `ignoredPaths` glob patterns. */
export function isIgnoredPath(
  projectRoot: string,
  absoluteFile: string,
  ignoredPaths: readonly string[],
): boolean {
  if (ignoredPaths.length === 0) return false;
  const rel = relative(projectRoot, absoluteFile).split("\\").join("/");
  return ignoredPaths.some((pattern) => minimatch(rel, pattern));
}
