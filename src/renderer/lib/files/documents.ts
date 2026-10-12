import { historyField } from "@codemirror/commands"
import {
  Annotation,
  EditorState,
  Text,
  type Extension,
} from "@codemirror/state"
import { EditorView, ViewPlugin } from "@codemirror/view"

/**
 * One buffer per path, shared by every editor showing that file.
 *
 * There can be more than one at a time: a file open in the text editor is the
 * same buffer as the right-hand side of its diff, and the `Changes` tab can be
 * showing that diff while the file has a tab of its own. And there is more than
 * one *over time*: `Diff | Edit` in the pane header unmounts one editor and
 * mounts the other, which must not read as the undo history and the caret being
 * thrown away.
 *
 * **This is the file that had to be written rather than ported.** Monaco has a
 * document model of its own — `createModel` against a URI, `getModel` to find it
 * again, every editor attached to one sharing its text and its undo stack — so
 * the whole of the old `modelFor`/`releaseModel` was a reference count over
 * something Monaco already owned. CodeMirror deliberately has no such registry:
 * a document is a value (`Text`), and state, history and selection belong to a
 * *view*. So the registry is here, and it is explicit about which of those three
 * things it shares and how:
 *
 * - **The document is shared live.** Every view registered against a path
 *   forwards its own changes to the others, so two editors on one file never
 *   disagree about a character. That is `docSharing` below.
 * - **The history and the selection are handed over, not shared.** An editable
 *   view writes its whole state out on the way down (`historyField` is
 *   serialisable for exactly this) and the next editable view for that path is
 *   built from it. Sequential views therefore continue one editing session,
 *   which is what `Diff | Edit` needs; simultaneous ones each have their own
 *   undo stack, which costs nothing because **only one of them can type** — a
 *   diff is read-only on both sides.
 *
 * Sharing history *live* between two views is possible and was not done: it
 * means a state field synchronised across configurations that are not the same
 * (a diff's extensions are not a text editor's), for the benefit of undoing in
 * one pane what was typed in another pane of the same file — which is not a
 * thing anyone reaching for ⌘Z means.
 */

/**
 * A change that arrived from another view, so the listener that receives it does
 * not send it back. Without it two open editors trade one keystroke forever.
 */
const fromShare = Annotation.define<boolean>()

type Doc = {
  /** The current text, kept up to date by every registered view so a view that
   * mounts later starts from what has been typed rather than from what was
   * read. */
  doc: Text
  /** The last editable view's whole state, and the document it was taken
   * against. The pair is the point: a snapshot is only safe to restore while
   * nothing has moved the text since — see `docState`. */
  snapshot: { json: unknown; doc: Text } | null
  /** Every mounted view for this path, and whether it can be typed into. */
  views: Map<EditorView, { editable: boolean }>
  /** How many panes are holding the path open. Not the same number as the views
   * above: a pane holds the path from the moment it decides to show it, which is
   * before its editor exists and after it has gone. */
  holders: number
}

const docs = new Map<string, Doc>()

/**
 * Takes a hold on a path's buffer, creating it from `text` if this is the first.
 *
 * `text` is only ever the *initial* text: a second pane opening a file that is
 * already open gets what is in the buffer, not what it read off disk. That is
 * the same guarantee `modelFor` gave and it is what stops a `Changes` diff
 * showing the saved file while the tab beside it holds unsaved edits.
 *
 * Every caller must `releaseDoc` when it is done.
 */
export function acquireDoc(filePath: string, text: string): void {
  const held = docs.get(filePath)
  if (held) {
    held.holders += 1
    return
  }

  docs.set(filePath, {
    doc: Text.of(text.split("\n")),
    snapshot: null,
    views: new Map(),
    holders: 1,
  })
}

/**
 * Lets go of a path's buffer, dropping it once nothing holds it.
 *
 * The buffer goes with the last pane that was showing the file — kept across a
 * hidden tab, since the pane stays mounted, and not across a closed one, where
 * it would be a copy of a file nobody is looking at held for the rest of the
 * run.
 */
export function releaseDoc(filePath: string): void {
  const held = docs.get(filePath)
  if (!held) return

  held.holders -= 1
  if (held.holders <= 0) docs.delete(filePath)
}

