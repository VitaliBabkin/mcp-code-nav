import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const CompileCommandEntry = z.object({
  directory: z.string(),
  file: z.string(),
});

const CompileCommandsSchema = z.array(CompileCommandEntry);

export class CompileDbNotFoundError extends Error {
  constructor(public readonly projectRoot: string) {
    super(`compile_commands.json not found or unreadable at "${projectRoot}"`);
    this.name = "CompileDbNotFoundError";
  }
}

/** Absolute paths of every translation unit named in `projectRoot/compile_commands.json`, deduplicated. */
export function listTranslationUnits(projectRoot: string): string[] {
  const dbPath = join(projectRoot, "compile_commands.json");
  let raw: string;
  try {
    raw = readFileSync(dbPath, "utf-8");
  } catch {
    throw new CompileDbNotFoundError(projectRoot);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${dbPath} is not valid JSON`, { cause: e });
  }
  const entries = CompileCommandsSchema.parse(parsed);
  const files = entries.map((entry) => resolve(entry.directory, entry.file));
  return Array.from(new Set(files));
}
