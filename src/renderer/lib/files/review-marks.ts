import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state"
import {
  BlockType,
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  type BlockInfo,
  type ViewUpdate,
} from "@codemirror/view"

import {
  DIFF_ROW_HEIGHT,
  FOREIGN_WIDGET,
  removedChunkAt,
  removedChunkOf,
} from "./diff-chrome"
import { threadHost } from "./review-hosts"
import {
  EMPTY_ANCHOR,
  isEmptyAnchor,
  withRow,
  type ReviewSelection,
  type ReviewSide,
  type ReviewSpot,
  type ReviewThread,
} from "./review"

/**
 * The review, as the diff draws it: the column a line is picked from, and the
 * tint on the lines a thread is about.
 *
 * **It draws the threads too, under the lines they are about** — and that has
 * been true, then not, and now is again. They were block widgets here; they were
 * taken out to a strip at the foot of the pane, on the argument that a diff with
 * three comments in it is a diff pushed apart in three places; and they are back,
 * because that argument was worth less than what it cost. A remark four hundred
 * pixels below the code it is about is a remark you read with a finger on the
 * screen, and a diff pushed apart *at* a comment is pushed apart where somebody
 * is already looking. Everywhere else it is untouched.
 *
 * What made the first attempt expensive was that a widget's DOM had to be built
 * by hand — a React root per thread would be mounted by a view that rebuilds on
 * every file, layout and theme change, and measured before React had committed
 * anything into it. `review-hosts.ts` is the answer to that: the node belongs to
 * neither side, the widget hands the same one back every time, and React portals
 * into it. See `threadWidgets` below.
 *
 * The column is a gutter rather than a click on the line itself for a reason
 * that is not cosmetic: the diff is genuinely read-only, so nothing in the
 * content area holds focus or reports a selection, and the browser's own text
 * selection there is what somebody uses to *copy* a line. A mousedown handler
 * over the code would have to guess which of the two a drag was, every time. A
 * click in a gutter is never anything else.
 *
 * **What is drawn is the state, and the state comes from outside.** The threads
 * live in a zustand store (`lib/files/review.ts`) that knows nothing about
 * editors, so the pane pushes them in as a `setReviewMarks` effect and this
 * field holds whatever it was last told. A widget reading the store directly
 * would work until the store changed without a transaction to redraw on, which
 * is every change.
 *
 * **A line here is a line of one of two files**, and which one is `side`. A
 * document line of the working side is the file's own; a document line of the
 * commit's editor — the left half of the split view — is the commit's. Neither
 * of those is where a **deleted** line lives in the unified diff: there it is a
 * row inside one of the merge extension's block widgets, drawn by
 * `widgetMarker` a whole chunk at a time and resolved back to a row by its
 * height, since a widget is one gutter slot however many lines it draws. That is
 * also the only way a pointer inside one can be turned into a line number, and
 * why `DIFF_ROW_HEIGHT` is a constant both files read rather than a number in a
 * theme.
 *
 * The one thing the removed rows cannot have is the diff's own row tint from a
 * decoration: those rows are inside a widget whose DOM `@codemirror/merge`
 * builds once and caches, so nothing in the document reaches them. They are
 * painted by `removedRowTints` below, which is the one piece of this file that
 * reaches into another extension's DOM.
 */

/** What the review looks like in one file, as the editor needs it. */
export type ReviewMarks = {
  /** This file's threads, **both sides**: one editor draws the working file's
   * and the removed rows in the same pass. */
  threads: ReviewThread[]
  /** The range being written about right now, or null. Both sides, since a range
   * can now cover a hunk — and its two ends on screen, which is what the band is
   * closed at. See `ReviewSelection`. */
  pending: ReviewSelection | null
}

/**
 * What the widgets call. Wired to the store by `codemirror-diff.tsx`, which is
 * the only place that knows which checkout and which file this diff is of.
 *
 * Handed in rather than reached for, so this file stays a drawing of a review
 * and not a second copy of what a review *is*.
 */
export type ReviewActions = {
  /**
   * A press in the review column, as the whole range it names.
   *
   * An anchor rather than a line and a side, because the two are no longer
   * separable: the run a gesture covers can cross from a chunk's deleted rows
   * into the lines that replaced them, and those are lines of two different
   * files. Working out which rows a gesture covered needs the editor, so it is
   * done here and the caller is handed the answer.
   */
  pick: (selection: ReviewSelection) => void
  /**
   * Where the range being picked is on screen, or null when none of it is.
   *
   * Reported by whichever editor draws that side, so in a split diff exactly one
   * of the two speaks — see `pendingSpot`. What the caller does with it is put
   * the composer against the lines rather than at the foot of the pane.
   */
  locate: (spot: ReviewSpot | null) => void
  /** The same, while the pointer is still down. */
  drag: (selection: ReviewSelection) => void
  /** The button let go, wherever that happened — what opens the box. */
  settle: () => void
}

/** What one editor's review column is: what to call, what a document line of it
 * is a line of, and whether removed chunks are drawn in it at all. */
export type ReviewColumn = ReviewActions & {
  /** `new` for the working side, `old` for the commit's own editor in the split
   * view. */
  side: ReviewSide
  /**
   * Whether this editor draws removed chunks as block widgets.
   *
   * The unified diff does; the split view puts them on its other editor, where
   * they are ordinary lines. Said rather than discovered, because a block
   * widget's position is also the start of the line after it — so an editor
   * with no removed rows in it could still find a chunk at a collapsed bar's
   * position and draw a column of marks against nothing.
   */
  removals: boolean
  /**
   * Whether to lay the column *over* the gutter beside it rather than take a
   * column of its own.
   *
   * True in the unified diff, whose `+`/`-` column it lands on: in flow it is
   * 16px of empty space between the signs and the code on every diff in the app,
   * since the mark itself is hidden until the row is hovered. False in the split
   * view, where the gutter beside it is CodeMirror's fold arrows — laying the
   * column over those would take a working control away rather than cover a
   * glyph that says the same thing as the row's own tint.
   */
  overlay: boolean
}

const EMPTY: ReviewMarks = { threads: [], pending: null }

export const setReviewMarks = StateEffect.define<ReviewMarks>()

const reviewMarks = StateField.define<ReviewMarks>({
  create: () => EMPTY,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReviewMarks)) return effect.value
    }
    return marks
  },
})

/** One row of one of the two files — what the pointer is over, and what a press
 * on it means. */
type Row = { side: ReviewSide; line: number }

const setHoverRow = StateEffect.define<Row | null>()

/**
 * The row the pointer is anywhere on — **the whole row, not the column**.
 *
 * This is the discoverability fix, and it is worth saying what it replaces. The
 * `+` was revealed by a CSS `:hover` on the gutter cell, which is a 14px-wide
 * target laid over the sign column: a reader who had never been told the column
 * was there had to sweep the pointer through it to find out, and one who had
 * been told still had to aim at it. The affordance now appears when the pointer
 * is anywhere on the line — which is where it already is, since the line is what
 * they are reading — and the column is then a short move sideways.
 *
 * It costs a transaction per row crossed, which is the thing the CSS was
 * avoiding. That is the same rate a drag already dispatches at, the marker for
 * every other row is `eq` to what it was so the gutter redraws one cell, and the
 * dispatch is skipped entirely when the row has not changed.
 *
 * In editor state rather than in a `:hover` because a removed chunk is **one**
 * gutter element holding twenty rows: CSS can light the slot or nothing, and
 * which of the twenty the pointer is on is arithmetic only this side knows.
 */
