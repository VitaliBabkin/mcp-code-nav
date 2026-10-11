// The addressing rule, tested over the outlines tsgo answers with and the text those
// outlines are read against. Every entry here is built the way tsgo reports one: `range` starts at the
// declaration's first character — modifiers included — and `selectionRange` is the declaration's own
// identifier, which is the only reason a `static` token can be read without re-parsing the declaration.

import { describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import {
  addressTsSymbol,
  implementationsSubject,
  matchingEntries,
  spellTsRow,
  type TsAddressSource,
} from "../../src/tools/ts-addressing.js";

/** The file the calls are about; `addressTsSymbol` only ever echoes this spelling back. */
const FILE = "C:/ws/packages/ui/src/driver.ts";

/** The LSP `SymbolKind` numbers tsgo answers with, named for the declaration each fixture stands for. */
const KIND = {
  namespace: 3,
  class: 5,
  method: 6,
  property: 7,
  enum: 10,
  interface: 11,
  function: 12,
  variable: 13,
  constant: 14,
} as const;

type Point = readonly [number, number];

interface EntryOptions {
  readonly name: string;
  readonly kind: number;
  /** `range`'s start and end: the whole declaration, modifiers included. */
  readonly range: readonly [Point, Point];
  /** `selectionRange`'s start: the declaration's own identifier. */
  readonly selection: Point;
  /** `selectionRange`'s end, which tsgo sends and a dotted namespace name needs to be read. */
  readonly selectionEnd?: Point;
  readonly children?: readonly LspDocumentSymbol[];
}

/** One entry as tsgo reports it, with the characters on both positions that a line-only fake would drop. */
function sym({ name, kind, range, selection, selectionEnd, children }: EntryOptions): LspDocumentSymbol {
  return {
    name,
    kind,
    range: {
      start: { line: range[0][0], character: range[0][1] },
      end: { line: range[1][0], character: range[1][1] },
    },
    selectionRange: {
      start: { line: selection[0], character: selection[1] },
      ...(selectionEnd === undefined ? {} : { end: { line: selectionEnd[0], character: selectionEnd[1] } }),
    },
    ...(children === undefined ? {} : { children: [...children] }),
  };
}

/** The text an outline is read against: a member's modifiers are the span between its start and its name. */
function source(lines: readonly string[]): TsAddressSource {
  return { file: FILE, lines };
}

// `class C { static run(); run(); }` — the two members share a key and differ only by a modifier.
const C_LINES = ["export class C {", "  static run(): void {}", "  run(): void {}", "}"];
const C_STATIC_RUN = sym({ name: "run", kind: KIND.method, range: [[1, 2], [1, 22]], selection: [1, 9] });
const C_INSTANCE_RUN = sym({ name: "run", kind: KIND.method, range: [[2, 2], [2, 15]], selection: [2, 2] });
const CLASS_C = sym({
  name: "C",
  kind: KIND.class,
  range: [[0, 13], [3, 1]],
  selection: [0, 13],
  children: [C_STATIC_RUN, C_INSTANCE_RUN],
});

// A static member and an instance one that are not the same kind of entry.
const D_LINES = ["export class D {", "  static run(): void {}", "  run: number = 0;", "}"];
const D_STATIC_RUN = sym({ name: "run", kind: KIND.method, range: [[1, 2], [1, 22]], selection: [1, 9] });
const D_INSTANCE_RUN = sym({ name: "run", kind: KIND.property, range: [[2, 2], [2, 16]], selection: [2, 2] });
const CLASS_D = sym({
  name: "D",
  kind: KIND.class,
  range: [[0, 13], [3, 1]],
  selection: [0, 13],
  children: [D_STATIC_RUN, D_INSTANCE_RUN],
});

// `export const Widget` beside `export interface Widget` — a value beside a type that cannot merge with it.
const WIDGET_LINES = ["export const Widget = 1;", "export interface Widget { size: number }"];
const WIDGET_VALUE = sym({ name: "Widget", kind: KIND.constant, range: [[0, 13], [0, 22]], selection: [0, 13] });
const WIDGET_TYPE = sym({ name: "Widget", kind: KIND.interface, range: [[1, 17], [1, 40]], selection: [1, 17] });

// Two instance members sharing a key, which is a collision no documented prefix separates.
const E_LINES = ["export class E {", "  run: number = 0;", "  run(): void {}", "}"];
const E_PROPERTY_RUN = sym({ name: "run", kind: KIND.property, range: [[1, 2], [1, 16]], selection: [1, 2] });
const E_METHOD_RUN = sym({ name: "run", kind: KIND.method, range: [[2, 2], [2, 15]], selection: [2, 2] });
const CLASS_E = sym({
  name: "E",
  kind: KIND.class,
  range: [[0, 13], [3, 1]],
  selection: [0, 13],
  children: [E_PROPERTY_RUN, E_METHOD_RUN],
});

// The `static` token on the line above the identifier, which is inside the modifier span once that span is
// read across the line break rather than stopped at it.
const F_LINES = ["export class F {", "  static", "  run(): void {}", "}"];
const F_STATIC_RUN = sym({ name: "run", kind: KIND.method, range: [[1, 2], [2, 15]], selection: [2, 2] });
const F_INSTANCE_RUN = sym({ name: "run", kind: KIND.property, range: [[3, 2], [3, 16]], selection: [3, 2] });
const CLASS_F = sym({
  name: "F",
  kind: KIND.class,
  range: [[0, 13], [4, 1]],
  selection: [0, 13],
  children: [F_STATIC_RUN, F_INSTANCE_RUN],
});

// A decorator on its own line above a `static` member — the usual layout — beside an instance member of the
// same name. The modifier is a `static` token outside decorator parentheses, which is a read across
// that line break: the pair is the two-symbols case, not one overload set.
const H_LINES = ["export class H {", "  @memo()", "  static run(): void {}", "  run(): void {}", "}"];
const H_STATIC_RUN = sym({ name: "run", kind: KIND.method, range: [[1, 2], [2, 22]], selection: [2, 9] });
const H_INSTANCE_RUN = sym({ name: "run", kind: KIND.method, range: [[3, 2], [3, 15]], selection: [3, 2] });
const CLASS_H = sym({
  name: "H",
  kind: KIND.class,
  range: [[0, 13], [4, 1]],
  selection: [0, 13],
  children: [H_STATIC_RUN, H_INSTANCE_RUN],
});

// `static` inside a decorator's string argument, on the member's own line: text, not a modifier. Both
// members are instance ones, so TypeScript makes them one symbol and the bare key addresses it.
const I_LINES = ["export class I {", "  @tag(\"static\") run(): void {}", "  run(): void {}", "}"];
const I_TAGGED_RUN = sym({ name: "run", kind: KIND.method, range: [[1, 2], [1, 29]], selection: [1, 17] });
const I_INSTANCE_RUN = sym({ name: "run", kind: KIND.method, range: [[2, 2], [2, 15]], selection: [2, 2] });
const CLASS_I = sym({
  name: "I",
  kind: KIND.class,
  range: [[0, 13], [3, 1]],
  selection: [0, 13],
  children: [I_TAGGED_RUN, I_INSTANCE_RUN],
});

// A comment that says `static` beside a decorated member, on the line the decorator lives on. It is prose,
// not a modifier: read as one, the instance member below it joins the static one in one symbol and the bare
// key answers about the wrong declaration.
const J_LINES = ["export class J {", "  @memo() // static cache", "  run(): void {}", "  static run(): void {}", "}"];
const J_COMMENTED_RUN = sym({ name: "run", kind: KIND.method, range: [[1, 2], [2, 15]], selection: [2, 2] });
const J_STATIC_RUN = sym({ name: "run", kind: KIND.method, range: [[3, 2], [3, 22]], selection: [3, 9] });
const CLASS_J = sym({
  name: "J",
  kind: KIND.class,
  range: [[0, 13], [4, 1]],
  selection: [0, 13],
  children: [J_COMMENTED_RUN, J_STATIC_RUN],
});

// The block-comment spelling of the same fact, on the member's own line and inside the span.
const K_LINES = ["export class K {", "  /* static */ run(): void {}", "  static run(): void {}", "}"];
const K_COMMENTED_RUN = sym({ name: "run", kind: KIND.method, range: [[1, 2], [1, 26]], selection: [1, 15] });
const K_STATIC_RUN = sym({ name: "run", kind: KIND.method, range: [[2, 2], [2, 22]], selection: [2, 9] });
const CLASS_K = sym({
  name: "K",
  kind: KIND.class,
  range: [[0, 13], [3, 1]],
  selection: [0, 13],
  children: [K_COMMENTED_RUN, K_STATIC_RUN],
});

describe("addressTsSymbol", () => {
  it("addresses a top-level name at its own identifier, in its own file", () => {
    const storage = sym({ name: "Storage", kind: KIND.interface, range: [[0, 17], [2, 1]], selection: [0, 24] });
    const outcome = addressTsSymbol("Storage", [storage], source([]));
    expect(outcome).toEqual({
      kind: "addressed",
      subject: {
        symbol: "Storage",
        entries: [storage],
        entry: storage,
        kind: "interface",
        file: FILE,
        line: 1,
        position: { line: 0, character: 24 },
        positions: [{ line: 0, character: 24 }],
        spelling: "Storage",
      },
    });
  });

  // This pair is the two-symbols case: overloads merge only at the same static-ness, so a
  // `static` member beside an instance one is two symbols sharing a key, never one declaration answered at a
  // position chosen for the other.
  it("refuses the bare key where a static and an instance member share it, listing each with its selector", () => {
    const outcome = addressTsSymbol("C.run", [CLASS_C], source(C_LINES));

    expect(outcome).toEqual({
      kind: "shared-key",
      symbol: "C.run",
      candidates: [
        { entry: C_STATIC_RUN, kind: "method", line: 2, selector: "static" },
        { entry: C_INSTANCE_RUN, kind: "method", line: 3, selector: "instance" },
      ],
    });
  });

  it("resolves `static C.run` at the static declaration's own identifier", () => {
    const outcome = addressTsSymbol("static C.run", [CLASS_C], source(C_LINES));
    const subject = outcome.kind === "addressed" ? outcome.subject : undefined;

    expect(subject?.entry).toBe(C_STATIC_RUN);
    expect(subject?.position).toEqual({ line: 1, character: 9 });
    expect(subject?.spelling).toBe("static C.run");
  });

  it("resolves `instance C.run` at the instance declaration, not at the static one above it", () => {
    const outcome = addressTsSymbol("instance C.run", [CLASS_C], source(C_LINES));
    const subject = outcome.kind === "addressed" ? outcome.subject : undefined;

    expect(subject?.entry).toBe(C_INSTANCE_RUN);
    expect(subject?.position).toEqual({ line: 2, character: 2 });
    expect(subject?.spelling).toBe("instance C.run");
  });

  it.each([
    { label: "class", kind: KIND.class },
    { label: "interface", kind: KIND.interface },
    { label: "enum", kind: KIND.enum },
    { label: "namespace", kind: KIND.namespace },
  ])("descends a dotted path through a $label entry to its member", ({ kind }: { label: string; kind: number }) => {
    const member = sym({ name: "run", kind: KIND.method, range: [[1, 2], [1, 15]], selection: [1, 2] });
    const container = sym({ name: "C", kind, range: [[0, 0], [3, 1]], selection: [0, 13], children: [member] });
    const outcome = addressTsSymbol("C.run", [container], source([]));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject).toMatchObject({
      kind: "method",
      position: { line: 1, character: 2 },
      line: 2,
      spelling: "C.run",
    });
  });

  it("descends through a namespace inside a namespace, which is one path and not two lookups", () => {
    const inner = sym({ name: "x", kind: KIND.function, range: [[2, 4], [2, 20]], selection: [2, 4] });
    const middle = sym({ name: "Inner", kind: KIND.namespace, range: [[1, 4], [3, 3]], selection: [1, 18], children: [inner] });
    const outer = sym({ name: "Ns", kind: KIND.namespace, range: [[0, 0], [4, 1]], selection: [0, 14], children: [middle] });
    const outcome = addressTsSymbol("Ns.Inner.x", [outer], source([]));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject).toMatchObject({
      kind: "function",
      position: { line: 2, character: 4 },
      line: 3,
      spelling: "Ns.Inner.x",
    });
  });

  it("refuses a path that descends through a function, naming the entry and its kind", () => {
    const local = sym({ name: "inner", kind: KIND.variable, range: [[1, 4], [1, 12]], selection: [1, 4] });
    const build = sym({ name: "build", kind: KIND.function, range: [[0, 0], [3, 1]], selection: [0, 16], children: [local] });
    expect(addressTsSymbol("build.inner", [build], source([]))).toEqual({
      kind: "not-addressable",
      symbol: "build.inner",
      through: "build",
      kindName: "function",
    });
  });

  it("refuses an object literal's member, which is not addressable at any depth", () => {
    const field = sym({ name: "host", kind: KIND.property, range: [[1, 2], [1, 10]], selection: [1, 2] });
    const cfg = sym({ name: "cfg", kind: KIND.variable, range: [[0, 0], [2, 1]], selection: [0, 13], children: [field] });
    expect(addressTsSymbol("cfg.host", [cfg], source([]))).toEqual({
      kind: "not-addressable",
      symbol: "cfg.host",
      through: "cfg",
      kindName: "variable",
    });
  });

  it("refuses a name the file does not declare, or one only its last segment lacks", () => {
    const storage = sym({ name: "Storage", kind: KIND.interface, range: [[0, 17], [2, 1]], selection: [0, 24] });
    expect(addressTsSymbol("Absent", [storage], source([]))).toEqual({ kind: "not-found", symbol: "Absent" });
    expect(addressTsSymbol("Storage.missing", [storage], source([]))).toEqual({
      kind: "not-found",
      symbol: "Storage.missing",
    });
  });

  it("reports an unknown first segment as a path nothing carries, not as a missing last name", () => {
    const storage = sym({ name: "Storage", kind: KIND.interface, range: [[0, 17], [2, 1]], selection: [0, 24] });
    expect(addressTsSymbol("Missing.x", [storage], source([]))).toEqual({
      kind: "not-addressable",
      symbol: "Missing.x",
      through: "Missing",
      kindName: "nothing",
    });
  });

  it("refuses an entry whose answer carries no selectionRange rather than guessing a position", () => {
    // No `selectionRange` means the server never located the name, and asking at `range`'s start would ask
    // at whatever keyword or modifier happens to be there.
    const bare: LspDocumentSymbol = { name: "Bare", kind: KIND.class, range: { start: { line: 3 }, end: { line: 9 } } };
    expect(addressTsSymbol("Bare", [bare], source([]))).toEqual({ kind: "not-found", symbol: "Bare" });
  });

  it("reads a pair of overloads as one symbol addressed at the first in source order", () => {
    const first = sym({ name: "run", kind: KIND.method, range: [[4, 2], [4, 20]], selection: [4, 2] });
    const second = sym({ name: "run", kind: KIND.method, range: [[5, 2], [5, 22]], selection: [5, 2] });
    const driver = sym({ name: "Driver", kind: KIND.class, range: [[3, 13], [7, 1]], selection: [3, 13], children: [first, second] });
    const outcome = addressTsSymbol("Driver.run", [driver], source([]));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.entries).toEqual([first, second]);
    expect(outcome.subject.position).toEqual({ line: 4, character: 2 });
    // Every entry of the merged symbol is a place the subject itself sits.
    expect(outcome.subject.positions).toEqual([
      { line: 4, character: 2 },
      { line: 5, character: 2 },
    ]);
    expect(outcome.subject.line).toBe(5);
    expect(outcome.subject.spelling).toBe("Driver.run");
  });

  it("reads a get/set pair as one symbol at the getter, whose span says `get` and not `static`", () => {
    const lines = [
      "export class Accessor {",
      "  get value(): number {",
      "    return 0;",
      "  }",
      "  set value(next: number) {",
      "    void next;",
      "  }",
      "}",
    ];
    const getter = sym({ name: "value", kind: KIND.method, range: [[1, 2], [3, 2]], selection: [1, 6] });
    const setter = sym({ name: "value", kind: KIND.method, range: [[4, 2], [6, 2]], selection: [4, 6] });
    const accessor = sym({ name: "Accessor", kind: KIND.class, range: [[0, 13], [7, 1]], selection: [0, 13], children: [getter, setter] });
    const outcome = addressTsSymbol("Accessor.value", [accessor], source(lines));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.entries).toEqual([getter, setter]);
    expect(outcome.subject.position).toEqual({ line: 1, character: 6 });
  });

  it.each([
    { label: "interface with interface", first: KIND.interface, second: KIND.interface, kind: "interface" },
    { label: "namespace with namespace", first: KIND.namespace, second: KIND.namespace, kind: "namespace" },
    { label: "enum with enum", first: KIND.enum, second: KIND.enum, kind: "enum" },
    { label: "class with interface", first: KIND.class, second: KIND.interface, kind: "class" },
    { label: "namespace with class", first: KIND.namespace, second: KIND.class, kind: "namespace" },
    { label: "namespace with function", first: KIND.namespace, second: KIND.function, kind: "namespace" },
    { label: "namespace with enum", first: KIND.namespace, second: KIND.enum, kind: "namespace" },
  ])("reads one declaration for $label, addressed at the first entry in source order", ({ first, second, kind }: { label: string; first: number; second: number; kind: string }) => {
    const a = sym({ name: "M", kind: first, range: [[0, 0], [1, 1]], selection: [0, 0] });
    const b = sym({ name: "M", kind: second, range: [[2, 0], [3, 1]], selection: [2, 0] });
    const outcome = addressTsSymbol("M", [a, b], source([]));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.entries).toEqual([a, b]);
    expect(outcome.subject.kind).toBe(kind);
    expect(outcome.subject.position).toEqual({ line: 0, character: 0 });
    expect(outcome.subject.spelling).toBe("M");
  });

  it("reads two classes beside a const as more than one symbol, because the const merges with neither", () => {
    const a = sym({ name: "M", kind: KIND.class, range: [[0, 0], [1, 1]], selection: [0, 0] });
    const b = sym({ name: "M", kind: KIND.class, range: [[2, 0], [3, 1]], selection: [2, 0] });
    const c = sym({ name: "M", kind: KIND.constant, range: [[4, 0], [4, 10]], selection: [4, 13] });
    const outcome = addressTsSymbol("M", [a, b, c], source([]));
    expect(outcome.kind).toBe("shared-key");
    if (outcome.kind !== "shared-key") return;
    expect(outcome.candidates.map((candidate) => [candidate.kind, candidate.selector])).toEqual([
      ["class", "type"],
      ["class", "type"],
      ["constant", "value"],
    ]);
  });

  // This pair is the two-symbols case: two
  // entries of one kind merge only when their static-ness agrees, so `mergeable` must not answer for a
  // same-kind pair. It did, and these two were read as one declaration.
  it("refuses the bare key for a static and an instance member of one kind, where the kinds alone do not merge", () => {
    const outcome = addressTsSymbol("C.run", [CLASS_C], source(C_LINES));
    expect(outcome.kind).toBe("shared-key");
    if (outcome.kind !== "shared-key") return;
    expect(outcome.candidates.map((candidate) => candidate.selector)).toEqual(["static", "instance"]);
  });

  it("merges two `static` overloads of one name, where the static-ness the pair above disagrees on agrees", () => {
    const first = sym({ name: "run", kind: KIND.method, range: [[1, 2], [1, 22]], selection: [1, 9] });
    const second = sym({ name: "run", kind: KIND.method, range: [[2, 2], [2, 22]], selection: [2, 9] });
    const bothStatic = ["export class C {", "  static run(): void {}", "  static run(): void {}", "}"];
    const container = sym({ name: "C", kind: KIND.class, range: [[0, 13], [3, 1]], selection: [0, 13], children: [first, second] });

    const outcome = addressTsSymbol("C.run", [container], source(bothStatic));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.entries).toEqual([first, second]);
    expect(outcome.subject.position).toEqual({ line: 1, character: 9 });
  });

  it("answers the documented `static` and `instance` prefixes at two different declarations", () => {
    const prefixed = (symbol: string) => {
      const outcome = addressTsSymbol(symbol, [CLASS_C], source(C_LINES));
      return outcome.kind === "addressed" ? { symbol: outcome.subject.symbol, position: outcome.subject.position } : outcome.kind;
    };
    expect(prefixed("static C.run")).toEqual({ symbol: "static C.run", position: { line: 1, character: 9 } });
    expect(prefixed("instance C.run")).toEqual({ symbol: "instance C.run", position: { line: 2, character: 2 } });
  });

  it("refuses the bare key when the two members sharing it are not of one kind, listing both prefixes", () => {
    const outcome = addressTsSymbol("D.run", [CLASS_D], source(D_LINES));
    expect(outcome).toEqual({
      kind: "shared-key",
      symbol: "D.run",
      candidates: [
        { entry: D_STATIC_RUN, kind: "method", line: 2, selector: "static" },
        { entry: D_INSTANCE_RUN, kind: "property", line: 3, selector: "instance" },
      ],
    });
  });

  it("resolves `static D.run` and `instance D.run` to their own entries, prefix and all in the spelling", () => {
    const staticRun = addressTsSymbol("static D.run", [CLASS_D], source(D_LINES));
    expect(staticRun.kind).toBe("addressed");
    if (staticRun.kind !== "addressed") return;
    expect(staticRun.subject).toMatchObject({
      symbol: "static D.run",
      spelling: "static D.run",
      kind: "method",
      entries: [D_STATIC_RUN],
      position: { line: 1, character: 9 },
      line: 2,
    });

    const instanceRun = addressTsSymbol("instance D.run", [CLASS_D], source(D_LINES));
    expect(instanceRun.kind).toBe("addressed");
    if (instanceRun.kind !== "addressed") return;
    expect(instanceRun.subject).toMatchObject({
      spelling: "instance D.run",
      kind: "property",
      position: { line: 2, character: 2 },
      line: 3,
    });
  });

  it("refuses a value beside a type that does not merge with it, with `value` and `type` as the spellings", () => {
    const outcome = addressTsSymbol("Widget", [WIDGET_VALUE, WIDGET_TYPE], source(WIDGET_LINES));
    expect(outcome).toEqual({
      kind: "shared-key",
      symbol: "Widget",
      candidates: [
        { entry: WIDGET_VALUE, kind: "constant", line: 1, selector: "value" },
        { entry: WIDGET_TYPE, kind: "interface", line: 2, selector: "type" },
      ],
    });
  });

  it("resolves `type Widget` to the interface and `value Widget` to the binding", () => {
    const type = addressTsSymbol("type Widget", [WIDGET_VALUE, WIDGET_TYPE], source(WIDGET_LINES));
    expect(type.kind).toBe("addressed");
    if (type.kind !== "addressed") return;
    expect(type.subject).toMatchObject({ spelling: "type Widget", kind: "interface", position: { line: 1, character: 17 } });

    const value = addressTsSymbol("value Widget", [WIDGET_VALUE, WIDGET_TYPE], source(WIDGET_LINES));
    expect(value.kind).toBe("addressed");
    if (value.kind !== "addressed") return;
    expect(value.subject).toMatchObject({ spelling: "value Widget", kind: "constant", position: { line: 0, character: 13 } });
  });

  it("refuses a collision that splits neither by static-ness nor by meaning, reporting no selector", () => {
    const outcome = addressTsSymbol("E.run", [CLASS_E], source(E_LINES));
    expect(outcome.kind).toBe("shared-key");
    if (outcome.kind !== "shared-key") return;
    expect(outcome.candidates.map((candidate) => [candidate.kind, candidate.selector])).toEqual([
      ["property", undefined],
      ["method", undefined],
    ]);
  });

  it("accepts a prefix on a key that does not collide, and drops it from the spelling it publishes", () => {
    const outcome = addressTsSymbol("value Widget", [WIDGET_VALUE], source(WIDGET_LINES));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject).toMatchObject({ symbol: "value Widget", spelling: "Widget", kind: "constant" });
  });

  it("reads a `static` written on the line above the name, because the span runs to the identifier", () => {
    // The modifier span is bounded by the server's own positions — `range.start` to
    // `selectionRange.start` — and not by a line break. Stopping at the break made this pair read as two
    // instance members, one symbol, answered at the first declaration: the same wrong answer the single-line
    // case was fixed for, reached from the other side.
    const outcome = addressTsSymbol("F.run", [CLASS_F], source(F_LINES));
    expect(outcome.kind).toBe("shared-key");
    if (outcome.kind !== "shared-key") return;
    expect(outcome.candidates.map((candidate) => candidate.selector)).toEqual(["static", "instance"]);
  });

  it("reads a decorated `static` on its own line as static, and refuses the bare key beside an instance one", () => {
    // The layout the parenthetical is about: `@memo()` above `static run()`. The decorator is inside
    // the span, the `static` token is outside its parentheses, and the pair is two symbols.
    const outcome = addressTsSymbol("H.run", [CLASS_H], source(H_LINES));
    expect(outcome.kind).toBe("shared-key");
    if (outcome.kind !== "shared-key") return;
    expect(outcome.candidates).toEqual([
      { entry: H_STATIC_RUN, kind: "method", line: 3, selector: "static" },
      { entry: H_INSTANCE_RUN, kind: "method", line: 4, selector: "instance" },
    ]);
  });

  it("resolves `static H.run` at the decorated static declaration, not at the instance one below it", () => {
    const outcome = addressTsSymbol("static H.run", [CLASS_H], source(H_LINES));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject).toMatchObject({
      spelling: "static H.run",
      entries: [H_STATIC_RUN],
      position: { line: 2, character: 9 },
      line: 3,
    });
  });

  it("does not read a `static` that is only a decorator's string argument", () => {
    // `@tag("static")` is text inside parentheses, so neither member is static, both are methods, and
    // TypeScript makes the two of them one symbol: the bare key addresses it rather than refusing a collision.
    const outcome = addressTsSymbol("I.run", [CLASS_I], source(I_LINES));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.entries).toEqual([I_TAGGED_RUN, I_INSTANCE_RUN]);
    expect(outcome.subject.position).toEqual({ line: 1, character: 17 });
  });

  it("does not read a `static` that is only a comment beside a decorated member", () => {
    // `@memo() // static cache` is prose, not a modifier, and it sits inside the span the member's own
    // static-ness is read from. Read as a modifier it makes the instance member below it static too, and the
    // pair becomes one overload set answered at the first declaration — the two-symbols case lost.
    const outcome = addressTsSymbol("J.run", [CLASS_J], source(J_LINES));
    expect(outcome.kind).toBe("shared-key");
    if (outcome.kind !== "shared-key") return;
    expect(outcome.candidates).toEqual([
      { entry: J_COMMENTED_RUN, kind: "method", line: 3, selector: "instance" },
      { entry: J_STATIC_RUN, kind: "method", line: 4, selector: "static" },
    ]);
  });

  it("resolves `instance J.run` at the commented member, not at the static one beside it", () => {
    const outcome = addressTsSymbol("instance J.run", [CLASS_J], source(J_LINES));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject).toMatchObject({
      spelling: "instance J.run",
      entries: [J_COMMENTED_RUN],
      position: { line: 2, character: 2 },
      line: 3,
    });
  });

  it("does not read a `static` inside a block comment on the member's own line", () => {
    // The other spelling of the same prose, this time between the span's first character and the name.
    const outcome = addressTsSymbol("K.run", [CLASS_K], source(K_LINES));
    expect(outcome.kind).toBe("shared-key");
    if (outcome.kind !== "shared-key") return;
    expect(outcome.candidates.map((candidate) => candidate.selector)).toEqual(["instance", "static"]);
  });

  it.each([
    { label: "interface, class, namespace", first: KIND.interface, second: KIND.class, third: KIND.namespace },
    { label: "namespace, interface, class", first: KIND.namespace, second: KIND.interface, third: KIND.class },
    { label: "class, interface, namespace", first: KIND.class, second: KIND.interface, third: KIND.namespace },
  ])("refuses one name declared $label, whatever order the server reported them in", ({ first, second, third }: { label: string; first: number; second: number; third: number }) => {
    // Checked against the first entry alone, the answer depended on which of the three the server happened to
    // report first: `namespace` merges with a `class` and a class with an `interface`, but `namespace|interface`
    // is not itself a merging pair, so one ordering called these one symbol and another refused the same file.
    // The group is judged pair by pair, which is the only reading that cannot flip with declaration order.
    const a = sym({ name: "M", kind: first, range: [[0, 0], [1, 1]], selection: [0, 0] });
    const b = sym({ name: "M", kind: second, range: [[2, 0], [3, 1]], selection: [2, 0] });
    const c = sym({ name: "M", kind: third, range: [[4, 0], [5, 1]], selection: [4, 0] });
    const outcome = addressTsSymbol("M", [a, b, c], source([]));
    expect(outcome.kind).toBe("shared-key");
    if (outcome.kind !== "shared-key") return;
    expect(outcome.candidates.map((candidate) => candidate.selector)).toEqual([undefined, undefined, undefined]);
  });

  it("reads a class beside an interface as one declaration in either order", () => {
    const classFirst = sym({ name: "M", kind: KIND.class, range: [[0, 0], [1, 1]], selection: [0, 0] });
    const interfaceFirst = sym({ name: "M", kind: KIND.interface, range: [[2, 0], [3, 1]], selection: [2, 0] });

    const forward = addressTsSymbol("M", [classFirst, interfaceFirst], source([]));
    const reverse = addressTsSymbol("M", [interfaceFirst, classFirst], source([]));

    expect(forward.kind).toBe("addressed");
    expect(reverse.kind).toBe("addressed");
    if (forward.kind !== "addressed" || reverse.kind !== "addressed") return;
    expect(forward.subject.entries).toEqual([classFirst, interfaceFirst]);
    expect(reverse.subject.entries).toEqual([interfaceFirst, classFirst]);
  });
});

