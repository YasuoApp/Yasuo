import { Chunk, unifiedMergeView } from "@codemirror/merge"
import { EditorSelection, EditorState, Text } from "@codemirror/state"

import { selectedText } from "../src/renderer/lib/files/diff-selection"
import {
  selectionText,
  type RunLines,
} from "../src/renderer/lib/files/diff-copy"
import { check, finish, section } from "./harness"

/**
 * What ⌘C copies from the unified diff when a selection runs through removed
 * rows — `lib/files/diff-copy.ts`.
 *
 * The chunks are `@codemirror/merge`'s own, built from the two texts, rather
 * than written out by hand: the off-by-one this is most likely to get wrong is
 * where a chunk's `to` lands relative to its last line break, and a fixture
 * would only agree with whoever wrote it.
 */

function chunksOf(a: string, b: string) {
  return Chunk.build(Text.of(a.split("\n")), Text.of(b.split("\n")))
}

function copy(
  a: string,
  b: string,
  from: number,
  to: number,
  taken: [number, RunLines][] = []
) {
  return selectionText(a, b, chunksOf(a, b), from, to, new Map(taken))
}

const a = ["one", "two", "three", "four"].join("\n")
const b = ["one", "TWO", "three", "four"].join("\n")
const at = (text: string, line: number) =>
  text.split("\n").slice(0, line).join("\n").length + (line > 0 ? 1 : 0)

section("a selection through a replaced line")
check(
  "copies the removed line above the added one, signed",
  copy(a, b, at(b, 0), at(b, 3)) === ["one", "two", "TWO", "three"].join("\n"),
  copy(a, b, at(b, 0), at(b, 3))
)
check(
  "takes whole lines when the ends are mid-line",
  copy(a, b, 1, at(b, 1) + 1) === ["one", "two", "TWO"].join("\n"),
  copy(a, b, 1, at(b, 1) + 1)
)

section("a selection that does not cross the removed rows")
check(
  "starting at the added line is below them — plain copy",
  copy(a, b, at(b, 1), at(b, 2) + 2) === null
)
check("within one line — plain copy", copy(a, b, 0, 3) === null)

section("a pure deletion")
const gone = ["one", "three", "four"].join("\n")
check(
  "dragged onto the line after it, the run comes last",
  copy(a, gone, 0, at(gone, 1)) === ["one", "two"].join("\n"),
  copy(a, gone, 0, at(gone, 1))
)
check(
  "through it, it sits between its neighbours",
  copy(a, gone, 0, at(gone, 1) + 2) === ["one", "two", "three"].join("\n"),
  copy(a, gone, 0, at(gone, 1) + 2)
)

// The mouse says which runs a selection that only *touches* one took in —
// see `included` in `diff-copy.ts`. The run before `TWO` is drawn at its
// start, `at(b, 1)`.
section("a run the mouse took in")
check(
  "a click on the red rows copies them alone",
  copy(a, b, at(b, 1), at(b, 1), [[at(b, 1), null]]) === "two",
  copy(a, b, at(b, 1), at(b, 1), [[at(b, 1), null]])
)
check(
  "dragged up from the added line onto them, both are copied",
  copy(a, b, at(b, 1), at(b, 1) + 3, [[at(b, 1), null]]) ===
    ["two", "TWO"].join("\n"),
  copy(a, b, at(b, 1), at(b, 1) + 3, [[at(b, 1), null]])
)
// From the margin right of `one`, which is its end, down through the hunk:
// `one` is where the drag began and is copied.
check(
  "started at the end of the line above, that line is taken",
  copy(a, b, at(b, 1) - 1, at(b, 3)) ===
    ["one", "two", "TWO", "three"].join("\n"),
  copy(a, b, at(b, 1) - 1, at(b, 3))
)

// Two rows removed before `four`, drawn at `at(gap, 1)`: a selection that
// ends in the run has the rows the mouse said, from the edge it came in over.
section("a run the selection ends in, by the row")
const gap = ["one", "four"].join("\n")
check(
  "from above, down to the row under the pointer",
  copy(a, gap, 0, at(gap, 1), [[at(gap, 1), { from: 0, to: 0 }]]) ===
    ["one", "two"].join("\n"),
  copy(a, gap, 0, at(gap, 1), [[at(gap, 1), { from: 0, to: 0 }]])
)
check(
  "from below, up to the row under the pointer",
  copy(a, gap, at(gap, 1), at(gap, 1) + 2, [
    [at(gap, 1), { from: 1, to: Infinity }],
  ]) === ["three", "four"].join("\n"),
  copy(a, gap, at(gap, 1), at(gap, 1) + 2, [
    [at(gap, 1), { from: 1, to: Infinity }],
  ])
)

// With the final newline a real file has: without one, the last line of each
// side differs by its line break and the diff calls `two` replaced too.
section("the end of the file")
const full = `${a}\n`
const cut = "one\ntwo\n"
check(
  "lines removed from the end are kept",
  copy(full, cut, 0, cut.length) === ["one", "two", "three", "four"].join("\n"),
  copy(full, cut, 0, cut.length)
)

// Through the real merge extension rather than chunks built here: the first
// version of this asked `getChunks` for `side === null` to recognise the
// unified view, which registers itself as `"b"` — so every copy fell back to
// plain text and the pure half above passed regardless.
section("the unified view's own state")
function unified(from: number, to: number) {
  return EditorState.create({
    doc: b,
    selection: EditorSelection.single(from, to),
    extensions: [unifiedMergeView({ original: a })],
  })
}
check(
  "a selection through the hunk copies both sides",
  selectedText(unified(at(b, 0), at(b, 3)), new Map()) ===
    ["one", "two", "TWO", "three"].join("\n"),
  selectedText(unified(at(b, 0), at(b, 3)), new Map())
)
check(
  "an empty selection leaves the copy to the editor",
  selectedText(unified(2, 2), new Map()) === null
)

finish()