const hoverRow = StateField.define<Row | null>({
  create: () => null,
  update(row, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHoverRow)) return effect.value
    }
    return row
  },
})

/** Whether this row is the one under the pointer. */
function hovered(row: Row | null, side: ReviewSide, line: number): boolean {
  return row !== null && row.side === side && row.line === line
}

/**
 * Which lines carry a thread, for the column's cells.
 *
 * Memoised on the list it was computed from, because the caller is a gutter
 * marker: it is asked once per row on screen, and the answer is the same fifty
 * times. The entry dies with the array, which is replaced whenever the review
 * changes — the same bargain `modelOf` in `diff-chrome.ts` makes with a state.
 */
const commented = new WeakMap<ReviewThread[], Record<ReviewSide, Set<number>>>()

function commentedIn(threads: ReviewThread[]): Record<ReviewSide, Set<number>> {
  const held = commented.get(threads)
  if (held) return held

  const lines: Record<ReviewSide, Set<number>> = {
    new: new Set<number>(),
    old: new Set<number>(),
  }
  for (const thread of threads) {
    // A thread whose lines are nowhere in the file has no rows to tint: its
    // numbers are the ones it was written with, and marking whatever sits at
    // them now would be the app pointing at the wrong code. The thread is still
    // drawn, under wherever it last was, and says it is outdated.
    if (thread.stale) continue
    for (const side of SIDES) {
      const range = thread.anchor[side]
      if (!range) continue
      for (let line = range.fromLine; line <= range.toLine; line += 1) {
        lines[side].add(line)
      }
    }
  }
  commented.set(threads, lines)
  return lines
}

const SIDES: readonly ReviewSide[] = ["old", "new"]

/**
 * What one row of one side is: nothing, somewhere in the range being written
 * about, one of that range's two ends, or already commented on.
 *
 * Pending before commented, the same way round as the line decorations — a line
 * already commented on can be in the range being picked now, and that is the
 * state worth drawing.
 *
 * The **ends** are their own states because they are the only rows that carry a
 * handle, and because the band drawn round the range is closed at the top on one
 * and at the bottom on the other. A range of one line is both at once, which is
 * what `pendingSolo` is: two rules on one row rather than a row that is only
 * half a box.
 */
function stateOf(marks: ReviewMarks, side: ReviewSide, line: number): CellKind {
  const { pending } = marks
  const range = pending?.anchor[side]
  if (pending && range && line >= range.fromLine && line <= range.toLine) {
    /*
     * Which end of the *whole* range this row is, taken from what the walk
     * actually saw rather than guessed from the side.
     *
     * A range covering a hunk has two runs in two files and is drawn as one
     * band, closed at the top of the topmost row and the bottom of the
     * bottommost, with no rule at the join. Which of the two sides is on top is
     * a fact about the layout — a deleted chunk sits after the context line
     * before the change and before the lines that replaced it — so it cannot be
     * read off the anchor. It was, and the band came out inside out: the top
     * rule drawn on the bottom row.
     *
     * In the split view each editor sees only its own side, so a hunk's band is
     * left open at the edge where it continues in the other editor — honest,
     * since the rest of it is over there.
     */
    const at = (end: { side: ReviewSide; line: number }) =>
      end.side === side && end.line === line
    const first = at(pending.first)
    const last = at(pending.last)
    if (first && last) return "pendingSolo"
    if (first) return "pendingFirst"
    if (last) return "pendingLast"
    return "pending"
  }
  /*
   * A commented run is drawn as the same band, one shade quieter.
   *
   * It was a filled bubble on **every** row of the range plus a bare left edge,
   * which put a column of solid glyphs down the diff — the loudest thing in a
   * pane whose whole job is showing code — and covered the `+`, so the one row
   * you could not offer to comment on was a row somebody had already commented
   * on. The band says the same thing with no glyphs at all, and it says it in the
   * vocabulary the reader has just used to pick the range.
   *
   * The ends come from the **set** rather than from anything stored: a row whose
   * neighbour on this side is not commented is an end of a run. That is exact
   * within a side — for the working file a line number is a row, and for the
   * commit two chunks cannot hold consecutive numbers or they would be one chunk
   * — and it costs one thing against `pending`, which carries its ends: a comment
   * covering a whole hunk is drawn as two touching bands rather than one, with a
   * hairline where the deleted rows meet the ones that replaced them. Storing the
   * ends per thread would close that, and it is not worth a field on the record
   * for a rule nobody would notice was there.
   */
  const has = commentedIn(marks.threads)[side]
  if (has.has(line)) {
    const first = !has.has(line - 1)
    const last = !has.has(line + 1)
    if (first && last) return "commentedSolo"
    if (first) return "commentedFirst"
    if (last) return "commentedLast"
    return "commented"
  }
  return "empty"
}

/** GitHub's own affordance: a `+` in a rounded square, one per row, drawn only
 * under the pointer. Written as DOM because a `GutterMarker` returns a node —
 * see the same note on `unfoldIcon` in `diff-chrome.ts`. */
function plusIcon(): SVGElement {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("width", "11")
  svg.setAttribute("height", "11")
  svg.setAttribute("aria-hidden", "true")

  const plus = document.createElementNS(ns, "path")
  plus.setAttribute(
    "d",
    "M7.25 3.5h1.5v3.75h3.75v1.5H8.75v3.75h-1.5V8.75H3.5v-1.5h3.75Z"
  )
  plus.setAttribute("fill", "currentColor")

  svg.append(plus)
  return svg
}

/** What one row's state looks like. Shared by the gutter cell and the rows of a
 * removed chunk, which are the same control drawn in two places. */
type CellKind =
  | "empty"
  | "pending"
  | "pendingFirst"
  | "pendingLast"
  | "pendingSolo"
  | "commented"
  | "commentedFirst"
  | "commentedLast"
  | "commentedSolo"

/**
 * The rows that carry a handle — **the bottom of the range, and only that**.
 *
 * Both ends carried one at first, and two of them at once turned out to read as
 * two separate offers rather than as one range with two ends: they are 20px
 * glyphs hanging over the code, and the band already says where the range starts
 * and stops. One is enough, and the bottom is where it belongs — the composer
 * hangs from the same edge, so the mark and the box are one thing rather than
 * two.
 */
const HANDLES = new Set<CellKind>(["pendingLast", "pendingSolo"])

/**
 * One row's mark.
 *
 * `shown` is the row being under the pointer — see `hoverRow`. It is a class
 * rather than a second `:hover` rule because what counts as "under the pointer"
 * here is a whole row of a diff, which the gutter cell is 14px of.
 */
