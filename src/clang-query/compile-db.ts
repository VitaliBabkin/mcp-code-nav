import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/** The shapes clang's own reader rejects: one such entry loses the whole file, and clangd then parses on default flags. */
const CompileCommandEntry = z
  .strictObject({
    directory: z.string(),
    file: z.string(),
    command: z.string().optional(),
    arguments: z.array(z.string()).optional(),
    output: z.unknown().optional(),
  })
  .refine((entry) => entry.command !== undefined || entry.arguments !== undefined, {
    message: 'missing key "command" or "arguments"',
  });

const CompileCommandsSchema = z.array(CompileCommandEntry);

export class CompileDbNotFoundError extends Error {
  constructor(public readonly projectRoot: string) {
    super(`compile_commands.json not found or unreadable at "${projectRoot}"`);
    this.name = "CompileDbNotFoundError";
  }
}

/**
 * The database is there and readable, but it is not JSON or not a compile database: nothing in it can be read as
 * a translation unit, and the file has to be fixed rather than located.
 */
export class CompileDbInvalidError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompileDbInvalidError";
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
    // clang reads past a byte-order mark, which Windows PowerShell's UTF-8 writer puts at the start of a file.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    throw new CompileDbInvalidError(`${dbPath} is not valid JSON`, { cause: e });
  }
  const entries = CompileCommandsSchema.safeParse(parsed);
  if (!entries.success) {
    throw new CompileDbInvalidError(
      `${dbPath} is not a compile database: ${firstIssueText(entries.error)}`,
      { cause: entries.error },
    );
  }
  const files = entries.data.map((entry) => resolve(entry.directory, entry.file));
  return Array.from(new Set(files));
}

/** The first problem zod found, by its path in the database, so a caller can find the entry that breaks it. */
function firstIssueText(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "unrecognised shape";
  const where = issue.path.map(String).join(".");
  return `${where === "" ? "the top level" : where}: ${issue.message}`;
}
