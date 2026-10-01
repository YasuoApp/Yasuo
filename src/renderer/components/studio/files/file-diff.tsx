import { lazy, Suspense, useEffect, useRef, useState } from "react"

import { rootIdOf, useGitStatus } from "@/lib/files/git-status"
import { useSettings } from "@/lib/settings"

/**
 * A file's diff against `HEAD`, fetched the first time one is opened.
 *
 * Split the way `file-editor.tsx` is split, and for the same reason. The
 * committed side is read here, outside the `lazy`, so the IPC round trip and the
 * chunk load happen at once rather than one after the other.
 *
 * **The editor is not mounted until `HEAD` is in hand.** Under Monaco that was
 * load-bearing in a way it no longer is — a diff computed against an empty
 * original has no unchanged region in it, and Monaco carried that absence
 * forward as *the reader has expanded everything* when the real text arrived, so
 * the fold only ever worked because of this. CodeMirror computes the collapsed
 * regions from the pair it is built with, so the reason it still waits is the
 * plainer one: an editor mounted against a blank commit would draw "the whole
 * file added" and then redraw it as a diff.
 *
 * **And the diff on screen stays there while the next one is read**: reading a
 * file and asking git for its committed self are both round trips, so waiting
 * for them with nothing mounted turned every click in the `Changes` list into an
 * empty pane for a beat and then a diff. A path is swapped in only once there is
 * something to draw for it, and until then the reader keeps looking at the file
 * they came from. This component is therefore *not* keyed by path, unlike
 * everything else in `Body`, and is mounted through that panel's `Reading…`
 * state as well — the whole point is that it outlives the switch.
 *
 * **The editor inside it, on the other hand, is now rebuilt per file**, and that
 * is the one place this pane got worse rather than better. Monaco reused a single
 * `IStandaloneDiffEditor` for every file the pane ever showed, because
 * `createDiffEditor` builds two code editors, a gutter and a worker connection
 * and doing that on every row clicked in `Changes` was a stutter on the thread
 * that also has to draw. CodeMirror's merge view has no worker, computes its diff
 * synchronously and comes up folded on the first paint, so the construction cost
 * that argument rested on is gone — and rebuilding is unavoidable anyway, since
 * side-by-side and inline are two different constructions rather than one widget
 * with a flag. See `CodeMirrorFileDiff`.
 */
const loadDiffEditor = () => import("./codemirror-diff")
const CodeMirrorFileDiff = lazy(loadDiffEditor)

