import {
  getChunks,
  getOriginalDoc,
  uncollapseUnchanged,
} from "@codemirror/merge"
import { EditorState, type Extension } from "@codemirror/state"
import {
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  type BlockInfo,
  type ViewUpdate,
} from "@codemirror/view"

/**
 * The unified diff, drawn the way a pull request is.
 *
 * `@codemirror/merge` gives the diff itself — the chunks, the collapsed
 * unchanged regions, the removed lines as widgets between the kept ones — and
 * draws it as one editor with a thin coloured gutter. What a reader recognises
 * as a diff is more specific: **an old line number, a new line number, a `+`/`-`
 * column, the row tinted from the sign across, and a `@@` bar where the file was
 * skipped.** That is what this file adds, on top of the merge extension rather
 * than in place of it.
 *
 * The colours and the metrics are Primer's, because half of reading a diff is
 * knowing at a glance which side you are on, and that association is already
 * built for anyone who reviews code.
 *
 * Two things about the *structure* are worth knowing before changing any of it,
 * because both were got wrong first:
 *
 * - **A removed line is not a line of this document.** The merge extension
 *   renders a whole removed chunk as one block widget inside `.cm-content`, and
 *   builds its inner rows itself. Drawing that row's own number with a
 *   `::before` on it does not work: the content column already starts *after*
 *   the gutters, so the number lands a gutter's width too far right (and pulling
 *   it back with a negative margin puts it under the sticky gutters, where it is
 *   invisible). The numbers come from `widgetMarker` instead — a gutter is asked
 *   what to draw beside a widget, and a marker holding one row per removed line
 *   at the same line height lines up because the widget's height *is* those rows.
 * - **The row tint cannot come from the merge extension's gutter classes.** Its
 *   `cm-changedLineGutter` only exists when its own `gutter` option is on, and it
 *   is off here — the `+`/`-` column says the same thing in the form a diff is
 *   read in. So the tint travels on `GutterMarker.elementClass`, which is the
 *   API for exactly this.
 */

/** How many unchanged lines of context a hunk keeps around its changes, and the
 * shortest run worth collapsing. Both are `@codemirror/merge`'s own defaults for
 * `collapseUnchanged`, and they have to agree with what is passed there or the
 * `@@` header would describe a hunk with different bounds from the one drawn. */
export const DIFF_CONTEXT = 3
export const DIFF_MIN_COLLAPSE = 4

/**
 * The height of one row of the diff, in pixels.
 *
 * Pinned rather than left to the font, and stated here rather than written into
 * the theme, because three different pieces of code lay out rows that have to
 * line up: the editor's own lines, the merge extension's removed rows inside a
 * block widget, and the gutter columns beside them. It is also what turns a
 * pointer's Y inside a removed chunk back into which removed line it is over —
 * see `reviewGutter`, which has no other way to ask.
 */
export const DIFF_ROW_HEIGHT = 20

/** One hunk, in the form a unified diff header states it. */
type Hunk = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

type DiffModel = {
  /** By new-document line number: the line's number in the commit, or null for
   * a line that was added. */
  oldOf: (number | null)[]
  /** Keyed by the position a removed chunk's widget sits at (`chunk.fromB`,
   * which is where the merge extension adds it). */
  removed: Map<number, { firstOld: number; lines: number }>
  /**
   * Every position the merge extension puts a deletion widget at — one per
   * chunk, `removed`'s keys plus the chunks that removed nothing.
   *
   * A chunk that is purely added still gets a widget (`buildDeletedChunks`
   * adds one unconditionally, and `chunk.fromA >= chunk.toA` returns an empty
   * node from it), so the map above is not the list of this module's own
   * widgets — which is what `isHunkBar` eliminates against.
   */
  widgets: Set<number>
  hunks: Hunk[]
}

/**
 * The model, computed once per state.
 *
 * A `WeakMap` on the state rather than a `StateField`, deliberately: this is
 * derived data with no transactions of its own, three gutters and a view plugin
 * all want it inside one measure pass, and a field would have to be added to
 * every configuration that wants a number column. The entry dies with the state.
 */
const models = new WeakMap<EditorState, DiffModel>()

function modelOf(state: EditorState): DiffModel {
  const held = models.get(state)
  if (held) return held

  const built = buildModel(state)
  models.set(state, built)
  return built
}

