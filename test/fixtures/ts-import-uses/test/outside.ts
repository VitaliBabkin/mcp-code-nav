import { Store } from "../src/store.js";

export const ONLY_OUTSIDE = "declared in a file no tsconfig includes";

export function outsideUses(store: Store): string {
  return store.read("outside");
}