describe("spellTsRow", () => {
  const LINES = [
    "export class ExecDriver {",
    "  run(job: string): string {",
    "    const local = job.length;",
    "    return \"done\";",
    "  }",
    "}",
  ];
  const LOCAL = sym({ name: "local", kind: KIND.variable, range: [[2, 10], [2, 24]], selection: [2, 10] });
  const RUN = sym({ name: "run", kind: KIND.method, range: [[1, 2], [4, 2]], selection: [1, 2], children: [LOCAL] });
  const DRIVER = sym({ name: "ExecDriver", kind: KIND.class, range: [[0, 13], [5, 1]], selection: [0, 13], children: [RUN] });
  const OUTLINE = [DRIVER];

  it("names a site inside a method of a class by the path `symbol` accepts, kind included", () => {
    expect(spellTsRow(OUTLINE, { line: 1, character: 2 }, LINES)).toEqual({ name: "ExecDriver.run", kind: "method" });
    expect(spellTsRow(OUTLINE, { line: 3, character: 4 }, LINES)).toEqual({ name: "ExecDriver.run", kind: "method" });
  });

  it("names a site inside a local by its enclosing declaration, which is the address that reads back", () => {
    expect(spellTsRow(OUTLINE, { line: 2, character: 12 }, LINES)).toEqual({ name: "ExecDriver.run", kind: "method" });
  });

  it("names a top-level function row by its own name alone, with no container in front of it", () => {
    const lines = ["export function build() {}"];
    const build = sym({ name: "build", kind: KIND.function, range: [[0, 16], [0, 26]], selection: [0, 16] });
    expect(spellTsRow([build], { line: 0, character: 20 }, lines)).toEqual({ name: "build", kind: "function" });
  });

  it("spells a path through two namespaces as the dotted address it sits in", () => {
    const lines = ["export namespace Ns {", "  export namespace Inner {", "    export function x() {}", "  }", "}"];
    const x = sym({ name: "x", kind: KIND.function, range: [[2, 4], [2, 24]], selection: [2, 18] });
    const inner = sym({ name: "Inner", kind: KIND.namespace, range: [[1, 4], [3, 2]], selection: [1, 20], children: [x] });
    const ns = sym({ name: "Ns", kind: KIND.namespace, range: [[0, 15], [4, 1]], selection: [0, 17], children: [inner] });
    expect(spellTsRow([ns], { line: 2, character: 20 }, lines)).toEqual({ name: "Ns.Inner.x", kind: "function" });
  });

  it("writes the selector into the row when its key is shared with another declaration in the same file", () => {
    expect(spellTsRow([CLASS_D, CLASS_E], { line: 1, character: 9 }, D_LINES)).toEqual({
      name: "static D.run",
      kind: "method",
    });
    expect(spellTsRow([CLASS_D, CLASS_E], { line: 2, character: 2 }, D_LINES)).toEqual({
      name: "instance D.run",
      kind: "property",
    });
  });

  it("spells a value beside a type with the prefix that selects the one the site is inside", () => {
    expect(spellTsRow([WIDGET_VALUE, WIDGET_TYPE], { line: 0, character: 13 }, WIDGET_LINES)).toEqual({
      name: "value Widget",
      kind: "constant",
    });
    expect(spellTsRow([WIDGET_VALUE, WIDGET_TYPE], { line: 1, character: 17 }, WIDGET_LINES)).toEqual({
      name: "type Widget",
      kind: "interface",
    });
  });

  it("spells a collision no documented prefix separates with that name and no prefix at all", () => {
    // A prefix is written only where one separates the pair, and `E.run`'s property beside its method
    // is not such a collision. The old row carried a leading space where the missing selector would have
    // been, which is a name `symbol` cannot read back as anything but the bare key the tool refuses anyway.
    expect(spellTsRow([CLASS_E], { line: 2, character: 2 }, E_LINES)).toEqual({ name: "E.run", kind: "method" });
  });

  it("spells a commented member's row with the prefix its own key needs", () => {
    // The row is the same read as the address, so a comment that read as a modifier would give this row a
    // prefix-less name and hand the caller back a key the tool refuses.
    expect(spellTsRow([CLASS_J], { line: 2, character: 2 }, J_LINES)).toEqual({
      name: "instance J.run",
      kind: "method",
    });
    expect(spellTsRow([CLASS_J], { line: 3, character: 9 }, J_LINES)).toEqual({
      name: "static J.run",
      kind: "method",
    });
  });

  it("leaves a location no declaration encloses unnamed, with the reason a row carries", () => {
    expect(spellTsRow(OUTLINE, { line: 40, character: 0 }, LINES)).toEqual({
      name: null,
      kind: null,
      reason: "no declaration in this file encloses the reported location",
    });
  });

  it("names a site on a container's own name by that container, the address the key reads back", () => {
    // The class is the declaration enclosing line 0, and `ExecDriver` is a `symbol` these tools accept, so
    // the row for its header is the class itself rather than an unnamed location.
    expect(spellTsRow(OUTLINE, { line: 0, character: 13 }, LINES)).toEqual({ name: "ExecDriver", kind: "class" });
  });
});

