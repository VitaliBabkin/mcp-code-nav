// The subject of the one `ts_find_references` call in this fixture's live case. Both configs list this file:
// `pkg/tsconfig.json` through its `include: ["src"]`, and the workspace-root config through its
// `include: ["pkg/src"]`, which names the same directory the nested config owns. The nested one is this file's
// NEAREST named config, so it owns the file and the root config does not — which is the shape
// the map rules `subsumed` rather than `failed` for.
export const SUBSUMED_SUBJECT = "subject";
