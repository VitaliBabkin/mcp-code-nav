import { Store } from "./store.js";

export function consume(store: Store): string {
  return store.read("consumed");
}