describe("implementationsSubject", () => {
  const CLASS_W = sym({ name: "Widget", kind: KIND.class, range: [[0, 13], [0, 22]], selection: [0, 13] });
  const INTERFACE_W = sym({ name: "Widget", kind: KIND.interface, range: [[1, 17], [1, 26]], selection: [1, 17] });
  const W_LINES = ["export class Widget {}", "export interface Widget {}"];

  it("re-aims a merged class-and-interface symbol at the interface, the question a type answers", () => {
    const outcome = addressTsSymbol("Widget", [CLASS_W, INTERFACE_W], source(W_LINES));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    // The address itself stays the first entry in source order — that is the rule for a request that
    // wants the symbol, not one that wants its implementers.
    expect(outcome.subject.entry).toBe(CLASS_W);

    const asked = implementationsSubject(outcome.subject);
    expect(asked).toMatchObject({ kind: "interface", line: 2, position: { line: 1, character: 17 } });
    expect(asked.entry).toBe(INTERFACE_W);
    // One key, one symbol: what the answer is about does not move with the position it is asked at.
    expect(asked.symbol).toBe(outcome.subject.symbol);
    expect(asked.spelling).toBe(outcome.subject.spelling);
    expect(asked.entries).toBe(outcome.subject.entries);
  });

  it("keeps a merged interface-before-class symbol at the interface it already asks at", () => {
    // The same pair, declared the other way round: the interface IS the first entry, so the preference finds it
    // and must hand the subject back. Falling through to the next preferred kind here re-aimed the query at the
    // CLASS, so "what implements this interface" answered "what this class implements".
    const outcome = addressTsSymbol("Widget", [INTERFACE_W, CLASS_W], source(W_LINES));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.entry).toBe(INTERFACE_W);

    const asked = implementationsSubject(outcome.subject);
    expect(asked).toBe(outcome.subject);
    expect(asked.kind).toBe("interface");
    expect(asked.position).toEqual({ line: 1, character: 17 });
  });

  it("re-aims a merged namespace-and-class symbol at the class, which is what a type derives from", () => {
    // `declare namespace N {}` before `declare class N {}`: the first entry is the namespace, and no kind gate
    // belongs to it — the group holds the class to ask at.
    const ns = sym({ name: "Pair", kind: KIND.namespace, range: [[0, 16], [1, 1]], selection: [0, 16] });
    const cls = sym({ name: "Pair", kind: KIND.class, range: [[1, 13], [1, 20]], selection: [1, 13] });
    const outcome = addressTsSymbol("Pair", [ns, cls], source(["namespace Pair {}", "class Pair {}"]));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.entry).toBe(ns);

    const asked = implementationsSubject(outcome.subject);
    expect(asked).not.toBe(outcome.subject);
    expect(asked).toMatchObject({ kind: "class", line: 2, position: { line: 1, character: 13 } });
    expect(asked.spelling).toBe(outcome.subject.spelling);
  });

  it("leaves a single-entry subject exactly the object it was handed", () => {
    const only = sym({ name: "Storage", kind: KIND.interface, range: [[0, 17], [2, 1]], selection: [0, 24] });
    const outcome = addressTsSymbol("Storage", [only], source([]));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(implementationsSubject(outcome.subject)).toBe(outcome.subject);
  });

  it("leaves a merged pair whose first entry is already the preferred kind where it is", () => {
    // Two non-static `class` entries under one key: the search finds a class, takes the first, and that is the
    // entry the bare key already asks at — so the subject object is handed back unchanged, not copied.
    const first = sym({ name: "Pair", kind: KIND.class, range: [[0, 13], [0, 20]], selection: [0, 13] });
    const second = sym({ name: "Pair", kind: KIND.class, range: [[1, 13], [1, 20]], selection: [1, 13] });
    const outcome = addressTsSymbol("Pair", [first, second], source(["class Pair {}", "class Pair {}"]));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(implementationsSubject(outcome.subject)).toBe(outcome.subject);
  });
});


