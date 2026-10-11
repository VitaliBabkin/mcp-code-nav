/*
  One class, three projects, one consumer each: what a project can *name* is what the
  member/owner/anchor rule and the documents-opened proof are measured against, because tsgo answers
  only for the projects whose anchor files it has opened.

  - `Store` is imported by src/app-only.ts (the app project's consumer), by tools/node-uses.ts (the node
    project's consumer) and by test/store.test.ts (the file no project lists).
  - `run`'s consumer inside a project is src/app-only.ts alone — a file only tsconfig.app.json lists, so an
    answer about `Store.run` needs the app project open. test/store.test.ts calls `run` too and is listed by no
    project: that use is what must be absent from the answer while the file is in `uncoveredSources`.
  - `flush`'s consumer is tools/node-uses.ts alone, listed only by tsconfig.node.json. That file also imports
    src/owner.ts, which the app project owns, so the node project's lexically first listed file is one it does
    not own — its anchor must still be tools/node-uses.ts.
  - The member project's consumer is packages/ui/src/widget.ts, on src/shared.ts's `SHARED_LABEL` and `Named`;
    configs/member.json reaches it, and is reached only through this fixture's `references`.

  Nothing here uses a global, a Node or DOM type, or a file outside this one.
*/

export class Store {
  constructor(private readonly where: string) {}

  run(): string {
    return "run:" + this.where;
  }

  flush(): string {
    return "flush:" + this.where;
  }
}
