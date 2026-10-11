// The nested project's anchor: the lexically first source that `pkg/tsconfig.json` owns, so this is the file
// this server opens to load that project. It is here only to sort first — it declares a symbol nobody uses, so
// it cannot move the answer of the call that asks about `SUBSUMED_SUBJECT`, and the anchor stays a document
// distinct from the one the call names.
export const SUBSUMED_ANCHOR = "anchor";
