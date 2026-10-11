// Both configs in this directory list the file: the tsconfig through its own `include`, the jsconfig through
// the one above it. The nearest-config rule reads `tsconfig.json` first, so this file belongs to the tsconfig
// project and is that project's anchor — the jsconfig may read it, but it cannot own it.
export const BOTH_CONFIGS = "both";
