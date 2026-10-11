import type { FlatSymbol } from "../clangd/outline.js";

export type SymbolKindFilter = "class" | "function" | "method" | "constructor";

export interface FindSymbolQuery {
  name: string;
  kind?: SymbolKindFilter;
}

/** Splits `ns::Class::method` into path segments; a bare name is a single-segment path. */
export function splitQualifiedName(name: string): string[] {
  return name.split("::").filter((s) => s.length > 0);
}

/**
 * Matches a flattened outline against a qualified-name query. The query's segments must match
 * the symbol's OWN trailing path segments in order, so `Class::method` also matches a symbol
 * nested under an enclosing namespace (`ns::Class::method`); a bare single-segment query
 * matches on name alone regardless of nesting depth. Generic in the entry type because a caller
 * may carry its own fields on the entry: this selects, it never copies.
 */
export function matchSymbols<T extends FlatSymbol>(flat: readonly T[], query: FindSymbolQuery): T[] {
  const segments = splitQualifiedName(query.name);
  const matches = flat.filter((s) => {
    const path = s.qualifiedPath;
    if (segments.length > path.length) return false;
    const tail = path.slice(path.length - segments.length);
    if (tail.some((seg, i) => seg !== segments[i])) return false;
    if (query.kind && s.kind !== query.kind) return false;
    return true;
  });
  return disambiguateClassVsConstructor(matches, query);
}

/**
 * The requirements: a bare-name query (no explicit `kind`) that matches both a class and
 * its constructor(s), with no other candidates, resolves to the class — the overwhelmingly
 * common intent. An explicit `kind` filter has already disambiguated upstream in `matchSymbols`,
 * so this only fires when `kind` was omitted.
 */
function disambiguateClassVsConstructor<T extends FlatSymbol>(matches: T[], query: FindSymbolQuery): T[] {
  if (query.kind) return matches;
  const classes = matches.filter((m) => m.kind === "class" || m.kind === "struct");
  const constructors = matches.filter((m) => m.kind === "constructor");
  const isOnlyClassAndConstructors = classes.length > 0 && classes.length + constructors.length === matches.length;
  return isOnlyClassAndConstructors ? classes : matches;
}
