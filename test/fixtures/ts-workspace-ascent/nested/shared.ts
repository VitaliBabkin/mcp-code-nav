// The disputed file of the ownership-ascent pin: the config beside it,
// `nested/tsconfig.json`, includes only `inner`, so it leaves this file out, while the ancestor config at the
// package root includes all of `nested` and therefore names it. Nothing else is opened when the question is
// asked, so the answer can only come from a program this file's own assignment put it into.
// It imports nothing: an import would pull another file into whatever program answers, and the pin would stop
// being a fact about tsgo's assignment instead of being one about this file.
export const SHARED_HERE = "here";
