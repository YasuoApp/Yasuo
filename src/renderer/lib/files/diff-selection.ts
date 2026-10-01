import { getChunks, getOriginalDoc } from "@codemirror/merge"
import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state"
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"

import {
  crossesRemoved,
  selectionText,
  type RunLines,
  type TakenRuns,
} from "./diff-copy"

/**
 * Selecting across the removed rows of the unified diff, and copying what was
 * selected — see `lib/files/diff-copy.ts` for what the copy is.
 *
 * The removed rows are a block widget, and **CodeMirror ignores every mouse
 * event that starts inside a widget** (`WidgetType.ignoreEvent`, which
 * `@codemirror/merge` leaves at its default). So a drag that begins on a red
 * line — the natural way to select a hunk — is never the editor's: the browser
 * runs a native selection. That is kept, deliberately: it is the only way to
 * select *part* of a red line, since the editor has no positions inside a
 * widget to offer. A version of this handed the mousedown to the editor, and
 * a click on a red line selected the whole run and nothing less.
 *
 * So there are two selections, and the work is making them look and copy the
 * same. A drag that begins on a line is the editor's: `mouseSelectionStyle`
 * reads a pointer over the red rows as the line below them and notes the run
 * in `taken` — a position alone cannot say whether the drag stopped above
 * the widget or below it, let alone on which of its rows — and the rows are
 * tinted and copied off that. A drag that begins on a red line is the
 * browser's: the widget is made focusable so that the mousedown focuses *it*
 * rather than the content around it, which is what keeps the editor from
 * writing its own selection back over the native one on every update
 * (`updateSelection` does nothing while the content is not the focus); the
 * native highlight is shown on the lines, which the editor otherwise hides,
 * for exactly as long as a widget holds focus; and ⌘C is read off the DOM
 * range instead. One thing it needs that is not here: the content itself must
 * be `contenteditable="false"` (`readOnly()` in `lib/editor.ts`), or Blink
 * stops the selection at the widget's edge rather than let it cross into
 * editable content.
 *
 * A run is taken **by the row**, in both: a drag from the context above that
 * stops on the second red line has taken two rows, not the run, which is how
 * every other line in the diff behaves. Which rows depends on where the
 * other end of the selection is — above the run, the rows from the top down
 * to the pointer; below it, from the pointer to the bottom.
 */
