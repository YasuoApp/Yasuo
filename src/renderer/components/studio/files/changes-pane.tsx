import { useEffect } from "react"
import { FolderGit2 } from "lucide-react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useChanges } from "@/lib/files/changes"
import { fileRootsOf } from "@/lib/files/roots"
import { useFiles } from "@/lib/files/store"
import { isStudioShortcut } from "@/lib/shortcuts"
import { useStudio } from "@/lib/store"
import { SECTION_ACCENT } from "../section-marks"
import { FilePane } from "./file-workspace"

/**
 * The diff of whichever changed file the Explorer's `Changes` tab has picked.
 *
 * One tab per checkout, and the tab's id is the root's — so it is in the strip
 * exactly while that checkout is the one being worked in
 * (`rootOf` in `lib/panels.ts`). One tab and not one per file: that is what a
 * pane of its own buys, and it is why the list in the sidebar is allowed to be
 * a list again. The sidebar list this replaced opened a **file** tab per row,
 * so a turn's twelve changed files left twelve tabs to close.
 *
 * The list itself is not here. It was, for as long as the Explorer's header was
 * a title — the pane held the list and the diff side by side, because there was
 * nowhere else to put the list. There is now (`All files | Changes`), and a list
 * in both places is one question answered twice.
 *
 * What is drawn is `FilePane` — the same component a file tab draws, so the
 * header, the diff controls, `Diff | Edit` and ⌘S are the ones somebody has
 * already learnt, rather than a second set that would drift from them. It reads
 * the file through the files store without putting it in `openIds`, which is
 * what keeps reviewing from spawning tabs.
 */
export function ChangesPane() {
  const openIds = useChanges((state) => state.openIds)
  const selectedId = useChanges((state) => state.selectedId)
  const rootId = selectedId && openIds.includes(selectedId) ? selectedId : null

  // The store's list rather than `fileRoots()`, which is a snapshot: this is
  // the render that has to notice a project leaving under the tab.
  const folders = useStudio((state) => state.folders)
  const root = fileRootsOf(folders).find((candidate) => candidate.id === rootId)

  const path = useChanges((state) =>
    rootId ? (state.selectedPath[rootId] ?? null) : null
  )
  const count = useChanges((state) =>
    rootId ? state.byRoot[rootId]?.length : undefined
  )

  // Whether this pane is the one on screen — what `FilePane` needs to know
  // before it builds an editor. See `FileWorkspace` for why the tab being active
  // is not the same question.
  const shown = useStudio((state) => state.pane) === "changes"

  /*
   * ⌘S saves the file this pane is reading.
   *
   * Here rather than in the editor, which is where it was. Monaco's diff took
   * the key itself — the widget was focusable even read-only, so a command bound
   * on it fired — and CodeMirror's read-only merge view is genuinely not
   * editable, so nothing in it holds focus to bind a key on. This is the same
   * claim `FileWorkspace` makes for a file tab, in the pane that knows which
   * path is on screen: the file can be dirty from its `Edit` view, and ⌘S is
   * muscle memory rather than a property of the pane it was pressed in.
   *
   * On the capture phase and with `preventDefault`, the way the palette claims
   * ⌘P — unclaimed, Chromium reads it as "save this page" and offers to write
   * the studio to disk as HTML.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isStudioShortcut(event, "s")) return
      if (!path || !shown) return

      event.preventDefault()
      void useFiles.getState().save(path)
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }, [path, shown])

  if (!root) {
    return (
      <Notice
        title="That project has gone"
        detail="The project this tab was opened for is no longer in the workspace. Close the tab, or pick a file under Changes in the Explorer."
      />
    )
  }

  return path ? (
    <FilePane path={path} visible={shown} preferred="diff" />
  ) : (
    <Notice
      title="Nothing selected"
      detail={
        count
          ? "Pick a file under Changes in the Explorer to read what changed in it."
          : "Nothing has changed in this checkout."
      }
    />
  )
}

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <Empty className="size-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon" style={{ color: SECTION_ACCENT.files }}>
          <FolderGit2 />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