function buildModel(state: EditorState): DiffModel {
  const chunks = getChunks(state)?.chunks ?? []
  const a = getOriginalDoc(state)
  const b = state.doc

  const oldOf: (number | null)[] = new Array<number | null>(b.lines + 1).fill(
    null
  )
  const removed = new Map<number, { firstOld: number; lines: number }>()
  const widgets = new Set<number>()

  /** Each chunk as line spans in both documents, which is what both the number
   * map and the hunk headers are built from. */
  const spans: {
    fromB: number
    oldLine: number
    newLine: number
    oldLines: number
    newLines: number
  }[] = []

  let oldLine = 1
  let newLine = 1

  for (const chunk of chunks) {
    const startsAt = b.lineAt(Math.min(chunk.fromB, b.length)).number

    // Unchanged lines before this chunk are the same line in both documents.
    while (newLine < startsAt && newLine <= b.lines) {
      oldOf[newLine] = oldLine
      oldLine += 1
      newLine += 1
    }

    const oldLines =
      chunk.toA > chunk.fromA
        ? a.lineAt(chunk.endA).number - a.lineAt(chunk.fromA).number + 1
        : 0
    const newLines =
      chunk.toB > chunk.fromB ? b.lineAt(chunk.endB).number - startsAt + 1 : 0

    widgets.add(chunk.fromB)
    if (oldLines > 0) {
      removed.set(chunk.fromB, { firstOld: oldLine, lines: oldLines })
    }

    spans.push({
      fromB: chunk.fromB,
      oldLine,
      newLine,
      oldLines,
      newLines,
    })

    // An added line keeps `null`: it has no line in the commit, which is what
    // the blank in the old column says.
    newLine += newLines
    oldLine += oldLines
  }

  while (newLine <= b.lines) {
    oldOf[newLine] = oldLine
    oldLine += 1
    newLine += 1
  }

  return { oldOf, removed, widgets, hunks: buildHunks(spans, b.lines) }
}

/**
 * The chunks, grouped into hunks the way a unified diff states them.
 *
 * Two changes closer together than twice the context are one hunk, because
 * their context overlaps and a header between them would describe a region that
 * was never skipped. The counts include the context on both sides, which is what
 * makes `@@ -49,6 +49,9 @@` add up.
 */
function buildHunks(
  spans: {
    fromB: number
    oldLine: number
    newLine: number
    oldLines: number
    newLines: number
  }[],
  totalNewLines: number
): Hunk[] {
  const hunks: Hunk[] = []

  for (let i = 0; i < spans.length;) {
    let last = i
    while (
      last + 1 < spans.length &&
      spans[last + 1]!.newLine -
        (spans[last]!.newLine + spans[last]!.newLines) <=
        DIFF_CONTEXT * 2
    ) {
      last += 1
    }

    const first = spans[i]!
    const final = spans[last]!

    const newStart = Math.max(1, first.newLine - DIFF_CONTEXT)
    const newEnd = Math.min(
      totalNewLines,
      final.newLine + Math.max(final.newLines, 1) - 1 + DIFF_CONTEXT
    )
    // The old side starts as far back as the new side does — they are the same
    // context lines — so the leading context is what maps one to the other.
    const oldStart = Math.max(1, first.oldLine - (first.newLine - newStart))

    let addedLines = 0
    let removedLines = 0
    for (let s = i; s <= last; s += 1) {
      addedLines += spans[s]!.newLines
      removedLines += spans[s]!.oldLines
    }

    const newCount = newEnd - newStart + 1
    hunks.push({
      oldStart,
      oldCount: newCount - addedLines + removedLines,
      newStart,
      newCount,
    })

    i = last + 1
  }

  return hunks
}

/** `@@ -49,6 +49,9 @@`, as git writes it. A count of one is stated without
 * it, which is the form every diff tool emits and reads. */
function hunkHeader(hunk: Hunk): string {
  const old = hunk.oldCount === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldCount}` // prettier-ignore
  const now = hunk.newCount === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newCount}` // prettier-ignore
  return `@@ -${old} +${now} @@`
}

/** A cell in one of the three columns. `elementClass` is what tints the cell
 * with the row, since the gutter element itself is not something a marker's own
 * DOM can reach. */
class Cell extends GutterMarker {
  constructor(
    readonly label: string,
    readonly inner: string,
    override readonly elementClass = ""
  ) {
    super()
  }

  override eq(other: Cell) {
    return (
      other.label === this.label &&
      other.inner === this.inner &&
      other.elementClass === this.elementClass
    )
  }