export function diffSelection(): Extension {
  /** The runs the gesture in progress has taken in. Written by the style's
   * `get` and read by the field in the `select.pointer` transaction the
   * editor dispatches right after it — a closure, since `get` returns a
   * selection and cannot attach anything to that transaction. */
  let pending: [number, RunLines][] = []

  /** The same, dispatched by `get` itself when the editor is not going to:
   * a pointer moving down the rows of a run is at the same position the whole
   * way, the selection does not change, and the editor dispatches nothing for
   * a selection that did not change — so the rows stayed at whichever the
   * pointer entered on. */
  const setTaken = StateEffect.define<[number, RunLines][]>()

  const taken = StateField.define<TakenRuns>({
    create: () => new Map(),
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setTaken)) return new Map(effect.value)
      }
      if (tr.isUserEvent("select.pointer")) return new Map(pending)
      // Any other selection is a new one, and a key or ⌘A that reaches past a
      // run crosses it, which the position does say. An edit — the buffer is
      // shared with the `Edit` view — moves every position and recomputes
      // the chunks, so nothing noted here is still true.
      if (tr.selection || tr.docChanged) return new Map()
      return value
    },
  })

  /** Which rows of the run drawn at `at` the selection has: all of them for
   * a run it crosses, the noted rows for one it ends in, none otherwise. */
  const rowsOf = (state: EditorState, at: number): RunLines | undefined => {
    const noted = state.field(taken)
    if (noted.has(at)) return noted.get(at)
    const { from, to } = state.selection.main
    return crossesRemoved(at, from, to) ? null : undefined
  }

  const style = EditorView.mouseSelectionStyle.of((view, start) => {
    const anchor = pointAt(view, start)
    const clicks = start.detail
    return {
      get(event, extend) {
        const head = pointAt(view, event)
        pending = []
        if (anchor.run !== null) pending.push([anchor.run.at, null])
        if (head.run !== null) {
          // From the row under the pointer to the far edge of the run — the
          // edge the selection came in over.
          const below = anchor.pos >= head.run.at
          pending.push([
            head.run.at,
            below
              ? { from: head.run.row, to: Infinity }
              : { from: 0, to: head.run.row },
          ])
        }
        if (!sameRuns(pending, view.state.field(taken))) {
          view.dispatch({ effects: setTaken.of(pending) })
        }
        if (extend) {
          return EditorSelection.single(
            view.state.selection.main.anchor,
            head.pos
          )
        }
        if (clicks > 1 && anchor.run === null && head.run === null) {
          // A double click is the word, a triple the line — the editor's own
          // reading of them, which this hook replaces.
          const range = clicks === 2 ? view.state.wordAt(head.pos) : null
          const line = view.state.doc.lineAt(head.pos)
          const from = Math.min(anchor.pos, range?.from ?? line.from)
          const to = Math.max(anchor.pos, range?.to ?? line.to)
          return EditorSelection.single(from, to)
        }
        return EditorSelection.single(anchor.pos, head.pos)
      },
      update: () => false,
    }
  })

  const widgets = ViewPlugin.define((view) => {
    // After the DOM update rather than in it: a plugin's `update` runs before
    // the widgets are redrawn, and a class put on one about to be replaced is
    // lost with it.
    const mark = () =>
      view.requestMeasure({
        read: () => null,
        write: () => {
          for (const widget of view.contentDOM.querySelectorAll<HTMLElement>(
            ".cm-deletedChunk"
          )) {
            // Focusable, so a mousedown on it lands focus here — see above.
            widget.tabIndex = -1
            const rows = rowsOf(view.state, view.posAtDOM(widget))
            rowsIn(widget).forEach((row, index) => {
              row.classList.toggle(
                "cm-deletedLine-selected",
                rows !== undefined &&
                  (rows === null || (index >= rows.from && index <= rows.to))
              )
            })
          }
        },
      })
    mark()
    return {
      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged || update.viewportChanged)
          mark()
      },
    }
  })

  // The editor's own selection: its copy event, which it raises only for a
  // selection it made.
  const copy = EditorView.domEventHandlers({
    copy(event, view) {
      const text = selectedText(view.state, view.state.field(taken))
      if (text === null || !event.clipboardData) return false
      event.clipboardData.setData("text/plain", text)
      event.preventDefault()
      return true
    },
  })

  // The browser's: a copy raised with a widget focused goes past the editor
  // (it ignores events from inside a widget) to the document, which is where
  // this listens. On the capture phase, ahead of anything else on the page.
  const nativeCopy = ViewPlugin.define((view) => {
    const onCopy = (event: ClipboardEvent) => {
      const text = nativeSelectedText(view)
      if (text === null || !event.clipboardData) return
      event.clipboardData.setData("text/plain", text)
      event.preventDefault()
    }
    document.addEventListener("copy", onCopy, true)
    return {
      destroy() {
        document.removeEventListener("copy", onCopy, true)
      },
    }
  })

  return [taken, style, widgets, copy, nativeCopy]
}

/** The text for the main selection, or null — for a selection that takes in
 * no removed run, which the editor's own copy handles.
 *
 * Exported for the test, which builds the unified view's real state: the
 * first version of this asked `getChunks` for `side === null` to recognise
 * that view, which registers itself as `"b"`, and every copy fell back. */
export function selectedText(
  state: EditorState,
  taken: TakenRuns,
  { from, to }: { from: number; to: number } = state.selection.main
): string | null {
  const merge = getChunks(state)
  if (!merge) return null
  if (from === to && taken.size === 0) return null
  return selectionText(
    getOriginalDoc(state).toString(),
    state.doc.toString(),
    merge.chunks,
    from,
    to,
    taken
  )
}

/**
 * The text for the browser's selection, or null when it is not this diff's
 * to copy: not in this editor, in no removed run — the editor's own copy has
 * that — or inside a single run, which the browser copies exactly as the text
 * that was selected, and is the whole reason the native selection is kept.
 */
