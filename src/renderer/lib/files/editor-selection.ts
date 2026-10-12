import { EditorState, StateField } from "@codemirror/state"
import {
  EditorView,
  showTooltip,
  ViewPlugin,
  type Tooltip,
} from "@codemirror/view"
import { create } from "zustand"

import { useComposerBus } from "@/lib/worktree-chat/composer-bus"

import { lineCount, selectedLines, type LineRun } from "./selected-lines"

/**
 * The lines last selected in a file, for the chat's composer to carry.
 *
 * A store because the two are never on screen together: a file and a chat are
 * tabs in one strip, so a composer that could only see a selection while the
 * file was showing would never see one. What it holds instead is the last thing
 * selected, which is what somebody switching to the chat to ask about it meant.
 *
 * Kept while the editor is merely hidden — switching tabs does not collapse a
 * CodeMirror selection, and nor should it drop this one — and let go when the
 * selection is collapsed, the tab is closed, or the message carrying it is sent.
 */
export type SelectedRun = LineRun & { path: string }

type SelectionState = {
  current: SelectedRun | null
  /** What `path`'s editor has selected now — null for nothing. */
  report: (path: string, run: LineRun | null) => void
  /** Taken by a message, or waved away from the composer. */
  clear: () => void
}

export const useEditorSelection = create<SelectionState>((set, get) => ({
  current: null,

  report(path, run) {
    if (run) {
      set({ current: { path, ...run } })
      return
    }
    // Only the editor that put it there can take it back: a caret landing in
    // another file is not a reason to forget what was selected in this one.
    if (get().current?.path === path) set({ current: null })
  },

  clear() {
    set({ current: null })
  },
}))

function runOf(state: EditorState): LineRun | null {
  const range = state.selection.main
  return selectedLines((pos) => state.doc.lineAt(pos), range.from, range.to)
}

/**
 * The `Ask about this` pill, at the moving end of any selection at all — a
 * word inside a line is as much something to ask about as a function.
 */
function pillFor(path: string, state: EditorState): readonly Tooltip[] {
  const run = runOf(state)
  if (!run) return []
  const range = state.selection.main
  return [
    {
      pos: range.head,
      above: range.head < range.anchor,
      arrow: false,
      create: () => ({ dom: pillDom(path, run) }),
    },
  ]
}

function pillDom(path: string, run: LineRun): HTMLElement {
  const dom = document.createElement("div")
  dom.className = "cm-askPill"
  const button = document.createElement("button")
  button.type = "button"
  const count = lineCount(run)
  button.textContent = `Ask about ${count} ${count === 1 ? "line" : "lines"}`
  // `mousedown`, default prevented, like the conflict buttons: a click lets the
  // editor take the press first and collapse the selection being asked about.
  button.addEventListener("mousedown", (event) => {
    event.preventDefault()
    // Reported again, since the chip may have been waved away since this
    // selection was made — the press is asking for it back.
    useEditorSelection.getState().report(path, run)
    useComposerBus.getState().reveal()
  })
  dom.appendChild(button)
  return dom
}

function pill(path: string) {
  return StateField.define<readonly Tooltip[]>({
    create: (state) => pillFor(path, state),
    update: (tooltips, tr) =>
      tr.docChanged || tr.selection ? pillFor(path, tr.state) : tooltips,
    provide: (field) =>
      showTooltip.computeN([field], (state) => state.field(field)),
  })
}

const pillTheme = EditorView.baseTheme({
  ".cm-tooltip:has(> .cm-askPill)": { padding: "2px" },
  ".cm-askPill button": {
    font: "500 12px var(--font-sans, inherit)",
    height: "24px",
    padding: "0 6px",
    borderRadius: "calc(var(--radius-md) - 2px)",
    cursor: "pointer",
  },
  ".cm-askPill button:hover": { backgroundColor: "var(--accent)" },
})

/**
 * What a file editor adds for its selection: the store kept up to date, and
 * the pill. Reported on focus as well as on change, so going back to a file
 * whose selection was never touched makes it the current one again.
 */
export function selectionToChat(path: string) {
  return [
    pill(path),
    pillTheme,
    EditorView.updateListener.of((update) => {
      const focused = update.focusChanged && update.view.hasFocus
      if (!update.selectionSet && !update.docChanged && !focused) return
      useEditorSelection.getState().report(path, runOf(update.state))
    }),
    ViewPlugin.define(() => ({
      destroy: () => useEditorSelection.getState().report(path, null),
    })),
  ]
}
