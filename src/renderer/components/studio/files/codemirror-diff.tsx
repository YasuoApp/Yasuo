import { useEffect, useRef } from "react"
import {
  Change,
  diff,
  MergeView,
  unifiedMergeView,
  type DiffConfig,
} from "@codemirror/merge"
import type { Extension } from "@codemirror/state"
import { EditorView, highlightWhitespace } from "@codemirror/view"
import { useTheme } from "next-themes"

import {
  baseChrome,
  editorTheme,
  languageConf,
  optionsConf,
  panelChrome,
  readOnly,
  themeConf,
} from "@/lib/editor"
import {
  DIFF_CONTEXT,
  DIFF_MIN_COLLAPSE,
  githubDiffGutters,
  githubDiffTheme,
} from "@/lib/files/diff-chrome"
import { languageExtension, languageForFile } from "@/lib/editor-languages"
import { gitDiffRanges } from "@/lib/files/git-diff"
import { reviewGutter, setReviewMarks } from "@/lib/files/review-marks"
import { useReview, type ReviewSide } from "@/lib/files/review"
import {
  acquireDoc,
  docSharing,
  docState,
  docTextOf,
  releaseDoc,
} from "@/lib/files/documents"

/**
 * One file against its committed self, in CodeMirror's merge view.
 *
 * The default export, imported nowhere but the `lazy` in `file-diff.tsx` — the
 * same bargain `codemirror-editor.tsx` makes.
 *
 * **Both sides are read-only, and that is the point of `Diff | Edit`.** A diff
 * is a thing to read: two columns, one of them a commit, with the caret jumping
 * between versions of the same line. Editing is the `Edit` half of the toggle in
 * the header above, which is one click and the same buffer.
 *
 * **The right-hand side is still the file**, not a copy of it: it takes the same
 * path-keyed buffer the text editor uses (`lib/files/documents.ts`), which is
 * what makes the diff show the edits that have not been saved yet rather than
 * what is on disk, and what makes switching to `Edit` keep the buffer and its
 * undo history. The left-hand side is `HEAD`, and belongs to nothing.
 *
 * **Most of what the Monaco version of this file was is gone, and the reason is
 * worth keeping.** That editor painted the file, then diffed it on a worker,
 * then folded the unchanged regions away — three states, in that order, with the
 * fold arriving a frame or more after the paint. Everything around it existed to
 * hide that: the host held at `visibility: hidden` from the moment a file was
 * attached, a reveal chained through two `requestAnimationFrame`s off
 * `onDidChangeHiddenAreas`, a fallback off `onDidUpdateDiff` delayed by 32ms
 * because the fold was not in the paint that computed the diff, a two-second
 * guard in case neither fired, and a rule that `HEAD` had to be in hand *before*
 * a file was attached because a diff against an empty original has no unchanged
 * region and Monaco carried that absence forward as "the reader expanded
 * everything". CodeMirror computes the diff and the collapsed regions
 * synchronously while building the view, so the first paint is the folded diff.
 * There is no intermediate state to hide, and none of that machinery survives.
 *
 * What it costs, and it is a real cost: **the whole view is rebuilt when the
 * file, the commit or the layout changes**, where Monaco reused one editor
 * across every file the pane ever showed and a new file was a `setModel`. That
 * was the expensive call in the old pane and the reason it was reused; here the
 * expensive call does not exist — there is no worker to connect and no second
 * editor to construct, because side-by-side and inline are two different
 * CodeMirror constructions rather than one widget with a flag (`MergeView`
 * against `unifiedMergeView`). Rebuilding is also the only way the layout toggle
 * can work at all, so it is the shape of the thing rather than a shortcut.
 */
