import { symbolKindName, type LspDocumentSymbol } from "../clangd/outline.js";
import type { LinePosition, Position } from "./lsp-locations.js";
import type { NamedSymbol } from "./location-naming.js";

/**
 * How a TypeScript symbol is addressed, and how a row is spelled so it can be handed
 * straight back as that address.
 *
 * One key can name one symbol or two. It is one when TypeScript itself makes it one — overloads, a `get`/`set`
 * pair, and declaration merging of a single meaning — and two when it does not: a `static` member beside an
 * instance one, or a value beside a type that cannot merge with it. Two symbols under one key are never
 * resolved by picking: the caller is shown each candidate with the spelling that selects it, because guessing
 * here answers about the other declaration, which is a wrong answer rather than a partial one.
 */

/** The entries a dotted `symbol` may descend through. A local's or an object literal's members are not addressable. */
export const CONTAINER_KINDS: ReadonlySet<string> = new Set(["class", "interface", "enum", "namespace"]);

/** Which meanings an entry can carry. A class, enum and namespace carry both, which is why merging works. */
const TYPE_MEANINGS = new Set(["class", "interface", "enum", "namespace", "module"]);
const VALUE_MEANINGS = new Set([
  "class",
  "enum",
  "namespace",
  "variable",
  "constant",
  "function",
  "method",
  "property",
  "field",
  "constructor",
]);

/** The unlike kind pairs TypeScript merges into one declaration; like pairs are covered by the overload rule. */
const MERGES = new Set(["class|interface", "namespace|class", "namespace|function", "namespace|enum"]);

/** The prefix that separates two symbols sharing a key. */
export type TsSelector = "static" | "instance" | "value" | "type" | "namespace";

const SELECTORS: readonly TsSelector[] = ["static", "instance", "value", "type", "namespace"];

export interface TsCandidate {
  readonly entry: LspDocumentSymbol;
  readonly kind: string;
  readonly line: number;
  /** The prefix that reaches this candidate, or `undefined` when no documented prefix separates it. */
  readonly selector?: TsSelector;
}

export type TsAddressOutcome =
  | { readonly kind: "addressed"; readonly subject: TsSubject }
  | { readonly kind: "shared-key"; readonly symbol: string; readonly candidates: readonly TsCandidate[] }
  | { readonly kind: "not-found"; readonly symbol: string }
  | { readonly kind: "unreadable-span"; readonly symbol: string; readonly entry: LspDocumentSymbol }
  | { readonly kind: "not-addressable"; readonly symbol: string; readonly through: string; readonly kindName: string };

/** One addressed subject: what it is, where its own name is, and how a row carrying it should spell it. */
export interface TsSubject {
  readonly symbol: string;
  /** Every entry that makes up this symbol — several for an overload set, a merged declaration or an accessor pair. */
  readonly entries: readonly LspDocumentSymbol[];
  /** The entry whose position a request is asked at: the first in source order. */
  readonly entry: LspDocumentSymbol;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly position: Position;
  /**
   * Where each of `entries` is asked at, which is not the entry's own start for a dotted namespace run (`A.B` is
   * asked at `B`). The identity test of a reported location reads these.
   */
  readonly positions?: readonly Position[];
  /** The `symbol` spelling a row uses: the dotted path, with a prefix only where its key is shared. */
  readonly spelling: string;
}

/** The addressed file's own text: a member's modifiers are read from between its start and its name. */
export interface TsAddressSource {
  readonly file: string;
  readonly lines: readonly string[];
}

/**
 * The text between a declaration's start and its own identifier — `static `, `get `, `set `, a decorator. tsgo's
 * `range` covers modifiers and its `selectionRange` is the identifier, as the live suite pins, so static-ness
 * is read off the server's own positions instead of re-parsing the declaration. The span is read ACROSS lines:
 * a decorator on the line above `static run()` is the usual layout, and stopping at the line break made that
 * member read as an instance one — which merged a static and an instance declaration into one symbol and
 * answered the pair at one declaration, the same wrong answer the prefixes exist to prevent.
 */
function modifierSpan(entry: LspDocumentSymbol, lines: readonly string[]): string {
  const start = entry.range.start;
  const identifier = entry.selectionRange?.start;
  if (identifier === undefined || start.character === undefined || identifier.line < start.line) return "";
  if (identifier.line === start.line) return lines[start.line]?.slice(start.character, identifier.character) ?? "";
  const first = lines[start.line]?.slice(start.character) ?? "";
  const last = lines[identifier.line]?.slice(0, identifier.character) ?? "";
  return [first, ...lines.slice(start.line + 1, identifier.line), last].join("\n");
}