function markDOM(kind: CellKind, shown: boolean): HTMLElement {
  const span = document.createElement("span")
  span.setAttribute("role", "button")
  span.title = COMMENTED.has(kind)
    ? "Commented — click to comment on this line too"
    : "Comment on this line — drag or shift-click for a range, ⌥-drag to select the code" // prettier-ignore

  /*
   * The `+` on every row, whatever else that row is.
   *
   * A commented row used to draw a filled bubble here instead, which put a
   * column of solid glyphs down the diff and — worse — meant the one row that
   * could not offer to be commented on was a row somebody had already commented
   * on. That a line carries a remark is the band's job now; this column has one
   * job, which is offering to add one.
   *
   * In the DOM for every row and revealed by the theme below on the row under
   * the pointer, or on the end of the range being picked. A column of plus signs
   * down every diff in the app would be the loudest thing in it.
   */
  span.className = `cm-reviewMark cm-reviewMark-add${
    shown ? " cm-reviewMark-shown" : ""
  }${HANDLES.has(kind) ? " cm-reviewMark-handle" : ""}`
  span.append(plusIcon())
  return span
}

/** The four states a row already carrying a remark can be in. */
const COMMENTED = new Set<CellKind>([
  "commented",
  "commentedFirst",
  "commentedLast",
  "commentedSolo",
])

/** The class a row of either kind carries for its state, so the tint is one
 * rule wherever the row is drawn. */
const CELL_CLASS: Record<CellKind, string> = {
  empty: "",
  pending: "cm-reviewCell-pending",
  pendingFirst: "cm-reviewCell-pending",
  pendingLast: "cm-reviewCell-pending",
  pendingSolo: "cm-reviewCell-pending",
  commented: "cm-reviewCell-has",
  commentedFirst: "cm-reviewCell-has",
  commentedLast: "cm-reviewCell-has",
  commentedSolo: "cm-reviewCell-has",
}

/**
 * The class the *line* carries for its state — the band round the range.
 *
 * One class per row rather than a shared one plus modifiers, because what draws
 * the band is a `box-shadow`: three insets on the row that closes the top, three
 * on the one that closes the bottom, and a class that only added a rule would
 * replace the others rather than join them.
 */
const LINE_CLASS: Record<CellKind, string> = {
  empty: "",
  pending: "cm-reviewLine-pending",
  pendingFirst: "cm-reviewLine-pendingFirst",
  pendingLast: "cm-reviewLine-pendingLast",
  pendingSolo: "cm-reviewLine-pendingSolo",
  /*
   * The same four, and that is the point rather than an oversight.
   *
   * They were a shade quieter, on the reasoning that a range already commented on
   * is a state of the file while a range being picked is something happening now.
   * That is backwards. A picked range lives for as long as a drag and arrives with
   * a handle on its end and a composer floating against it — it could not be
   * missed if it tried. A commented one has to be **found**, by somebody scrolling
   * a diff looking for what they have already said, and it was the fainter of the
   * two. So: one band, one strength, and what tells "now" apart from "marked" is
   * the handle and the box, which is where the difference belongs.
   *
   * Two sets of **names** for one appearance, rather than one set: `spotOf` finds
   * the range being picked by querying these classes, and a commented row sharing
   * them would be a composer anchored to the union of everything marked in the
   * file. The theme groups the selectors, so there is still one declaration per
   * shape.
   */
  commented: "cm-reviewLine-has",
  commentedFirst: "cm-reviewLine-hasFirst",
  commentedLast: "cm-reviewLine-hasLast",
  commentedSolo: "cm-reviewLine-hasSolo",
}

class ReviewCell extends GutterMarker {
  constructor(
    readonly kind: CellKind,
    readonly shown: boolean,
    override readonly elementClass: string
  ) {
    super()
  }

  override eq(other: ReviewCell) {
    return (
      other.kind === this.kind &&
      other.shown === this.shown &&
      other.elementClass === this.elementClass
    )
  }

  override toDOM() {
    return markDOM(this.kind, this.shown)
  }
}

const CELL_ELEMENT: Record<CellKind, string> = {
  empty: "cm-reviewCell",
  pending: "cm-reviewCell cm-reviewCell-pending",
  pendingFirst: "cm-reviewCell cm-reviewCell-pending",
  pendingLast: "cm-reviewCell cm-reviewCell-pending",
  pendingSolo: "cm-reviewCell cm-reviewCell-pending",
  commented: "cm-reviewCell cm-reviewCell-has",
  commentedFirst: "cm-reviewCell cm-reviewCell-has",
  commentedLast: "cm-reviewCell cm-reviewCell-has",
  commentedSolo: "cm-reviewCell cm-reviewCell-has",
}

/**
 * Every cell there is, built once — twelve objects, one per state and hover.
 *
 * Prebuilt because a marker is compared by `eq` and rebuilt whenever it differs:
 * a fresh object per row would redraw the whole column on every pointer move,
 * which is exactly the traffic hovering a whole row generates. What changes as
 * the pointer crosses a row is which two of these twelve are handed back.
 */
const CELLS: Record<"off" | "on", Record<CellKind, ReviewCell>> = {
  off: build(false),
  on: build(true),
}

function build(shown: boolean): Record<CellKind, ReviewCell> {
  const cell = (kind: CellKind) =>
    new ReviewCell(kind, shown, CELL_ELEMENT[kind])
  return {
    empty: cell("empty"),
    pending: cell("pending"),
    pendingFirst: cell("pendingFirst"),
    pendingLast: cell("pendingLast"),
    pendingSolo: cell("pendingSolo"),
    commented: cell("commented"),
    commentedFirst: cell("commentedFirst"),
    commentedLast: cell("commentedLast"),
    commentedSolo: cell("commentedSolo"),
  }
}

const emptyCell = CELLS.off.empty

/**
 * The column beside a removed chunk: one mark per removed line.
 *
 * The shape `RemovedColumn` in `diff-chrome.ts` has, for the reason stated
 * there — a widget is one gutter slot however many rows it draws, so the slot is
 * filled with that many rows at the pinned line height. What is different here
 * is that each row is a control: the hover that reveals a `+` is per row rather
 * than per slot, which is a `:hover` on the row in the theme below.
 */
class RemovedReviewColumn extends GutterMarker {
  constructor(
    /** The first row's line number in the commit — what a click on it means. */
    readonly firstOld: number,
    readonly kinds: CellKind[],
    /** Which of these rows the pointer is on, as an offset from the first, or
     * null. The slot's own `:hover` cannot answer this — see `hoverRow`. */
    readonly hover: number | null
  ) {
    super()
  }

  override eq(other: RemovedReviewColumn) {
    return (
      other.firstOld === this.firstOld &&
      other.hover === this.hover &&
      other.kinds.length === this.kinds.length &&
      other.kinds.every((kind, at) => kind === this.kinds[at])
    )
  }

  override toDOM() {
    const wrap = document.createElement("span")
    wrap.className = "cm-reviewRemovedCol"
    this.kinds.forEach((kind, at) => {
      const row = wrap.appendChild(document.createElement("span"))
      row.className = `cm-reviewRemovedRow ${CELL_CLASS[kind]}`.trimEnd()
      row.append(markDOM(kind, at === this.hover))
    })
    return wrap
  }
}

/** One line decoration per state, built once for the same reason `CELLS` is. */
const LINES: Record<CellKind, Decoration | null> = {
  empty: null,
  pending: Decoration.line({ class: LINE_CLASS.pending }),
  pendingFirst: Decoration.line({ class: LINE_CLASS.pendingFirst }),
  pendingLast: Decoration.line({ class: LINE_CLASS.pendingLast }),
  pendingSolo: Decoration.line({ class: LINE_CLASS.pendingSolo }),
  commented: Decoration.line({ class: LINE_CLASS.commented }),
  commentedFirst: Decoration.line({ class: LINE_CLASS.commentedFirst }),
  commentedLast: Decoration.line({ class: LINE_CLASS.commentedLast }),
  commentedSolo: Decoration.line({ class: LINE_CLASS.commentedSolo }),
}