/** The entries a name reaches, without the positions each is asked at. */
function reachedEntries(name: string, outline: readonly LspDocumentSymbol[]): LspDocumentSymbol[] {
  const reach = matchingEntries(name, outline, []);
  return reach.kind === "reached" ? reach.entries.map((reached) => reached.entry) : [];
}

describe("matchingEntries (ts_find_symbol's file anchor: every entry a name reaches, no opinion on merging)", () => {
  // `class C { static run(); run(); }` beside `function run(): void;` twice (an overload pair) and a namespace.
  const OVERLOAD_A = sym({ name: "run", kind: KIND.function, range: [[5, 0], [5, 30]], selection: [5, 16] });
  const OVERLOAD_B = sym({ name: "run", kind: KIND.function, range: [[6, 0], [6, 30]], selection: [6, 16] });
  const NAMESPACE_N = sym({
    name: "N",
    kind: KIND.namespace,
    range: [[8, 0], [10, 1]],
    selection: [8, 17],
    children: [CLASS_C],
  });
  const VARIABLE_V = sym({
    name: "v",
    kind: KIND.variable,
    range: [[12, 0], [12, 20]],
    selection: [12, 13],
    children: [sym({ name: "inner", kind: KIND.variable, range: [[12, 14], [12, 18]], selection: [12, 14] })],
  });
  const OUTLINE = [CLASS_C, OVERLOAD_A, OVERLOAD_B, NAMESPACE_N, VARIABLE_V];

  it("returns every overload and both the static and the instance member, where addressing would refuse", () => {
    expect(reachedEntries("run", OUTLINE)).toEqual([OVERLOAD_A, OVERLOAD_B]);
    expect(reachedEntries("C.run", OUTLINE)).toEqual([C_STATIC_RUN, C_INSTANCE_RUN]);
  });

  it("descends through a namespace to a class and its member, in order", () => {
    expect(reachedEntries("N.C.run", OUTLINE)).toEqual([C_STATIC_RUN, C_INSTANCE_RUN]);
  });

  it("reaches nothing through a variable, because only a class, interface, enum or namespace holds members", () => {
    expect(reachedEntries("v.inner", OUTLINE)).toEqual([]);
  });

  it("reaches nothing for a name that is not declared, or a path that stops at an undeclared segment", () => {
    expect(reachedEntries("Absent", OUTLINE)).toEqual([]);
    expect(reachedEntries("C.absent", OUTLINE)).toEqual([]);
    expect(reachedEntries("Absent.run", OUTLINE)).toEqual([]);
  });
});

