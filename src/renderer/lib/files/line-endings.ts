/**
 * A file's line endings, read off it and put back on the way out.
 *
 * Every buffer this app holds is `\n` only. A Windows checkout under
 * `core.autocrlf` is `\r\n` on disk, and splitting that on `\n` left a `\r` at
 * the end of every line, which `highlightSpecialChars` drew as a red mark on
 * each one. Normalising on read alone would have been worse: the first save
 * would rewrite every line of somebody's file, and the dirty check would
 * compare a normalised buffer against a `saved` that was not.
 */
export type LineEnding = "\n" | "\r\n"

/**
 * Whichever ending the file mostly uses — a file that mixes them is written
 * back in the majority's, which is what an editor that normalises does.
 */
export function lineEndingOf(text: string): LineEnding {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  return crlf > lf ? "\r\n" : "\n"
}

/** The text with every `\r\n` (and a lone `\r`) as `\n`. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

/** A `\n`-only buffer in the ending the file had on disk. */
export function withLineEnding(text: string, ending: LineEnding): string {
  return ending === "\n" ? text : text.replace(/\n/g, ending)
}