/** The index of the last character of the string literal opening at `from`, or the span's end if none closes. */
function closingQuote(span: string, from: number): number {
  const quote = span[from];
  let index = from + 1;
  while (index < span.length) {
    const char = span[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index;
    index += 1;
  }
  return index;
}

/** The index of the last character of the comment opening at `from`, or the span's end if none closes. */
function closingComment(span: string, from: number): number {
  if (span[from + 1] === "/") {
    const newline = span.indexOf("\n", from + 2);
    return newline === -1 ? span.length : newline - 1;
  }
  const end = span.indexOf("*/", from + 2);
  return end === -1 ? span.length : end + 1;
}

/**
 * Whether the span carries the `static` MODIFIER. It is a `static` token outside decorator
 * parentheses, so what a decorator's argument list holds is dropped before the word is looked for — and so is
 * every string literal and every comment, because `@tag("static")` and `// static cache` are prose about the
 * member, not modifiers on it. Reading either as a modifier merges a static member with an instance one, which
 * is the wrong answer the prefixes exist to prevent.
 */
function staticTokenIn(span: string): boolean {
  let outside = "";
  let depth = 0;
  for (let index = 0; index < span.length; index += 1) {
    const char = span[index] as string;
    if (char === '"' || char === "'" || char === "`") {
      index = closingQuote(span, index);
      outside += " ";
    } else if (char === "/" && (span[index + 1] === "/" || span[index + 1] === "*")) {
      index = closingComment(span, index);
      outside += " ";
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
      outside += " ";
    } else if (depth === 0) {
      outside += char;
    }
  }
  return /\bstatic\b/.test(outside);
}

function isStaticEntry(entry: LspDocumentSymbol, lines: readonly string[]): boolean {
  return staticTokenIn(modifierSpan(entry, lines));
}

function mergeable(left: string, right: string): boolean {
  // Two entries of the SAME kind are one symbol only when they are also equally static — the first half of
  // `isOneSymbol`. Folding same-kind pairs in here is what made a `static` member and an instance one of one
  // name read as a single declaration, and answered `instance C.run` at the static one (that pair is the
  // two-symbols case, separated by its prefixes).
  return MERGES.has(`${left}|${right}`) || MERGES.has(`${right}|${left}`);
}

/**
 * Whether two entries under one key are one declaration: the same kind at the same static-ness (an overload
 * set, a `get`/`set` pair), or a pair of kinds TypeScript merges.
 */
function oneOfThem(entry: LspDocumentSymbol, other: LspDocumentSymbol, lines: readonly string[]): boolean {
  const kind = symbolKindName(entry.kind);
  if (kind === symbolKindName(other.kind)) return isStaticEntry(entry, lines) === isStaticEntry(other, lines);
  return mergeable(kind, symbolKindName(other.kind));
}

/**
 * Whether these entries are one symbol: every PAIR in the group has to be a pair TypeScript makes one.
 * Judging each entry against the first alone made the answer depend on which declaration the server happened
 * to report first — `namespace` merges with a `class`, and a class with an `interface`, but
 * `namespace|interface` is not itself a merging pair — so one ordering of three declarations called them one
 * symbol and another refused them, for the same file. A group of one is one symbol by definition.
 */
function isOneSymbol(entries: readonly LspDocumentSymbol[], lines: readonly string[]): boolean {
  for (let index = 0; index < entries.length; index += 1) {
    for (let other = index + 1; other < entries.length; other += 1) {
      if (!oneOfThem(entries[index] as LspDocumentSymbol, entries[other] as LspDocumentSymbol, lines)) return false;
    }
  }
  return true;
}

/**
 * The prefix that separates each candidate from the rest of the group: static-ness when the group splits that
 * way, meaning when it splits a value from a type. A group that splits neither way has no documented spelling,
 * and saying so is better than picking one of them.
 */
function candidatesOf(entries: readonly LspDocumentSymbol[], lines: readonly string[]): TsCandidate[] {
  const read = entries.map((entry) => ({ entry, kind: symbolKindName(entry.kind), static: isStaticEntry(entry, lines) }));
  const splitsByStatic = read.some(({ static: memberStatic }) => memberStatic) && read.some(({ static: memberStatic }) => !memberStatic);
  const valueKinds = read.filter(({ kind }) => VALUE_MEANINGS.has(kind) && !TYPE_MEANINGS.has(kind));
  const splitsByMeaning = valueKinds.length > 0 && read.some(({ kind }) => TYPE_MEANINGS.has(kind));
  // An interface is a type and a namespace is a namespace, and TypeScript's reference search widens only through
  // declarations whose meaning intersects: a group of exactly those two
  // is two symbols with a prefix each.
  const interfaceBesideNamespace =
    read.every(({ kind }) => kind === "interface" || kind === "namespace") &&
    read.some(({ kind }) => kind === "interface") &&
    read.some(({ kind }) => kind === "namespace");
  return read.map(({ entry, kind, static: memberStatic }) => ({
    entry,
    kind,
    line: nameLine(entry),
    selector: splitsByStatic
      ? memberStatic
        ? "static"
        : "instance"
      : interfaceBesideNamespace
        ? kind === "interface"
          ? "type"
          : "namespace"
        : splitsByMeaning
        ? TYPE_MEANINGS.has(kind)
          ? "type"
          : "value"
        : undefined,
  }));
}

/** The documented prefix on a `symbol`, if it carries one, and the name under it. */
function splitSelector(symbol: string): { readonly selector?: TsSelector; readonly name: string } {
  const prefix = /^([a-z]+)\s+(.*)$/s.exec(symbol.trim());
  const word = prefix?.[1];
  if (word === undefined || !SELECTORS.includes(word as TsSelector)) return { name: symbol.trim() };
  return { selector: word as TsSelector, name: (prefix?.[2] ?? "").trim() };
}

function withKey(entries: readonly LspDocumentSymbol[], key: string): LspDocumentSymbol[] {
  return entries.filter((entry) => entry.name === key);
}

function childEntries(entry: LspDocumentSymbol): LspDocumentSymbol[] {
  return entry.children ?? [];
}

/** The 1-based line of the entry's own name: a decorator line above it belongs to the range, not to the name. */
export function nameLine(entry: LspDocumentSymbol): number {
  return (entry.selectionRange?.start.line ?? entry.range.start.line) + 1;
}

function selectionOf(entry: LspDocumentSymbol): Position | undefined {
  const start = entry.selectionRange?.start;
  return start === undefined ? undefined : { line: start.line, character: start.character };
}

function addressed(
  symbol: string,
  spelling: string,
  entries: readonly LspDocumentSymbol[],
  entry: LspDocumentSymbol,
  position: Position | undefined,
  source: TsAddressSource,
  positions: readonly (Position | undefined)[] = [position],
): TsAddressOutcome {
  if (position === undefined) {
    // Addressing asks about a name, and a name the server never located cannot be asked about at all.
    return { kind: "not-found", symbol };
  }
  return {
    kind: "addressed",
    subject: {
      symbol,
      entries,
      entry,
      kind: symbolKindName(entry.kind),
      file: source.file,
      line: position.line + 1,
      position,
      positions: positions.filter((one): one is Position => one !== undefined),
      spelling,
    },
  };
}

/** An entry a name reaches, with the position a type-aware request about it is asked at. */
export interface ReachedEntry {
  readonly entry: LspDocumentSymbol;
  /** `undefined` when the server located no name for the entry. */
  readonly position: Position | undefined;
}

/** Where descending a dotted name through an outline ended: at its entries, at a segment that holds no member, or unreadable. */
export type Reach =
  | { readonly kind: "reached"; readonly entries: ReachedEntry[] }
  | { readonly kind: "blocked"; readonly through: string; readonly kindName: string }
  | { readonly kind: "unreadable"; readonly entry: LspDocumentSymbol };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const IDENTIFIER_AT = /^[A-Za-z_$][\w$]*/;

/**
 * The identifiers a dotted namespace entry spells (`A.B` is `["A", "B"]`), or `undefined` for any other entry.
 * tsgo reports `namespace A.B { ... }` as ONE entry named `A.B`.
 */
function dottedParts(entry: LspDocumentSymbol): string[] | undefined {
  const kind = symbolKindName(entry.kind);
  if ((kind !== "namespace" && kind !== "module") || !entry.name.includes(".")) return undefined;
  const parts = entry.name.split(".");
  return parts.every((part) => IDENTIFIER.test(part)) ? parts : undefined;
}

function isContainer(entry: LspDocumentSymbol): boolean {
  return CONTAINER_KINDS.has(symbolKindName(entry.kind)) || dottedParts(entry) !== undefined;
}

/** Where the block comment opening just before `from` on `line` ends, searching across lines. */
function afterBlockComment(lines: readonly string[], line: number, from: number): Position | undefined {
  let row = line;
  let column = from;
  while (row < lines.length) {
    const closing = (lines[row] ?? "").indexOf("*/", column);
    if (closing >= 0) return { line: row, character: closing + 2 };
    row += 1;
    column = 0;
  }
  return undefined;
}

/**
 * The identifiers inside an entry's `selectionRange`, each with where it starts: names separated by `.`, with
 * whitespace and comments allowed around the dots. This is the second lexical read beside the `static` modifier
 * span, and like that one it reads only text between positions the server gave. `undefined` when the span holds
 * anything else, or when the server sent no end for it.
 */
function spelledIdentifiers(entry: LspDocumentSymbol, lines: readonly string[]): { text: string; position: Position }[] | undefined {
  const start = entry.selectionRange?.start;
  const end = entry.selectionRange?.end;
  if (start === undefined || end === undefined) return undefined;
  const found: { text: string; position: Position }[] = [];
  let line = start.line;
  let column = start.character;
  let expectName = true;
  while (line < end.line || (line === end.line && column < end.character)) {
    const text = lines[line];
    if (text === undefined) return undefined;
    if (column >= text.length) {
      line += 1;
      column = 0;
      continue;
    }
    const rest = text.slice(column);
    if (/^\s/.test(rest)) {
      column += 1;
    } else if (rest.startsWith("//")) {
      line += 1;
      column = 0;
    } else if (rest.startsWith("/*")) {
      const after = afterBlockComment(lines, line, column + 2);
      if (after === undefined) return undefined;
      line = after.line;
      column = after.character;
    } else if (expectName) {
      const name = IDENTIFIER_AT.exec(rest)?.[0];
      if (name === undefined) return undefined;
      found.push({ text: name, position: { line, character: column } });
      column += name.length;
      expectName = false;
    } else if (rest.startsWith(".")) {
      column += 1;
      expectName = true;
    } else {
      return undefined;
    }
  }
  return expectName ? undefined : found;
}

/**
 * The position a key that ends at `index` of a dotted entry's run is asked at: where the identifier the key's
 * last segment names starts. The first identifier is the entry's own `selectionRange.start`, which needs no read.
 */
function runPosition(entry: LspDocumentSymbol, parts: readonly string[], index: number, lines: readonly string[]): Position | undefined | "unreadable" {
  if (index === 0) return selectionOf(entry);
  const spelled = spelledIdentifiers(entry, lines);
  const at = spelled?.[index];
  const holdsRun = spelled !== undefined && spelled.length === parts.length && spelled.every((id, i) => id.text === parts[i]);
  return holdsRun && at !== undefined ? at.position : "unreadable";
}

/** Whether `segments[from ...]` starts with the first `take` identifiers of an entry's run. */
function startsWithRun(segments: readonly string[], from: number, take: number, parts: readonly string[]): boolean {
  for (let offset = 0; offset < take; offset += 1) {
    if (segments[from + offset] !== parts[offset]) return false;
  }
  return true;
}

/** One level of the outline still to be searched, and how many key segments the entries above it consumed. */
interface Level {
  readonly entries: readonly LspDocumentSymbol[];
  readonly from: number;
}

/**
 * Each key segment names one entry, except that a dotted namespace entry (`A.B`) consumes as many segments as it
 * spells, and a key that ends inside its run (`A` against `A.B`) reaches it at that segment. A segment after the
 * entries above it is looked for among their children, which have to be a class, interface, enum or namespace.
 */
function descend(name: string, outline: readonly LspDocumentSymbol[], lines: readonly string[]): Reach {
  const segments = name.split(".");
  const reached: ReachedEntry[] = [];
  let blocked: Reach | undefined;
  const work: Level[] = [{ entries: outline, from: 0 }];
  for (const { entries, from } of work) {
    let matched = 0;
    let through = 0;
    let containers = 0;
    let firstThrough: LspDocumentSymbol | undefined;
    for (const entry of entries) {
      const parts = dottedParts(entry) ?? [entry.name];
      const take = Math.min(segments.length - from, parts.length);
      if (!startsWithRun(segments, from, take, parts)) continue;
      matched += 1;
      if (from + take === segments.length) {
        const position = runPosition(entry, parts, take - 1, lines);
        if (position === "unreadable") return { kind: "unreadable", entry };
        reached.push({ entry, position });
        continue;
      }
      through += 1;
      firstThrough ??= entry;
      if (!isContainer(entry)) continue;
      containers += 1;
      work.push({ entries: childEntries(entry), from: from + take });
    }
    if (from >= segments.length - 1 || blocked !== undefined) continue;
    const path = segments.slice(0, from + 1).join(".");
    if (matched === 0) blocked = { kind: "blocked", through: path, kindName: "nothing" };
    else if (through > 0 && containers === 0) {
      blocked = { kind: "blocked", through: path, kindName: symbolKindName(firstThrough?.kind ?? 0) };
    }
  }
  if (reached.length > 0) return { kind: "reached", entries: reached };
  return blocked ?? { kind: "reached", entries: [] };
}

/**
 * Every entry a dotted `name` reaches, several or none, with no opinion on whether TypeScript makes them one
 * symbol: the question "what declares this name" is answered by the whole set, so listing it guesses nothing.
 * `name` carries no selector prefix; `lines` is the file's text, read only inside a dotted entry's own span.
 */
export function matchingEntries(name: string, outline: readonly LspDocumentSymbol[], lines: readonly string[]): Reach {
  const reach = descend(name, outline, lines);
  return reach.kind === "blocked" ? { kind: "reached", entries: [] } : reach;
}

/** The entries a caller can ask, when some can and some cannot; all of them when none can, so its kind gate speaks. */
function narrowed(reached: readonly ReachedEntry[], askable: (entry: LspDocumentSymbol) => boolean): readonly ReachedEntry[] {
  const kept = reached.filter(({ entry }) => askable(entry));
  return kept.length > 0 ? kept : reached;
}

/**
 * Address `symbol` in the outline of `source.file`. Each dotted segment names one entry (a dotted namespace entry
 * names several); a segment after the first is looked for among the children of the entry above it, which has to
 * be a class, interface, enum or namespace. Where a segment names several entries that TypeScript makes one
 * symbol, the first in source order is the position asked at. Where they are separate symbols, a prefix on the
 * name selects one, and a bare name is refused with each candidate's own spelling. `askable` drops, before that
 * rule, the entries a caller cannot ask about whenever some can be asked — and never when the caller chose one
 * with a prefix.
 */
export function addressTsSymbol(
  symbol: string,
  outline: readonly LspDocumentSymbol[],
  source: TsAddressSource,
  askable?: (entry: LspDocumentSymbol) => boolean,
): TsAddressOutcome {
  const { selector, name } = splitSelector(symbol);
  const descent = descend(name, outline, source.lines);
  if (descent.kind === "blocked") {
    return { kind: "not-addressable", symbol, through: descent.through, kindName: descent.kindName };
  }
  if (descent.kind === "unreadable") return { kind: "unreadable-span", symbol, entry: descent.entry };
  const reached = selector === undefined && askable !== undefined ? narrowed(descent.entries, askable) : descent.entries;
  if (reached.length === 0) return { kind: "not-found", symbol };
  const candidates = reached.map(({ entry }) => entry);
  const positions = new Map(reached.map(({ entry, position }) => [entry, position]));
  const first = candidates[0] as LspDocumentSymbol;
  if (isOneSymbol(candidates, source.lines)) {
    return addressed(symbol, name, candidates, first, positions.get(first), source, reached.map(({ position }) => position));
  }
  const candidatesRead = candidatesOf(candidates, source.lines);
  const chosen = selector === undefined ? undefined : candidatesRead.find((candidate) => candidate.selector === selector);
  if (chosen === undefined) return { kind: "shared-key", symbol: name, candidates: candidatesRead };
  return addressed(symbol, `${selector} ${name}`, [chosen.entry], chosen.entry, positions.get(chosen.entry), source);
}

/** The entries an implementations question prefers, in preference order. */
const IMPLEMENTATION_PREFERRED = ["interface", "class"];

/**
 * The same symbol asked at another of the entries that make it up. Nothing about its name or spelling moves —
 * one key, one symbol — only the position, the kind and the line the answer is about.
 */
function reaimed(subject: TsSubject, entry: LspDocumentSymbol): TsSubject {
  const position = selectionOf(entry);
  if (position === undefined) return subject;
  return { ...subject, entry, kind: symbolKindName(entry.kind), line: nameLine(entry), position };
}

/** The entry of one symbol the implementations question belongs to, or `undefined` when it holds neither kind. */
function preferredEntry(subject: TsSubject): LspDocumentSymbol | undefined {
  for (const kind of IMPLEMENTATION_PREFERRED) {
    const entry = subject.entries.find((candidate) => symbolKindName(candidate.kind) === kind);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/**
 * The subject a `ts_find_implementations` call asks ("an implementations call prefers
 * an interface or class entry among them"). One key can merge a class with an interface, and TypeScript makes
 * those two one symbol addressed at the first in source order — but they answer different questions: the
 * interface is what a type implements and the class is what a type derives from. Asking at whichever came
 * first would make the answer depend on the order the server happened to report them in, so the preference is
 * read here, where the entries and their kinds are. A symbol whose first entry already IS the preferred one is
 * handed back untouched — re-aiming it at the OTHER kind would change the question being asked.
 */
export function implementationsSubject(subject: TsSubject): TsSubject {
  const preferred = preferredEntry(subject);
  return preferred === undefined || preferred === subject.entry ? subject : reaimed(subject, preferred);
}

/** Whether `entry`'s span holds `position`, by line and, when both sides have one, by character. */
function containsPosition(entry: LspDocumentSymbol, position: LinePosition): boolean {
  const { start, end } = entry.range;
  const character = position.character;
  if (character === undefined) return position.line >= start.line && position.line <= end.line;
  const before = position.line < start.line || (position.line === start.line && (start.character ?? 0) > character);
  const after = position.line > end.line || (position.line === end.line && (end.character ?? 0) < character);
  return !before && !after;
}

/** The entries containing `position`, outermost first, descending through children only. */
function enclosingChain(symbols: readonly LspDocumentSymbol[], position: LinePosition): LspDocumentSymbol[] {
  const chain: LspDocumentSymbol[] = [];
  let level = symbols;
  for (;;) {
    const next = level.find((entry) => containsPosition(entry, position));
    if (next === undefined) return chain;
    chain.push(next);
    level = childEntries(next);
  }
}

function unnamed(reason: string): NamedSymbol {
  return { name: null, kind: null, reason };
}

const NO_ENCLOSING_DECLARATION = "no declaration in this file encloses the reported location";

/**
 * The TypeScript row name: the deepest enclosing declaration spelled the way `symbol` accepts it
 * — the containers above it plus its own name — so a row can be pasted straight back as the next call's
 * `symbol`. A site on a container's own name is inside that container and nothing below it, so the container
 * is the declaration named. The key that names it carries a prefix only where that key is shared in its own
 * file, because a row that could address two declarations would otherwise be read back as one of them by luck.
 */
export function spellTsRow(
  symbols: readonly LspDocumentSymbol[],
  position: LinePosition,
  lines: readonly string[],
  noDeclarationReason = NO_ENCLOSING_DECLARATION,
): NamedSymbol {
  const chain = enclosingChain(symbols, position);
  if (chain.length === 0) return unnamed(noDeclarationReason);
  const containers = [];
  for (const entry of chain) {
    if (!CONTAINER_KINDS.has(symbolKindName(entry.kind))) break;
    containers.push(entry);
  }
  // A chain of nothing but containers is a site on the innermost one's own name: that entry is the subject,
  // and the entries above it are the path a `symbol` descends through to reach it.
  const depth = containers.length === chain.length ? containers.length - 1 : containers.length;
  const subject = chain[depth];
  if (subject === undefined) return unnamed(NO_ENCLOSING_DECLARATION);
  const above = containers.slice(0, depth);
  const siblings = above.length === 0 ? symbols : childEntries(above[above.length - 1] as LspDocumentSymbol);
  const sharing = withKey(siblings, subject.name);
  // A prefix is written only where one separates the pair. Where the collision splits neither by
  // static-ness nor by meaning there is no documented selector, and the row carries the bare dotted path
  // rather than a space where the missing word would have been — a `" E.run"` is a name no `symbol` reads
  // back as anything, and the refusal the bare key earns at least lists the candidates.
  const selector =
    sharing.length > 1 && !isOneSymbol(sharing, lines)
      ? candidatesOf(sharing, lines).find((candidate) => candidate.entry === subject)?.selector
      : undefined;
  const prefix = selector === undefined ? "" : `${selector} `;
  const path = [...above.map((entry) => entry.name), subject.name];
  return { name: `${prefix}${path.join(".")}`, kind: symbolKindName(subject.kind) };
}
