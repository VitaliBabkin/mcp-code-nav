// The nested project's own file: the one member `nested/tsconfig.json` names, which is what makes that config a
// real project rather than an empty directory. It imports nothing, so the nested program holds neither the
// disputed file nor its use, and an answer carrying the use cannot have come from the nested project.
export const INNER_OWNED = "owned";
