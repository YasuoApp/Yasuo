import {
  Compartment,
  Prec,
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  type DecorationSet,
} from "@codemirror/view"

import type { ChatBlame, Snapshot } from "@shared/api"
import { colorOf, hoverOf, labelOf, runsOf } from "./files/blame"

/**
 * The blame gutter: which chat wrote each line, drawn beside the numbers.
 *
 * Built from a `ChatBlame` (`lib/files/blame.ts`) rather than reading the
 * store itself, so the editor decides when to swap one in — through
 * `blameConf`, the way the theme and the language are swapped. The answer is
 * indexed by the line of the text it was asked about; the buffer may have
 * moved on by the time it lands, so a line past the end is simply unmarked,
 * and the line tints are mapped through edits until the next answer replaces
 * them.
 *
 * Two pieces: a gutter cell per written line — a bar in the chat's lane, and
 * on the first line of each run the chat's name — and a faint tint across the
 * line itself, so a run reads as a block rather than as a stripe beside one.
 * The colours are CSS classes (`blame-c0..7`, `blame-line-c0..7` in
 * `styles/globals.css`) rather than a theme spec, because a `GutterMarker`
 * returns DOM and the tint has to follow the palette the rest of the studio is
 * drawn in.
 */

/** The compartment the editor reconfigures with `blameExtension`, or with
 * nothing when the gutter is switched off. Shared across views like the ones
 * in `lib/editor.ts`, and safe for the same reason. */
export const blameConf = new Compartment()

class Cell extends GutterMarker {
  constructor(
    readonly color: number,
    readonly label: string | null,
    readonly title: string
  ) {
    super()
  }

  eq(other: Cell) {
    return (
      this.color === other.color &&
      this.label === other.label &&
      this.title === other.title
    )
  }

  toDOM() {
    const cell = document.createElement("div")
    cell.className = `cm-blameCell blame-c${this.color}`
    cell.title = this.title
    if (this.label !== null) {
      const text = document.createElement("span")
      text.className = "cm-blameLabel"
      text.textContent = this.label
      cell.appendChild(text)
    }
    return cell
  }
}

/** One marker per 0-based line of the blamed text, null for an unwritten one. */
function cellsOf(blame: ChatBlame): (Cell | null)[] {
  const cells = new Array<Cell | null>(blame.lines.length).fill(null)
  for (const run of runsOf(blame.lines)) {
    const snapshot = blame.snapshots[run.snapshotId]
    if (!snapshot) continue
    const color = colorOf(snapshot.chatId)
    const title = hoverOf(snapshot, blame.chats)
    // The run's first line carries the name; the rest carry the bar alone, as
    // one marker rather than one each so `eq` keeps the gutter from redrawing.
    const rest = new Cell(color, null, title)
    cells[run.from] = new Cell(color, labelOf(snapshot, blame.chats), title)
    for (let i = run.from + 1; i < run.to; i += 1) cells[i] = rest
  }
  return cells
}

function tintsOf(blame: ChatBlame, state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const lines = Math.min(blame.lines.length, state.doc.lines)
  for (let i = 0; i < lines; i += 1) {
    const id = blame.lines[i]
    if (id == null) continue
    const snapshot = blame.snapshots[id]
    if (!snapshot) continue
    const line = state.doc.line(i + 1)
    builder.add(
      line.from,
      line.from,
      Decoration.line({ class: `blame-line-c${colorOf(snapshot.chatId)}` })
    )
  }
  return builder.finish()
}

export function blameExtension(
  blame: ChatBlame,
  onReveal: (snapshot: Snapshot) => void
): Extension {
  const cells = cellsOf(blame)
  const snapshotAt = (view: EditorView, from: number): Snapshot | null => {
    const id = blame.lines[view.state.doc.lineAt(from).number - 1]
    return id ? (blame.snapshots[id] ?? null) : null
  }

  const tints = StateField.define<DecorationSet>({
    create: (state) => tintsOf(blame, state),
    update: (value, tr) => (tr.docChanged ? value.map(tr.changes) : value),
    provide: (field) => EditorView.decorations.from(field),
  })

  return [
    // `Prec.high` is what puts it left of the numbers: gutters are laid out in
    // facet order, and the number and fold gutters are added at default
    // precedence by `fileChrome`, ahead of anything in this compartment.
    Prec.high(
      gutter({
        class: "cm-blameGutter",
        lineMarker: (view, line) =>
          cells[view.state.doc.lineAt(line.from).number - 1] ?? null,
        lineMarkerChange: (update) => update.docChanged,
        domEventHandlers: {
          click(view, line) {
            const snapshot = snapshotAt(view, line.from)
            if (!snapshot) return false
            onReveal(snapshot)
            return true
          },
        },
      })
    ),
    tints,
  ]
}