// tsgo spells `namespace A.B { ... }` as ONE outline entry named "A.B".
describe("a dotted namespace declaration consumes as many key segments as it spells", () => {
  const LINES = ["export namespace A.B {", "  export function f() {}", "}"];
  const F_ENTRY = sym({ name: "f", kind: KIND.function, range: [[1, 2], [1, 24]], selection: [1, 18] });
  const DOTTED = sym({
    name: "A.B",
    kind: KIND.namespace,
    range: [[0, 7], [2, 1]],
    selection: [0, 17],
    selectionEnd: [0, 20],
    children: [F_ENTRY],
  });

  it("addresses a member of the dotted namespace at its own name, spelled with the whole dotted run", () => {
    const outcome = addressTsSymbol("A.B.f", [DOTTED], source(LINES));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.entries).toEqual([F_ENTRY]);
    expect(outcome.subject.position).toEqual({ line: 1, character: 18 });
    expect(outcome.subject.spelling).toBe("A.B.f");
  });

  it("addresses the namespace at the identifier the LAST key segment names, which is B and not A", () => {
    const full = addressTsSymbol("A.B", [DOTTED], source(LINES));
    expect(full.kind).toBe("addressed");
    if (full.kind !== "addressed") return;
    expect(full.subject.kind).toBe("namespace");
    expect(full.subject.position).toEqual({ line: 0, character: 19 });

    const prefix = addressTsSymbol("A", [DOTTED], source(LINES));
    expect(prefix.kind).toBe("addressed");
    if (prefix.kind !== "addressed") return;
    expect(prefix.subject.kind).toBe("namespace");
    expect(prefix.subject.position).toEqual({ line: 0, character: 17 });
  });

  it("never addresses the tail of a dotted run alone, nor a key past its end", () => {
    expect(addressTsSymbol("B", [DOTTED], source(LINES)).kind).toBe("not-found");
    expect(addressTsSymbol("A.B.g", [DOTTED], source(LINES)).kind).toBe("not-found");
    expect(addressTsSymbol("A.C.f", [DOTTED], source(LINES)).kind).toBe("not-addressable");
  });

  it("reads whitespace and comments around the dots when it finds the identifier", () => {
    const lines = ["export namespace A /* c */ . B {", "  export const x = 1;", "}"];
    const spaced = sym({
      name: "A.B",
      kind: KIND.namespace,
      range: [[0, 7], [2, 1]],
      selection: [0, 17],
      selectionEnd: [0, 30],
      children: [sym({ name: "x", kind: KIND.variable, range: [[1, 2], [1, 21]], selection: [1, 15] })],
    });
    const outcome = addressTsSymbol("A.B", [spaced], source(lines));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.position).toEqual({ line: 0, character: 29 });
  });

  it("reaches a three-segment run, and a member through it", () => {
    const lines = ["export namespace P.Q.R {", "  export const x = 2;", "}"];
    const run = sym({
      name: "P.Q.R",
      kind: KIND.namespace,
      range: [[0, 7], [2, 1]],
      selection: [0, 17],
      selectionEnd: [0, 22],
      children: [sym({ name: "x", kind: KIND.variable, range: [[1, 2], [1, 21]], selection: [1, 15] })],
    });
    expect(addressTsSymbol("P.Q.R.x", [run], source(lines)).kind).toBe("addressed");
    const middle = addressTsSymbol("P.Q", [run], source(lines));
    expect(middle.kind).toBe("addressed");
    if (middle.kind !== "addressed") return;
    expect(middle.subject.position).toEqual({ line: 0, character: 19 });
  });

  it("reads a dotted entry beside a nested twin spelling the same path as one namespace", () => {
    const lines = ["export namespace A.B {", "  export function f() {}", "}", "export namespace A {", "  export namespace B {}", "}"];
    const nested = sym({
      name: "A",
      kind: KIND.namespace,
      range: [[3, 7], [5, 1]],
      selection: [3, 17],
      selectionEnd: [3, 18],
      children: [sym({ name: "B", kind: KIND.namespace, range: [[4, 9], [4, 23]], selection: [4, 20] })],
    });
    const outcome = addressTsSymbol("A.B", [DOTTED, nested], source(lines));
    expect(outcome.kind).toBe("addressed");
    if (outcome.kind !== "addressed") return;
    expect(outcome.subject.entries).toHaveLength(2);
    expect(outcome.subject.position).toEqual({ line: 0, character: 19 });
  });

  it("names the entry when its selectionRange does not hold the dotted run it claims", () => {
    const wrong = sym({ name: "A.B", kind: KIND.namespace, range: [[0, 7], [2, 1]], selection: [0, 17], selectionEnd: [0, 20] });
    const outcome = addressTsSymbol("A.B", [wrong], source(["export namespace X.Y {", "}", "}"]));
    expect(outcome.kind).toBe("unreadable-span");
    if (outcome.kind !== "unreadable-span") return;
    expect(outcome.entry).toBe(wrong);

    const noEnd = sym({ name: "A.B", kind: KIND.namespace, range: [[0, 7], [2, 1]], selection: [0, 17] });
    expect(addressTsSymbol("A.B", [noEnd], source(LINES)).kind).toBe("unreadable-span");
  });

  it("does not read the text for a key that never needs a position inside a dotted entry", () => {
    const wrong = sym({ name: "A.B", kind: KIND.namespace, range: [[0, 7], [2, 1]], selection: [0, 17] });
    expect(addressTsSymbol("Other", [wrong], source(LINES)).kind).toBe("not-found");
  });

  it("returns the position each reached entry is asked at from matchingEntries", () => {
    const reach = matchingEntries("A.B", [DOTTED], LINES);
    expect(reach.kind).toBe("reached");
    if (reach.kind !== "reached") return;
    expect(reach.entries).toEqual([{ entry: DOTTED, position: { line: 0, character: 19 } }]);
  });

  it("spells a row inside a dotted namespace with the whole dotted run", () => {
    expect(spellTsRow([DOTTED], { line: 1, character: 20 }, LINES)).toEqual({ name: "A.B.f", kind: "function" });
  });
});

