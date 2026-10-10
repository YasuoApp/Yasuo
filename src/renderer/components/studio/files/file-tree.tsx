import { useEffect, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import {
  BookOpen,
  Globe,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCode,
  FileText,
  Image,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  NotebookPen,
  Pencil,
  RotateCw,
  Trash2,
} from "lucide-react"

import type { FileEntry, WorkspaceFolder } from "@shared/api"
import { changeCount, useChanges, useWatchChanges } from "@/lib/files/changes"
import { isDirty, useFiles, viewOf } from "@/lib/files/store"
import {
  gitStateOf,
  GIT_LABELS,
  GIT_LETTERS,
  GIT_TONES,
  useGitStatus,
} from "@/lib/files/git-status"
import { iconFor } from "@/lib/files/icons"
import {
  isImage,
  isNote,
  noteFileName,
  viewerLabel,
  viewersFor,
  type Viewer,
} from "@/lib/files/viewers"
import { useProjects } from "@/lib/projects"
import { shownRootOf } from "@/lib/files/roots"
import { relativeTo } from "@/lib/files/paths"
import { useStudio } from "@/lib/store"
import { RenameDialog } from "../rename-dialog"
import { IconButton } from "../icon-button"
import { RenameRow, useMenuFocusHandoff } from "../rename-row"
import { SideRow } from "../side-row"
import { ChangesList } from "./changes-list"
import { CommitsList } from "./commits-list"

/** What the right-click menu is about: a row in the tree, or the workspace
 * folder heading above one. */
/** What the tree's own menu is over: a row, or the empty space under the last
 * one. The root has a menu of its own, on the bar above the list — see
 * `RootMenu`. */
type MenuTarget = { kind: "entry"; entry: FileEntry }

/** A pending "name this" dialog: a new file, note or folder inside `dir`. */
type Creating = { dir: string; kind: "file" | "directory" | "note" }

/**
 * What the dialog says for each of the three.
 *
 * A table rather than three conditionals threaded through the same JSX: a note
 * made "file or folder" into a third case, and the wording is the only thing
 * that differs between them.
 */
const CREATING_WORDS: Record<
  Creating["kind"],
  { title: string; label: string }
> = {
  file: { title: "New file", label: "File name" },
  directory: { title: "New folder", label: "Folder name" },
  note: { title: "New note", label: "Note name" },
}

function failureOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/**
 * The workspace's folders, as directories.
 *
 * The other sidebars list records this app owns — a request, a note, a saved
 * query — and can therefore file them however they like. This one lists what is
 * actually on disk, so its shape is not the studio's to choose: the tree is the
 * directory tree, and a folder is read one level at a time, as it is opened. A
 * repository holds far more files than anybody wants listed, and the ones under
 * a folded directory are ones nobody has asked about.
 *
 * What is expanded is watched, and nothing else is — one non-recursive watcher
 * per open directory, closed again when the row is folded (`main/watch.ts`). A
 * watcher over a whole repository would be a `node_modules` of file handles and
 * a rebuild of the tree on every `npm install`; this costs a handle per row
 * somebody is looking at. Refresh is still in the header, for the filesystems
 * `fs.watch` is quiet on. What is never silently overwritten either way is an
 * edit: only the files with nothing unsaved in them are re-read.
 *
 * The rows are coloured by what git says about them — new, modified, ignored —
 * from one `git status` per folder (`lib/files/git-status.ts`). A tracked file
 * with no changes is the ordinary row and has no colour of its own.
 *
 * **The folders are this panel's, and only this panel's.** Adding, renaming and
 * removing one used to live in the Terminal sidebar as well, which drew the
 * same folder list a second time to hang the same three actions off it — so a
 * workspace of three folders with one session running redrew this sidebar over
 * there with a single extra row in it, and "where do I remove a folder" had two
 * answers. This is the list that says what the workspace is pointed at, so it
 * is the one that changes it. The File menu opens the same Add folder dialog,
 * which is what a rail with this section hidden falls back to.
 *
 * **Nothing here starts a terminal.** A folder's menu used to hold
 * `New session here…`, and there was a Sessions list under the tree; both are
 * gone with the panel they opened into. A shell is a tab of the dock now,
 * pointed at whichever project was last clicked in the left column, so the one
 * place to open one is the one place it can be — and a menu item that put a
 * shell in a corner of another column would be a menu item nobody could find
 * the result of.
 */
export function FileTree({ onAddFolder }: { onAddFolder: () => void }) {
  const folders = useStudio((state) => state.folders)
  const renameFolder = useStudio((state) => state.renameFolder)
  const removeFolder = useStudio((state) => state.removeFolder)

  /** The one root drawn: the project being worked in. Subscribed to both
   * stores rather than read through `shownRoot`, since this is the render that
   * has to follow a row being clicked in the left column. */
  const activeFolderId = useProjects((state) => state.activeFolderId)
  const shown = shownRootOf(folders, activeFolderId)
  const folder = folders.find((entry) => entry.id === shown?.folderId) ?? null

  const expanded = useFiles((state) => state.expanded)
  const refresh = useFiles((state) => state.refresh)

  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null)
  const [creating, setCreating] = useState<Creating | null>(null)
  const [trashing, setTrashing] = useState<FileEntry | null>(null)
  const menuFocus = useMenuFocusHandoff()
  const [renamingFolder, setRenamingFolder] = useState<WorkspaceFolder | null>(
    null
  )
  const [removingFolder, setRemovingFolder] = useState<WorkspaceFolder | null>(
    null
  )

  /*
   * The root is read and watched without being a row.
   *
   * `expanded` is what the tree reads and what `main/watch.ts` watches, and
   * every other directory joins it by being clicked. This one has no row to
   * click — it *is* the list — so it is put there whenever it is not, which
   * also covers Collapse all: that clears the set, and a tree whose own root
   * had been collapsed out of it would be a blank panel with no way back.
   */
  const rootPath = shown?.path ?? null
  const rootRead = rootPath !== null && expanded.includes(rootPath)
  useEffect(() => {
    if (rootPath !== null && !rootRead) useFiles.getState().toggle(rootPath)
  }, [rootPath, rootRead])

  /** Which of the two tabs is showing, and what the other one has to say for
   * itself. The count is read for the project on screen whichever tab that is,
   * so `Changes 12` is true before it is clicked — which is the whole use of a
   * number on a tab. */
  const tab = useStudio((state) => state.explorerTab)
  const setTab = useStudio((state) => state.setExplorerTab)
  const gitView = useStudio((state) => state.gitView)
  const setGitView = useStudio((state) => state.setGitView)
  // Files, not rows: a file staged and then edited again is two rows in the
  // list below and one file here.
  const changes = useChanges((state) =>
    shown ? state.byRoot[shown.id] : undefined
  )
  const changed = changes === undefined ? undefined : changeCount(changes)
  useWatchChanges(shown)

  return (
    <ContextMenu>
      <div className="flex h-full flex-col">
        {/* Two tabs where the panel's title used to be.
            `Explorer` named the panel to somebody already looking at it, and
            the space is worth more as the way in to the other list this panel
            has: what the project has changed, which after an agent's turn is
            the only question being asked. The names are Conductor's, since this
            is Conductor's column. */}
        {/* `pr-11` rather than `pr-2`: the column's collapse button is
            positioned over the right of this row (`explorer-rail.tsx`), and it
            is out of flow, so the room for it has to be left here. */}
        <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-11 pl-1.5">
          {/* `overflow-hidden` is the safety valve: with one button beside
              them the two tabs fit the panel's minimum with room to spare,
              and a sidebar dragged narrower than that clips them rather than
              pushing Refresh off the end. */}
          <div
            role="tablist"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
          >
            <ExplorerTabButton
              active={tab === "files"}
              onClick={() => setTab("files")}
              label="All files"
            />
            {/* The count rides on `Git` too, so `Git 12` is true before it is
                clicked — and on whichever view is showing inside it. */}
            <ExplorerTabButton
              active={tab === "git"}
              onClick={() => setTab("git")}
              label="Git"
              count={changed}
            />
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {/* **Refresh is the only one left**, and the rule it stands for
                still holds: a row of icons beside two tabs is a row of icons
                nobody reads, so every action about a *thing* is on a menu over
                that thing — `New file` and `Collapse all` on the root bar's menu
                (or a directory row's, which creates in *that* directory),
                `Add folder` on the empty space under the tree and in the File
                menu. It is now the **only** one: this header carried three more
                for a while — the two arrows that walked the comments and a
                Discard for the whole pile — and they are gone with the
                comments themselves. Refresh is the one that is about the panel
                itself, and the filesystems `fs.watch` is quiet on are why it
                exists at all. */}
            <IconButton
              label="Refresh"
              disabled={folders.length === 0}
              // Both halves of what a row shows: what is on disk, and what git
              // says about it. One button, since "this is out of date" is one
              // thought — and the changed-file list re-reads off the git half,
              // so this is its Refresh too.
              onClick={() => {
                void refresh()
                void useGitStatus.getState().refreshAll()
              }}
            >
              <RotateCw />
            </IconButton>
          </div>
        </div>

        {/* The changed files, when that is the tab.
            Their own scroller and **outside** the tree's context menu: the rows
            there open a diff, and a right-click offering `Add folder…` over
            them would be the workspace's menu on a list that is not about the
            workspace. The changed-file list carries its own menu — Stage,
            Unstage, Discard — inside this scroller. */}
        {tab === "git" ? (
          <>
            {/* The `Git` tab's two views, a row under the tab that holds them:
                what has changed, and what has been committed. */}
            <div
              role="tablist"
              className="flex h-8 shrink-0 items-center gap-0.5 border-b px-1.5"
            >
              <ExplorerTabButton
                active={gitView === "changes"}
                onClick={() => setGitView("changes")}
                label="Changes"
                count={changed}
              />
              <ExplorerTabButton
                active={gitView === "commits"}
                onClick={() => setGitView("commits")}
                label="Commits"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto pb-3">
              {shown &&
                (gitView === "commits" ? (
                  <CommitsList root={shown} />
                ) : (
                  <ChangesList root={shown} />
                ))}
            </div>
          </>
        ) : (
          /* One trigger over the whole tree, rather than one per row: the rows
             are a recursive component, and a trigger inside a trigger inside a
             trigger is a menu nobody can predict the target of. Each row says
             what it is instead, on the way past. */
          <ContextMenuTrigger
            render={
              <div
                className="min-h-0 flex-1 overflow-auto pb-3"
                onContextMenu={(event) => {
                  // Only the empty space below the last row: a row of its own
                  // has already set the target by the time this is reached.
                  if (event.target === event.currentTarget) setMenuTarget(null)
                }}
              />
            }
          >
            {/* No heading over the list, and no row for the root itself. The
                tree is one project's files, so a row saying which one would be
                a row every file is indented under for no answer it gives —
                which project and which branch is the bar above, where it can be
                read with the list scrolled. */}
            {shown && folder ? (
              <Directory
                dir={shown.path}
                depth={0}
                onMenu={(entry) => setMenuTarget({ kind: "entry", entry })}
              />
            ) : (
              /* A workspace pointed at nothing used to draw an empty list and
                 say nothing, because `Add folder` was a button in the header
                 directly above it. It is not any more, and a blank column whose
                 only way forward is a right-click is a dead end — so the way in
                 is drawn where the files would have been. Only for a workspace
                 with no folders at all: a folder that is merely empty has a
                 root bar above it saying which one it is. */
              folders.length === 0 && (
                <Empty className="border-0 py-8">
                  <EmptyHeader>
                    <EmptyTitle className="text-sm">No folders yet</EmptyTitle>
                    <EmptyDescription>
                      Point the workspace at a directory on this machine.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button size="sm" variant="outline" onClick={onAddFolder}>
                      <FolderPlus />
                      Add folder…
                    </Button>
                  </EmptyContent>
                </Empty>
              )
            )}
          </ContextMenuTrigger>
        )}

        {creating && (
          <RenameDialog
            title={CREATING_WORDS[creating.kind].title}
            description={
              <>
                Inside <code className="font-mono">{creating.dir}</code>.
              </>
            }
            label={CREATING_WORDS[creating.kind].label}
            currentName=""
            submitLabel="Create"
            pendingLabel="Creating…"
            onRename={async (name) => {
              const { create, createFolder } = useFiles.getState()
              try {
                if (creating.kind === "directory") {
                  await createFolder(creating.dir, name)
                } else {
                  // A note is an ordinary empty file with the extension that
                  // opens it in the note editor — the pane draws an empty
                  // document for one, so there is nothing to write into it.
                  await create(
                    creating.dir,
                    creating.kind === "note" ? noteFileName(name) : name
                  )
                }
                return null
              } catch (error) {
                return failureOf(error, "Could not create that.")
              }
            }}
            onClose={() => setCreating(null)}
          />
        )}

        {renamingFolder && (
          <RenameDialog
            title="Rename folder"
            description={
              <>
                Only what the studio calls it. The directory —{" "}
                <code className="font-mono">{renamingFolder.path}</code> — keeps
                its own name.
              </>
            }
            label="Folder name"
            currentName={renamingFolder.name}
            onRename={async (name) => {
              try {
                await renameFolder(renamingFolder.id, name)
                return null
              } catch (error) {
                return failureOf(error, "Could not rename that folder.")
              }
            }}
            onClose={() => setRenamingFolder(null)}
          />
        )}
      </div>

      {/* The empty space under the tree is **the root's** menu.
          It was the bar above the list — the project's name, its branch and a
          checkout picker — and the bar is gone: the left column already lists
          every project and says which one is selected, so
          a strip repeating it was a row of chrome answering a question that was
          already on screen. What the bar carried had to go somewhere, and the
          empty space under the last row is the only part of this panel that is
          about the project as a whole rather than about a file in it. It acts
          on the project being read — a new file lands in the branch on
          screen — while Rename and Remove are about the workspace's record of
          the **project** being read. */}
      {menuTarget === null &&
        (shown && folder ? (
          <RootMenu
            folder={folder}
            path={shown.path}
            expanded={expanded.length > 1}
            onCreate={(kind) => setCreating({ dir: shown.path, kind })}
            onRename={() => setRenamingFolder(folder)}
            onRemove={() => setRemovingFolder(folder)}
            onAddFolder={onAddFolder}
          />
        ) : (
          <ContextMenuContent className="w-52">
            <ContextMenuItem onClick={onAddFolder}>
              <FolderPlus />
              Add folder…
            </ContextMenuItem>
          </ContextMenuContent>
        ))}

      {menuTarget?.kind === "entry" && (
        <ContextMenuContent
          className="w-52"
          // Rename hands focus to the field it opens — see `useMenuFocusHandoff`.
          finalFocus={menuFocus.finalFocus}
        >
          {/* Only where there is a choice to make — an SVG, a `.md` and a
              `.note` are the files the studio can honestly draw more than one
              way; offering the menu on a `.ts` would be offering the same thing
              twice. */}
          {menuTarget.entry.kind === "file" &&
            viewersFor(menuTarget.entry.path).length > 1 && (
              <>
                <ContextMenuGroup>
                  {/* Base UI throws for a label outside the group it names. */}
                  <ContextMenuLabel>Open with</ContextMenuLabel>
                  <OpenWith path={menuTarget.entry.path} />
                </ContextMenuGroup>
                <ContextMenuSeparator />
              </>
            )}
          {menuTarget.entry.kind === "directory" && (
            <>
              <ContextMenuItem
                onClick={() =>
                  setCreating({ dir: menuTarget.entry.path, kind: "file" })
                }
              >
                <FilePlus />
                New file…
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() =>
                  setCreating({ dir: menuTarget.entry.path, kind: "note" })
                }
              >
                <NotebookPen />
                New note…
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() =>
                  setCreating({ dir: menuTarget.entry.path, kind: "directory" })
                }
              >
                <FolderPlus />
                New folder…
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            onClick={() =>
              void navigator.clipboard.writeText(menuTarget.entry.path)
            }
          >
            <Copy />
            Copy path
          </ContextMenuItem>
          {shown && (
            <ContextMenuItem
              onClick={() =>
                void navigator.clipboard.writeText(
                  relativeTo(shown.path, menuTarget.entry.path)
                )
              }
            >
              <Copy />
              Copy relative path
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={() =>
              void window.desktop.revealPath(menuTarget.entry.path)
            }
          >
            <ExternalLink />
            Reveal in file manager
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              menuFocus.handOff()
              useFiles.getState().beginRename(menuTarget.entry.path)
            }}
          >
            <Pencil />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => setTrashing(menuTarget.entry)}
          >
            <Trash2 />
            Move to trash…
          </ContextMenuItem>
        </ContextMenuContent>
      )}

      <AlertDialog
        open={trashing !== null}
        onOpenChange={(next) => {
          if (!next) setTrashing(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move “{trashing?.name}” to the trash?
            </AlertDialogTitle>
            {/* Says where it goes rather than "this cannot be undone", because
                it can: the OS trash is the undo, which is the whole reason
                this is not an `unlink`. */}
            <AlertDialogDescription>
              {trashing?.kind === "directory"
                ? "The folder and everything in it goes to the system trash, and any tabs open on those files close."
                : "It goes to the system trash, and its tab closes."}{" "}
              You can put it back from there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (trashing) {
                  void useFiles
                    .getState()
                    .trash(trashing.path)
                    .catch((error: unknown) => {
                      console.error("Could not move that to the trash", error)
                    })
                }
                setTrashing(null)
              }}
            >
              Move to trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={removingFolder !== null}
        onOpenChange={(next) => {
          if (!next) setRemovingFolder(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this folder?</AlertDialogTitle>
            {/*
              Both consequences, because this is now the only place a folder is
              removed from: the tabs are this panel's own, and the sessions are
              killed by the terminal store's subscription to the folder list. The
              Terminal sidebar's dialog used to be the one that mentioned them.
              And the folder is the user's own — a dialog that left that in doubt
              would be asking them to gamble a repository on it.
            */}
            <AlertDialogDescription>
              “{removingFolder?.name}” is removed from the workspace, along with
              any tabs open on files inside it and any terminal sessions running
              in it. The folder itself —{" "}
              <code className="font-mono">{removingFolder?.path}</code> — is
              left exactly as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removingFolder) void removeFolder(removingFolder.id)
                setRemovingFolder(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ContextMenu>
  )
}

/**
 * One of the Explorer's tabs, or one of the `Git` tab's two views inside it.
 *
 * Not the workbench's `TabStrip`, and not shadcn's `Tabs`: those are about
 * things somebody opened and can close, and these are two fixed views of one
 * project. What it borrows instead is the treatment `SideRow` gives a selected
 * row, so a tab and the row under it read as the same kind of "this is the one".
 */
function ExplorerTabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      {/* Nothing at all at zero, and nothing before the first read: a badge
          saying `0` has to be read to learn there is nothing to read. */}
      {count !== undefined && count > 0 && (
        <span className="font-mono text-[0.65rem] tabular-nums opacity-70">
          {count}
        </span>
      )}
    </button>
  )
}

/**
 * The viewers a file can be opened with, as a radio group.
 *
 * Its own component so the current choice is read from the store rather than
 * captured when the menu opened: picking one leaves the menu on screen for the
 * blink before it closes, and a stale tick in that moment reads as a click that
 * did not land.
 */
function OpenWith({ path }: { path: string }) {
  const current = useFiles((state) => viewOf(state, path))

  return (
    <ContextMenuRadioGroup
      value={current}
      onValueChange={(value) => {
        void useFiles.getState().setView(path, value as Viewer)
        // Opened as well as switched: the menu is reachable from a row that is
        // not the one on screen, and choosing a viewer for it plainly means
        // "show me this".
        void useFiles.getState().open(path)
      }}
    >
      {viewersFor(path).map((viewer) => (
        <ContextMenuRadioItem key={viewer} value={viewer}>
          <ViewerIcon viewer={viewer} />
          {viewerLabel(viewer, path)}
        </ContextMenuRadioItem>
      ))}
    </ContextMenuRadioGroup>
  )
}

function ViewerIcon({ viewer }: { viewer: Viewer }) {
  const Icon =
    viewer === "image"
      ? Image
      : viewer === "markdown"
        ? BookOpen
        : viewer === "html"
          ? Globe
          : viewer === "blocks"
            ? NotebookPen
            : FileCode
  return <Icon className="text-muted-foreground" />
}

/**
 * One directory's rows, and the open directories under it.
 *
 * Recursive rather than a flattened list because the shape it draws is
 * recursive and nothing here needs the flat one: the tree has no keyboard
 * navigation across rows, and every row's indent is its own depth.
 */
/**
 * The menu on the bar above the tree: the project being read, and the project
 * it belongs to.
 *
 * Split that way on purpose. `New file…`, `Refresh`, `Copy path` and `Reveal`
 * act on the **directory on screen**, which is the project — a file made here
 * while a branch is being read belongs to that branch. `Rename…` and
 * `Remove folder…` act on the workspace's record of the **project**: what the
 * studio calls it, and whether it is pointed at it at all, neither of which is
 * a property of one of its copies.
 */
function RootMenu({
  folder,
  path,
  expanded,
  onCreate,
  onRename,
  onRemove,
  onAddFolder,
}: {
  folder: WorkspaceFolder
  /** The directory being read — the project folder's own path. */
  path: string
  /** Whether anything is open below the root, which is what `Collapse all` has
   * to do. The root itself is always in the set — it is read without being a
   * row — so the count rather than the set is what the panel hands down. */
  expanded: boolean
  onCreate: (kind: Creating["kind"]) => void
  onRename: () => void
  onRemove: () => void
  onAddFolder: () => void
}) {
  return (
    <ContextMenuContent className="w-52">
      <ContextMenuItem onClick={() => onCreate("file")}>
        <FilePlus />
        New file…
      </ContextMenuItem>
      {/* Beside New file rather than in a group of its own: a note is a file in
          this folder like any other, and what it opens in is what the extension
          says. */}
      <ContextMenuItem onClick={() => onCreate("note")}>
        <NotebookPen />
        New note…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCreate("directory")}>
        <FolderPlus />
        New folder…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void useFiles.getState().read(path)}>
        <RotateCw />
        Refresh
      </ContextMenuItem>
      {/* Where the header button went. It is about the tree rather than about
          this project's files, but this menu is the one the tree has — and a
          button for it beside the tabs was a button that got used once. */}
      <ContextMenuItem
        disabled={!expanded}
        onClick={() => useFiles.getState().collapseAll()}
      >
        <ChevronDown />
        Collapse all
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void navigator.clipboard.writeText(path)}>
        <Copy />
        Copy path
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void window.desktop.revealPath(path)}>
        <ExternalLink />
        Reveal in file manager
      </ContextMenuItem>
      <ContextMenuSeparator />
      {/* The workspace's own action, at the end and under a rule: everything
          above is about this project, and this one is about which projects
          there are. */}
      <ContextMenuItem onClick={onAddFolder}>
        <FolderPlus />
        Add folder…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onRename}>
        <Pencil />
        Rename…
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={onRemove}>
        <Trash2 />
        Remove {folder.name}…
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

