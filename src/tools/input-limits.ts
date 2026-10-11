import { z } from "zod";

const NO_NUL = (value: string): boolean => !value.includes("\0");

/** A file-system path argument: non-empty, at most 4096 characters, no NUL (which Node rejects with a `TypeError`). */
export const PathInput = z.string().min(1).max(4096).refine(NO_NUL, "must not contain NUL");

/** A symbol, name or free-text argument: non-empty, at most 1024 characters, no NUL. */
export const NameInput = z.string().min(1).max(1024).refine(NO_NUL, "must not contain NUL");

/** A list of paths, at most 256 entries. */
export const PathList = z.array(PathInput).max(256);
