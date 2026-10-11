import { Store } from "./store.js";

export function appReport(store: Store): string {
  return store.run();
}
