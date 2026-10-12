/**
 * What ⌘C puts on the clipboard when a selection in the unified diff takes in
 * removed lines.
 *
 * Those lines are not in the document being selected. The unified view's
 * document is the working file, and a removed run is a block widget drawn at
 * the start of the line after it — so a selection dragged across one covers the
 * rows above and below and *nothing* of the red ones, and a plain copy dropped
 * them. Pasting the hunk somewhere was the whole reason to select across it.
 *
 * So a selection that takes in a removed run copies what is on screen, in the
 * order it is on screen: the removed lines where they are drawn, above the
 * lines that replaced them, as plain text. It was a patch for a while — every
 * line signed `+`, `-` or a space, the way git writes one — on the argument
 * that a hunk pasted without the signs is two versions of the code run
 * together. The signs were asked off: what gets pasted is code, into a chat
 * or an editor, and a leading sign on every line is something to strip first.
 * A selection that takes in no removed run is `null` here and copies as text
 * the ordinary way.
 *
 * A run is taken in two ways, and `taken` is the second. The selection
 * **crosses** it when it runs from above the widget to at or past the line
 * below it (`crossesRemoved`), and then it has the whole run. But a selection
 * that *ends* in the widget — dragged from the context above onto its second
 * row, dragged up from the `+` line into it, or started with a click on it —
 * sits at `at` on the side the widget is not, and the position alone cannot
 * say which side that is, let alone which rows. The mouse handling in
 * `diff-selection.ts` knows, and says so in `taken`: which run, and which of
 * its rows, so a drag that stops on a red row stops there the way it would on
 * any other line.
 *
 * Free of CodeMirror, so `test/diff-copy.ts` can import it.
 */

/** One changed chunk, as `@codemirror/merge`'s `Chunk` gives it: `to*` is one
 * past the line break of the chunk's last line, and equal to `from*` on a side
 * the chunk has no lines on. */
export type CopyChunk = {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

/**
 * Whether a selection runs through the removed rows drawn at `at`.
 *
 * The widget sits *above* the line starting at `at`, so a selection starting
 * exactly there began below it, and one ending exactly there was dragged onto
 * the top of that line — through the widget.
 */
export function crossesRemoved(at: number, from: number, to: number): boolean {
  return from < at && at <= to
}

/** The rows of a run a selection has, as inclusive indices into its lines —
 * `to` may be `Infinity` for "down to the last" — or null for all of them. */
export type RunLines = { from: number; to: number } | null

/** The runs a selection ends in, by the position each is drawn at, and which
 * of their rows it has. A run not here is taken whole if the selection crosses
 * it and not at all otherwise. */
export type TakenRuns = ReadonlyMap<number, RunLines>

const NONE: TakenRuns = new Map()

/**
 * The lines a selection `from`–`to` of the working text `b` covers, with the
 * removed lines of `a` it takes in put back where they are drawn — or null
 * when it takes in none. Whole lines, since a removed run is only ever whole.
 */
export function selectionText(
  a: string,
  b: string,
  chunks: readonly CopyChunk[],
  from: number,
  to: number,
  taken: TakenRuns = NONE
): string | null {
  const crossed = chunks.filter(
    (chunk) =>
      chunk.toA > chunk.fromA &&
      (taken.has(chunk.fromB) || crossesRemoved(chunk.fromB, from, to))
  )
  if (crossed.length === 0) return null

  const starts = lineStarts(b)
  // Past the last line is the end of the text, which is where the next one
  // would have started.
  const startOf = (line: number) => starts[line] ?? b.length + 1
  const endOf = (line: number) => Math.min(startOf(line + 1) - 1, b.length)

  // Which lines the selection has any of. A drag that ends at the start of a
  // line selected nothing of it. One that starts at the *end* of a line is
  // the line — that is where a drag begun in the margin to the right of its
  // text starts, and a rule here that read it as "only the line break" was
  // dropping the context line a selection of a hunk began on.
  const first = lineAt(starts, from)
  let last = lineAt(starts, to)
  if (from < to && to === startOf(last)) last -= 1
  const lines = from < to && last >= first

  const out: string[] = []
  const removedAt = (at: number) => {
    for (const chunk of crossed) {
      if (chunk.fromB !== at) continue
      const lines = linesOf(a.slice(chunk.fromA, chunk.toA))
      // The noted rows where the selection ends in the run; crossed, all.
      const rows = taken.get(at)
      out.push(...(rows ? lines.slice(rows.from, rows.to + 1) : lines))
    }
  }

  if (lines) {
    for (let line = first; line <= last; line++) {
      const start = startOf(line)
      removedAt(start)
      out.push(b.slice(start, endOf(line)))
    }
  }
  // The runs drawn under the last line taken — the selection was dragged onto
  // the line after it, or the run is at the very end of the file — and every
  // run when no line was.
  for (const chunk of crossed) {
    if (!lines || chunk.fromB > startOf(last)) removedAt(chunk.fromB)
  }

  return out.join("\n")
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    starts.push(at + 1)
  return starts
}

/** Which line `pos` is on — the last start at or before it. */
function lineAt(starts: number[], pos: number): number {
  let line = 0
  while ((starts[line + 1] ?? Infinity) <= pos) line += 1
  return line
}

/** A chunk's text as its lines: `toA` runs one past the final line break, so
 * the empty string after it is not a line. */
function linesOf(text: string): string[] {
  const lines = text.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}