function Directory({
  dir,
  depth,
  onMenu,
}: {
  dir: string
  depth: number
  onMenu: (entry: FileEntry) => void
}) {
  const entries = useFiles((state) => state.entries[dir])
  const error = useFiles((state) => state.errors[dir])
  const loading = useFiles((state) => state.loading.includes(dir))

  if (error) {
    return (
      <p
        style={{ paddingLeft: `${depth * 0.75 + 0.75}rem` }}
        className="py-1 pr-2 text-xs text-destructive"
      >
        {error}
      </p>
    )
  }

  // Nothing at all until the first listing lands, rather than a row that says
  // so: a directory on a local disk is read faster than a placeholder can be
  // read, and one that flickers past is worse than none.
  if (entries === undefined) {
    if (!loading) return null
    return (
      <p
        style={{ paddingLeft: `${depth * 0.75 + 0.75}rem` }}
        className="py-1 pr-2 text-xs text-muted-foreground/70"
      >
        Reading…
      </p>
    )
  }

  if (entries.length === 0) {
    return (
      <p
        style={{ paddingLeft: `${depth * 0.75 + 0.75}rem` }}
        className="py-1 pr-2 text-xs text-muted-foreground/70"
      >
        Empty
      </p>
    )
  }

  return (
    <ul>
      {entries.map((entry) => (
        <Row key={entry.path} entry={entry} depth={depth} onMenu={onMenu} />
      ))}
    </ul>
  )
}