export function FileDiff({
  path,
  initialText,
  ready,
}: {
  path: string
  initialText: string
  /** Whether `initialText` is the file — false while the pane is still reading
   * it. The committed side is not asked for until it is, which is what makes
   * `read` below lag the prop by the whole switch rather than half of it: a
   * `HEAD` that arrived first would mount an editor against a blank file. */
  ready: boolean
}) {
  // The file the editor is showing, which lags the prop through a switch: the
  // one on screen stays until there is a committed side for the next.
  const [head, setHead] = useState<Head | null>(null)

  // The read is dropped if the pane has already moved on — its `initialText`
  // would be the new file's, and that pair is one file's commit against
  // another's buffer. The read for the file now selected is already in flight.
  const docRef = useRef({ path, initialText })
  useEffect(() => {
    docRef.current = { path, initialText }
  })

  /*
   * What git last said about this checkout, as the signal to ask it again.
   *
   * The committed side survives a file being rewritten — `HEAD` did not move —
   * but **the patch does not**, and the view's ranges are read off it: a file
   * edited again under an open diff was drawn through the ranges of the edit
   * before it. The same record the pane re-reads the file off, so the two halves
   * of the pair arrive for the same answer rather than one of them lagging.
   */
  const status = useGitStatus((state) => {
    const rootId = rootIdOf(path)
    return rootId ? state.byRoot[rootId] : undefined
  })

  useHeadDiff(ready ? path : null, status, (read) => {
    const doc = docRef.current
    if (doc.path !== read.path) return
    setHead({
      path: read.path,
      text: read.text,
      patch: read.patch,
      initialText: doc.initialText,
    })
  })

  // Warmed while the reads are in flight, since nothing is mounted until they
  // land: the module registry dedupes this against the `lazy`, so the chunk and
  // the IPC overlap rather than queueing.
  useEffect(() => {
    void loadDiffEditor()
  }, [])

  // Read here rather than handed down from the pane: they are the diff's own two
  // and nothing above it has any use for them.
  const sideBySide = useSettings((state) => state.diffSideBySide)
  const whitespace = useSettings((state) => state.diffWhitespace)

  // Nothing read yet, which is only ever the first diff of a pane. Blank rather
  // than a spinner: two round trips and a diff is a beat, and a spinner
  // appearing and leaving in that window is more movement than none.
  if (!head) return <div className="h-full w-full" />

  return (
    <Suspense fallback={<div className="h-full w-full" />}>
      <CodeMirrorFileDiff
        // The editor rebuilds itself on the file, the commit and the layout, so
        // no `key` is needed to make that happen — and one here would also throw
        // away the host element every switch.
        path={head.path}
        // The text that was read for *that* file, and only a seed: a buffer this
        // path already has — the `Edit` view's unsaved work — wins over it.
        initialText={head.initialText}
        sideBySide={sideBySide}
        whitespace={whitespace}
        original={head.text}
        patch={head.patch}
      />
    </Suspense>
  )
}

/**
 * What git has to say about a file, **with the path it was read for** — null
 * text for a file `HEAD` does not have, which is both a new file and a directory
 * that is not a repository, and null altogether until the first read comes back.
 *
 * The path travels with the text for two reasons. Nothing worth drawing can be
 * built against an empty committed side — a diff computed against one is "the
 * whole file added", which is a pane that redraws itself the moment the real text
 * lands. And the caller draws whatever the last answer was while the next is in
 * flight, so it has to be able to tell which file that answer is about.
 *
 * Not in the files store, unlike the working text: nothing else in the studio
 * asks for it, it cannot be edited, and it is invalidated by a commit rather
 * than by anything the store already watches for. A tab kept open across one is
 * re-read when the path it is showing changes, which is this hook's own effect.
 */
type Head = {
  path: string
  /** What `HEAD` has of it, null for a file `HEAD` does not have. */
  text: string | null
  /** And git's own patch between the two, which is what the view's ranges are
   * read off — see `lib/files/git-diff.ts`. Null is a fallback rather than an
   * error: the view computes the difference itself when there is none. */
  patch: string | null
  /** And the working tree's, kept beside it so the pair the editor is built from
   * is two halves of one file. */
  initialText: string
}

function useHeadDiff(
  path: string | null,
  /** Whatever changing means "ask git again" — see the caller. Only its identity
   * is read here. */
  generation: unknown,
  onRead: (read: {
    path: string
    text: string | null
    patch: string | null
  }) => void
) {
  // Through a ref, so a caller that builds its handler inline does not re-run
  // `git show` on every render.
  const onReadRef = useRef(onRead)
  useEffect(() => {
    onReadRef.current = onRead
  }, [onRead])

  useEffect(() => {
    // Nothing to read against yet — the pane has not finished reading the file.
    // Whatever was answered last stays, and with it the diff drawn from it.
    if (path === null) return

    let alive = true

    void window.desktop
      .fileDiff(path)
      .then((read) => {
        if (alive)
          onReadRef.current({ path, text: read.head, patch: read.patch })
      })
      .catch(() => {
        // A path outside the workspace's roots, or a git that could not be run.
        // Both mean there is nothing to compare against, which the empty left
        // side already says.
        if (alive) onReadRef.current({ path, text: null, patch: null })
      })

    return () => {
      alive = false
    }
  }, [path, generation])
}
