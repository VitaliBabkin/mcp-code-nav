/** The message of a caught value: an `Error`'s own, otherwise the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
