import { Store as S } from "./store.js";

export function renamed(store: S): string {
  return store.read("renamed");
}