/**
 * The tints: the lines a thread is about, and the range being picked.
 *
 * The gutter's `elementClass` reaches its own cell and nothing else, and a range
 * marked only in a 14px column is a range nobody can see the extent of — which
 * is the whole question a reader has while picking one.
 *
 * A line is drawn as pending *or* commented, not both. Pending wins: it is the
 * thing being done right now, and a line already commented on can be in a new
 * range.
 *
 * In line order, which `RangeSetBuilder` requires: the two sets interleave, so
 * they cannot be two lists appended.
 */
function reviewDecorations(
  marks: ReviewMarks,
  doc: { lines: number; line: (n: number) => { from: number } },
  side: ReviewSide
) {
  const builder = new RangeSetBuilder<Decoration>()
  const lines = new Set<number>(commentedIn(marks.threads)[side])
  const range = marks.pending?.anchor[side]
  if (range) {
    for (let line = range.fromLine; line <= range.toLine; line += 1) {
      lines.add(line)
    }
  }

  for (const line of [...lines].sort((a, b) => a - b)) {
    if (line < 1 || line > doc.lines) continue
    const from = doc.line(line).from
    const decoration = LINES[stateOf(marks, side, line)]
    if (decoration) builder.add(from, from, decoration)
  }

  return builder.finish()
}

/**
 * The threads, drawn under the lines they are about.
 *
 * **This is the reversal.** They were block widgets here once, were taken out to
 * a strip at the foot of the pane because a diff with three comments in it is a
 * diff pushed apart in three places, and are back — because that objection turned
 * out to be worth less than what it bought: a remark four hundred pixels below
 * the code it is about is a remark you read with your finger on the screen. A
 * diff pushed apart at a comment is pushed apart *where you are already looking*,
 * and everywhere else it is untouched. `docs/design.md` has both arguments.
 *
 * What is different this time is `review-hosts.ts`: the widget hands back a node
 * somebody else owns, so the thread is still a React component with a reply box
 * and a spinner in it. The plain-DOM version is what made this expensive before.
 *
 * **Where it attaches.** Under the last line of the range on this editor's own
 * side — or, for a comment on deleted lines in the unified diff, under the chunk
 * those rows live in, since a removed row is inside another widget and is not a
 * document position anybody can hang anything from. `side: 1` puts it after the
 * line rather than before it.
 *
 * One editor draws each thread, the same rule `pendingSpot` follows: a comment
 * with any working-file lines belongs beside those, and only a wholly deleted one
 * goes on the commit's side.
 */
function threadWidgets(column: ReviewColumn): Extension {
  const { side, removals } = column

  class ThreadWidget extends WidgetType {
    /** Not the diff chrome's own widget — see `FOREIGN_WIDGET`. Without it every
     * gutter in `diff-chrome.ts` reads a thread as a collapsed region and draws
     * the expander beside it. */
    readonly [FOREIGN_WIDGET] = true

    constructor(readonly ids: string[]) {
      super()
    }

    override eq(other: ThreadWidget) {
      return (
        other.ids.length === this.ids.length &&
        other.ids.every((id, at) => id === this.ids[at])
      )
    }

    override toDOM() {
      const wrap = document.createElement("div")
      wrap.className = "cm-reviewThreads"
      // The same nodes every time — see `review-hosts.ts`. Appending a node that
      // is already somewhere else moves it, which is exactly what a rebuilt view
      // needs to happen.
      for (const id of this.ids) wrap.append(threadHost(id))
      return wrap
    }

    /* Everything in here is React's: a click on `Reply` is not a click in the
     * document, and letting the editor see it would put the caret somewhere and
     * take the focus off the box being typed into. */
    override ignoreEvent() {
      return true
    }
  }

  return EditorView.decorations.compute([reviewMarks], (state) => {
    const { threads } = state.field(reviewMarks)
    if (threads.length === 0) return Decoration.none

    /** Threads by the position they hang from, since several can land on one
     * line — two remarks about the same range, or two ranges ending together. */
    const at = new Map<number, string[]>()

    for (const thread of threads) {
      const pos = anchorPos(state, thread)
      if (pos === null) continue
      at.set(pos, [...(at.get(pos) ?? []), thread.id])
    }

    const builder = new RangeSetBuilder<Decoration>()
    for (const pos of [...at.keys()].sort((a, b) => a - b)) {
      builder.add(
        pos,
        pos,
        Decoration.widget({
          widget: new ThreadWidget(at.get(pos) ?? []),
          block: true,
          side: 1,
        })
      )
    }
    return builder.finish()
  })

  /** Where one thread hangs from in this editor, or null when it is not this
   * editor's to draw. */
  function anchorPos(
    state: Parameters<typeof removedChunkOf>[0],
    thread: ReviewThread
  ): number | null {
    const { doc } = state

    if (thread.anchor.new) {
      // The working file's lines are this editor's own in both layouts, so the
      // commit's editor in a split diff draws nothing for a thread that has any.
      if (side !== "new") return null
      const line = Math.min(Math.max(thread.anchor.new.toLine, 1), doc.lines)
      return doc.line(line).to
    }

    if (!thread.anchor.old) return null

    // Deleted lines are ordinary lines of the commit's own editor in a split
    // diff, and rows inside a chunk widget in the unified one.
    if (side === "old" && !removals) {
      const line = Math.min(Math.max(thread.anchor.old.toLine, 1), doc.lines)
      return doc.line(line).to
    }
    if (!removals) return null

    return removedChunkOf(state, thread.anchor.old.toLine)?.pos ?? null
  }
}

/**
 * The column, and the line decorations that go with it.
 *
 * Two ways to name more than one line, which are the two a reader already knows
 * from a forge: **drag** down or up, and **shift-click** a second line. `onDrag`
 * is handed the line the pointer went down on as well as the one it is over,
 * because a drag that turns back has to shrink the range and one that only ever
 * grows is a range with no anchor; `onPick` grows what is there, which is what a
 * shift-click means. Everything either of them *means* is the store's.
 *
 * **The drag is followed on `window`, not on this column.** It was the gutter's
 * own `mouseover`, which is a 22px-wide target: pressing in it and pulling down
 * *through the code* — which is what the hand does, since the range being chosen
 * is the code — left the column and the range stopped following. So the row is
 * read off the pointer's Y through `lineBlockAtHeight`, the same way the gutter's
 * own handlers resolve a line, and the X is ignored entirely. Which also means a
 * drag that leaves the editor keeps working, and one that leaves the window ends
 * where the button was let go.
 *
 * The gutter swallows the press either way, so it never reaches whatever else
 * the pane binds — and `preventDefault` on it is also what stops the drag from
 * selecting the text it is dragged across. **`⌥` is the one press it does not
 * take**: the strip is laid over the `+`/`-` column and is the only thing there,
 * so a reader who wants the code selected from its left edge would have nowhere
 * to start. See `startSelecting`.
 */
