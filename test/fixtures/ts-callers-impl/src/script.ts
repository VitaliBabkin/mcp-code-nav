export function firstDeclaration(): number { return 1; }
export class Target { run(): void {} }
export const stored = new Target().run;
/*
  This file opens with a declaration, so that declaration starts at line 0, column 0: the position tsgo gives the
  SOURCE-FILE call-hierarchy item. The module-scope mention above must not be credited to `firstDeclaration`.
*/
