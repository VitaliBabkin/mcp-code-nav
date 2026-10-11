import { LABEL } from "./label.js";
import { LABEL as RENAMED } from "./label.js";
import makeTarget from "./bindings-target.js";
import * as NS from "./bindings-target.js";
import type { TargetShape } from "./bindings-target.js";
import {
  TARGET,
} from "./bindings-target.js";
import { missing } from "./no-such-module.js";
export { LABEL as RETHROWN } from "./label.js";
export const plain: TargetShape = { size: makeTarget().length };
export let later = RENAMED + TARGET + NS.TARGET + LABEL;
const counted = 0;
export { counted };
export function read(shape: typeof plain): number {
  return shape.size + counted;
}