function nativeSelectedText(view: EditorView): string | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed) return null

  const a = endOf(view, selection.anchorNode, selection.anchorOffset)
  const b = endOf(view, selection.focusNode, selection.focusOffset)
  if (!a || !b) return null
  if (a.run === null && b.run === null) return null
  if (a.run !== null && a.run.element === b.run?.element) return null

  const taken = new Map<number, RunLines>()
  for (const [end, other] of [
    [a, b],
    [b, a],
  ] as const) {
    if (end.run === null) continue
    // The other end is below this run when it is past the line the run is
    // drawn above — or on that line, which is under the run.
    const below =
      other.pos > end.run.at || (other.pos === end.run.at && other.run === null)
    taken.set(
      end.run.at,
      below ? { from: end.run.row, to: Infinity } : { from: 0, to: end.run.row }
    )
  }
  return selectedText(view.state, taken, {
    from: Math.min(a.pos, b.pos),
    to: Math.max(a.pos, b.pos),
  })
}

function sameRuns(runs: [number, RunLines][], noted: TakenRuns): boolean {
  if (runs.length !== noted.size) return false
  return runs.every(([at, rows]) => {
    if (!noted.has(at)) return false
    const was = noted.get(at) ?? null
    if (rows === null || was === null) return rows === was
    return rows.from === was.from && rows.to === was.to
  })
}

/** A removed run under the pointer or under one end of a range: the position
 * it is drawn at, and which of its rows. */
type RunPoint = { at: number; row: number; element: Element }

/** One end of a DOM range as a position, and the run it is in if it is in
 * one. Null for an end outside this editor. */
function endOf(
  view: EditorView,
  node: Node | null,
  offset: number
): { pos: number; run: RunPoint | null } | null {
  if (!node || !view.contentDOM.contains(node)) return null
  const element = node instanceof Element ? node : node.parentElement
  const widget = widgetOf(view, element)
  if (!widget) return { pos: view.posAtDOM(node, offset), run: null }

  const rows = rowsIn(widget)
  const row = element?.closest(".cm-deletedLine")
  const index = row
    ? Math.max(0, rows.indexOf(row as HTMLElement))
    : // The range ends on the widget itself, between its rows: the offset is
      // how many rows are before it.
      Math.min(offset, rows.length - 1)
  const at = view.posAtDOM(widget)
  return { pos: at, run: { at, row: index, element: widget } }
}

/**
 * Where a pointer is: a document position, and the run and row it is over if
 * it is over one.
 *
 * Off the element under the pointer rather than the event's target, since the
 * target of a drag's `mousemove` is whatever the document has there.
 * `posAtCoords` over a widget answers with the nearest line, which is the one
 * below it.
 */
function pointAt(
  view: EditorView,
  event: MouseEvent
): { pos: number; run: RunPoint | null } {
  const element = document.elementFromPoint(event.clientX, event.clientY)
  const widget = widgetOf(view, element)
  if (widget) {
    const at = view.posAtDOM(widget)
    return {
      pos: at,
      run: { at, row: rowAt(widget, event.clientY), element: widget },
    }
  }
  const pos =
    view.posAtCoords({ x: event.clientX, y: event.clientY }, false) ??
    view.state.doc.length
  return { pos, run: null }
}

function widgetOf(
  view: EditorView,
  target: EventTarget | null
): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const widget = target.closest<HTMLElement>(".cm-deletedChunk")
  return widget && view.contentDOM.contains(widget) ? widget : null
}

/** A run's rows, one element each — `@codemirror/merge` draws a `div` per
 * removed line, directly under the widget. */
function rowsIn(widget: HTMLElement): HTMLElement[] {
  return Array.from(
    widget.querySelectorAll<HTMLElement>(":scope > .cm-deletedLine")
  )
}

/** Which row of a run is at `y`: the first whose bottom edge is past it, or
 * the last for a pointer in the padding below. */
function rowAt(widget: HTMLElement, y: number): number {
  const rows = rowsIn(widget)
  const index = rows.findIndex((row) => row.getBoundingClientRect().bottom > y)
  return index === -1 ? Math.max(0, rows.length - 1) : index
}
