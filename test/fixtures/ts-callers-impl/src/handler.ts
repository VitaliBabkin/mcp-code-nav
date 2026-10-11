/*
  the live shape, in the declarations `ts_find_callers` and `ts_find_implementations` are
  measured against. One project (`tsconfig.json` includes `src`), so nothing here can be missing from an
  answer because a project was never loaded — what comes back is tsgo's own type-aware answer about these
  declarations and nothing else.

  - `Handler.handle` is called two ways from src/uses.ts: on a `Direct` value directly, and on a `Handler`
    value. The over-report is that a method's listing carries both, which is the measured server behaviour's measurement:
    calls made through the interface are credited to the implementing method.
  - `picked("c")` in src/uses.ts calls the same method through a FUNCTION VALUE. That is not a call-hierarchy
    edge and must be absent, which is what `indirect-dispatch-not-resolved` states on every caller answer. The
    extraction that produced it (`const picked = new Direct().handle`) is credited, at module scope, and so are
    `register` and `boundToNull`, which pass `handle` to `map` and to `.bind` without ever calling it —
    the tool states that widening, and `uncalled-mentions-included` says so on every
    answer. `passJobBare` passes `runJob` BARE instead, which the rule does not reach, so it stays absent.
  - `Both extends Base implements Handler` measures which half of a heritage clause tsgo's `implementation`
    reaches: a class that both derives from an implementer and names the interface itself must be listed for
    that interface, and `Base` alone answers for the derivation.
  - `Structural` satisfies `Handler` member for member and never names it. the measured server behaviour measured that neither
    tsgo nor tsls reports such a type, so its absence is the fact `structural-implementers-not-reported` is
    there to say.
  - `Alone` has no implementer at all: the answer must be a scoped empty, not an error.
  - `runJob` is an arrow-function `const` that is called, and `LABEL` is a `const` that is never called.
    tsgo's outline kind cannot tell the two apart, so `prepareCallHierarchy` itself is the
    callable gate, and these two declarations are how that is measured live.

  Nothing here uses a global, a Node or DOM type, or a file outside this fixture.
*/

export interface Handler {
  handle(job: string): string;
}

export class Base implements Handler {
  handle(job: string): string {
    return "base:" + job;
  }
}

export class Both extends Base implements Handler {
  handle(job: string): string {
    return "both:" + job;
  }
}

export class Direct implements Handler {
  handle(job: string): string {
    return "direct:" + job;
  }
}

export class Structural {
  handle(job: string): string {
    return "structural:" + job;
  }
}

export interface Alone {
  only(): void;
}

export const runJob = (job: string): string => job.trim();

export const LABEL = "label";
