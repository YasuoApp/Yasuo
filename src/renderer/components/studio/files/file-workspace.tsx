import { useCallback, useEffect, useRef, useState } from "react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import {
  Columns2,
  Copy,
  ExternalLink,
  FolderTree,
  Pilcrow,
  Rows3,
  Save,
} from "lucide-react"

import { hasGitChange, useGitStatus } from "@/lib/files/git-status"
import { parentOf, relativeTo } from "@/lib/files/paths"
import { fileRootsOf, rootOfPath } from "@/lib/files/roots"
import { isDirty, useFiles, viewOf, type FileDoc } from "@/lib/files/store"
import { viewersFor, type Viewer } from "@/lib/files/viewers"
import { useSettings } from "@/lib/settings"
import { isStudioShortcut } from "@/lib/shortcuts"
import { useStudio } from "@/lib/store"
import { SECTION_ACCENT } from "../section-marks"
import { IconButton } from "../icon-button"
import { FileDiff } from "./file-diff"
import { FileEditor } from "./file-editor"
import { FileImage } from "./file-image"
import { FileImageDiff } from "./file-image-diff"
import { FileHtml } from "./file-html"
import { FileMarkdown } from "./file-markdown"
import { FileBlocks } from "./file-blocks"

/**
 * The open files, one editor each.
 *
 * Stacked and hidden rather than mounted one at a time, for the reason the
 * Notes pane stacks its editors: an editor rebuilt on every tab click is a lost
 * undo history, a caret back at line 1, the folds reset and the scroll position
 * gone. The text was never the cost — the store has it — the editing state was.
 */