export function reviewGutter(column: ReviewColumn): Extension {
  const { side, removals, overlay } = column

  /**
   * The row the pointer went down on, or null when it is up.
   *
   * Closed over rather than kept in the editor's state: a drag is a gesture over
   * the DOM and is finished by a `mouseup` that can land anywhere — outside the
   * gutter, outside the editor, outside the window — so it is followed on
   * `window` and cannot be a transaction on a view that may be gone by then.
   * Nothing draws from it either; what is on screen is the pending range the
   * store already holds.
   */
  let anchor: Row | null = null
  /**
   * Where the gesture started, in **document** coordinates.
   *
   * Document rather than client, so it survives the diff scrolling under it: a
   * shift-click reaches back to this after any amount of reading in between, and
   * a client Y recorded before a scroll names a different row after one.
   *
   * Kept past the release, unlike `anchor`, because a shift-click is the second
   * half of a gesture whose first half was an ordinary press. Cleared by the next
   * plain press, which starts a new one.
   */
  let anchorDocY: number | null = null
  /** The view the press landed in, so the pointer can be resolved to a row of
   * *that* editor after it has left the column — and, in a split diff, not the
   * commit's side. */
  let dragging: EditorView | null = null
  /** The row the range was last taken to, so a `mousemove` that has not crossed
   * into another one does nothing: the range changes per row, not per pixel, and
   * each change is a store write, a render of the strip and a transaction on the
   * view. */
  let over: Row | null = null

  /**
   * Which row of which file a block is, at this Y.
   *
   * A removed chunk is one block however many lines it draws, so the row inside
   * it is the offset from its top over the pinned row height — the same fact
   * `RemovedColumn` relies on to line its numbers up, read the other way round.
   * Null for a collapsed bar: it is not a line of either file, so it is not
   * something a comment can name.
   */
  const rowOf = (
    view: EditorView,
    block: BlockInfo,
    clientY: number
  ): Row | null => {
    if (block.type !== BlockType.Text) {
      const removed = removals ? removedChunkAt(view.state, block.from) : null
      if (!removed) return null

      const at = Math.floor(
        (clientY - view.documentTop - block.top) / DIFF_ROW_HEIGHT
      )
      const row = Math.min(Math.max(at, 0), removed.lines - 1)
      return { side: "old", line: removed.firstOld + row }
    }

    return { side, line: view.state.doc.lineAt(block.from).number }
  }

  /**
   * Every row between two heights, as one anchor.
   *
   * **Sampled rather than enumerated**, and the reason is that the samples go
   * through `rowOf` — the same function the press itself used. A walk over
   * `viewportLineBlocks` would be the tidier shape and would have to re-derive
   * what a block *means*, which is where the old version's two answers came from:
   * the press resolved one row and the drag resolved another, and a diff whose
   * rows are not all the same height is where the two parted company. One
   * function, one answer, and the range always contains the row that was clicked.
   *
   * The step is half a row, so no row can be stepped over — every row in this
   * pane is at least `DIFF_ROW_HEIGHT` tall, since that is what pins the removed
   * chunks' arithmetic. Both ends are sampled exactly, so a one-row gesture is
   * one row whatever the step lands on.
   *
   * A folded bar contributes nothing: `rowOf` answers null for it, and it is not
   * a line of either file. Before this, a drag that reached one stopped dead —
   * the range froze while the pointer kept going, which read as the selection
   * being broken. Now the walk passes over it and picks up on the far side, which
   * is what dragging across a fold looks like everywhere else.
   */
  const spanBetween = (
    view: EditorView,
    fromDocY: number,
    toDocY: number
  ): ReviewSelection | null => {
    const top = Math.min(fromDocY, toDocY)
    const bottom = Math.max(fromDocY, toDocY)
    const step = DIFF_ROW_HEIGHT / 2

    let anchor = EMPTY_ANCHOR
    /* The two ends **on screen**, which is the one thing the anchor cannot say
     * and the walk gets for free: it goes down the page, so the first row it
     * sees is the top of the range and the last is the bottom. */
    let first: Row | null = null
    let last: Row | null = null

    const take = (docY: number) => {
      const row = rowOf(view, view.lineBlockAtHeight(docY), docY + view.documentTop) // prettier-ignore
      if (!row) return
      anchor = withRow(anchor, row.side, row.line)
      first ??= row
      last = row
    }

    for (let docY = top; docY < bottom; docY += step) take(docY)
    take(bottom)

    // Every row of the run was a folded bar, which is a line of neither file.
    if (!first || !last || isEmptyAnchor(anchor)) return null
    return { anchor, first, last }
  }

  /**
   * The view an `⌥`-drag is selecting text in, or null.
   *
   * Only the view is kept: the anchor is the DOM selection's own, and the focus
   * is wherever the pointer last resolved to.
   */
  let selecting: EditorView | null = null

  /** Where a point in the pane is in the code, or null for a point that is not
   * in it — a gutter cell, or past either end of the content. */
  const caretAt = (view: EditorView, x: number, y: number): Range | null => {
    const range = document.caretRangeFromPoint(x, y)
    if (!range || !view.contentDOM.contains(range.startContainer)) return null
    return range
  }

  /**
   * An `⌥`-press: a text selection rather than a range to comment on.
   *
   * This strip is fourteen pixels wide and all fourteen are the comment control,
   * so somebody who wants the code selected from its left edge has nowhere to
   * put the press. `⌥` is the way out, and what it starts is the selection this
   * diff already has everywhere else — **the browser's own**, which the observer
   * reads back into the editor's state even though the view is not editable, as
   * long as it is inside the content. That last clause is the whole reason this
   * is driven by hand rather than by letting the press through: a drag the
   * browser anchors in a *gutter* cell covers every cell of every column before
   * it reaches the first line of code, since that is the DOM order, so it would
   * copy the margin along with the row.
   */
  const startSelecting = (
    view: EditorView,
    block: BlockInfo,
    mouse: MouseEvent
  ): boolean => {
    // A removed row lives inside a block widget, and a selection anchored in one
    // is dropped by the observer — `DeletionWidget.ignoreEvent` is true, so the
    // state keeps its empty selection and a copy would take some other line
    // entirely. The working file's own lines only; a press on a deleted row
    // falls through to the comment column.
    if (block.type !== BlockType.Text) return false

    const selection = document.getSelection()
    const box = view.contentDOM.getBoundingClientRect()
    // The row's first character rather than where the pointer is: the press is
    // out in the margin, and what it names is the row.
    const range = caretAt(view, box.left + 1, mouse.clientY)
    if (!selection || !range) return false

    selection.removeAllRanges()
    selection.addRange(range)
    selection.collapseToStart()

    selecting = view
    // On `window` for the same reason the comment drag is: the pointer spends
    // the rest of the gesture over the code, and a mouseup can land anywhere.
    window.addEventListener("mousemove", extend)
    window.addEventListener("mouseup", stopSelecting, { once: true })
    mouse.preventDefault()
    return true
  }

  const extend = (event: MouseEvent) => {
    if (selecting === null) return

    const selection = document.getSelection()
    const box = selecting.contentDOM.getBoundingClientRect()
    // Clamped to the content's left edge, so a drag pulled back into the gutters
    // — which is what pulling straight down the margin is — keeps selecting
    // whole rows rather than stopping dead at a point that is in no line.
    const range = caretAt(
      selecting,
      Math.max(event.clientX, box.left + 1),
      event.clientY
    )
    if (!selection || !range) return
    selection.extend(range.startContainer, range.startOffset)
  }

  const stopSelecting = () => {
    window.removeEventListener("mousemove", extend)
    selecting = null
  }

  const track = (event: MouseEvent) => {
    if (anchor === null || dragging === null || anchorDocY === null) return

    const row = rowAtY(dragging, event.clientY, rowOf)
    // A row the pointer is already on, or a folded bar, which is not a row of
    // either file. Either way there is nothing new to select: the range changes
    // per row, not per pixel.
    if (row === null) return
    if (row.line === over?.line && row.side === over.side) return
    over = row

    // The clamped Y rather than the raw one, so a drag pulled past the end of the
    // pane selects to the last row on screen and stays there — the same bargain
    // `rowAtY` makes for the row itself.
    const box = dragging.scrollDOM.getBoundingClientRect()
    const clamped = Math.min(
      Math.max(event.clientY, box.top + 1),
      box.bottom - 1
    )
    const span = spanBetween(
      dragging,
      anchorDocY,
      clamped - dragging.documentTop
    )
    if (span) column.drag(span)
  }

  const release = () => {
    window.removeEventListener("mousemove", track)
    if (anchor === null) return
    anchor = null
    dragging = null
    over = null
    column.settle()
  }

  /**
   * The row under the pointer, followed on this editor's own DOM.
   *
   * On `view.dom` rather than on the gutter, which is the whole point: the
   * pointer is on the *code* while somebody reads it, and that is when the offer
   * to comment has to be visible. `mouseleave` clears it, or the last row stays
   * lit after the pointer has gone to the composer.
   *
   * Nothing here runs during a drag — `track` on `window` owns the pointer then,
   * and the two ends of the range are drawn as handles regardless.
   */
  const hoverTracking = ViewPlugin.fromClass(
    class {
      private at: Row | null = null

      constructor(readonly view: EditorView) {
        view.dom.addEventListener("mousemove", this.move)
        view.dom.addEventListener("mouseleave", this.leave)
      }

      destroy() {
        this.view.dom.removeEventListener("mousemove", this.move)
        this.view.dom.removeEventListener("mouseleave", this.leave)
      }

      private readonly move = (event: MouseEvent) => {
        // Not through `rowAtY`, which clamps to the scroller and reads its
        // rectangle to do it: a `mousemove` on this editor's own DOM is inside
        // it by definition, and a layout read per pointer move is the one cost
        // this plugin cannot afford. What is left is what CodeMirror's own
        // gutter handlers do to resolve a line.
        const y = event.clientY - this.view.documentTop
        const row = rowOf(this.view, this.view.lineBlockAtHeight(y), event.clientY) // prettier-ignore
        // Per row, not per pixel: a move inside the row it is already on is the
        // common case and must cost nothing.
        if (row?.line === this.at?.line && row?.side === this.at?.side) return
        this.set(row)
      }

      private readonly leave = () => this.set(null)

      private set(row: Row | null) {
        this.at = row
        this.view.dispatch({ effects: setHoverRow.of(row) })
      }
    }
  )

  return [
    reviewMarks,
    hoverRow,
    hoverTracking,
    gutter({
      class: `cm-diffGutter cm-reviewGutter${overlay ? " cm-reviewGutter-over" : ""}`,
      lineMarker: (view, line) => {
        const marks = view.state.field(reviewMarks)
        const number = view.state.doc.lineAt(line.from).number
        const kind = stateOf(marks, side, number)
        const on = hovered(view.state.field(hoverRow), side, number)
        return CELLS[on ? "on" : "off"][kind]
      },
      /**
       * Beside a removed chunk: a mark per line it draws, numbered in the
       * commit. Nothing beside a collapsed bar, which is not a line of either
       * file — `removedChunkAt` answering null is what tells the two apart.
       */
      widgetMarker: (view, _widget, block) => {
        const removed = removals ? removedChunkAt(view.state, block.from) : null
        if (!removed) return null

        const marks = view.state.field(reviewMarks)
        const at = view.state.field(hoverRow)
        const hover =
          at !== null &&
          at.side === "old" &&
          at.line >= removed.firstOld &&
          at.line < removed.firstOld + removed.lines
            ? at.line - removed.firstOld
            : null

        return new RemovedReviewColumn(
          removed.firstOld,
          Array.from({ length: removed.lines }, (_, at) =>
            stateOf(marks, "old", removed.firstOld + at)
          ),
          hover
        )
      },
      lineMarkerChange: (update) =>
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(reviewMarks) !==
          update.state.field(reviewMarks) ||
        update.startState.field(hoverRow) !== update.state.field(hoverRow),
      domEventHandlers: {
        mousedown(view, block, event) {
          const mouse = event as MouseEvent
          // The left button only: the right one is a context menu, and the
          // middle one is a paste on some platforms.
          if (mouse.button !== 0) return false

          // The escape hatch out of this column — see `startSelecting`. Before
          // the row is resolved, since it is not a row this gesture is after.
          if (mouse.altKey) return startSelecting(view, block, mouse)

          const row = rowOf(view, block, mouse.clientY)
          // The collapsed bar's own cell. Left alone rather than swallowed:
          // there is nothing to pick there.
          if (row === null) return false

          const docY = mouse.clientY - view.documentTop
          /*
           * A shift-click reaches back to where the last press was.
           *
           * The anchor is **tracked** now, where it deliberately was not before:
           * a shift-click used to grow whatever was pending, so one below
           * extended downwards and one above extended upwards, which is what a
           * reader means by either when a range is a pair of numbers in one file.
           * A range that can cross sides has no such thing as growing — the rows
           * between two points are what it is made of, and which rows those are
           * depends on where the run *started*. So the second half of the gesture
           * is measured from the first, the way a shift-click works in an editor.
           */
          const span: ReviewSelection = (mouse.shiftKey && anchorDocY !== null
            ? spanBetween(view, anchorDocY, docY)
            : null) ?? {
            anchor: withRow(EMPTY_ANCHOR, row.side, row.line),
            first: row,
            last: row,
          }

          if (!mouse.shiftKey) anchorDocY = docY
          anchor = row
          over = row
          dragging = view
          // Both on `window`, since the pointer spends the rest of the gesture
          // outside the column it was pressed in — and `once` on the mouseup, so
          // a gesture leaves nothing behind.
          window.addEventListener("mousemove", track)
          window.addEventListener("mouseup", release, { once: true })

          column.pick(span)
          // Both, and both matter: the default would start a text selection
          // that a shift-click then extends across the diff, and the bubble
          // would reach the pane's own handlers.
          event.preventDefault()
          return true
        },
      },
      initialSpacer: () => emptyCell,
    }),
    EditorView.decorations.compute([reviewMarks], (state) =>
      reviewDecorations(state.field(reviewMarks), state.doc, side)
    ),
    // Only where there are removed rows to paint: the split view's deletions are
    // ordinary lines on its other editor and are tinted by the decorations above.
    ...(removals ? [removedRowTints] : []),
    pendingSpot(column),
    threadWidgets(column),
    reviewTheme,
  ]
}