  override toDOM() {
    const span = document.createElement("span")
    span.className = this.inner
    span.textContent = this.label
    return span
  }
}

/**
 * The column beside a removed chunk: one row per removed line.
 *
 * A widget takes one gutter slot however many rows it draws, so the slot is
 * filled with that many rows at the same line height. Which is why the line
 * height is pinned in the theme below rather than left to the font: these rows
 * and the widget's own are laid out by two different pieces of code and only
 * line up if they agree on it.
 */
class RemovedColumn extends GutterMarker {
  constructor(
    readonly labels: (number | string)[],
    readonly inner: string,
    override readonly elementClass = ""
  ) {
    super()
  }

  override eq(other: RemovedColumn) {
    return (
      other.inner === this.inner &&
      other.elementClass === this.elementClass &&
      other.labels.length === this.labels.length &&
      other.labels.every((label, at) => label === this.labels[at])
    )
  }

  override toDOM() {
    const wrap = document.createElement("span")
    wrap.className = "cm-diffRemovedCol"
    for (const label of this.labels) {
      const row = wrap.appendChild(document.createElement("span"))
      row.className = this.inner
      row.textContent = String(label)
    }
    return wrap
  }
}

const NUM = "cm-diffNum"
const SIGN = "cm-diffSign"

const addedSign = new Cell("+", `${SIGN} cm-diffSign-added`, "cm-diffCell-added") // prettier-ignore
const plainSign = new Cell("", SIGN)
const blankNum = new Cell("", NUM)
const addedNum = new Cell("", NUM, "cm-diffCell-addedNum")

function num(value: number | null, tint: boolean) {
  if (value === null) return tint ? addedNum : blankNum
  return new Cell(String(value), NUM, tint ? "cm-diffCell-addedNum" : "")
}

/** What a removed chunk gets in each of the three columns. `null` for a widget
 * that is not one — this app's own `@@` bars come down the same callback. */
function removedColumns(model: DiffModel, block: BlockInfo) {
  return model.removed.get(block.from) ?? null
}

/**
 * The removed chunk whose widget sits at `pos`: which line of the commit its
 * first row is, and how many rows it draws. Null for anything else.
 *
 * Exported for the review column, which asks the same two questions the number
 * gutters do — a comment on a deleted line is a comment on a row this file
 * numbered. Keyed by the widget's position, which is also the start of the line
 * *after* the deletion, so a caller must ask only about block widgets: a text
 * block at the same position is a different row.
 */
export function removedChunkAt(
  state: EditorState,
  pos: number
): { firstOld: number; lines: number } | null {
  return modelOf(state).removed.get(pos) ?? null
}

/**
 * The same map read the other way: where the chunk holding one line of the
 * commit sits in this document.
 *
 * For the one caller that has a line number and needs a position — the review's
 * inline threads, which have to attach a block widget beneath a comment on
 * **deleted** lines. Those rows are inside another widget and are not addressable
 * as document positions, so the nearest thing that is, is the chunk's own
 * position: the widget lands directly under the rows it is about.
 *
 * A linear scan, which is what the shape allows and what the size makes fine: a
 * file's removed chunks number in the tens, and this is asked once per thread per
 * redraw of the decorations rather than once per row.
 */
export function removedChunkOf(
  state: EditorState,
  oldLine: number
): { pos: number; firstOld: number; lines: number } | null {
  for (const [pos, chunk] of modelOf(state).removed) {
    if (oldLine >= chunk.firstOld && oldLine < chunk.firstOld + chunk.lines) {
      return { pos, ...chunk }
    }
  }
  return null
}

function rangeOf(first: number, count: number) {
  return Array.from({ length: count }, (_, at) => first + at)
}

/**
 * The expander, as an icon in the gutter rather than a glyph in the bar.
 *
 * Drawn rather than taken from `lucide-react`, which is the app's icon set
 * everywhere else: a `GutterMarker` returns a DOM node and this file is not a
 * component, so a React icon would mean rendering one per gutter cell. Two
 * chevrons and a dashed rule between them is the whole shape, and it is the
 * shape every editor and forge uses for "there is more here".
 */
