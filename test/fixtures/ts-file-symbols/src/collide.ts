/*
  Every entry here exists to pin one addressing rule, which is decided by what tsgo's
  `documentSymbol` reports rather than by anything this server computes:

  - `run` twice, once `static`, once not: two symbols share one key, and the only thing that tells them apart
    is the modifier span between the entry's `range.start` and its `selectionRange.start`.
  - `label` as a `get` and a `set`: TypeScript makes one symbol of the pair, so both entries carry one name.
  - `Widget` as a value and as an interface that does not merge with it: a second way two symbols share a key.
  - `Mergeable` declared twice as an interface: declaration merging of one meaning is one symbol.
*/

export class Collide {
  static run(): number {
    return 1;
  }

  run(): number {
    return 2;
  }

  get label(): string {
    return "read";
  }

  set label(value: string) {}
}

export const Widget = { kind: "value" };

export interface Widget {
  kind: string;
}

export interface Mergeable {
  first(): void;
}

export interface Mergeable {
  second(): void;
}