/**
 * Where the range being picked is on screen, told to the caller.
 *
 * **Measured off the DOM rather than computed from line numbers**, and that is
 * the shortcut worth defending: a range on the *new* side is a run of document
 * lines and `coordsAtPos` would answer it, but a range on the **old** side lives
 * inside a `@codemirror/merge` block widget, where there is no position to ask
 * about — finding it would mean scanning the chunks for one containing that
 * commit line and then doing the row-height arithmetic again. Both sides already
 * carry a class saying they are pending, on the rows themselves
 * (`reviewDecorations` for one, `removedRowTints` for the other), so reading
 * their rectangles is one query that is right for both by construction.
 *
 * Reported after the layout it is measuring, which is why it is on `measure`
 * rather than in `update`: the pending class arrives in a transaction, and
 * reading a rectangle in the middle of applying one is what forces the layout
 * this is trying to observe.
 *
 * **Exactly one editor speaks.** In a split diff the marks are pushed to both
 * and each draws its own side, so each reports only for the side it owns —
 * otherwise the editor with nothing pending in it would answer null over the
 * top of the one that had measured it.
 */
function pendingSpot(column: ReviewColumn): Extension {
  /* A range covering a hunk is drawn in both editors of a split diff, and the
   * box belongs beside the working file's half of it — which is where the reader
   * is looking and where the fix will go. So the `new` editor wins whenever the
   * range has a `new` half, and the `old` one speaks only for a range that is
   * entirely deleted lines. The unified editor draws both and always owns it. */
  const owns = (pending: ReviewMarks["pending"]) =>
    pending === null ||
    column.removals ||
    (pending.anchor.new ? column.side === "new" : column.side === "old")

  return ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        this.schedule()
      }

      update(update: ViewUpdate) {
        // Geometry as well as the marks: scrolling the diff moves the range
        // under a box that would otherwise stay where it was.
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.geometryChanged ||
          update.startState.field(reviewMarks) !== update.state.field(reviewMarks) // prettier-ignore
        ) {
          this.schedule()
        }
      }

      private schedule() {
        this.view.requestMeasure({
          read: (view) => {
            const marks = view.state.field(reviewMarks)
            return owns(marks.pending) ? spotOf(view) : undefined
          },
          write: (spot) => {
            if (spot !== undefined) column.locate(spot)
          },
        })
      }
    }
  )
}

