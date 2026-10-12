/**
 * Git's own patch, turned into the ranges the diff view is built from.
 *
 * The pane used to compute the difference between the committed text and the
 * working one itself, in CodeMirror's diff algorithm. It now reads the ranges
 * off `git diff HEAD --unified=0` instead, so that the bands on screen and the
 * `+`/`-` counts beside the row in the Changes list — which have always come
 * from `git diff --numstat` — are one algorithm's answer rather than two that
 * agree most of the time. The seam is `DiffConfig.override` in
 * `@codemirror/merge`, which is the whole of what makes this possible without
 * touching a line of the view: everything above the diff — the folding, the
 * gutters, the review column, the two layouts — is built from `Change[]` and
 * does not care where they came from.
 *
 * **This is a hint, and `null` is a real answer.** Git reads the file on disk;
 * the pane's right-hand side is the shared buffer, which may hold edits nobody
 * has saved. It is also perfectly possible for git to describe a pair that is
 * not the pair on screen for duller reasons — a line-ending filter, a `diff=`
 * driver, a file written between the read and the `git diff`. So the patch is
 * **checked against the two texts** rather than trusted, and the caller falls
 * back to computing the difference itself when it does not fit.
 *
 * The check is cheap and total, which is why it is worth doing rather than
 * guessing at the ways it could be stale: a list of changed ranges describes a
 * pair of texts if and only if **everything it leaves unchanged is equal in
 * both**. So the gaps between the hunks are compared, and if every gap matches
 * then the ranges are, by construction, a valid diff of exactly these two
 * strings. Nothing else needs to be known about where the patch came from.
 */

/** One changed range, in character offsets into the two texts — the shape
 * `@codemirror/merge`'s own `Change` is constructed from. `toA === fromA` is an
 * insertion, `toB === fromB` a deletion. */
export type DiffRange = {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

/**
 * `@@ -l,s +m,t @@`, with the counts optional — git writes `@@ -3 +3 @@` for a
 * single line rather than `-3,1`.
 *
 * Anchored, and that is what makes it safe to scan a patch for these without
 * parsing the hunk bodies: every line of a body is prefixed (`+`, `-`, or `\`
 * for the no-newline marker), so a line of the file that happens to begin with
 * `@@` can never appear at column zero. A merge's combined format (`@@@`) does
 * not match either, and falls through to the check below.
 */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * The ranges `patch` says separate `a` from `b`, or null when it does not
 * describe that pair.
 *
 * Empty is a real answer and not the same as null: it is what an unchanged file
 * gets, and the check below is what tells the two apart.
 */
export function gitDiffRanges(
  patch: string,
  a: string,
  b: string
): DiffRange[] | null {
  const startsA = lineStarts(a)
  const startsB = lineStarts(b)
  const ranges: DiffRange[] = []

  // Walks the two texts alongside the hunks: everything between the end of the
  // last hunk and the start of the next is what the patch claims is unchanged.
  let seenA = 0
  let seenB = 0

  for (const line of patch.split("\n")) {
    const header = HUNK.exec(line)
    if (!header) continue

    // Groups 1 and 3 are not optional in the pattern, so they matched.
    const [fromLineA, toLineA] = hunkLines(header[1]!, header[2])
    const [fromLineB, toLineB] = hunkLines(header[3]!, header[4])

    const range = {
      fromA: offsetAt(startsA, fromLineA, a.length),
      toA: offsetAt(startsA, toLineA, a.length),
      fromB: offsetAt(startsB, fromLineB, b.length),
      toB: offsetAt(startsB, toLineB, b.length),
    }

    // Out of order or overlapping, which a patch of these texts cannot be.
    if (range.fromA < seenA || range.fromB < seenB) return null
    if (range.toA < range.fromA || range.toB < range.fromB) return null

    // The gap since the last hunk. Unequal means the patch is about some other
    // pair of texts, and one wrong gap is enough to throw the whole patch away
    // — a partly-right set of ranges would draw a diff that is quietly wrong,
    // which is worse than the algorithm this replaced.
    if (a.slice(seenA, range.fromA) !== b.slice(seenB, range.fromB)) return null

    ranges.push(range)
    seenA = range.toA
    seenB = range.toB
  }

  // And the tail, which is also the whole of both texts when there were no
  // hunks at all: an empty patch describes an unchanged file and nothing else.
  if (a.slice(seenA) !== b.slice(seenB)) return null

  return ranges
}

/**
 * A hunk header's side, as a half-open range of **zero-based line numbers**.
 *
 * The count is `1` when git left it off, and `0` is the case worth knowing: a
 * hunk that changes no lines on one side is an insertion or a deletion, and
 * there git gives the line **before** the join rather than the first line of a
 * range that does not exist. So `-0,0` is the very start of the file and
 * `-7,0` is after the seventh line — which is `7` zero-based, one past the last
 * line the hunk leaves alone.
 */
function hunkLines(start: string, count: string | undefined): [number, number] {
  const line = Number(start)
  const length = count === undefined ? 1 : Number(count)
  const from = length === 0 ? line : line - 1
  return [from, from + length]
}

/** Where each line begins. `lineStarts("a\nb")` is `[0, 2]`; the end of the
 * text is deliberately not in here, and is `offsetAt`'s business. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (
    let at = text.indexOf("\n");
    at !== -1;
    at = text.indexOf("\n", at + 1)
  ) {
    starts.push(at + 1)
  }
  return starts
}

/** A line's start, with one line past the last reading as the end of the text —
 * which is where a hunk that appends to a file with no trailing newline lands,
 * and the one index `lineStarts` does not hold. */
function offsetAt(starts: number[], line: number, end: number): number {
  return line < starts.length ? starts[line]! : end
}
