import { describe, expect, it } from "vitest";
import { flattenOutline, symbolKindName, toOutline, type LspDocumentSymbol } from "../../src/clangd/outline.js";
import { symAt } from "../helpers/fake-clangd.js";

function sym(name: string, kind: number, children?: LspDocumentSymbol[]): LspDocumentSymbol {
  return { name, kind, range: { start: { line: 0 }, end: { line: 5 } }, children };
}

describe("symbolKindName", () => {
  it("maps known LSP SymbolKind numbers", () => {
    expect(symbolKindName(5)).toBe("class");
    expect(symbolKindName(9)).toBe("constructor");
    expect(symbolKindName(6)).toBe("method");
    expect(symbolKindName(23)).toBe("struct");
  });

  it("labels an unknown kind rather than throwing", () => {
    expect(symbolKindName(999)).toBe("unknown(999)");
  });
});

/** A flat `SymbolInformation`-shaped entry — what clangd sends without `hierarchicalDocumentSymbolSupport`. */
function flatSymbolInformation(name: string, kind: number): LspDocumentSymbol {
  return {
    name,
    kind,
    location: { uri: "file:///x.cpp", range: { start: { line: 0 }, end: { line: 5 } } },
    containerName: "",
  } as unknown as LspDocumentSymbol;
}

describe("toOutline", () => {
  it("converts 0-based LSP lines to 1-based output lines", () => {
    const out = toOutline([sym("Foo", 5)], 1);
    expect(out[0]).toMatchObject({ name: "Foo", kind: "class", range: { startLine: 1, endLine: 6 } });
  });

  it("throws a named error instead of silently mis-mapping a flat SymbolInformation entry", () => {
    expect(() => toOutline([flatSymbolInformation("Foo", 5)], 1)).toThrow(/flat SymbolInformation/);
  });

  it("includes children at depth 1", () => {
    const out = toOutline([sym("Foo", 5, [sym("bar", 6)])], 1);
    expect(out[0]?.children).toHaveLength(1);
    expect(out[0]?.children?.[0]).toMatchObject({ name: "bar", kind: "method" });
  });

  it("omits children at depth 0", () => {
    const out = toOutline([sym("Foo", 5, [sym("bar", 6)])], 0);
    expect(out[0]?.children).toBeUndefined();
  });

  it("unwraps namespace nesting without consuming the depth budget", () => {
    // namespace gizmo { namespace connector { class Foo { void bar(); }; } }
    const out = toOutline([sym("gizmo", 3, [sym("connector", 3, [sym("Foo", 5, [sym("bar", 6)])])])], 1);
    const gizmo = out[0];
    expect(gizmo).toMatchObject({ name: "gizmo", kind: "namespace" });
    const connector = gizmo?.children?.[0];
    expect(connector).toMatchObject({ name: "connector", kind: "namespace" });
    const foo = connector?.children?.[0];
    expect(foo).toMatchObject({ name: "Foo", kind: "class" });
    expect(foo?.children).toHaveLength(1);
    expect(foo?.children?.[0]).toMatchObject({ name: "bar", kind: "method" });
  });

  it("depth 0 still unwraps namespaces but shows only the class itself, no members", () => {
    const out = toOutline([sym("gizmo", 3, [sym("connector", 3, [sym("Foo", 5, [sym("bar", 6)])])])], 0);
    const foo = out[0]?.children?.[0]?.children?.[0];
    expect(foo).toMatchObject({ name: "Foo", kind: "class" });
    expect(foo?.children).toBeUndefined();
  });

  it("transparently unwraps 3+ levels of nested namespaces", () => {
    const out = toOutline([sym("a", 3, [sym("b", 3, [sym("c", 3, [sym("Foo", 5, [sym("bar", 6)])])])])], 1);
    const foo = out[0]?.children?.[0]?.children?.[0]?.children?.[0];
    expect(foo).toMatchObject({ name: "Foo", kind: "class" });
    expect(foo?.children?.[0]).toMatchObject({ name: "bar", kind: "method" });
  });

  it("a header with no namespace wrapper behaves exactly as before", () => {
    const out = toOutline([sym("Foo", 5, [sym("bar", 6)])], 1);
    expect(out[0]?.children).toHaveLength(1);
    expect(out[0]?.children?.[0]).toMatchObject({ name: "bar", kind: "method" });
  });
});

describe("flattenOutline", () => {
  it("tags each entry with its ancestor qualified path", () => {
    const flat = flattenOutline([sym("Foo", 5, [sym("bar", 6), sym("Foo", 9)])]);
    expect(flat).toHaveLength(3);
    expect(flat[0]).toMatchObject({ qualifiedPath: ["Foo"], kind: "class" });
    expect(flat[1]).toMatchObject({ qualifiedPath: ["Foo", "bar"], kind: "method" });
    expect(flat[2]).toMatchObject({ qualifiedPath: ["Foo", "Foo"], kind: "constructor" });
  });

  it("throws a named error instead of silently mis-mapping a flat SymbolInformation entry", () => {
    expect(() => flattenOutline([flatSymbolInformation("Foo", 5)])).toThrow(/flat SymbolInformation/);
  });

  it("carries the position of the declaration's own name, which is where a type-aware request is asked", () => {
    const flat = flattenOutline([symAt("Widget", 5, 4, 6)]);
    expect(flat[0]).toMatchObject({ name: "Widget", namePosition: { line: 4, character: 6 } });
  });

  it("carries no name position for an entry whose server answer named none, rather than a guessed one", () => {
    expect(flattenOutline([sym("Widget", 5)])[0]?.namePosition).toBeUndefined();
  });

  it("keeps each nesting level's own name position", () => {
    const flat = flattenOutline([{ ...symAt("Widget", 5, 4, 6), children: [symAt("bar", 6, 5, 8)] }]);
    expect(flat.map((s) => s.namePosition)).toEqual([
      { line: 4, character: 6 },
      { line: 5, character: 8 },
    ]);
  });
});
