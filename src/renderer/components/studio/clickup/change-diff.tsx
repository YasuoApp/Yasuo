import { useEffect, useRef } from "react"
import { unifiedMergeView } from "@codemirror/merge"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { useTheme } from "next-themes"

import { baseChrome, editorTheme, readOnly } from "@/lib/editor"
import {
  DIFF_CONTEXT,
  DIFF_MIN_COLLAPSE,
  githubDiffGutters,
  githubDiffTheme,
} from "@/lib/files/diff-chrome"

/**
 * Two ClickUp texts against each other, in the diff the `Changes` tab is built
 * from.
 *
 * The default export, imported nowhere but the `lazy` in `clickup-pane.tsx` —
 * the same bargain `codemirror-diff.tsx` makes, and for the same reason: an
 * editor is the largest thing in this app's bundle and a history somebody never
 * expands should not pay for one.
 *
 * **What is reused, and what is deliberately not.** The chunking, the folded
 * unchanged bands, the `+`/`-` column and Primer's palette are the file diff's
 * own (`unifiedMergeView`, `githubDiffGutters`, `githubDiffTheme`), because a
 * diff should read the same everywhere in the app. Everything the file diff
 * has that is *about being a file* is absent: no `documents.ts` buffer, since
 * this text is not a path anything else can hold open; no language, since a
 * ClickUp description is prose; no review column, since there is nothing here
 * to leave a comment on; no side-by-side, since this lives in a pane half a
 * dialog wide. No `git diff` either — there is no git here, so the ranges are
 * CodeMirror's own, which is what `DiffConfig.override` exists to displace and
 * has nothing to displace it with.
 *
 * It is **read-only on both sides** for a stronger reason than the file diff's:
 * this app never writes to ClickUp at all.
 */
export default function ClickupChangeDiff({
  before,
  after,
}: {
  before: string
  after: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: after,
        extensions: [
          ...baseChrome(),
          ...readOnly(),
          editorTheme(isDark),
          githubDiffGutters(),
          githubDiffTheme(isDark),
          // Prose in a narrow pane, so the wrapping `baseChrome` already turns
          // on is doing more work here than it ever does over code.
          EditorView.theme({
            "&": { fontSize: "0.75rem" },
            ".cm-scroller": { overflow: "auto", lineHeight: "1.5" },
            ".cm-content": { padding: "4px 0" },
          }),
          unifiedMergeView({
            original: before,
            // All four are the file diff's own settings, and the comments on
            // them there are the argument: a flat tint per row, no second
            // change gutter, deletions still highlighted, and no accept/reject
            // — which would be an edit, and there is nothing here to edit.
            highlightChanges: false,
            gutter: false,
            syntaxHighlightDeletions: true,
            mergeControls: false,
            collapseUnchanged: {
              margin: DIFF_CONTEXT,
              minSize: DIFF_MIN_COLLAPSE,
            },
          }),
        ],
      }),
    })

    return () => view.destroy()
    // Rebuilt on a theme swap for the reason the file diff is: Primer's palette
    // is baked into the view's configuration rather than held in a compartment,
    // and this view is a few paragraphs rather than a file.
  }, [before, after, isDark])

  return <div ref={hostRef} className="max-h-96 overflow-auto" />
}
