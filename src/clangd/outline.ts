/** LSP `SymbolKind` numeric values (LSP spec 3.17), mapped to lowercase names used in this server's output. */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? `unknown(${kind})`;
}

/** Raw shape of an LSP `DocumentSymbol` (the hierarchical variant clangd returns), fields this server reads. */
export interface LspDocumentSymbol {
  name: string;
  kind: number;
  /**
   * LSP always sends the character offsets; they are optional here because a line is all the C++
   * consumers read, and a caller that has them matches positions rather than lines.
   */
  range: { start: { line: number; character?: number }; end: { line: number; character?: number } };
  /**
   * The declaration's own name range. A position for a type-aware request must land inside it: on a
   * Go `type` keyword rather than the identifier, gopls answers `no identifier found`.
   */
  selectionRange?: { start: { line: number; character: number }; end?: { line: number; character: number } };
  children?: LspDocumentSymbol[];
}

export interface OutlineSymbol {
  name: string;
  kind: string;
  range: { startLine: number; endLine: number };
  children?: OutlineSymbol[];
}

/**
 * Guards against a server answering with the flat `SymbolInformation[]` shape (`location.range`, a
 * `containerName`, no `range`/`children`) instead of the nested `DocumentSymbol[]` shape this module
 * assumes. That fallback only happens if the client's `initialize` capabilities omit
 * `textDocument.documentSymbol.hierarchicalDocumentSymbolSupport` — every `LanguageServerConfig` in
 * `src/lsp/server-config.ts` declares it — but a raw process response is never something to trust
 * blindly, so a missing `range` fails loudly and by name instead of a bare "Cannot read properties of
 * undefined" a few frames down.
 */
function assertHierarchical(s: LspDocumentSymbol): void {
  if (!s.range) {
    throw new Error(
      `the language server returned a flat SymbolInformation entry ("${s.name}") instead of a hierarchical ` +
        "DocumentSymbol — hierarchicalDocumentSymbolSupport may be missing from the client capabilities.",
    );
  }
}

/**
 * Converts clangd's raw `DocumentSymbol[]` into this server's output shape, truncated to `depth`
 * levels of children. `namespace` containers are transparent to the depth budget: unwrapping one
 * never consumes `depth`, so `depth` counts nesting starting from the first non-namespace
 * container (class/struct/enum/function) — otherwise `depth`'s default of 1 is fully spent
 * unwrapping a C++ codebase's routine `namespace a { namespace b { ... } }` wrapper and never
 * reaches the class or method it exists to surface.
 */
export function toOutline(symbols: LspDocumentSymbol[], depth: number): OutlineSymbol[] {
  return symbols.map((s) => {
    assertHierarchical(s);
    const kind = symbolKindName(s.kind);
    const out: OutlineSymbol = {
      name: s.name,
      kind,
      // LSP lines are 0-based; this server's output is 1-based to match editor/human conventions.
      range: { startLine: s.range.start.line + 1, endLine: s.range.end.line + 1 },
    };
    const isNamespace = kind === "namespace";
    if ((isNamespace || depth > 0) && s.children && s.children.length > 0) {
      out.children = toOutline(s.children, isNamespace ? depth : depth - 1);
    }
    return out;
  });
}

/** Flattens a (possibly truncated) outline into a single list, tagging each entry with its ancestor qualified path. */
export interface FlatSymbol {
  qualifiedPath: string[];
  name: string;
  kind: string;
  range: { startLine: number; endLine: number };
  /**
   * Where the declaration's OWN identifier is, in the server's 0-based coordinates — the start of the
   * entry's `selectionRange`, and the only position of it a type-aware request may be asked at. `range`
   * is the whole declaration and starts on the `class`/`template` keyword for a C++ class, so it is never
   * one. Absent when the server named no identifier span for this entry, which costs a request about that
   * entry, never the entry itself.
   */
  namePosition?: { line: number; character: number };
}

export function flattenOutline(symbols: LspDocumentSymbol[], parentPath: string[] = []): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  for (const s of symbols) {
    assertHierarchical(s);
    const path = [...parentPath, s.name];
    out.push({
      qualifiedPath: path,
      name: s.name,
      kind: symbolKindName(s.kind),
      range: { startLine: s.range.start.line + 1, endLine: s.range.end.line + 1 },
      namePosition: s.selectionRange?.start,
    });
    if (s.children && s.children.length > 0) {
      out.push(...flattenOutline(s.children, path));
    }
  }
  return out;
}
