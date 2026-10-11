import { SUBSUMED_SUBJECT } from "./subject.js";

// The one use of the subject, in the third file the unloaded config lists and owns none of. It is neither a
// project anchor nor the named file of the call, so the use coming back means the program loaded by
// `pkg/tsconfig.json`'s anchor covered ground the root config reads without that project ever being opened —
// the reason for reporting it instead of failing it.
export function subsumedUse(): string {
  return SUBSUMED_SUBJECT;
}