export function FileWorkspace() {
  const openIds = useFiles((state) => state.openIds)
  const selectedId = useFiles((state) => state.selectedId)

  /*
   * Whether this panel is the one on screen at all.
   *
   * The workbench stacks every panel it has built and hides the rest with
   * `invisible` (see `studio.tsx`), so a file tab can be the active *file* tab
   * while the pane showing is a chat's. Both halves are needed here: "the tab
   * somebody is looking at" is the active tab **of the panel being looked at**,
   * and a panel that assumes the first implies the second has editors behaving
   * as though they were on screen when they are not.
   *
   * What that cost: a **diff** editor left live in the hidden panel went
   * on painting its own line numbers and its red and green bands through the
   * chat drawn over it. It also had a note editor in a hidden panel answering
   * the drawing event that only the visible one may answer.
   */
  const paneShown = useStudio((state) => state.pane) === "files"

  const activeId =
    selectedId && openIds.includes(selectedId) ? selectedId : null

  /*
   * ⌘S saves the file on screen.
   *
   * The editor takes the key for itself while it has focus, which is most
   * of the time and not all of it: the tree, the tab strip and this panel's own
   * header can each hold focus with a file open behind them. Claimed on the
   * capture phase and with `preventDefault`, the way the palette claims ⌘P —
   * unclaimed, Chromium reads it as "save this page" and offers to write the
   * studio to disk as HTML.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isStudioShortcut(event, "s")) return
      // Only while this panel is the one showing. The listener is on the window
      // and the panel is hidden rather than unmounted, so without this ⌘S typed
      // into a chat's composer wrote a file tab nobody could see.
      if (!activeId || !paneShown) return

      event.preventDefault()
      void useFiles.getState().save(activeId)
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }, [activeId, paneShown])

  return (
    <div className="relative h-full">
      {openIds.map((filePath) => (
        <div
          key={filePath}
          className={cn(
            "absolute inset-0",
            filePath !== activeId && "invisible"
          )}
        >
          <FilePane
            path={filePath}
            visible={filePath === activeId && paneShown}
          />
        </div>
      ))}

      {activeId === null && (
        <Empty className="absolute inset-0 size-full border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon" style={{ color: SECTION_ACCENT.files }}>
              <FolderTree />
            </EmptyMedia>
            <EmptyTitle>No file open</EmptyTitle>
            <EmptyDescription>
              Pick one from the tree on the left.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  )
}

/**
 * One open file: the header row and whichever viewer it is being shown with.
 *
 * Exported for the `Changes` tab, which draws the selected file with exactly
 * this — the same header, the same diff controls, the same ⌘S. A second copy of
 * it there would be two toolbars to keep in step, and a review view whose Save
 * button behaved slightly differently from the one on a file tab.
 *
 * `visible` is "this is the pane on screen **and** the tab it is showing", not
 * merely the latter: see `FileWorkspace`.
 *
 * `preferred` is what a file is shown as here when the reader has not said
 * otherwise — `diff` for the `Changes` tab, nothing for a file tab. It is a prop
 * rather than a write into `views` on the way in, which is what it was: writing
 * it meant the pane rendered the new path once with the *default* viewer before
 * the write landed, so clicking a row drew that file's text editor for a frame
 * and took the diff — and everything it was holding to make the switch smooth —
 * off the screen to do it.
 */
export function FilePane({
  path,
  visible,
  preferred,
}: {
  path: string
  visible: boolean
  preferred?: Viewer
}) {
  const doc = useFiles((state) => state.docs[path])
  const image = useFiles((state) => state.images[path])
  const viewer = useFiles((state) => viewOf(state, path, preferred))

  /*
   * Ask for what this pane is about to draw.
   *
   * Opening a file from the tree already reads it, but a tab can reach the
   * screen without that: restored from the last run, or picked up by `close` as
   * the neighbour of the tab that went. The pane is the one place that knows
   * which half it needs, and asking twice costs nothing — the store hands back
   * what it already holds.
   */
  useEffect(() => {
    void useFiles.getState().ensureLoaded(path, viewer)
  }, [path, viewer])
  const setText = useFiles((state) => state.setText)
  const save = useFiles((state) => state.save)

  /** A failed write, shown against the file it belongs to — a read-only file,
   * or one whose directory has gone since it was opened. */
  const [failure, setFailure] = useState<string | null>(null)

  const dirty = isDirty(doc)

  /* Which root this file is in, subscribed rather than read: a project removed
   * under an open tab has to fall back to the absolute path rather than keep
   * drawing a name relative to a root that has gone. */
  const folders = useStudio((state) => state.folders)
  const root = rootOfPath(fileRootsOf(folders), path)
  const label = (root && relativeTo(root.path, path)) || path

  const changed = useGitStatus((state) => hasGitChange(state, path))

  /*
   * Re-read the file when git's answer for its checkout moves.
   *
   * The watchers' own re-read (`syncDirs`) follows `openIds`, and the `Changes`
   * pane deliberately shows a file without giving it a tab — so a file rewritten
   * while its diff was on screen kept drawing the text it was opened at, while
   * the row beside it counted the new one. This is the same signal the list
   * re-reads off (`useWatchChanges`), so the two cannot disagree, and it works
   * for a file whose directory the tree never had open.
   *
   * Against the record it was last called for rather than on every run: the
   * store has read this file already, both on mount and on a switch to another
   * path, and a second read for the answer that was already in hand is a round
   * trip that says nothing.
   */
  const status = useGitStatus((state) =>
    root ? state.byRoot[root.id] : undefined
  )
  const read = useRef(status)
  useEffect(() => {
    if (read.current === status) return
    read.current = status
    void useFiles.getState().reload(path)
  }, [path, status])

  const write = useCallback(
    (text: string) => {
      setText(path, text)
      // The previous failure was about text that has since been typed over;
      // leaving it up would have it outlive what it was about.
      setFailure(null)
    },
    [path, setText]
  )

  const commit = useCallback(() => {
    void save(path).then(setFailure)
  }, [path, save])

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        {/* The path **relative to its project**, and the whole of it only on
            the hover line: a repository somewhere deep under `~` spends the
            first forty characters of its absolute path saying nothing about
            the file, and truncating from the left is what put `…/hhh/bbb.txt`
            in a header that had room for `bbb.txt`. Copy path and Reveal still
            deal in the absolute one, since that is what the OS and a terminal
            want. */}
        <span
          title={path}
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        >
          {label}
        </span>

        {dirty && (
          <span className="shrink-0 text-[0.65rem] text-muted-foreground">
            Unsaved
          </span>
        )}

        {/* The diff's own controls, in the row that already holds this file's:
            how the two sides are laid out and whether whitespace is drawn are
            questions about the thing on screen, and a second strip under this
            one would be two toolbars for one pane. */}
        {viewer === "diff" && <DiffControls />}

        {/* Only between these two, and only when one of them is showing. A `.md`
            can also be a preview or a block editor, and a segmented pair cannot
            say which of three is on without lying about the other two — that
            menu is the tree's right-click, which offers all of them.

            And only for a file git has something to say about: a diff of an
            unchanged file is the same text in both columns, so the switch would
            be offering a view with nothing in it. `viewer === "diff"` keeps it
            for the diff already on screen — a file committed while its diff is
            open must not lose the way back to `Edit`. An `.html` adds its
            `Preview` to the same control, since the page is the other thing
            somebody editing one keeps switching to. */}
        <ViewerSwitch path={path} viewer={viewer} changed={changed} />

        {/* Shown for every document, including the ones with no editor: a
            picture still has a path worth copying and a place in Finder worth
            opening. Save stays put rather than disappearing in the image
            view — a control that moves between viewers is one the eye has to
            find again. */}
        <IconButton
          label="Save"
          disabled={!dirty}
          onClick={commit}
          className="shrink-0"
        >
          <Save />
        </IconButton>
        <IconButton
          label="Copy path"
          onClick={() => void navigator.clipboard.writeText(path)}
          className="shrink-0"
        >
          <Copy />
        </IconButton>
        <IconButton
          label="Reveal in file manager"
          onClick={() => void window.desktop.revealPath(path)}
          className="shrink-0"
        >
          <ExternalLink />
        </IconButton>
      </div>

      {failure && (
        <p className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 font-mono text-xs text-destructive">
          {failure}
        </p>
      )}

      <div className="min-h-0 flex-1">
        {viewer === "image" && preferred === "image" ? (
          // Only the `Changes` tab prefers a picture, and there the question is
          // what changed in it rather than what it looks like now.
          <FileImageDiff
            path={path}
            image={image ?? { kind: "loading" }}
            revision={status}
          />
        ) : viewer === "image" ? (
          <FileImage image={image ?? { kind: "loading" }} alt={path} />
        ) : (
          <Body
            path={path}
            doc={doc}
            viewer={viewer}
            visible={visible}
            onChange={write}
            onSave={commit}
          />
        )}
      </div>
    </div>
  )
}

