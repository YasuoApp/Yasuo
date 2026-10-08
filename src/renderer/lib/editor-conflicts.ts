import {
  StateField,
  type Range as Ranged,
  type EditorState,
  type Extension,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view"

import {
  conflictsIn,
  resolution,
  type Conflict,
  type Range,
  type Resolution,
} from "./files/conflicts"

/**
 * Merge conflicts resolved in the file itself, the way VS Code does it: each
 * `<<<<<<<` block gets a row of actions over it — **Accept Current**, **Accept
 * Incoming**, **Accept Both** — and its two sides are tinted so which is which
 * reads without counting markers.
 *
 * An edit, not a git command. A button rewrites the block in the buffer like
 * typing would — undoable with ⌘Z, unsaved until ⌘S, and forwarded to any other
 * view of the path (`lib/files/documents.ts`). Telling git the file is resolved
 * is still staging it in `Changes`, which is what `git add` on a `UU` path has
 * always meant.
 *
 * The blocks are re-read from the text on every edit (`conflictsIn`), so a block
 * resolved by hand loses its buttons the moment its last marker goes, and the
 * button acts on the block as it stands when clicked rather than as it was when
 * it was drawn.
 */
export function conflictResolution(): Extension {
  return [conflictField, conflictTheme]
}

const conflictField = StateField.define<DecorationSet>({
  create: (state) => decorationsOf(state),
  update: (value, tr) => (tr.docChanged ? decorationsOf(tr.state) : value),
  // A block widget has to come from a field rather than a view plugin: it
  // changes the height of the document, which CodeMirror has to know before it
  // lays the viewport out.
  provide: (field) => EditorView.decorations.from(field),
})

function decorationsOf(state: EditorState): DecorationSet {
  const conflicts = conflictsIn(state.doc.toString())
  const ranges: Ranged<Decoration>[] = []

  for (const conflict of conflicts) {
    ranges.push(
      Decoration.widget({
        widget: new Actions(conflict.currentLabel, conflict.incomingLabel),
        block: true,
        side: -1,
      }).range(conflict.from)
    )

    const tinted: { at: number; className: string }[] = [
      ...conflict.markers.map((at) => ({ at, className: "cm-conflictMarker" })),
      ...linesIn(state, conflict.current).map((at) => ({
        at,
        className: "cm-conflictCurrent",
      })),
      ...(conflict.base
        ? linesIn(state, conflict.base).map((at) => ({
            at,
            className: "cm-conflictBase",
          }))
        : []),
      ...linesIn(state, conflict.incoming).map((at) => ({
        at,
        className: "cm-conflictIncoming",
      })),
    ]

    for (const { at, className } of tinted) {
      ranges.push(Decoration.line({ class: className }).range(at))
    }
  }

  // Sorted by `Decoration.set` rather than by hand: a block widget and a line
  // decoration share the opener's position, and which goes first is
  // CodeMirror's to say by their sides.
  return Decoration.set(ranges, true)
}

/** The start of every line a side covers. */
function linesIn(state: EditorState, range: Range): number[] {
  const starts: number[] = []
  let at = range.from
  while (at < range.to) {
    const line = state.doc.lineAt(at)
    starts.push(line.from)
    at = line.to + 1
  }
  return starts
}

const ACTIONS: { choice: Resolution; label: string }[] = [
  { choice: "current", label: "Accept Current" },
  { choice: "incoming", label: "Accept Incoming" },
  { choice: "both", label: "Accept Both" },
]

class Actions extends WidgetType {
  constructor(
    readonly currentLabel: string,
    readonly incomingLabel: string
  ) {
    super()
  }

  eq(other: Actions) {
    return (
      this.currentLabel === other.currentLabel &&
      this.incomingLabel === other.incomingLabel
    )
  }

  toDOM(view: EditorView) {
    const row = document.createElement("div")
    row.className = "cm-conflictActions"

    for (const { choice, label } of ACTIONS) {
      const button = document.createElement("button")
      button.type = "button"
      button.textContent = label
      button.title =
        choice === "current"
          ? `Keep ${this.currentLabel || "the current side"}`
          : choice === "incoming"
            ? `Keep ${this.incomingLabel || "the incoming side"}`
            : "Keep both, current first"
      // `mousedown` rather than `click`, and default prevented: the editor
      // moves its selection on mousedown, and a caret jumping into the block
      // a moment before the block is replaced is a flicker for nothing.
      button.addEventListener("mousedown", (event) => {
        event.preventDefault()
        accept(view, row, choice)
      })
      row.appendChild(button)
    }

    return row
  }

  // The buttons handle their own events; the editor is told to stay out.
  ignoreEvent() {
    return true
  }
}

/**
 * The block under this row, as the text stands now — found by where the row
 * is drawn rather than remembered from when it was, since the text above it
 * may have moved since.
 */
function accept(view: EditorView, row: HTMLElement, choice: Resolution) {
  if (view.state.readOnly) return
  const at = view.posAtDOM(row)
  const text = view.state.doc.toString()
  const conflict: Conflict | undefined = conflictsIn(text).find(
    (candidate) => candidate.from === at
  )
  if (!conflict) return
  view.dispatch({
    changes: resolution(text, conflict, choice),
    userEvent: "input.resolve",
    scrollIntoView: true,
  })
  view.focus()
}

/**
 * The tints, as translucent colours so one rule serves both themes: the
 * current side green and the incoming one blue, which is the pairing VS Code
 * has taught everybody who has resolved a conflict in it.
 */
const conflictTheme = EditorView.baseTheme({
  ".cm-conflictCurrent": { backgroundColor: "rgba(64, 200, 174, 0.12)" },
  ".cm-conflictIncoming": { backgroundColor: "rgba(64, 166, 255, 0.12)" },
  ".cm-conflictBase": { backgroundColor: "rgba(140, 140, 140, 0.1)" },
  ".cm-conflictMarker": { opacity: "0.6", fontWeight: "600" },
  ".cm-conflictActions": {
    display: "flex",
    gap: "2px",
    padding: "2px 0 1px 6px",
    fontFamily: "var(--font-sans, system-ui)",
    fontSize: "0.7rem",
    lineHeight: "1.4",
  },
  ".cm-conflictActions button": {
    border: "none",
    background: "transparent",
    color: "inherit",
    opacity: "0.65",
    padding: "0 4px",
    borderRadius: "3px",
    cursor: "pointer",
  },
  ".cm-conflictActions button:hover": {
    opacity: "1",
    textDecoration: "underline",
  },
  ".cm-conflictActions button + button::before": {
    content: '"|"',
    marginRight: "6px",
    opacity: "0.4",
    textDecoration: "none",
    display: "inline-block",
  },
})