function unfoldIcon(): SVGElement {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("width", "12")
  svg.setAttribute("height", "12")
  svg.setAttribute("aria-hidden", "true")

  // Two solid arrowheads pointing apart. It was a pair of stroked chevrons plus
  // a dashed rule between them, which at twelve pixels resolved into a diamond
  // with something inside it — the outline read as one shape rather than as two
  // arrows. Filled triangles survive being small, which is the only size this
  // is ever drawn at.
  const arrows = document.createElementNS(ns, "path")
  arrows.setAttribute("d", "M8 3.5 11.2 7.2 4.8 7.2Z M8 12.5 4.8 8.8 11.2 8.8Z")
  arrows.setAttribute("fill", "currentColor")

  svg.append(arrows)
  return svg
}

/** The expander cell. A button, because it is one: clicking it is what opens the
 * region, and the gutter's own click handler is what carries that out. */
class UnfoldCell extends GutterMarker {
  override elementClass = "cm-diffCell-hunk cm-diffCell-unfold"

  override eq() {
    // Every one of these is the same control; nothing about it varies per row.
    return true
  }

  override toDOM() {
    const button = document.createElement("span")
    button.className = "cm-diffUnfold"
    button.setAttribute("role", "button")
    button.title = "Expand unchanged lines"
    button.append(unfoldIcon())
    return button
  }
}

const unfoldCell = new UnfoldCell()
const hunkBlank = new Cell("", NUM, "cm-diffCell-hunk")
const hunkBlankSign = new Cell("", SIGN, "cm-diffCell-hunk")

/**
 * Whether a block widget is one of the collapsed-region bars.
 *
 * By elimination rather than by asking the widget: `WidgetType` exposes no
 * public tag, and reading a minified class name would be a guess that survives
 * until the next build. This configuration has exactly two kinds of block
 * widget — a chunk's own, whose position the model knows, and a collapsed
 * region — so not being the first is being the second.
 *
 * Eliminated against `widgets` rather than `removed`, which is the fix for a
 * `⇕` drawn beside an added line: the merge extension puts a deletion widget at
 * every chunk, and a chunk that removed nothing gets an **empty** one. Those are
 * not in `removed`, so each was read as a collapsed bar — a zero-height row
 * carrying the bar's borders across the three columns and an expander tall
 * enough to overflow onto the line below it, which would have tried to
 * uncollapse a region that is not there.
 */
function isHunkBar(model: DiffModel, block: BlockInfo): boolean {
  // Elimination only works over the widgets this module knows about, and the
  // review's inline threads are a third kind it does not — see `FOREIGN_WIDGET`.
  if (block.widget && FOREIGN_WIDGET in block.widget) return false
  return !model.widgets.has(block.from)
}

/**
 * A block widget that belongs to somebody else.
 *
 * `isHunkBar` above identifies a collapsed region **by elimination**, which was
 * exact while this configuration had two kinds of block widget and became wrong
 * the moment the review added a third: a thread drawn under its lines is not a
 * removed chunk, so every gutter here decided it was a collapsed bar and drew the
 * expander beside it — a control that would have tried to uncollapse a region
 * that is not there.
 *
 * A symbol on the widget rather than a class this module imports, because the
 * import would go the wrong way: `review-marks.ts` already reads this file, and
 * this file has no business knowing what a review is. Anything adding a block
 * widget to a diff should carry it.
 */
export const FOREIGN_WIDGET: unique symbol = Symbol("not the diff's own widget")

/**
 * The three columns down the left: old number, new number, `+`/`-`.
 *
 * Three gutters rather than one with three spans, because that is what lets the
 * sign column be tinted with the row while the two number columns are not —
 * which is how GitHub draws it, and is a distinction a single gutter with one
 * background cannot make.
 */
