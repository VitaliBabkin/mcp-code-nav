/**
 * Markdown reduced to its lines: every run of line breaks, with the blanks around it, becomes one `\n`. clangd 18 joins
 * the parts of a hover with a hard line break (two trailing spaces, then a newline) and later releases separate them
 * with a blank line, so a comparison against clangd's text pins the words and their order and is indifferent to which
 * of the two spellings of "next line" the release used.
 */
export function collapseLineBreaks(markdown: string | undefined): string | undefined {
  return markdown?.replace(/[ \t]*\n(?:[ \t]*\n)*/g, "\n");
}
