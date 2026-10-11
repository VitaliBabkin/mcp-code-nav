import { Store } from "../src/store.js";
import { OWNER_FILE } from "../src/owner.js";

export function nodeFlush(store: Store): string {
  return OWNER_FILE + store.flush();
}
