import { useEffect, useRef } from "react"
import { EditorView } from "@codemirror/view"
import { useTheme } from "next-themes"

import {
  editorTheme,
  fileChrome,
  languageConf,
  saveKeymap,
  themeConf,
} from "@/lib/editor"
import { conflictResolution } from "@/lib/editor-conflicts"
import { languageExtension, languageForFile } from "@/lib/editor-languages"
import {
  acquireDoc,
  docSharing,
  docState,
  releaseDoc,
} from "@/lib/files/documents"
import {
  closeFile,
  moveTo,
  openFile,
  pendingReveal,
  servesTypeScript,
  syncFile,
  typeScriptFeatures,
} from "@/lib/files/typescript"

/**
 * One open file, in CodeMirror.
 *
 * The default export, and imported nowhere but the `lazy` in `file-editor.tsx`:
 * that is what keeps the editor and its language parsers out of the bundle the
 * studio launches with.
 *
 * Uncontrolled. The buffer belongs to the editor and the store is told what was
 * typed, not the other way round — a controlled editor would rewrite the
 * document on every keystroke and take the undo history, the cursor and the
 * folded regions with it. Safe because nothing but the user writes an open
 * file's text: the Explorer's Refresh deliberately skips files with unsaved
 * edits.
 *
 * The buffer is not this component's, though — it belongs to the path (see
 * `lib/files/documents.ts`), which is what makes this editor and the `Changes`
 * diff of the same file two views of one thing and what carries an editing
 * session across the `Diff | Edit` switch.
 */
export default function CodeMirrorFileEditor({
  path,
  initialText,
  onChange,
  onSave,
}: {
  path: string
  /** The text as it stood when the tab was read. Only used if this is the first
   * pane to hold the path open — a file already being edited elsewhere keeps
   * what is in its buffer. */
  initialText: string
  onChange: (text: string) => void
  onSave: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  // Through refs so the editor is built once: a fresh `onChange` identity from
  // the parent's render must never tear down a buffer being typed into.
  const handlers = useRef({ onChange, onSave })
  useEffect(() => {
    handlers.current = { onChange, onSave }
  }, [onChange, onSave])

  const initialRef = useRef({ path, initialText, isDark })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = initialRef.current
    acquireDoc(initial.path, initial.initialText)

    const extensions = [
      ...fileChrome(),
      // Set at construction as well as in the effect below, so the first paint
      // is not a light editor in a dark studio.
      themeConf.of(editorTheme(initial.isDark)),
      // Empty to begin with: a language is a dynamic import, so the first paint
      // is the file in plain text and the highlighting lands a frame or two
      // later. See `lib/editor-languages.ts`.
      languageConf.of([]),
      docSharing(initial.path, { editable: true }),
      saveKeymap(() => handlers.current.onSave()),
      // Inert in a file with no `<<<<<<<` in it — see `conflictsIn`.
      conflictResolution(),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const text = update.state.doc.toString()
        handlers.current.onChange(text)
        // The server reads the editor, not the disk — a hover over a symbol
        // typed a moment ago has to be about the text on screen.
        syncFile(initial.path, text)
      }),
      servesTypeScript(initial.path) ? typeScriptFeatures(initial.path) : [],
    ]

    const view = new EditorView({
      parent: host,
      state: docState(initial.path, extensions, { editable: true }),
    })
    viewRef.current = view

    // What the TypeScript server is told. Sent for every file rather than only
    // for the ones it can answer about: which languages it serves is its own
    // business, and a `.md` it is handed is a message it ignores.
    openFile(initial.path, initial.initialText)

    let alive = true
    void languageExtension(languageForFile(initial.path)).then((language) => {
      if (!alive) return
      view.dispatch({ effects: languageConf.reconfigure(language) })
    })

    // A tab opened by go-to-definition names where it was going; the editor
    // that lands on it is this one, a frame or two later.
    const target = pendingReveal.get(initial.path)
    if (target) {
      pendingReveal.delete(initial.path)
      moveTo(view, target.line, target.column, target.length)
    }

    return () => {
      alive = false
      closeFile(initial.path)
      // Destroying the view is what hands its editing session to whatever shows
      // this path next — the `ViewPlugin` in `docSharing` takes the snapshot on
      // the way down. The buffer itself is let go rather than dropped: the same
      // one is the right-hand side of this file's diff, which the `Changes` tab
      // may be showing right now.
      view.destroy()
      viewRef.current = null
      releaseDoc(initial.path)
    }
  }, [])

  // Per view, unlike Monaco's one global theme for every editor on the page.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeConf.reconfigure(editorTheme(isDark)),
    })
  }, [isDark])

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />
}