// An interface and a namespace of one name are two meanings.
describe("an interface beside a namespace of one name", () => {
  const LINES = ["export interface I { a: number }", "export namespace I { export const x = 1; }"];
  const INTERFACE_I = sym({ name: "I", kind: KIND.interface, range: [[0, 7], [0, 32]], selection: [0, 17] });
  const NAMESPACE_I = sym({ name: "I", kind: KIND.namespace, range: [[1, 7], [1, 41]], selection: [1, 17] });

  it("refuses the bare key and offers `type` for the interface and `namespace` for the namespace", () => {
    for (const outline of [[INTERFACE_I, NAMESPACE_I], [NAMESPACE_I, INTERFACE_I]]) {
      const outcome = addressTsSymbol("I", outline, source(LINES));
      expect(outcome.kind).toBe("shared-key");
      if (outcome.kind !== "shared-key") return;
      expect(Object.fromEntries(outcome.candidates.map((candidate) => [candidate.kind, candidate.selector]))).toEqual({
        interface: "type",
        namespace: "namespace",
      });
    }
  });

  it("selects each entry by its prefix and spells the subject with it", () => {
    const type = addressTsSymbol("type I", [INTERFACE_I, NAMESPACE_I], source(LINES));
    expect(type.kind).toBe("addressed");
    if (type.kind !== "addressed") return;
    expect(type.subject.kind).toBe("interface");
    expect(type.subject.spelling).toBe("type I");

    const namespace = addressTsSymbol("namespace I", [INTERFACE_I, NAMESPACE_I], source(LINES));
    expect(namespace.kind).toBe("addressed");
    if (namespace.kind !== "addressed") return;
    expect(namespace.subject.kind).toBe("namespace");
    expect(namespace.subject.spelling).toBe("namespace I");
    expect(namespace.subject.position).toEqual({ line: 1, character: 17 });
  });

  it("spells a row of each declaration with the prefix, because their key collides", () => {
    expect(spellTsRow([INTERFACE_I, NAMESPACE_I], { line: 0, character: 25 }, LINES).name).toBe("type I");
    expect(spellTsRow([INTERFACE_I, NAMESPACE_I], { line: 1, character: 30 }, LINES).name).toBe("namespace I");
  });

  it("narrows to the askable entries before the collision rule, unless the caller chose with a prefix", () => {
    const askable = (entry: LspDocumentSymbol): boolean => entry.kind === KIND.interface;
    const bare = addressTsSymbol("I", [NAMESPACE_I, INTERFACE_I], source(LINES), askable);
    expect(bare.kind).toBe("addressed");
    if (bare.kind !== "addressed") return;
    expect(bare.subject.kind).toBe("interface");

    const chosen = addressTsSymbol("namespace I", [NAMESPACE_I, INTERFACE_I], source(LINES), askable);
    expect(chosen.kind).toBe("addressed");
    if (chosen.kind !== "addressed") return;
    expect(chosen.subject.kind).toBe("namespace");

    // With nothing askable among them the entries are kept, so the kind gate can say what the name is.
    const onlyOther = addressTsSymbol("I", [NAMESPACE_I], source(LINES), askable);
    expect(onlyOther.kind).toBe("addressed");
  });
});