/**
 * The rectangle around every pending row this editor currently draws.
 *
 * Null when none of them is on screen, which is a real state rather than a
 * failure: a range picked and then scrolled past has nowhere to hang a box, and
 * the caller falls back to the strip at the foot of the pane. Partly scrolled is
 * not — what is left visible is what the box points at.
 *
 * `left` is the code's own left edge rather than the editor's, so the box lines
 * up with the lines and not with the gutters; `right` is the scroller's, which
 * is what its width is measured against.
 */
function spotOf(view: EditorView): ReviewSpot | null {
  const rows = view.contentDOM.querySelectorAll(
    ".cm-reviewLine-pending, .cm-reviewLine-pendingFirst, .cm-reviewLine-pendingLast, .cm-reviewLine-pendingSolo"
  )
  if (rows.length === 0) return null

  let top = Infinity
  let bottom = -Infinity
  for (const row of rows) {
    const box = row.getBoundingClientRect()
    // A row scrolled out of the viewport still has a rectangle, just one outside
    // the scroller. Clamping is the caller's; what matters here is the extent.
    if (box.top < top) top = box.top
    if (box.bottom > bottom) bottom = box.bottom
  }

  const content = view.contentDOM.getBoundingClientRect()
  const scroller = view.scrollDOM.getBoundingClientRect()
  return { top, bottom, left: content.left, right: scroller.right }
}

/**
 * The tint on the rows of a removed chunk, painted onto the merge extension's
 * own DOM.
 *
 * The one place in this file that reaches into another extension's elements, and
 * the reason is that there is no other way in: a removed chunk is a block widget
 * whose DOM `@codemirror/merge` builds once and caches on the chunk, so no
 * decoration of ours addresses those rows and re-rendering them is not something
 * the widget offers. What a comment needs is the same thing the kept lines get —
 * the extent of the range visible in the code rather than only in a 16px column.
 *
 * `posAtDOM` is how the merge extension itself finds a chunk from its element
 * (its accept/reject buttons do exactly this), so it is the supported way back
 * from a node to a position. A chunk that cannot be resolved is skipped, which
 * costs the tint and nothing else.
 */
const removedRowTints = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.paint(view)
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.startState.field(reviewMarks) !== update.state.field(reviewMarks)
      ) {
        this.paint(update.view)
      }
    }

    paint(view: EditorView) {
      const marks = view.state.field(reviewMarks)

      for (const chunk of view.contentDOM.querySelectorAll(
        ".cm-deletedChunk"
      )) {
        let removed: { firstOld: number; lines: number } | null = null
        try {
          removed = removedChunkAt(view.state, view.posAtDOM(chunk))
        } catch {
          // A node the view no longer has a position for — mid-update, or a
          // chunk on its way out. There is nothing to tint in it.
        }
        if (!removed) continue

        const rows = chunk.querySelectorAll(".cm-deletedLine")
        rows.forEach((row, at) => {
          const wanted =
            LINE_CLASS[stateOf(marks, "old", removed.firstOld + at)]
          for (const name of Object.values(LINE_CLASS)) {
            if (name) row.classList.toggle(name, name === wanted)
          }
        })
      }
    }
  }
)

/**
 * The row under a pointer, by its Y alone.
 *
 * `y - documentTop` is how the gutter's own event handlers resolve a block, so
 * this agrees with the cell the press landed on rather than being a second
 * opinion about it. What that block *means* is `rowOf`'s, which is the column's
 * own: only it knows which side this editor's lines are, and whether a widget in
 * it is a removed chunk.
 *
 * Clamped to the scroller, which is what a drag past either end means: dragging
 * below the pane takes the range to the last row on screen and stops there. It
 * does **not** scroll the diff — a review of a range longer than the pane is a
 * range picked by shift-clicking its two ends, and an editor that scrolls itself
 * under a held pointer is a range nobody can aim.
 */
function rowAtY(
  view: EditorView,
  clientY: number,
  rowOf: (view: EditorView, block: BlockInfo, clientY: number) => Row | null
): Row | null {
  const box = view.scrollDOM.getBoundingClientRect()
  const y = Math.min(Math.max(clientY, box.top + 1), box.bottom - 1)
  return rowOf(view, view.lineBlockAtHeight(y - view.documentTop), y)
}

/**
 * The column's own metrics and the two colours in it.
 *
 * Primer's blue, as the rest of the diff is Primer's — a review mark is a
 * control rather than a state of the code, so it is the one thing in this pane
 * drawn in the accent rather than in a diff tint.
 */
