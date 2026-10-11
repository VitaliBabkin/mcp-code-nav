// Named by the jsconfig alone. This file's own directory holds no config, so its nearest config is the one in
// the root beside it — the tsconfig — and that config does not list it. The owner search therefore goes down
// the tsconfig's `references` closure and lands on the jsconfig, which anchors on this file.
export const JS_ONLY = "js-only";
