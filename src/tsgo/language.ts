import { extname } from "node:path";

/**
 * The LSP `languageId` tsgo is told for a document, by extension. One process answers TypeScript and
 * JavaScript, so unlike clangd and gopls this server's id is a property of the file;
 * a `.tsx` opened as `typescript` is parsed as TypeScript without JSX, which is a wrong answer about the
 * file rather than a different spelling of the right one.
 */
const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};

/** The extensions a TS/JS tool accepts a path for; the same set the ids above are keyed by. */
const SOURCE_EXTENSIONS = new Set(Object.keys(LANGUAGE_IDS));

/**
 * The id for `file`. An extension outside the set is opened as TypeScript: a request reaching here with one
 * is a caller that did not check `isTsOrJsSourceFile`, and TypeScript is what tsgo itself assumes for a file
 * it cannot classify, so the fallback states nothing the server would not have said anyway.
 */
export function tsLanguageId(file: string): string {
  return LANGUAGE_IDS[extname(file).toLowerCase()] ?? "typescript";
}

/** Whether `file` is one of the TS-family or JS-family sources this backend answers for. */
export function isTsOrJsSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(file).toLowerCase());
}

/** The accepted extensions, in the order a refusal names them. */
export const TS_SOURCE_EXTENSIONS: readonly string[] = [...SOURCE_EXTENSIONS];
