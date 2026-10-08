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
  type TooltipView,
  type ViewUpdate,
} from "@codemirror/view"

import type { GitBlame, GitBlameCommit } from "@shared/api"
import {
  ago,
  annotationOf,
  commitAt,
  askAboutCommit,
  commitUrl,
  fileUrl,
  issueNumbers,
  messageParts,
} from "./files/git-blame"
import { useComposerBus } from "./worktree-chat/composer-bus"
import { dateTimeOf } from "./worktree-chat/since"

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

/** What the card's buttons are drawn from — `components/studio/files/
 * blame-actions.tsx`, which is handed in rather than imported so that `lib/`
 * does not reach into the components. */
export type BlameActions = {
  hash: string
  summary: string
  /** `GitHub`, `GitLab`, `Bitbucket` — null for a remote with no forge. */
  forge: string | null
  commitHref: string | null
  fileHref: string | null
  issues: { number: number; href: string }[]
  onAsk: () => void
}

/** Draws the buttons into `host`, and answers with the way to take them down. */
export type MountBlameActions = (
  host: HTMLElement,
  actions: BlameActions
) => () => void

const actionsMount = Facet.define<MountBlameActions, MountBlameActions | null>({
  combine: (values) => values[0] ?? null,
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
   * the words hang off it absolutely, cut to the room left before the edge
   * (`fit`) — the code on screen never moves for them.
   */
  toDOM(view: EditorView) {
    const dom = document.createElement("span")
    dom.className = "cm-gitBlame"
    const text = document.createElement("span")
    text.className = "cm-gitBlame-text"
    text.textContent = this.text
    if (this.hoverable) holdOpen(view, text)
    dom.appendChild(text)
    fit(view)
    return dom
  }

  ignoreEvent() {
    return true
  }
}

/** Least room worth writing into; past this the line has the width and the
 * annotation is hidden rather than drawn as a lone `…`. */
const MIN_WIDTH = 60
/** The gap between the code and the words. */
const GAP = 32

/**
 * Cuts the annotation to the room between the end of its line and the edge of
 * what is visible, re-asked whenever the geometry moves — a resize, a scroll
 * sideways, a fold opening above it.
 */
function fit(view: EditorView) {
  view.requestMeasure({
    key: "gitBlameFit",
    read() {
      const anchor = view.contentDOM.querySelector<HTMLElement>(".cm-gitBlame")
      if (!anchor) return null
      const right = Math.min(
        view.contentDOM.getBoundingClientRect().right,
        view.scrollDOM.getBoundingClientRect().right
      )
      return {
        anchor,
        room: right - anchor.getBoundingClientRect().left - GAP - 8,
      }
    },
    write(measured) {
      if (!measured) return
      const text = measured.anchor.firstElementChild as HTMLElement | null
      if (!text) return
      const fits = measured.room >= MIN_WIDTH
      text.style.display = fits ? "" : "none"
      if (fits) text.style.maxWidth = `${measured.room}px`
    },
  })
}

const refit = EditorView.updateListener.of((update) => {
  if (update.geometryChanged || update.viewportChanged) fit(update.view)
})

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

function holdOpen(view: EditorView, dom: HTMLElement) {
  dom.addEventListener("mouseenter", () => setHover(view, true, 250))
  dom.addEventListener("mouseleave", () => setHover(view, false, 200))
}

const card = showTooltip.compute([blameState, "selection"], (state) => {
  if (!state.field(blameState).hover) return null
  const current = currentOf(state)
  if (!current?.commit) return null
  const { blame } = state.field(blameState)
  const commit = current.commit
  return {
    pos: current.to,
    above: false,
    arrow: false,
    create: (view) => cardView(view, commit, blame!, current.line),
  } satisfies Tooltip
})

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function link(text: string, href: string, className = ""): HTMLAnchorElement {
  const anchor = el("a", className, text)
  anchor.href = href
  // Out to the browser — `setWindowOpenHandler` in `main.ts` sends a new
  // window's URL to `shell.openExternal`.
  anchor.target = "_blank"
  anchor.rel = "noreferrer"
  return anchor
}

function cardView(
  view: EditorView,
  commit: GitBlameCommit,
  blame: GitBlame,
  line: number
): TooltipView {
  const dom = el("div", "cm-gitBlameCard")
  holdOpen(view, dom)

  const head = el("div", "cm-gitBlameCard-head")
  const author = el("span", "cm-gitBlameCard-author", commit.author)
  if (commit.email) author.title = commit.email
  head.append(
    author,
    el("span", "cm-gitBlameCard-when", ago(commit.date)),
    el("span", "cm-gitBlameCard-date", `(${dateTimeOf(commit.date)})`)
  )

  const message = el("div", "cm-gitBlameCard-message")
  for (const part of messageParts(commit.summary, blame.webUrl)) {
    message.append(
      "href" in part
        ? link(part.text, part.href)
        : document.createTextNode(part.text)
    )
  }

  dom.append(head, message)

  const mount = view.state.facet(actionsMount)
  if (!mount) return { dom }

  const { webUrl } = blame
  const forge = webUrl && new URL(webUrl).hostname.replace(/\.(com|org)$/, "")
  const actions = el("div", "cm-gitBlameCard-actions")
  dom.append(actions)
  const unmount = mount(actions, {
    hash: commit.hash,
    summary: commit.summary,
    // The forge's links are absent rather than greyed for a remote `webUrlOf`
    // cannot address — a button that cannot work is not an option.
    forge: forge ? forge[0]!.toUpperCase() + forge.slice(1) : null,
    commitHref: webUrl && commitUrl(webUrl, commit.hash),
    fileHref: webUrl && fileUrl(webUrl, commit.hash, blame.path, line),
    issues: webUrl
      ? issueNumbers(commit.summary).map((number) => ({
          number,
          href: `${webUrl}/issues/${number}`,
        }))
      : [],
    onAsk() {
      view.dispatch({ effects: hovered.of(false) })
      // Into the draft, never sent — the question is the user's to write, the
      // same bargain the terminal's `Ask about this` makes.
      useComposerBus
        .getState()
        .deliver({ text: askAboutCommit(commit, blame.path, line) })
    },
  })
  return { dom, destroy: unmount }
}

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
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "pre",
    color: "var(--muted-foreground)",
    opacity: "0.7",
    fontStyle: "normal",
    cursor: "default",
  },
  ".cm-gitBlame-text:hover": { opacity: "1" },
  ".cm-tooltip:has(> .cm-gitBlameCard)": { overflow: "visible" },
  ".cm-gitBlameCard": {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxWidth: "36rem",
    padding: "10px 12px",
    font: "12px/1.5 var(--font-sans, inherit)",
  },
  ".cm-gitBlameCard-head": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "6px",
  },
  ".cm-gitBlameCard-author": { fontWeight: "600" },
  ".cm-gitBlameCard-date": {
    color: "var(--muted-foreground)",
    fontStyle: "italic",
  },
  ".cm-gitBlameCard-message": { whiteSpace: "pre-wrap" },
  ".cm-gitBlameCard a": { color: "var(--primary)", textDecoration: "none" },
  ".cm-gitBlameCard a:hover": { textDecoration: "underline" },
  ".cm-gitBlameCard-actions": {
    display: "flex",
    paddingTop: "6px",
    borderTop: "1px solid var(--border)",
  },
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

export function gitBlame(
  path: string,
  mountActions?: MountBlameActions
): Extension {
  return [
    blameState,
    annotation,
    refit,
    card,
    theme,
    asker(path),
    mountActions ? actionsMount.of(mountActions) : [],
  ]
}
