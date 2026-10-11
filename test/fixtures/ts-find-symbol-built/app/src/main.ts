// Reads the build output of a sibling directory that no tsconfig above it includes: the declaration is
// inside the workspace root and listed by the program, but no project owns it.
import { area as builtArea } from "../../built/area.js";

export const total: number = builtArea();
