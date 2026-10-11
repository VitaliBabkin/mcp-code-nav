// The use the pin asks about. It sits in `nested`, not in `nested/inner`, so the config beside it — which
// includes `inner` alone — does not reach it, and the ancestor `tsconfig.json`, whose `include` covers all of
// `nested`, is the only project in the fixture that lists it. The pin never opens this file: opening it would
// load the ancestor itself and answer the question before it was asked.
import { SHARED_HERE } from "./shared.js";

export function consumeHere(): string {
  return SHARED_HERE;
}