export default function CodeMirrorFileDiff({
  path,
  initialText,
  sideBySide,
  whitespace,
  original,
  patch,
  reviewRootId = null,
}: {
  path: string
  /** The working tree's text as the tab read it. Only used if no pane is already
   * holding this path open — otherwise the shared buffer wins, unsaved edits
   * and all. */
  initialText: string
  /** The toolbar's two, from `useSettings`. The first rebuilds the view — the
   * two layouts are two different constructions — and the second is a
   * compartment. */
  sideBySide: boolean
  whitespace: boolean
  /** What `HEAD` has, or null for a file it does not have — a new file, whose
   * diff is the whole of it added. */
  original: string | null
  /** Git's own patch between the two, or null when there is none to be had —
   * see `gitDiffConfig` below. */
  patch: string | null
  /**
   * The checkout being reviewed, or null for a diff that is not a review.
   *
   * A root id, not a flag, because a comment belongs to one: the `Changes` pane
   * hands its own down, and the `Diff` half of a file tab's toggle hands
   * nothing — the same diff, without the column. Reviewing is what the
   * `Changes` tab is *for*, and a `+` in every diff in the app would offer a
   * review with nowhere to submit it.
   */
  reviewRootId?: string | null
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  /** Every view this diff is made of — one for inline, two for side by side —
   * so a theme or whitespace change reaches all of them. */
  const viewsRef = useRef<EditorView[]>([])
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  /*
   * The review column, and what it is drawing.
   *
   * The id goes through a ref for the same reason the theme does: it is read
   * while the view is built, and a change to it has to rebuild the view — which
   * the effect's own dependency below is what does — rather than re-run the
   * builder on every render.
   */
  const reviewRef = useRef(reviewRootId ?? null)
  const themeRef = useRef(isDark)
  const whitespaceRef = useRef(whitespace)
  useEffect(() => {
    reviewRef.current = reviewRootId ?? null
    themeRef.current = isDark
    whitespaceRef.current = whitespace
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    acquireDoc(path, initialText)

    const dark = themeRef.current
    const marks = whitespaceRef.current
    /** What both sides share. Not the file editor's chrome: a diff is read, so
     * the active-line band and the indenting Tab have nothing to do here. */
    const common = (): Extension[] => [
      ...readOnly(),
      themeConf.of(editorTheme(dark)),
      // `highlightWhitespace` renders every space and tab, where Monaco's
      // `renderWhitespace: "selection"` drew them only inside a selection. There
      // is no selection-scoped equivalent here, so the toggle is all or nothing
      // — which is what somebody who turned it on to find a stray tab wanted.
      optionsConf.of(marks ? highlightWhitespace() : []),
      languageConf.of([]),
    ]

    /**
     * The review column, for one editor of this diff.
     *
     * `side` is what a document line of *that* editor is a line of, and
     * `removals` whether its deleted lines are block widgets in it — which is
     * the whole difference between the two layouts: the unified diff draws the
     * removed rows inside the working editor, and the split one puts them on the
     * commit's own, where they are ordinary lines. `overlay` follows from that:
     * only the unified diff has a `+`/`-` column for the marks to sit over, and
     * the split view's editors would have them over CodeMirror's fold arrows.
     * Empty for a diff that is not a review, which is what keeps the `+` out of
     * a file tab's `Diff`.
     */
    const rootId = reviewRef.current
    const review = (
      side: ReviewSide,
      removals: boolean,
      overlay: boolean
    ): Extension[] =>
      rootId === null
        ? []
        : [
            reviewGutter({
              side,
              removals,
              overlay,
              // The anchor arrives worked out, both sides of it: only the editor
              // can say which rows a gesture crossed, and a run through a hunk
              // crosses two files.
              pick: (anchor) =>
                useReview.getState().pick({ rootId, path }, anchor),
              drag: (anchor) =>
                useReview.getState().stretch({ rootId, path }, anchor),
              settle: () => useReview.getState().settle(),
              // Where the range is on screen, so the composer can be drawn
              // against it. Guarded in the store, since this arrives on every
              // frame of a scroll.
              locate: (spot) => useReview.getState().locate(spot),
            }),
          ]

    // The unchanged bands, folded away. A file where every line moved is a file
    // whose diff is the file, and folding it is what makes the handful of real
    // changes findable. The two numbers come from `diff-chrome.ts` because the
    // `@@` header drawn on each folded bar has to describe the same bounds the
    // fold used.
    const collapseUnchanged = {
      margin: DIFF_CONTEXT,
      minSize: DIFF_MIN_COLLAPSE,
    }
    const committed = original ?? ""
    // The working side, hoisted because it is half of the pair `gitDiffConfig`
    // has to recognise — and it is the shared buffer rather than `initialText`
    // whenever a text editor already holds this path open.
    const working = docTextOf(path) ?? initialText
    const diffConfig = gitDiffConfig(patch, committed, working)

    let views: EditorView[]
    let destroy: () => void

    if (sideBySide) {
      // `MergeView` builds its two sides from configs rather than from states,
      // so the shared buffer goes into `b` as its document and the sharing
      // plugin as an extension. Nothing is lost by not going through
      // `docState`: what that adds is a restored undo history, and neither side
      // here can be typed into. No revert arrows either — they write the
      // commit's version into the file, which is an edit.
      const merge = new MergeView({
        parent: host,
        orientation: "a-b",
        highlightChanges: false,
        gutter: true,
        collapseUnchanged,
        diffConfig,
        // Side by side is GitHub's split view: one number column per side,
        // which is what `panelChrome`'s own gutter already is. Only the tints
        // and the word-level highlighting are Primer's here.
        a: {
          doc: committed,
          extensions: [
            ...panelChrome(),
            ...common(),
            githubDiffTheme(dark),
            // The commit's own editor, so every line in it is a line of the
            // commit — which is where a deleted line lives in this layout, and
            // therefore where a comment on one is left.
            ...review("old", false, false),
          ],
        },
        b: {
          doc: working,
          extensions: [
            ...panelChrome(),
            ...common(),
            githubDiffTheme(dark),
            // After the number column, so it sits against the code the way a
            // forge draws it — a gutter's place is where it appears.
            ...review("new", false, false),
            docSharing(path, { editable: false }),
          ],
        },
      })
      views = [merge.a, merge.b]
      destroy = () => merge.destroy()
    } else {
      const view = new EditorView({
        parent: host,
        state: docState(
          path,
          [
            ...baseChrome(),
            ...common(),
            // The three columns and Primer's palette. `panelChrome`'s own
            // `lineNumbers` is deliberately not here: it would be a third
            // number column beside the old and new ones.
            githubDiffGutters(),
            githubDiffTheme(dark),
            // One editor holding both sides: its own lines are the working
            // file's, and the removed rows drawn between them are the commit's.
            ...review("new", true, true),
            docSharing(path, { editable: false }),
            unifiedMergeView({
              original: committed,
              // Off, which is what makes an added row one flat tint. The
              // extension marks the whole of an inserted line as "changed
              // text", so this drew a darker band hugging the characters inside
              // an already-green row — where GitHub tints the row and stops.
              highlightChanges: false,
              // The merge extension's own thin change gutter, off: the `+`/`-`
              // column above says the same thing in the form a diff is read in.
              gutter: false,
              // Deletions keep their highlighting, which is the whole reason to
              // read a removed line rather than see that one went.
              syntaxHighlightDeletions: true,
              // Accept/reject buttons are edits; see above.
              mergeControls: false,
              collapseUnchanged,
              diffConfig,
            }),
          ],
          { editable: false }
        ),
      })
      views = [view]
      destroy = () => view.destroy()
    }

    viewsRef.current = views

    let alive = true
    void languageExtension(languageForFile(path)).then((language) => {
      if (!alive) return
      for (const view of views) {
        view.dispatch({ effects: languageConf.reconfigure(language) })
      }
    })

    return () => {
      alive = false
      viewsRef.current = []
      destroy()
      // Let go rather than drop: the text editor may be holding the same buffer.
      releaseDoc(path)
    }
    // `isDark` is a dependency because Primer's diff palette is baked into the
    // view's configuration rather than held in a compartment: a light/dark swap
    // rebuilds the diff, which is the same rebuild a new file already costs.
    // `initialText` is deliberately not one: it is the seed for a buffer that
    // may already exist, and re-seeding it on every keystroke elsewhere would
    // rebuild the pane under the reader.
    // `patch` is one because it arrives with `original` and describes the same
    // pair: a rebuild for the commit that did not carry the patch with it would
    // draw the new file through the old file's ranges — which `gitDiffRanges`
    // would refuse, quietly costing the thing this was done for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, original, patch, sideBySide, isDark, reviewRootId])

  /*
   * What the review column draws, pushed in.
   *
   * Declared after the builder above and depending on everything it depends on,
   * which is what puts the marks back after a rebuild: React runs a component's
   * effects in order, so the view exists by the time this one asks for it. The
   * alternative was a generation counter and a render to carry it.
   */
  const threads = useReview((state) => state.threads)
  const pending = useReview((state) => state.pending)
  useEffect(() => {
    if (!reviewRootId) return

    const marks = setReviewMarks.of({
      threads: threads.filter(
        (thread) => thread.rootId === reviewRootId && thread.path === path
      ),
      // Only while it is about *this* file: one range is picked at a time
      // across the whole review, and a range picked in the file before this
      // one is not a range to tint in this one.
      pending: pending && pending.path === path ? pending : null,
    })

    // Every view rather than the working one: in the split layout the commit's
    // editor is the one drawing the deleted lines. Both are handed the same
    // threads and each filters by its own side, so neither has to be told twice
    // which it is.
    for (const view of viewsRef.current) view.dispatch({ effects: marks })
    // `patch` is here for the same reason it is a dependency of the builder: a
    // file edited again under an open diff rebuilds the view on the new patch
    // alone — `HEAD` did not move — and marks pushed into the views before that
    // went with the ones they were pushed into.
  }, [
    threads,
    pending,
    path,
    reviewRootId,
    original,
    patch,
    sideBySide,
    isDark,
  ])

  /* Both texts, handed to the review.
   *
   * The commit is the one thing a review cannot read off the buffer — a comment
   * on a deleted line quotes lines that are only there (see `committed` on the
   * store) — and the working side is what a **kept** review is put back on: this
   * fires when a file is shown, which is the one moment both halves exist, and
   * `showing` re-anchors every thread in this file against them. */
  useEffect(() => {
    if (!reviewRootId) return
    useReview
      .getState()
      .showing(path, original ?? "", docTextOf(path) ?? initialText)
    // `initialText` is the seed for a buffer that may already exist and is
    // deliberately not a dependency anywhere in this file — the buffer is read
    // here, not watched.
    // `patch` is, and it is what re-anchors a review against a file that has
    // been edited again since it was opened: the commit is unchanged, so this
    // is the only thing that says the working side moved. `showing` is built to
    // be run on every rebuild — see the guard on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, original, patch, reviewRootId])

  useEffect(() => {
    for (const view of viewsRef.current) {
      view.dispatch({
        effects: optionsConf.reconfigure(
          whitespace ? highlightWhitespace() : []
        ),
      })
    }
  }, [whitespace])

  return (
    <div
      ref={hostRef}
      className="h-full w-full overflow-hidden [&_.cm-editor]:h-full [&>.cm-mergeView]:h-full"
    />
  )
}

/**
 * What the package's own default `diffConfig` is when none is passed.
 *
 * Repeated here rather than imported because it is not exported, and it has to
 * be exact: the fallback below is the same call the view would have made on its
 * own, and a diff computed without this limit is the quadratic one the limit
 * exists to prevent on a large, wholly rewritten file.
 */
const DEFAULT_DIFF_CONFIG: DiffConfig = { scanLimit: 500 }

/**
 * Git's answer, wired in as the view's diff algorithm.
 *
 * `DiffConfig.override` is the whole of the seam: `@codemirror/merge` funnels
 * every diff it computes through one function, and everything built on top of
 * the result — the chunking, the folded unchanged bands, the gutters, the
 * review column, both layouts — is the same code either way. Nothing about the
 * view changes; only who decided where the changed lines are.
 *
 * **The override has to answer synchronously, and git does not.** So the patch
 * is fetched alongside the committed text and the ranges are read out of it
 * here, for the one pair of texts it was computed for. That guard is not
 * belt-and-braces: the extension calls this again on **substrings** of the two
 * documents when a chunk is recomputed after an edit, and it is called on the
 * live buffer, which git — reading the file on disk — knows nothing about the
 * unsaved state of. Both land on the fallback, which is the algorithm this
 * replaced, unchanged.
 *
 * The result still goes through the package's `makePresentable`, since
 * `presentableDiff` is what calls `diff`: adjacent ranges separated by a line or
 * two get merged into one chunk exactly as they always did. That is why the
 * bands look the way they did before rather than one per `@@`.
 *
 * One knowingly-left rough edge: the package tracks whether its last diff fell
 * back to the imprecise algorithm in a module-level flag, and the git path never
 * touches it. It is only read to decide whether a chunk may be shown as an
 * inline word-level diff, which needs `allowInlineDiffs` — not set here, and
 * `highlightChanges` is off anyway.
 */
function gitDiffConfig(
  patch: string | null,
  committed: string,
  working: string
): DiffConfig {
  if (patch === null) return DEFAULT_DIFF_CONFIG

  const ranges = gitDiffRanges(patch, committed, working)
  if (ranges === null) return DEFAULT_DIFF_CONFIG

  const changes = ranges.map(
    (range) => new Change(range.fromA, range.toA, range.fromB, range.toB)
  )

  return {
    ...DEFAULT_DIFF_CONFIG,
    override: (a, b) =>
      a === committed && b === working
        ? changes
        : // A substring, or a buffer that has moved on. `diff` is the package's
          // own export, and calling it without the override is what keeps this
          // from recurring into itself.
          diff(a, b, DEFAULT_DIFF_CONFIG),
  }
}
