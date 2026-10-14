import {
  Compartment,
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  showTooltip,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view"

import type { GitBlame, GitBlameCommit } from "@shared/api"
import { annotationOf, commitAt } from "./files/git-blame"

/**
 * Who last changed the caret's line, written faintly after it, and the commit
 * behind that in a card when the words are hovered — what GitLens calls its
 * current-line blame.
 *
 * One `git blame` per file rather than one per caret move (`gitBlame`, see
 * `blame` in `main/git.ts`): asked when the editor opens, when it is focused
 * again — a commit made in the dock's shell meanwhile — and a moment after
 * typing stops, with the buffer as it stands so the lines line up.
 *
 * **Hidden while the answer is stale.** It is indexed by the line of the text
 * it was asked about, and a line typed above the caret moves every line under
 * it; a name that is one line off is worse than none, for the second it takes
 * to ask again.
 *
 * The hover is a tooltip the widget opens itself rather than a `hoverTooltip`,
 * which is asked about positions — and the annotation is past the end of the
 * line, where every point maps to the same one.
 */

/** Swapped between `gitBlame(path)` and nothing by the Settings switch, the way
 * the theme is. */
export const gitBlameConf = new Compartment()

/** What the card is drawn from — `components/studio/files/blame-card.tsx`,
 * which is handed in rather than imported so that `lib/` does not reach into
 * the components. */
export type BlameCard = {
  /** The file on disk — the gate `gitLineHistory` is asked through. */
  filePath: string
  blame: GitBlame
  commit: GitBlameCommit
  /** The caret's line, in the buffer. */
  line: number
  /** The same line in `commit`, where its history starts. */
  source: { line: number; path: string } | null
  close: () => void
  /** The card has grown — the history arrived — and its place is re-asked. */
  remeasure: () => void
}

/** Draws the card into `host`, and answers with the way to take it down. */
export type MountBlameCard = (host: HTMLElement, card: BlameCard) => () => void

const cardMount = Facet.define<MountBlameCard, MountBlameCard | null>({
  combine: (values) => values[0] ?? null,
})

/** The file the extension was made for, for the card's history call. */
const blamedPath = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
})

const answered = StateEffect.define<GitBlame | null>()
const hovered = StateEffect.define<boolean>()

type BlameState = {
  blame: GitBlame | null
  /** The buffer has changed since `blame` was asked for. */
  stale: boolean
  /** The card is open. */
  hover: boolean
}

const blameState = StateField.define<BlameState>({
  create: () => ({ blame: null, stale: false, hover: false }),
  update(value, tr) {
    let next = value
    for (const effect of tr.effects) {
      if (effect.is(answered))
        next = { ...next, blame: effect.value, stale: false }
      if (effect.is(hovered)) next = { ...next, hover: effect.value }
    }
    if (tr.docChanged) next = { ...next, stale: true, hover: false }
    // The card is about one line, and a caret moving off it is a new question.
    else if (tr.selection) next = { ...next, hover: false }
    return next
  },
})

/** The caret's line and the commit behind it, or null when there is nothing
 * worth writing there. */
function currentOf(
  state: EditorState
): { line: number; to: number; commit: GitBlameCommit | null } | null {
  const { blame, stale } = state.field(blameState)
  if (!blame || stale) return null
  const line = state.doc.lineAt(state.selection.main.head)
  const commit = commitAt(blame, line.number)
  if (commit === undefined) return null
  return { line: line.number, to: line.to, commit }
}

class Annotation extends WidgetType {
  constructor(
    readonly text: string,
    readonly hoverable: boolean
  ) {
    super()
  }

  eq(other: Annotation) {
    return this.text === other.text && this.hoverable === other.hoverable
  }

  /**
   * **Laid over the line, not in it.** The file editor wraps, so words written
   * into the line made it longer — onto a second row, pushing every line under
   * it down a row as the caret moved. So the line gets a zero-width anchor, and
   * the words hang off it absolutely — the code on screen never moves for
   * them.
   *
   * **Never cut.** They were once trimmed to the room before the edge and
   * hidden below 60px, which hid them — and the card behind them — on exactly
   * the long lines; now a line that reaches the edge pushes them past it, and
   * the scroller's horizontal bar is the way to them.
   */
  toDOM(view: EditorView) {
    const dom = document.createElement("span")
    dom.className = "cm-gitBlame"
    const text = document.createElement("span")
    text.className = "cm-gitBlame-text"
    text.textContent = this.text
    if (this.hoverable) holdOpen(view, text)
    dom.appendChild(text)
    return dom
  }

  ignoreEvent() {
    return true
  }
}

