import {
  keymap,
  type Command,
  EditorView,
  hoverTooltip,
} from "@codemirror/view"
import type { Extension } from "@codemirror/state"

import type { TsHover } from "@shared/api"

import { markdownRenderer } from "@/lib/markdown/renderer"

import { editableViewOf } from "./documents"
import { nameOf } from "./paths"
import { useFiles } from "./store"

/**
 * What the editor asks the TypeScript server, and what it does with the answer.
 *
 * The server behind these is a real `tsserver` in the main process; see
 * `main/tsserver.ts` for why it is that rather than a language server. The two
 * questions it answers are the two that are about a *project* rather than about
 * a file — what is this symbol, and where does it come from — and they are the
 * reason it exists at all.
 *
 * **They are also now the only language intelligence a `.ts` file gets**, which
 * is the one thing this app lost by moving off Monaco and is worth stating
 * plainly. Monaco carried a TypeScript worker that reported *syntax* errors in
 * the file in front of it, held to that because it could see no tsconfig and no
 * `node_modules` and reported every import in a real project as missing (see the
 * old `lib/monaco.ts`). Lezer parses for structure and highlighting and does not
 * diagnose, and there is no CodeMirror TypeScript service that is not a second
 * copy of the compiler in the renderer — which is what the `tsserver` in main
 * was written to avoid. So the squiggle on a genuine typo is gone. The server
 * that could give it back properly — with the *type* errors Monaco's worker
 * never had — is already running; wiring diagnostics through it is a feature
 * this migration deliberately did not smuggle in.
 *
 * These are per view rather than registered per language, which is the shape
 * CodeMirror asks for and happens to be better: a hover source attached to one
 * editor cannot answer for another one's file, so nothing here has to work out
 * which document it was handed.
 */

/** What the server is worth asking about — every extension `typescript` and
 * `javascript` claimed in Monaco, which is what it was registered against. */
const SERVED = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"])

/** Whether a path is one the TypeScript server has anything to say about. The
 * gate is here rather than in the server because a hover is an IPC round trip
 * per pointer rest, and a `.md` file would spend one to be told nothing. */
export function servesTypeScript(filePath: string): boolean {
  const name = nameOf(filePath).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 && SERVED.has(name.slice(dot + 1))
}

/** How long typing settles before the server is told what changed. Short
 * enough that a hover a moment after a keystroke is about the text on screen,
 * long enough that a held key is not a message per character. */
const SYNC_DELAY_MS = 250

/** One timer per file, so two open editors do not cancel each other's sync. */
const pendingSync = new Map<string, ReturnType<typeof setTimeout>>()

/** Tells the server a file is being edited, and hands it the text once the
 * typing stops. */
export function syncFile(filePath: string, text: string): void {
  const existing = pendingSync.get(filePath)
  if (existing !== undefined) clearTimeout(existing)

  pendingSync.set(
    filePath,
    setTimeout(() => {
      pendingSync.delete(filePath)
      void window.desktop.tsChange(filePath, text).catch(() => {
        // A server that is not running is a hover that says nothing, which is
        // what the editor did before any of this existed. Not worth a notice.
      })
    }, SYNC_DELAY_MS)
  )
}

export function openFile(filePath: string, text: string): void {
  void window.desktop.tsOpen(filePath, text).catch(() => {})
}

export function closeFile(filePath: string): void {
  const existing = pendingSync.get(filePath)
  if (existing !== undefined) clearTimeout(existing)
  pendingSync.delete(filePath)
  void window.desktop.tsClose(filePath).catch(() => {})
}

/** Where in the document, as tsserver counts: one-based line, one-based
 * column. */
function placeOf(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos)
  return { line: line.number, column: pos - line.from + 1 }
}

/**
 * The tooltip, assembled from the three things tsserver hands back.
 *
 * The signature is its own mono block rather than a markdown fence: the fence
 * was there so Monaco would highlight it, and this app's markdown renderer is
 * the one the chat view uses — it produces static DOM and highlights nothing.
 * A declaration in the editor's own font, above the prose, reads as a
 * declaration without the round trip through a code block that would not be
 * coloured either way.
 *
 * The documentation *is* markdown and goes through that renderer. Nothing here
 * is trusted with links that do anything: this is markdown out of a package's
 * own doc comments, and it is rendered to nodes rather than assigned as HTML.
 */
