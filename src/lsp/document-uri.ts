import { pathToFileURL } from "node:url";

/** The `file:` URI that names a document, built by `node:url` rather than by string surgery. */
export function fileUri(path: string): string {
  return pathToFileURL(path).toString();
}

/** The `textDocument` identifier every document-scoped request and notification carries. */
export function textDocumentId(path: string): { uri: string } {
  return { uri: fileUri(path) };
}
