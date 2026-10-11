import { Store } from "../src/store.js";

export function testUsesRun(store: Store): string {
  return store.run();
}