export function githubDiffGutters(): Extension {
  return [
    gutter({
      class: "cm-diffGutter cm-diffOld",
      lineMarker: (view, line) => {
        const model = modelOf(view.state)
        return num(
          model.oldOf[view.state.doc.lineAt(line.from).number] ?? null,
          false
        )
      },
      widgetMarker: (view, _widget, block) => {
        const model = modelOf(view.state)
        if (isHunkBar(model, block)) return unfoldCell

        const removed = removedColumns(model, block)
        if (!removed) return null
        return new RemovedColumn(
          rangeOf(removed.firstOld, removed.lines),
          NUM,
          "cm-diffCell-removedNum"
        )
      },
      // The expander is a control, and this is what makes it one: the bar's own
      // click handler lives on the widget in the content column, which the icon
      // is not in. `uncollapseUnchanged` takes the start of the replaced range,
      // which is exactly the block position handed in here.
      domEventHandlers: {
        click(view, block) {
          if (!isHunkBar(modelOf(view.state), block)) return false
          view.dispatch({ effects: uncollapseUnchanged.of(block.from) })
          return true
        },
      },
      lineMarkerChange: (update) => update.docChanged || update.viewportChanged,
      initialSpacer: () => new Cell("9999", NUM),
    }),
    gutter({
      class: "cm-diffGutter cm-diffNew",
      lineMarker: (view, line) =>
        new Cell(String(view.state.doc.lineAt(line.from).number), NUM),
      widgetMarker: (view, _widget, block) => {
        const model = modelOf(view.state)
        if (isHunkBar(model, block)) return hunkBlank

        const removed = removedColumns(model, block)
        if (!removed) return null
        // Blank, and deliberately still drawn: a removed line has no line in the
        // new file, and an empty column of the right width is what says so.
        return new RemovedColumn(
          new Array<string>(removed.lines).fill(""),
          NUM,
          "cm-diffCell-removedNum"
        )
      },
      lineMarkerChange: (update) => update.docChanged || update.viewportChanged,
      initialSpacer: () => new Cell("9999", NUM),
    }),
    gutter({
      class: "cm-diffGutter cm-diffSigns",
      lineMarker: (view, line) => {
        const model = modelOf(view.state)
        const number = view.state.doc.lineAt(line.from).number
        return model.oldOf[number] === null ? addedSign : plainSign
      },
      widgetMarker: (view, _widget, block) => {
        const model = modelOf(view.state)
        if (isHunkBar(model, block)) return hunkBlankSign

        const removed = removedColumns(model, block)
        if (!removed) return null
        return new RemovedColumn(
          new Array<string>(removed.lines).fill("−"),
          `${SIGN} cm-diffSign-removed`,
          "cm-diffCell-removed"
        )
      },
      lineMarkerChange: (update) => update.docChanged || update.viewportChanged,
      initialSpacer: () => plainSign,
    }),
    hunkHeaders,
    // The collapsed bar carries no words of its own: the `@@` header replaces
    // them (see `hunkHeaders`), and leaving the count in would be the same row
    // saying the same thing twice in two vocabularies.
    EditorState.phrases.of({ "$ unchanged lines": "" }),
  ]
}

/**
 * `@@ -49,6 +49,9 @@` on each collapsed bar.
 *
 * The bar itself is `@codemirror/merge`'s `CollapseWidget` — its click handler is
 * what expands the region, and reimplementing the collapse to own the DOM would
 * mean reimplementing that too. So the widget is left alone and the header is
 * written onto it as an attribute, which the theme draws with `content:
 * attr(...)`.
 *
 * This is the one cosmetic thing here that reaches into the DOM, and it is
 * written to fail quietly: a bar this cannot place keeps no attribute, which
 * draws the expander with no header rather than a wrong one.
 *
 * A collapsed region always ends where the next hunk begins, so the header is
 * the first hunk starting at or after the bar — which is also why
 * `DIFF_CONTEXT`/`DIFF_MIN_COLLAPSE` have to be the values handed to
 * `collapseUnchanged`.
 */
const hunkHeaders = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.stamp(view)
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged
      ) {
        this.stamp(update.view)
      }
    }

    stamp(view: EditorView) {
      const { hunks } = modelOf(view.state)
      if (hunks.length === 0) return

      for (const bar of view.dom.querySelectorAll<HTMLElement>(
        ".cm-collapsedLines"
      )) {
        let pos: number
        try {
          pos = view.posAtDOM(bar)
        } catch {
          continue
        }

        const line = view.state.doc.lineAt(
          Math.min(pos, view.state.doc.length)
        ).number
        const next = hunks.find((hunk) => hunk.newStart >= line)
        if (next) bar.dataset.hunk = hunkHeader(next)
      }
    }
  }
)

/*
 * Primer's diff palette and metrics.
 *
 * Light is Primer's own hex; dark is `rgba` over whatever the pane's ground is,
 * which is how Primer specifies it and is what keeps the tint honest over this
 * app's `#111218` rather than over GitHub's `#0d1117`.
 *
 * **The two number columns are not tinted and the sign column is**, which is
 * GitHub's own reading of where the row starts: the numbers are a margin, and
 * the row is the change.
 */