function Row({
  entry,
  depth,
  onMenu,
}: {
  entry: FileEntry
  depth: number
  onMenu: (entry: FileEntry) => void
}) {
  const open = useFiles((state) => state.expanded.includes(entry.path))
  const active = useFiles((state) => state.selectedId === entry.path)
  const renaming = useFiles((state) => state.renaming === entry.path)
  // Marked on the row as well as on the tab: the tree is where somebody looks
  // to find the file they were editing, and a strip with fifteen tabs in it is
  // not.
  const dirty = useFiles((state) => isDirty(state.docs[entry.path]))
  // A string or null rather than the store's own record, so a row re-renders
  // when *its* file's state changes and not when any file's does.
  const git = useGitStatus((state) => gitStateOf(state, entry.path))

  const directory = entry.kind === "directory"
  const Icon = directory
    ? open
      ? FolderOpen
      : Folder
    : isImage(entry.path)
      ? Image
      : // The same glyph the Notes sidebar draws a note with, so a note reads
        // as one wherever it is listed. `NotebookPen` is the panel's mark, not
        // a note's.
        isNote(entry.path)
        ? FileText
        : File
  // A vendored file-type icon where there is one, and the Lucide glyph above
  // otherwise — so a coloured icon reads as "a kind of file the studio knows"
  // rather than as decoration. Folders keep the glyph either way: they are the
  // tree's structure, and forty coloured folder icons would compete with the
  // files they hold.
  const iconUrl = directory ? null : iconFor(entry.path)
  const Chevron = open ? ChevronDown : ChevronRight

  /* The row's own left-hand side, drawn the same whether the right of it is the
     name or a field being typed into — so the field opens exactly where the name
     was rather than a few pixels off it. */
  const lead = (
    <>
      {/* A file has no chevron but keeps its width, so names line up down a
          mixed listing rather than stepping in and out. */}
      {directory ? (
        <Chevron className="size-3.5 shrink-0" />
      ) : (
        <span aria-hidden className="size-3.5 shrink-0" />
      )}
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          aria-hidden
          // The icon recedes with the name for an ignored row: a full-colour
          // TypeScript logo beside a greyed `dist/bundle.ts` would be the
          // brightest thing in the subtree it is meant to play down.
          className={cn("size-3.5 shrink-0", git === "ignored" && "opacity-40")}
        />
      ) : (
        <Icon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            git === "ignored" && "opacity-60"
          )}
        />
      )}
    </>
  )

  if (renaming) {
    return (
      <li>
        <RenameRow
          name={entry.name}
          indent={depth}
          // A directory's dot is part of its name; a file's is its extension.
          selection={directory ? "all" : "stem"}
          label={directory ? "Folder name" : "File name"}
          lead={lead}
          onRename={async (name) => {
            try {
              await useFiles.getState().rename(entry.path, name)
              useFiles.getState().endRename()
              return null
            } catch (error) {
              return failureOf(error, "Could not rename that.")
            }
          }}
          onCancel={() => useFiles.getState().endRename()}
        />
        {directory && open && (
          <Directory dir={entry.path} depth={depth + 1} onMenu={onMenu} />
        )}
      </li>
    )
  }

  return (
    <li>
      <SideRow
        active={active}
        indent={depth}
        // The state in words as well as in colour: the hover line is the only
        // thing that says what a green name means to somebody who has not
        // learnt the palette, or who cannot see it.
        title={git ? `${entry.path} — ${GIT_LABELS[git]}` : entry.path}
        // A single click on a file is a **look**: the tab it opens is the
        // preview one, in italics, and the next look takes its place rather
        // than adding a tab beside it. Reading through a repository was the
        // thing that left fifteen tabs nobody had asked for.
        onClick={() =>
          directory
            ? useFiles.getState().toggle(entry.path)
            : void useFiles.getState().open(entry.path, { preview: true })
        }
        // And a double click keeps it. The first of the two clicks has already
        // opened it, so this only has to promote what is on screen.
        onDoubleClick={
          directory ? undefined : () => useFiles.getState().keep(entry.path)
        }
        onContextMenu={() => onMenu(entry)}
      >
        {lead}
        <span
          className={cn(
            "truncate",
            dirty && "italic",
            // Git's colour, and only where git has something to say — a
            // tracked file with no changes is the ordinary row and stays the
            // sidebar's own foreground.
            git && GIT_TONES[git]
          )}
        >
          {entry.name}
        </span>
        {(dirty || (git && GIT_LETTERS[git])) && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
            {dirty && (
              <span
                aria-label="Unsaved changes"
                className="size-1.5 rounded-full bg-foreground/60"
              />
            )}
            {/* Git's own letter, at the end of the row the way every editor
                draws it. `aria-hidden` because the row's hover line already
                says the state in words, and a bare "M" read out is worse than
                nothing. */}
            {git && GIT_LETTERS[git] && (
              <span
                aria-hidden
                className={cn("text-[0.7rem] leading-none", GIT_TONES[git])}
              >
                {GIT_LETTERS[git]}
              </span>
            )}
          </span>
        )}
      </SideRow>

      {directory && open && (
        <Directory dir={entry.path} depth={depth + 1} onMenu={onMenu} />
      )}
    </li>
  )
}