/** The gap between the code and the words. */
const GAP = 32

const annotation = EditorView.decorations.compute(
  [blameState, "selection"],
  (state): DecorationSet => {
    const current = currentOf(state)
    // A selection is being made, not read, and the pill for it sits there.
    if (!current || !state.selection.main.empty) return Decoration.none
    return Decoration.set(
      Decoration.widget({
        widget: new Annotation(
          annotationOf(current.commit),
          current.commit !== null
        ),
        side: 1,
      }).range(current.to)
    )
  }
)

/** The open and close delays, per view — a pointer crossing from the words to
 * the card passes over a gap, and closing on that would make the card
 * unreachable. */
const timers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>()

function setHover(view: EditorView, on: boolean, delay: number) {
  clearTimeout(timers.get(view))
  timers.set(
    view,
    setTimeout(() => {
      if (view.state.field(blameState, false)?.hover === on) return
      view.dispatch({ effects: hovered.of(on) })
    }, delay)
  )
}

/** Long enough that a pointer passing over the annotation on its way somewhere
 * else does not throw a card over the code. Entering the card itself still
 * cancels a pending close at once — `setHover` clears the timer before waiting. */
const OPEN_DELAY_MS = 1000

function holdOpen(view: EditorView, dom: HTMLElement) {
  dom.addEventListener("mouseenter", () => setHover(view, true, OPEN_DELAY_MS))
  dom.addEventListener("mouseleave", () => setHover(view, false, 200))
}

const card = showTooltip.compute([blameState, "selection"], (state) => {
  if (!state.field(blameState).hover) return null
  const mount = state.facet(cardMount)
  const current = currentOf(state)
  if (!mount || !current?.commit) return null
  const { blame } = state.field(blameState)
  const path = state.facet(blamedPath)
  const card: Omit<BlameCard, "close" | "remeasure"> = {
    filePath: path,
    blame: blame!,
    commit: current.commit,
    line: current.line,
    source: blame!.sources[current.line - 1] ?? null,
  }
  return {
    pos: current.to,
    above: false,
    arrow: false,
    create(view) {
      const dom = document.createElement("div")
      dom.className = "cm-gitBlameCard"
      holdOpen(view, dom)
      const unmount = mount(dom, {
        ...card,
        close: () => view.dispatch({ effects: hovered.of(false) }),
        remeasure: () => view.requestMeasure(),
      })
      return { dom, destroy: unmount }
    },
  } satisfies Tooltip
})

const theme = EditorView.baseTheme({
  // `inline-block` with no width, top-aligned, so the words hung off it sit on
  // the caret's row however tall the line box is.
  ".cm-gitBlame": {
    display: "inline-block",
    position: "relative",
    width: "0",
    verticalAlign: "top",
  },
  ".cm-gitBlame-text": {
    position: "absolute",
    top: "0",
    left: `${GAP}px`,
    // Room after the words, so scrolled to the end they do not sit against
    // the scrollbar.
    paddingRight: "16px",
    whiteSpace: "pre",
    color: "var(--muted-foreground)",
    opacity: "0.7",
    fontStyle: "normal",
    cursor: "default",
  },
  ".cm-gitBlame-text:hover": { opacity: "1" },
  ".cm-tooltip:has(> .cm-gitBlameCard)": { overflow: "visible" },
})

/** How long typing has to stop before the buffer is blamed again. */
const SETTLE_MS = 800

/** The asking: on open, on focus, and once typing settles. */
function asker(path: string) {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined
      /** Answers land out of order; only the newest is kept. */
      asked = 0
      alive = true

      constructor(readonly view: EditorView) {
        this.ask()
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.ask(SETTLE_MS)
        else if (update.focusChanged && update.view.hasFocus) this.ask()
      }

      ask(delay = 0) {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          const id = ++this.asked
          const text = this.view.state.doc.toString()
          void window.desktop
            .gitBlame(path, text)
            .catch(() => null)
            .then((blame) => {
              if (!this.alive || id !== this.asked) return
              // Typed into while git was reading: the answer is already stale,
              // and the next one is on its way.
              if (this.view.state.doc.toString() !== text) return
              this.view.dispatch({ effects: answered.of(blame) })
            })
        }, delay)
      }

      destroy() {
        this.alive = false
        clearTimeout(this.timer)
        clearTimeout(timers.get(this.view))
      }
    }
  )
}

export function gitBlame(path: string, mountCard?: MountBlameCard): Extension {
  return [
    blameState,
    annotation,
    card,
    theme,
    asker(path),
    blamedPath.of(path),
    mountCard ? cardMount.of(mountCard) : [],
  ]
}
