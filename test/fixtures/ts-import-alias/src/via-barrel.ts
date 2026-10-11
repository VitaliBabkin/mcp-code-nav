import { Store } from "./barrel.js";

export function viaBarrel(store: Store): string {
  return store.read("barrel");
}