export function githubDiffTheme(isDark: boolean): Extension {
  /*
   * Opaque, both themes, and that is the point rather than a style preference.
   *
   * These were `rgba` tints in dark mode — Primer's own way of specifying them —
   * and the row came out two shades: the `+`/`-` column is painted by a gutter
   * marker and the code by a line decoration, so an alpha tint composites over
   * whatever each of those happens to sit on. Flattened against the studio's
   * dark ground — `--background`, `#111218` (`styles/globals.css`) — so the two
   * halves of a row are the same colour because they are literally the same
   * colour. That also means these two follow the ground: they were flattened
   * against `#1e1e1e` and had to be recomputed when it moved.
   */
  const line = isDark
    ? { add: "#15271e", del: "#281819" }
    : { add: "#e6ffec", del: "#ffebe9" }
  const sign = isDark
    ? { add: "#3fb950", del: "#f85149" }
    : { add: "#1a7f37", del: "#cf222e" }
  const hunk = isDark
    ? {
        bg: "#212934",
        edge: "#253956",
        fg: "#8b949e",
        icon: "#58a6ff",
        iconHover: "#79c0ff",
      }
    : {
        bg: "#f6f8fa",
        edge: "#d1d9e0",
        fg: "#59636e",
        icon: "#0969da",
        iconHover: "#0550ae",
      }

  return EditorView.theme(
    {
      // A diff's own metrics, not the editor's. Pinned rather than inherited
      // because the removed rows and the gutter column beside them are laid out
      // by two different pieces of code and line up only if both use this.
      ".cm-scroller": { fontSize: "12px", lineHeight: `${DIFF_ROW_HEIGHT}px` },
      ".cm-content, .cm-line": {
        fontSize: "12px",
        lineHeight: `${DIFF_ROW_HEIGHT}px`,
      },
      ".cm-content": { padding: "0" },

      ".cm-diffGutter": {
        backgroundColor: "transparent",
        border: "none",
        padding: "0",
        minWidth: "0",
        color: hunk.fg,
      },
      ".cm-diffGutter .cm-gutterElement": { padding: "0 10px" },
      ".cm-diffSigns": { borderLeft: "1px solid var(--border)" },
      ".cm-diffSigns .cm-gutterElement": { padding: "0 4px 0 6px" },
      // Stated rather than inherited. `lib/editor.ts` sets the studio's editors
      // to 13px, and which of two themes wins is not the order they appear in
      // an extension array — so anything that has to match the code text says
      // its size here.
      ".cm-diffNum": {
        display: "block",
        textAlign: "right",
        fontSize: "12px",
        lineHeight: `${DIFF_ROW_HEIGHT}px`,
      },
      ".cm-diffSign": {
        display: "block",
        width: "1ch",
        textAlign: "center",
        fontSize: "12px",
        lineHeight: `${DIFF_ROW_HEIGHT}px`,
      },
      ".cm-diffSign-added": { color: sign.add },
      ".cm-diffSign-removed": { color: sign.del },
      /*
       * The columns beside a removed chunk, pinned to the slot rather than left
       * to flow inside it.
       *
       * A removed chunk is **one** gutter element however many rows it draws, so
       * this column has to line up with rows another piece of code laid out. It
       * was `display: block` and nothing else, which left two things to chance:
       * where the column sits inside a slot taller than its content, and how tall
       * each row is. Both were usually right and visibly wrong when they were not
       * — the `−` signs drawn a whole row below the lines they belong to, with the
       * numbers beside them correct, since a number cell and a sign cell resolve
       * their line boxes differently.
       *
       * `alignSelf: stretch` makes the column start at the top of the slot rather
       * than wherever the gutter's own alignment puts it, and an explicit `height`
       * per row stops a row's height depending on the glyph in it. That is what
       * `.cm-reviewRemovedCol` has always done, which is why the review column's
       * marks lined up beside signs that did not — the same slot, one column with
       * its geometry stated and one without.
       */
      ".cm-diffRemovedCol": {
        display: "block",
        alignSelf: "stretch",
        width: "100%",
      },
      ".cm-diffRemovedCol > *": {
        display: "block",
        height: `${DIFF_ROW_HEIGHT}px`,
        lineHeight: `${DIFF_ROW_HEIGHT}px`,
      },

      // An added line, tinted from the sign column across. No inner highlight:
      // the merge extension's word-level marks are off (`highlightChanges`), for
      // the reason a wholly new line has no "changed part" to pick out.
      /*
       * `!important` on the two row tints, for the same reason the collapsed bar
       * needs it: `@codemirror/merge`'s `baseTheme` paints `.cm-deletedChunk`
       * `rgba(160, 128, 100, .08)` — a brown — at the same specificity as a rule
       * here, so which of the two applies comes down to the order the style
       * modules were mounted in. It lost, and the result was a removed row whose
       * `-` column was red and whose code was brown.
       */
      ".cm-changedLine, .cm-inlineChangedLine": {
        backgroundColor: `${line.add} !important`,
      },
      ".cm-gutterElement.cm-diffCell-added": { backgroundColor: line.add },
      // The number columns stay on the pane's own ground: on GitHub the numbers
      // are a margin and the row starts at the sign.
      ".cm-gutterElement.cm-diffCell-addedNum, .cm-gutterElement.cm-diffCell-removedNum":
        { backgroundColor: "transparent" },

      // A removed chunk: the rows the merge extension draws, and the columns
      // beside them from `RemovedColumn`.
      ".cm-deletedChunk": {
        backgroundColor: `${line.del} !important`,
        padding: "0",
      },
      ".cm-deletedChunk .cm-deletedLine": {
        display: "block",
        lineHeight: `${DIFF_ROW_HEIGHT}px`,
        padding: "0 2px 0 6px",
      },
      ".cm-deletedChunk .cm-deletedLine del": { textDecoration: "none" },
      ".cm-gutterElement.cm-diffCell-removed": { backgroundColor: line.del },
      ".cm-deletedLineGutter": { backgroundColor: "transparent" },

      /*
       * The hunk bar. Two pseudo-elements over an empty widget: the expander
       * where the gutters are, and the `@@` header where the code is — which is
       * the layout GitHub uses and the reason the bar is not simply centred
       * text.
       */
      /*
       * The collapsed bar.
       *
       * `background` rather than `backgroundColor`, and `!important`, because
       * `@codemirror/merge`'s own `baseTheme` paints it with a grey
       * `linear-gradient` under `&dark .cm-collapsedLines` — two classes on the
       * root plus one here, which a plain rule in a theme cannot out-specify. Its
       * shorthand also has to be beaten by a shorthand, or the gradient survives
       * underneath.
       */
      ".cm-collapsedLines": {
        background: `${hunk.bg} !important`,
        color: hunk.fg,
        borderTop: `1px solid ${hunk.edge}`,
        borderBottom: `1px solid ${hunk.edge}`,
        cursor: "pointer",
        lineHeight: `${DIFF_ROW_HEIGHT}px`,
        padding: "0",
        fontSize: "12px",
      },
      // And the `⦚` it puts on both sides of its own text. The `::after` is
      // already claimed below for the `@@` header; this is the other one, which
      // was drawing a stray dotted bar in front of it.
      ".cm-collapsedLines::before": { content: '""', margin: "0" },
      ".cm-collapsedLines::after": {
        content: "attr(data-hunk)",
        paddingLeft: "8px",
        fontFamily: "inherit",
        whiteSpace: "pre",
      },

      /*
       * The expander, in the gutter where it belongs.
       *
       * It was a `⌃⌄` in the bar's own `::before` for one revision, which put a
       * pair of text glyphs at the start of the code column — the wrong shape in
       * the wrong place. A block widget cannot reach back over the gutters (they
       * are sticky and paint above the content), so the icon is a gutter marker
       * of its own and the gutter carries the click. See `UnfoldCell`.
       */
      // The gutter cells carry the bar's own borders, so the row reads as one
      // strip across the pane rather than as a box floating in the code column.
      ".cm-gutterElement.cm-diffCell-hunk": {
        backgroundColor: hunk.bg,
        borderTop: `1px solid ${hunk.edge}`,
        borderBottom: `1px solid ${hunk.edge}`,
      },
      ".cm-gutterElement.cm-diffCell-unfold": {
        // Against the column's inner edge: the control reads as belonging to the
        // pair of number columns rather than to the first of them.
        padding: "0 2px 0 10px",
        textAlign: "right",
      },
      // The icon and nothing behind it. It sat in a rounded blue chip for one
      // revision, which put a second box inside a row that is already a tinted
      // strip — two backgrounds arguing about which one is the control.
      ".cm-diffUnfold": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: `${DIFF_ROW_HEIGHT}px`,
        color: hunk.icon,
        cursor: "pointer",
        verticalAlign: "middle",
      },
      ".cm-diffUnfold:hover": { color: hunk.iconHover },
    },
    { dark: isDark }
  )
}