/** What the pane draws for a document — the editor, the rendered markdown, or
 * the reason there is neither. The notices below are shared by both: a file too
 * large to edit is one no preview could render either. */
function Body({
  path,
  doc,
  viewer,
  visible,
  onChange,
  onSave,
}: {
  path: string
  doc: FileDoc | undefined
  viewer: Viewer
  /** Whether this pane is the one on screen — the note editor needs it, since
   * the stacked editors share the drawing event and only the visible one may
   * answer it. */
  visible: boolean
  onChange: (text: string) => void
  onSave: () => void
}) {
  /*
   * The diff goes first, before the read has even landed, and it is the one
   * viewer that does.
   *
   * `Reading…` here is what made clicking down the `Changes` list flicker: the
   * notice replaced the diff for as long as the file took to read, so the pane
   * went diff → notice → diff, and `FileDiff` — whose whole job is to hold the
   * last diff through a switch — was unmounted by the notice and had nothing to
   * hold. So it is mounted through the read instead and told whether there is
   * anything to draw yet (`ready`), which it answers by keeping the diff that is
   * already on screen.
   *
   * `binary` and `too-large` are left to the notices below, which are honest for
   * a diff too — two versions of a megabyte of one line is not a thing to
   * render — and `error` is not, for the reason the comment further down gives.
   */
  const readable =
    doc === undefined ||
    doc.kind === "loading" ||
    doc.kind === "text" ||
    doc.kind === "error"

  if (viewer === "diff" && readable) {
    /*
     * Unmounted while it is off screen, unlike every other editor here.
     *
     * The stacking exists to keep editing state — an undo history, a caret, the
     * folds — and a diff has none of that worth keeping: the right-hand side is
     * the file's own path-keyed buffer, which the text editor holds either way,
     * so what is lost by rebuilding is a scroll position. Set against that, a
     * diff editor that is merely `invisible` was drawing its line numbers and
     * its bands over whatever pane was actually showing.
     */
    if (!visible) return null

    return (
      <FileDiff
        // Not keyed by the path, unlike every other editor here: `FileDiff`
        // keeps the diff on screen while the next file is read, and a key would
        // unmount the thing it is holding.
        path={path}
        initialText={doc?.kind === "text" ? doc.text : ""}
        // A deleted file reads as an error and is ready: its right-hand side is
        // empty and its left is what was committed, which is what its diff is.
        ready={doc !== undefined && doc.kind !== "loading"}
        // No writers: a diff takes no keystrokes, and the buffer it shows is the
        // path's own — whichever editor *can* be typed into is the one that tells
        // the store what is in it (`lib/files/documents.ts`). ⌘S is claimed by
        // the pane rather than by this editor for the same reason.
      />
    )
  }

  if (doc === undefined || doc.kind === "loading") {
    return <Notice title="Reading…" />
  }

  if (doc.kind === "binary") {
    return (
      <Notice
        title="Not a text file"
        detail="There is nothing here an editor could show without corrupting it on the way back out. Reveal it to open it in whatever does read this format."
      />
    )
  }

  if (doc.kind === "too-large") {
    return (
      <Notice
        title="Too large to open"
        detail={`${(doc.size / (1024 * 1024)).toFixed(1)} MB. Files this size are the ones that hang an editor rather than the ones somebody reads, so the studio leaves them on disk.`}
      />
    )
  }

  /*
   * The diff was drawn above this, and deliberately.
   *
   * A **deleted** file cannot be read and is exactly the file whose diff
   * somebody wants: it is a row in the Changes list, it has no row in the tree
   * at all, and "could not open this file" is the least useful thing to say
   * about it. So the right-hand side is empty and the left is what was
   * committed, which is what its diff *is*.
   *
   * Nothing to guard there any more: **the diff is read-only whatever it is
   * showing** (`codemirror-diff.tsx`), so a deleted file is a diff of a file that is
   * gone rather than a pane taking keystrokes the store would drop. Writing one
   * back would be a way to undelete it — a different feature, and not one to
   * arrive at by typing.
   */
  if (doc.kind === "error") {
    return <Notice title="Could not open this file" detail={doc.message} />
  }

  if (viewer === "markdown") return <FileMarkdown text={doc.text} path={path} />

  if (viewer === "html")
    return <FileHtml text={doc.text} dir={parentOf(path)} />

  if (viewer === "blocks") {
    return (
      <FileBlocks
        // The path is the identity here too — a renamed file is a fresh editor
        // rather than one holding a document from a name that has moved.
        key={path}
        path={path}
        // What was read, not what has been typed: the editor takes its document
        // once, and `text` is what it will be writing back.
        text={doc.text}
        onChange={onChange}
        visible={visible}
      />
    )
  }

  return (
    <FileEditor
      // The path is the identity, so a renamed file gets a new editor rather
      // than one pointed at a name that no longer exists — and with it the
      // highlighting its new extension asks for.
      key={path}
      path={path}
      // `text`, not `saved`: on the one path where an open editor is rebuilt
      // — a rename, which changes the key — what is in the buffer is what
      // should come back, not what the file held before it was typed into.
      initialText={doc.text}
      onChange={onChange}
      onSave={onSave}
    />
  )
}

