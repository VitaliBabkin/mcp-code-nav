import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const CPP_SOURCE_EXTENSIONS = new Set([".cpp", ".cc", ".cxx", ".mm"]);
const HEADER_EXTENSIONS = [".h", ".hpp", ".hh", ".hxx"];

export function isCppSourceFile(file: string): boolean {
  return CPP_SOURCE_EXTENSIONS.has(extname(file).toLowerCase());
}

/**
 * Candidate declaring-header paths for a `.cpp`/`.cc`/`.cxx`/`.mm` file: same basename in the same directory,
 * then in sibling `include`/`inc` directories relative to the file's own directory.
 */
export function candidateHeaders(cppFile: string): string[] {
  const dir = dirname(cppFile);
  const base = basename(cppFile, extname(cppFile));
  const candidates: string[] = [];
  for (const ext of HEADER_EXTENSIONS) {
    candidates.push(join(dir, base + ext));
  }
  for (const siblingDirName of ["include", "inc"]) {
    const siblingDir = join(dir, "..", siblingDirName);
    for (const ext of HEADER_EXTENSIONS) {
      candidates.push(join(siblingDir, base + ext));
    }
  }
  return candidates;
}

/** First candidate header that exists on disk, or `undefined` if none do. */
export function resolveHeaderCounterpart(cppFile: string, exists: (p: string) => boolean = existsSync): string | undefined {
  return candidateHeaders(cppFile).find(exists);
}