/**
 * The wash over the rows being picked — **a box-shadow, not a background.**
 *
 * It was `backgroundColor`, and that lost on exactly the rows a review is most
 * often about: `diff-chrome.ts` paints `.cm-changedLine` with `!important` (it
 * has to — `@codemirror/merge`'s own base theme competes with it at the same
 * specificity), and `!important` beats any specificity this side can reach. So a
 * range dragged across a hunk came out tinted on its context lines and bare on
 * its added ones, which reads as the selection being cut in half rather than as
 * one band.
 *
 * An inset shadow with a spread big enough to fill the row paints **over** the
 * row's own background instead of replacing it, which is what this always wanted
 * — a line being picked is still an added or a removed line, and losing that
 * would take away the thing the comment is about. It is the same bargain
 * `.cm-reviewLine-has` already made by being an edge rather than a fill.
 *
 * Listed **last** in every rule below: earlier shadows paint on top, so the edges
 * stay crisp over the wash.
 */
const BAND_WASH =
  "inset 0 0 0 9999px color-mix(in oklab, var(--primary) 14%, transparent)"
const BAND_EDGE = "inset 2px 0 0 var(--primary)"

const reviewTheme = EditorView.theme({
  ".cm-reviewGutter": { cursor: "pointer", overflow: "visible" },
  /*
   * Out of the row of gutters and over the `+`/`-` column, rather than a fifth
   * column of its own — see `overlay`, which is what says where this is safe.
   *
   * A gutter in flow is 16px of empty space between the signs and the code on
   * every diff in the app, since the mark itself is hidden until the row is
   * hovered: a permanent gap paid for a control that is usually not drawn.
   * Absolute takes it out of `.cm-gutters`' flex row — which is `position:
   * sticky`, and therefore the containing block — and lays it over the sign
   * column, where a forge puts the button anyway: the cell is transparent, so
   * the row's own tint still reads through, and the sign is covered only while
   * the mark is up. `right: 0` rather than `left: 100%` for the same reason —
   * over the code would hide its first character.
   */
  ".cm-reviewGutter-over": {
    position: "absolute",
    top: "0",
    bottom: "0",
    right: "0",
  },
  ".cm-reviewGutter .cm-gutterElement": {
    // Narrow enough to stay inside the sign column it is laid over rather than
    // spilling onto the numbers beside it.
    padding: "0 1px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // The handle at either end of a range deliberately hangs out of this column
    // and over the code, and `.cm-gutter` is `overflow: hidden` in CodeMirror's
    // own base theme — which clipped it to a half-round stub. Nothing else in
    // here overflows, and `.cm-gutters` sits at `z-index: 200`, so what hangs
    // out paints over the code rather than under it.
    overflow: "visible",
  },
  ".cm-reviewMark": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    borderRadius: "3px",
    color: "#ffffff",
    backgroundColor: "var(--primary)",
  },
  // Hidden until the row is under the pointer, or the row is one of the two ends
  // of the range being written about — a column of plus signs down every diff in
  // the app would be the loudest thing in it.
  ".cm-reviewMark-add": { opacity: "0", transition: "opacity 80ms" },
  /* Put up by `hoverRow`, which is the whole row of the diff rather than this
     14px column — see the field. The gutter's own `:hover` is kept beside it so
     the mark does not blink out in the frame between the pointer entering the
     column and the transaction that says so landing. */
  ".cm-reviewMark-shown, .cm-reviewGutter .cm-gutterElement:hover > .cm-reviewMark-add": // prettier-ignore
    {
      opacity: "1",
    },
  /* The rows of a removed chunk. One slot, one row per removed line at the
     pinned height, so the marks line up with the code the widget drew — and the
     hover is per row rather than per slot, since each row is its own control. */
  ".cm-reviewRemovedCol": {
    display: "block",
    // The whole slot, so the rows start where the widget's own do: the cell
    // centres a single mark, and a column of them centred would drift by half
    // whatever rounding the slot has.
    alignSelf: "stretch",
    width: "100%",
  },
  ".cm-reviewRemovedRow": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: `${DIFF_ROW_HEIGHT}px`,
  },
  ".cm-reviewRemovedRow:hover .cm-reviewMark-add": { opacity: "1" },
  /* The mark is 14px and the row is 20: the cell around it is the target, and
     making the whole of it clickable is the difference between aiming at the
     glyph and aiming at the row. Nothing is drawn for it — the cursor and the
     mark that appeared under the pointer are what say it is there. */
  ".cm-reviewMark, .cm-reviewRemovedRow": { cursor: "pointer" },
  /*
   * The two ends of the range being picked, as handles.
   *
   * Bigger than the mark that opened the range, always drawn, and hanging over
   * the code: what they say is *this is the range and these are its ends*, which
   * is a different job from the `+` that appears under the pointer — and a
   * reader mid-gesture is looking at the code rather than at a 16px column. The
   * rows between them draw no mark at all, so the pair reads as two ends of one
   * thing rather than as a column of buttons.
   *
   * The ring is the pane's own background, which is what keeps a handle legible
   * where it overlaps a line of code.
   */
  ".cm-reviewMark-handle": {
    opacity: "1",
    width: "20px",
    height: "20px",
    borderRadius: "6px",
    transform: "translateX(7px)",
    boxShadow: "0 0 0 2px var(--background)",
    position: "relative",
    zIndex: "1",
  },
  ".cm-reviewCell-pending, .cm-reviewCell-has": { backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)" }, // prettier-ignore
  /* Over the diff's own tint rather than instead of it: a line in a band is
     still an added or a removed one, and losing that would take away the thing
     the comment is about. Hence an edge and a wash rather than a fill — see
     `BAND_WASH`, which is also what makes this survive an `!important`
     background on the added rows. */
  ".cm-reviewLine-pending, .cm-reviewLine-has": {
    boxShadow: `${BAND_EDGE}, ${BAND_WASH}`,
  },
  /* The range as a closed band: the same left edge on every row of it, plus a
     rule across the top of the first and the bottom of the last. Insets rather
     than borders, because a border is a pixel of height and would move the rows
     under the pointer that is still choosing them. */
  ".cm-reviewLine-pendingFirst, .cm-reviewLine-hasFirst": {
    boxShadow: `${BAND_EDGE}, inset 0 1px 0 var(--primary), ${BAND_WASH}`,
  },
  ".cm-reviewLine-pendingLast, .cm-reviewLine-hasLast": {
    boxShadow: `${BAND_EDGE}, inset 0 -1px 0 var(--primary), ${BAND_WASH}`,
  },
  ".cm-reviewLine-pendingSolo, .cm-reviewLine-hasSolo": {
    boxShadow: `${BAND_EDGE}, inset 0 1px 0 var(--primary), inset 0 -1px 0 var(--primary), ${BAND_WASH}`, // prettier-ignore
  },
  /*
   * The threads' own block, under the range.
   *
   * Indented to where the code starts rather than to the pane's edge, so a
   * comment reads as belonging to the lines above it rather than as a band across
   * the diff. `whiteSpace: normal` because everything inside is prose and this
   * editor's own rule is `pre`, and `userSelect: text` because a reader copying a
   * remark out of a thread is copying text, not code.
   */
  ".cm-reviewThreads": {
    // Air above and below, so the card reads as sitting *between* two runs of
    // code rather than as another row of the file. The rows either side are 20px
    // and this is deliberately not a multiple of that.
    padding: "10px 16px 12px 0",
    whiteSpace: "normal",
    userSelect: "text",
    cursor: "auto",
    // The diff's own row height is pinned everywhere else in this pane; a
    // paragraph is not a row.
    lineHeight: "normal",
    fontFamily: "var(--font-sans, inherit)",
  },
})