/**
 * The state to build a view from: the shared document, plus the previous
 * editable view's history and caret where that is still the same text.
 *
 * The doc comparison is the guard that matters. A snapshot carries a document
 * of its own, and restoring one taken before another pane typed into the file
 * would put those keystrokes back in the past. `Text.eq` is a structural
 * comparison over a rope, so this is cheap on the files it is cheap to be
 * wrong about.
 */
export function docState(
  filePath: string,
  extensions: Extension,
  options: { editable: boolean }
): EditorState {
  const held = docs.get(filePath)
  if (!held) return EditorState.create({ extensions })

  const { snapshot } = held
  if (options.editable && snapshot && snapshot.doc.eq(held.doc)) {
    return EditorState.fromJSON(
      snapshot.json,
      { extensions },
      {
        history: historyField,
      }
    )
  }

  return EditorState.create({ doc: held.doc, extensions })
}

/**
 * Registers a view against a path for as long as it is mounted: forwards what
 * is typed into it to every other view on the same file, and hands its editing
 * state on when it goes.
 *
 * A `ViewPlugin` rather than an `updateListener` because all three of those need
 * the view itself — the first at construction, the last at teardown — and a
 * plugin is the one extension that gets both.
 */
export function docSharing(
  filePath: string,
  options: { editable: boolean }
): Extension {
  return ViewPlugin.define((view) => {
    docs.get(filePath)?.views.set(view, { editable: options.editable })

    return {
      update(update) {
        if (!update.docChanged) return

        const held = docs.get(filePath)
        if (!held) return
        held.doc = update.state.doc

        // A change that came from a sibling is already in every sibling.
        if (update.transactions.some((tr) => tr.annotation(fromShare))) return

        for (const [other] of held.views) {
          if (other === view) continue
          other.dispatch({
            changes: update.changes,
            annotations: fromShare.of(true),
          })
        }
      },

      destroy() {
        const held = docs.get(filePath)
        if (!held) return

        held.views.delete(view)
        // Only an editable view has an editing session worth handing on, and
        // taking a snapshot off a read-only one would overwrite the real one
        // with a state that has no history in it.
        if (options.editable) {
          held.snapshot = {
            json: view.state.toJSON({ history: historyField }),
            doc: view.state.doc,
          }
        }
      },
    }
  })
}

/**
 * The mounted editor for a path, if there is one that can be typed into.
 *
 * What go-to-definition asks: a definition in the file already on screen is a
 * caret move rather than a tab to open. This is the registry Monaco answered
 * with `editor.getEditors()`.
 */
export function editableViewOf(filePath: string): EditorView | null {
  const held = docs.get(filePath)
  if (!held) return null

  for (const [view, { editable }] of held.views) {
    if (editable) return view
  }
  return null
}

/**
 * Puts a path's buffer back to what is on disk, in every view holding it.
 *
 * The store's own `docs` entry is not the thing on screen: an editor takes its
 * document from this registry when it is built and from its own state after
 * that, so a file re-read behind a mounted view — a build, an agent's edit —
 * landed in the store and nowhere else. The diff is where that showed: its
 * working side is this buffer, so it kept drawing the text the file was opened
 * at while the `Changes` row beside it counted the new one.
 *
 * Only ever called for a file with no unsaved edits (`reloadOpen` is the one
 * caller and it checks): this replaces the whole document, which is not a thing
 * to do to text somebody typed.
 */
export function resetDoc(filePath: string, text: string): void {
  const held = docs.get(filePath)
  if (!held) return
  if (held.doc.toString() === text) return

  held.doc = Text.of(text.split("\n"))
  // The handed-on editing session was taken against text that has since been
  // overwritten, and `docState` would restore it over this one.
  held.snapshot = null

  for (const [view] of held.views) {
    view.dispatch({
      // Annotated the way a sibling's change is: this loop is already reaching
      // every view, and without it each would forward the replacement to the
      // others on top of the one they have just been given.
      changes: { from: 0, to: view.state.doc.length, insert: text },
      annotations: fromShare.of(true),
    })
  }
}

/** The text of an open buffer, for a caller that has no view of its own. */
export function docTextOf(filePath: string): string | null {
  return docs.get(filePath)?.doc.toString() ?? null
}
