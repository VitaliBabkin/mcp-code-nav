import { SHARED_CLIMB } from "../nested/shared.js";

// The only consumer of the disputed file, and the only file the ancestor config owns: it sits in `src`, which
// the nested config does not reach. Finding the use below therefore means the ancestor project answered.
export function ancestorUse(): string {
  return SHARED_CLIMB;
}