async function tooltipDom(hover: TsHover): Promise<HTMLElement> {
  const dom = document.createElement("div")
  dom.className = "max-w-[42rem] overflow-auto p-2 text-xs"

  const signature = document.createElement("pre")
  signature.className = "font-mono text-xs whitespace-pre-wrap"
  signature.textContent = hover.signature
  dom.append(signature)

  const prose = [
    hover.documentation,
    ...hover.tags.map((tag) => `*@${tag.name}* ${tag.text}`.trim()),
  ]
    .filter(Boolean)
    .join("\n\n")

  if (prose) {
    const render = await markdownRenderer()
    const body = document.createElement("div")
    body.className = "mt-2 border-t pt-2 [&_p]:my-1"
    body.append(render(prose))
    dom.append(body)
  }

  return dom
}

/**
 * Go to definition, for the file the caret is in and for one it is not.
 *
 * Monaco had to be handed an `registerEditorOpener` for the second case — given
 * a target in a model it was not attached to, its standalone editor did nothing
 * at all, which looked like a broken key rather than a missing feature. Here
 * there is no editor-level indirection to satisfy: the command has the path and
 * calls the store, which is the same thing clicking the file in the tree does.
 */
function goToDefinition(filePath: string): Command {
  return (view) => {
    const { line, column } = placeOf(view, view.state.selection.main.head)

    void window.desktop
      .tsDefinition(filePath, line, column)
      .then((definitions) => {
        const target = definitions[0]
        if (target) revealAt(target.path, target.line, target.column)
      })
      .catch(() => {})

    // Claimed either way: the key is spent asking, and letting it fall through
    // to the browser's own F12 would open Chromium's devtools over the studio.
    return true
  }
}

/**
 * Hover and go-to-definition for one open file.
 *
 * `Mod-click` as well as `F12`, which is the pair every editor binds and the
 * pair Monaco bound. The click handler returns nothing, so the editor still
 * places the caret where it was clicked — the jump and the caret are not
 * competing for the gesture, the way they would if this claimed the event.
 */
export function typeScriptFeatures(filePath: string): Extension {
  const jump = goToDefinition(filePath)

  return [
    hoverTooltip(async (view, pos) => {
      const { line, column } = placeOf(view, pos)
      const hover = await window.desktop
        .tsHover(filePath, line, column)
        .catch(() => null)
      if (!hover) return null

      const dom = await tooltipDom(hover)
      return { pos, create: () => ({ dom }) }
    }),

    keymap.of([{ key: "F12", run: jump }]),

    EditorView.domEventHandlers({
      click(event, view) {
        if (!event.metaKey && !event.ctrlKey) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return false

        const { line, column } = placeOf(view, pos)
        void window.desktop
          .tsDefinition(filePath, line, column)
          .then((definitions) => {
            const target = definitions[0]
            if (target) revealAt(target.path, target.line, target.column)
          })
          .catch(() => {})
        return false
      },
    }),
  ]
}

/**
 * Where a definition landed, for the editor that has not mounted yet.
 *
 * A tab opened by go-to-definition builds its editor a frame or two later, so
 * the position cannot be applied to it here. It is left here instead, and the
 * editor takes it on mount.
 */
export const pendingReveal = new Map<
  string,
  { line: number; column: number; length?: number }
>()

/** Also the left column's Search, which hands a `length` so the match itself
 * is selected rather than a caret put in front of it. */
export function revealAt(
  filePath: string,
  line: number,
  column: number,
  length?: number
) {
  const files = useFiles.getState()

  // Already the file on screen: the editor is mounted, so it can be moved
  // directly rather than through a tab that is already open.
  const view = editableViewOf(filePath)
  if (view) {
    moveTo(view, line, column, length)
    files.select(filePath)
    return
  }

  pendingReveal.set(filePath, { line, column, length })
  void files.open(filePath)
  // The tree follows, so a file arrived at this way is also somewhere the user
  // can see it sits.
  void files.reveal(filePath)
}

/**
 * Puts the caret on a one-based line and column and scrolls it into the middle
 * of the pane.
 *
 * Shared with the editor's own mount, which is the other half of a jump into a
 * file that was not open. Clamped to the document: a definition can name a line
 * a stale buffer does not have, and CodeMirror throws on a position out of range
 * rather than moving to the end.
 */
export function moveTo(
  view: EditorView,
  line: number,
  column: number,
  length = 0
): void {
  const doc = view.state.doc
  const target = doc.line(Math.min(Math.max(line, 1), doc.lines))
  const pos = Math.min(target.from + Math.max(column - 1, 0), target.to)

  view.dispatch({
    selection: {
      anchor: pos,
      head: Math.min(pos + length, doc.length),
    },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  })
  view.focus()
}