/**
 * `Diff` and `Edit`, over the same `views` field the tree's "open with" writes.
 *
 * A pair of buttons rather than a toggle: which of the two is showing has to be
 * readable, and "the one that is not pressed is what you would get" is a thing
 * to work out rather than read. `Edit` goes to `text` rather than to
 * `defaultViewer` — a `.md` arrives on its preview and a `.note` on the block
 * editor, and a control labelled `Edit` beside a diff of a file's text means
 * that text.
 */
function ViewerSwitch({
  path,
  viewer,
  changed,
}: {
  path: string
  viewer: Viewer
  changed: boolean
}) {
  if (viewer !== "diff" && viewer !== "text" && viewer !== "html") return null

  const offered = viewersFor(path)
  const choices: [Viewer, string][] = [
    ...(offered.includes("html")
      ? [["html", "Preview"] as [Viewer, string]]
      : []),
    ...(offered.includes("diff") && (viewer === "diff" || changed)
      ? [["diff", "Diff"] as [Viewer, string]]
      : []),
    ["text", "Edit"],
  ]
  // `Edit` alone is a control with nothing to switch to.
  if (choices.length < 2) return null

  return (
    <div className="flex shrink-0 items-center rounded-md border p-0.5">
      {choices.map(([choice, label]) => (
        <SwitchButton
          key={choice}
          label={label}
          on={viewer === choice}
          onClick={() => void useFiles.getState().setView(path, choice)}
        />
      ))}
    </div>
  )
}

