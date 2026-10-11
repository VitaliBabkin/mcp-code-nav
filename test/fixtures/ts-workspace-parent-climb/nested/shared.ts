// The disputed file of the parent-climb pin: the config in this same directory (`nested/tsconfig.json`)
// leaves it out of its `include`, while the ancestor config at the package root lists it. It is read by
// nobody in the nested project, and its one consumer sits in `src`, which only the ancestor project covers.
export const SHARED_CLIMB = "climb";