function SwitchButton({
  label,
  on,
  onClick,
}: {
  label: string
  on: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-5 rounded-[0.25rem] px-2 text-[0.7rem] transition-colors",
        on
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  )
}

/**
 * How the diff is drawn: two columns or one, and whitespace or not.
 *
 * Both are `useSettings`, so the choice outlives this tab and this launch — how
 * somebody reads a diff is not a property of the file they happen to have open.
 *
 * The layout pair is segmented with the current one lit, rather than one button
 * that swaps its icon: a single icon has to stand either for the mode you are in
 * or for the mode you would get, and whichever it means, half the people reading
 * it will take it for the other. `pressed` on `IconButton` is only
 * `aria-pressed` — it says so to a screen reader and nothing to the eye — which
 * is why the on state here is drawn.
 */
function DiffControls() {
  const sideBySide = useSettings((state) => state.diffSideBySide)
  const setSideBySide = useSettings((state) => state.setDiffSideBySide)
  const whitespace = useSettings((state) => state.diffWhitespace)
  const setWhitespace = useSettings((state) => state.setDiffWhitespace)

  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className="flex items-center rounded-md border p-0.5">
        <IconButton
          label="Inline"
          pressed={!sideBySide}
          className={cn("size-5", !sideBySide && ON)}
          onClick={() => setSideBySide(false)}
        >
          <Rows3 />
        </IconButton>
        <IconButton
          label="Side by side"
          pressed={sideBySide}
          className={cn("size-5", sideBySide && ON)}
          onClick={() => setSideBySide(true)}
        >
          <Columns2 />
        </IconButton>
      </div>

      <IconButton
        label="Show whitespace"
        pressed={whitespace}
        className={cn("shrink-0", whitespace && ON)}
        onClick={() => setWhitespace(!whitespace)}
      >
        <Pilcrow />
      </IconButton>
    </div>
  )
}

/** What a toggle in this row looks like while it is on. */
const ON = "bg-accent text-accent-foreground"

function Notice({ title, detail }: { title: string; detail?: string }) {
  return (
    <Empty className="size-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon" style={{ color: SECTION_ACCENT.files }}>
          <FolderTree />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {detail && <EmptyDescription>{detail}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  )
}
