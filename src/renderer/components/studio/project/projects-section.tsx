import { useState } from "react"
import {
  Columns3,
  Folder,
  FolderOpen,
  GraduationCap,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  ShieldQuestion,
  Trash2,
} from "lucide-react"

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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { useBoard } from "@/lib/board/store"
import { useProjects } from "@/lib/projects"
import { useStudio } from "@/lib/store"
import { IconButton } from "../icon-button"
import { RenameRow, useMenuFocusHandoff } from "../rename-row"
import { SideRow } from "../side-row"
import { DistillDialog } from "../worktree/distill-dialog"
import { useShells } from "@/lib/shell/store"
import {
  chatsOf,
  ungroupedChats,
  useWorktreeChats,
} from "@/lib/worktree-chat/store"
import type { WorkspaceFolder, WorktreeChat } from "@shared/api"
import { since } from "@/lib/worktree-chat/since"
import {
  activityLabel,
  activityOf,
  activityTitle,
  isRunning,
  type ChatActivity,
} from "@/lib/worktree-chat/running"
import { unreadIn } from "@/lib/worktree-chat/unread"

/**
 * The chats this column lists: the ones that are on disk.
 *
 * A `+` opens a tab before anything has been said in it — the chat is held in
 * `unsaved` until its first message writes it down. The strip is what is open
 * in this run and so shows it at once; this column is where a conversation from
 * last week is found again, and a row for a chat that will leave no file if the
 * tab is shut is a row that disappears without anybody deleting it.
 */
function saved(chats: WorktreeChat[], unsaved: string[]): WorktreeChat[] {
  if (unsaved.length === 0) return chats
  return chats.filter((chat) => !unsaved.includes(chat.id))
}

/**
 * The workspace's projects, and the chats held in each.
 *
 * One of the four sections the left column stacks — see `WorkspaceSidebar` for
 * why the other three are beside it rather than behind tabs on the right. It
 * carries no `Search` row and no settings button any more: those belong to the
 * column, not to this section, and a row that lived in whichever section
 * happened to be first was a row in the wrong place.
 *
 * A project's rows used to be its `git worktree` checkouts, with the chats
 * hidden a level below them — one row per branch, and no way to see from this
 * column what conversations a project actually held. That layer is gone, and
 * what a project opens onto is the thing the column was always navigating to:
 * its chats, listed, so a conversation from last week is one click rather than
 * a tab strip somebody has to remember opening.
 *
 * There was a **task** layer over this — a task was a name and a set of members
 * taken from any panel, listed here with a dashboard behind `Home` — and it is
 * gone, deleted rather than hidden.
 *
 * **The rows are drawn as a file tree rather than a disclosure list.** A folder
 * mark, open or shut, in place of the chevron that was there: what this column
 * lists is projects on disk, and the chevron said only "there is more below",
 * which is the one thing the indent already says. The chats under it carry no
 * mark at all — a column of identical speech bubbles is a column of noise, and
 * the only thing they distinguish is a chat from a chat. What that vacated
 * space is spent on instead is the **age** of each conversation, right-aligned,
 * which is the question actually asked of this list: not what a row is, but
 * which of four similarly-named chats is the one from this afternoon.
 */
export function ProjectsSection() {
  const collapsed = useProjects((state) => state.collapsed)
  const toggleFolder = useProjects((state) => state.toggleFolder)

  const folders = useStudio((state) => state.folders)
  const chats = useWorktreeChats((state) => state.chats)
  const unsaved = useWorktreeChats((state) => state.unsaved)
  // Read here as well as in `ProjectChats` so a shut project can say what is
  // happening inside it — see the `activity` prop on `ProjectRow`.
  const sending = useWorktreeChats((state) => state.sending)
  const asks = useWorktreeChats((state) => state.asks)
  const unread = useWorktreeChats((state) => state.unread)

  const listed = saved(chats, unsaved)
  const orphans = ungroupedChats(listed)
  const ungroupedShut = collapsed.includes(UNGROUPED_ID)

  /**
   * Which project the confirmation is up for. One dialog for the whole list
   * rather than one per row: only ever one is open, and a dialog mounted inside
   * a row is unmounted by the very removal it asked about.
   */
  const [removing, setRemoving] = useState<WorkspaceFolder | null>(null)

  return (
    <nav
      aria-label="Projects"
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {folders.length === 0 && orphans.length === 0 && (
          <p className="px-3 py-1 text-xs leading-relaxed text-muted-foreground">
            No folders yet. Add one with the + above and it will show up here.
          </p>
        )}

        {folders.map((folder) => {
          const shut = collapsed.includes(folder.id)
          return (
            <div key={folder.id}>
              <ProjectRow
                name={folder.name}
                shut={shut}
                // Only while it is shut: open, the chat rows underneath say
                // this one at a time and in more detail, and a count repeating
                // what is directly below it is a number somebody has to check
                // against the rows to trust.
                activity={
                  shut
                    ? activityOf(chatsOf(listed, folder.id), sending, asks)
                    : null
                }
                // Shut only, for the same reason — open, the rows underneath
                // each carry their own dot.
                unread={shut ? unreadIn(chatsOf(listed, folder.id), unread) : 0}
                onNewChat={() =>
                  void useWorktreeChats
                    .getState()
                    .create({ folderId: folder.id })
                }
                onOpenBoard={() => useBoard.getState().open(folder.id)}
                onRemove={() => setRemoving(folder)}
                onToggle={() => {
                  toggleFolder(folder.id)
                  // And the dock's shell follows: a project row is the one
                  // place this app says "this project", so a terminal that
                  // stayed in the last one would be a `pwd` nobody asked for.
                  // It does not open the dock — see `showFor`.
                  useShells.getState().showFor(folder.id)
                  // So does Explorer: this row is the app saying "this
                  // project", and the tree draws the one project being worked
                  // in.
                  useProjects.getState().setActive(folder.id)
                }}
              />
              {!shut && <ProjectChats folderId={folder.id} />}
            </div>
          )
        })}

        {/*
          Last, and only when there is something in it: an empty `Ungrouped`
          would be a row explaining a situation nobody is in.
        */}
        {orphans.length > 0 && (
          <div>
            <ProjectRow
              name="Ungrouped"
              shut={ungroupedShut}
              // A chat here has nowhere to run its next turn, so it is never
              // one of the ones answering, and so never one that has answered.
              activity={null}
              unread={0}
              // No `+` and no board: both need a project, and this row names
              // the absence of one.
              onNewChat={null}
              onOpenBoard={null}
              onRemove={null}
              onToggle={() => toggleFolder(UNGROUPED_ID)}
            />
            {!ungroupedShut && <ProjectChats folderId={null} />}
          </div>
        )}
      </div>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this project?</AlertDialogTitle>
            {/*
              The same three sentences Explorer's own dialog says, and
              deliberately so: this is the same call, and a second wording for it
              would leave a user comparing two dialogs to work out whether their
              repository is at stake. The folder is theirs — saying the directory
              is untouched, by path, is the whole job here.
            */}
            <AlertDialogDescription>
              “{removing?.name}” is removed from the workspace, along with any
              tabs open on files inside it and any terminal sessions running in
              it. The folder itself —{" "}
              <code className="font-mono">{removing?.path}</code> — is left
              exactly as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing)
                  void useStudio.getState().removeFolder(removing.id)
                setRemoving(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  )
}

/**
 * The `Ungrouped` row's key in `collapsed`.
 *
 * A sentinel among folder ids, which are uuids, so it cannot collide with one.
 * Folding it is remembered the same way a real project's is — the store keeps a
 * list of strings and has no opinion about which of them name folders.
 */
const UNGROUPED_ID = "ungrouped"

/**
 * The pill an active row is drawn as, in this section only.
 *
 * `SideRow` is full-bleed with a bar down its left edge, which is right for the
 * Explorer's tree and for the three panel lists: those are dense, and a row that
 * inset itself would break the alignment of the guides beside it. This column is
 * not that — it holds a dozen rows with the whole height to themselves — and the
 * shape it wants is Conductor's, a rounded block sitting inside the column with
 * air around it. Overriding at the call site rather than adding a variant to
 * `SideRow`, since one section wanting a different shape is not yet a second
 * kind of row; if a second section asks for it, that is when it becomes one.
 *
 * The inset is `px-1` on the scrolling list rather than a margin on each row,
 * and that is not a matter of taste: a row given `w-auto` to make room for the
 * margin stops being `w-full`, so it sizes to its content, so `truncate` on the
 * title inside it never has a width to truncate against. What that looked like
 * was a column of clipped titles and a horizontal scrollbar under the list.
 */
const PILL = "rounded-md"
const PILL_ACTIVE = "shadow-none"

/**
 * One project: the folder's name, a `+` that starts a chat in it, and a menu
 * offering the same.
 *
 * The `+` is Conductor's, and it belongs on the row rather than in a header
 * above the list: it acts on *this* project. It made a `git worktree` once,
 * which was the expensive half of starting work here — a branch to name, a
 * directory to remove afterwards — and a chat is what somebody wanted from it
 * in nearly every case. `onNewChat` is nullable for the one row that is not a
 * project — see `UNGROUPED_ID`.
 */
function ProjectRow({
  name,
  shut,
  activity,
  unread,
  onToggle,
  onNewChat,
  onOpenBoard,
  onRemove,
}: {
  name: string
  shut: boolean
  /**
   * What is happening in this project's chats, or null when the row is not the
   * one saying so.
   *
   * The whole of the argument for it is that a project is normally shut: this
   * app is for running several chats at once, and the way somebody does that is
   * by starting one here, folding it away, and starting another somewhere else.
   * Without this the column goes completely still while three turns are
   * running, and the only thing that ever said otherwise was a notification —
   * which by design does not fire while the window is focused.
   */
  activity: ChatActivity | null
  /**
   * How many of this project's chats have answered since anybody looked, or 0
   * when the row is not the one saying so.
   *
   * Beside `activity` rather than inside it: `ChatActivity` is shared with the
   * menu bar's tray, which counts what is *happening*, and a chat that has
   * something unread in it is one where nothing is happening any more. Folding
   * this into that count would make the number on this row and the number in
   * the menu bar two readings of the same chats.
   */
  unread: number
  onToggle: () => void
  onNewChat: (() => void) | null
  /** Opens this project's board. Nullable for the same row `onNewChat` is. */
  onOpenBoard: (() => void) | null
  /**
   * Asks to take this project out of the workspace. It only asks — the
   * confirmation and the call itself are the section's, since a dialog owned by
   * a row would be unmounted by the removal it is confirming. Nullable for the
   * same row the other two are.
   */
  onRemove: (() => void) | null
}) {
  // Open and shut rather than one mark rotated: a folder is the thing being
  // drawn, and its two states are two glyphs rather than two angles.
  const Mark = shut ? Folder : FolderOpen

  const running = activity !== null && isRunning(activity)
  // Only where the row has nothing more immediate to say. A project with a turn
  // running is already drawing that, and it outranks news of one that finished.
  const news = !running && unread > 0

  const row = (
    <div className="group/project relative flex items-center">
      <SideRow
        onClick={onToggle}
        title={
          running
            ? `${name} — ${activityTitle(activity)}`
            : news
              ? `${name} — ${unread} answered since you last looked`
              : name
        }
        className={cn(PILL, "font-medium text-foreground")}
      >
        <Mark
          className={cn(
            "size-4 shrink-0",
            // The open folder takes the section's own hue, which is what marks
            // the project being worked in from the ones merely listed. A shut
            // one is furniture and drawn as furniture.
            shut ? "text-muted-foreground" : "text-primary"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>

        {/*
          The count, at the end the chat rows put their age at, so a shut
          project and its chats line up on the same right edge.

          `invisible` on hover rather than gone, and for the same reason the
          Changes list hides its counts that way: the `+` and the board button
          are positioned over this exact spot, and a count that unmounted would
          let the project name reflow as the pointer arrived.
        */}
        {running && (
          <span
            aria-hidden
            className={cn(
              "shrink-0 text-[0.6875rem] tabular-nums transition-opacity group-hover/project:invisible",
              // Waiting takes the hue, because waiting is the half that is
              // somebody's to act on. Working is furniture — it will finish
              // whether or not anybody is looking at it.
              activity.waiting > 0
                ? "font-medium text-primary"
                : "text-muted-foreground"
            )}
          >
            {activityLabel(activity)}
          </span>
        )}
        {/* The spinner is what makes it read as *now* rather than as a badge
            counting something. Only for the working half: a chat stopped on a
            question is the opposite of moving. */}
        {running && activity.waiting === 0 && (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground group-hover/project:invisible" />
        )}
        {running && activity.waiting > 0 && (
          <ShieldQuestion className="size-3 shrink-0 animate-pulse text-primary group-hover/project:invisible" />
        )}

        {/*
          And the same pair for a project that has been answered in while it was
          shut, in the same two slots — the count where the count goes, the mark
          where the spinner goes. Not animated: this is news that has already
          happened, and a pulse would make a finished chat read as a running one.
        */}
        {news && (
          <>
            <span
              aria-hidden
              className="shrink-0 text-[0.6875rem] font-medium text-muted-foreground tabular-nums transition-opacity group-hover/project:invisible"
            >
              {unread}
            </span>
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-primary group-hover/project:invisible"
            />
          </>
        )}
      </SideRow>

      {/*
        Over the row rather than in it: a row is a button, and a button
        inside a button is neither valid markup nor clickable. Shown on
        hover, like the ✕ on a tab — a column of projects each wearing a
        permanent `+` is a column of plus signs.
      */}
      {onNewChat && (
        <div className="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/project:opacity-100 focus-within:opacity-100">
          {/* Left of the `+`, in the order the two are reached for: a board is
              where the work is decided and a chat is where it is done. */}
          {onOpenBoard && (
            <IconButton
              label={`Board for ${name}`}
              onClick={onOpenBoard}
              className="size-5"
            >
              <Columns3 className="size-3" />
            </IconButton>
          )}
          <IconButton
            label={`New chat in ${name}`}
            onClick={onNewChat}
            className="size-5"
          >
            <Plus className="size-3" />
          </IconButton>
        </div>
      )}
    </div>
  )

  // A menu whose only item would be missing is no menu: `Ungrouped` right-clicks
  // to nothing rather than to an empty box.
  if (!onNewChat) return row

  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={onNewChat}>
          <MessageSquare className="text-muted-foreground" />
          New chat here
        </ContextMenuItem>
        {onOpenBoard && (
          <ContextMenuItem onClick={onOpenBoard}>
            <Columns3 className="text-muted-foreground" />
            Open board
          </ContextMenuItem>
        )}
        {onRemove && (
          <>
            <ContextMenuSeparator />
            {/* "Remove", not "Delete": the directory is the user's own and
                stays where it is — only the workspace forgets it. */}
            <ContextMenuItem variant="destructive" onClick={onRemove}>
              <Trash2 />
              Remove project
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * One project's chats, newest first — a chat just started is the top row.
 *
 * The row is the chat's **title**, which is the first thing that was asked in
 * it (`"Untitled"` until there is one). Listed here rather than only in the tab
 * strip because the strip holds what is open in *this* run: a chat is written
 * down as it happens, and the column is where one from last week is found
 * again.
 *
 * `folderId` is null for the `Ungrouped` group, which is the one list here whose
 * rows move nothing else when clicked: there is no project to point the shell
 * and the tree at, and pointing them at whichever project was last active would
 * be this app guessing.
 */
function ProjectChats({ folderId }: { folderId: string | null }) {
  const chats = useWorktreeChats((state) => state.chats)
  const unsaved = useWorktreeChats((state) => state.unsaved)
  const selectedId = useWorktreeChats((state) => state.selectedId)
  const sending = useWorktreeChats((state) => state.sending)
  // Which chats are stopped on a question — see the note in `tab-items.tsx`
  // about why that is not the same thing as one that is working.
  const asks = useWorktreeChats((state) => state.asks)
  // Which have answered since anybody looked — see `lib/worktree-chat/unread.ts`.
  const unread = useWorktreeChats((state) => state.unread)
  const select = useWorktreeChats((state) => state.select)
  const remove = useWorktreeChats((state) => state.remove)
  const rename = useWorktreeChats((state) => state.rename)

  /** Which chat's name is a field right now. In place, the way every other
   * sidebar in the studio renames — see `RenameRow`. */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  /** Which chat is being distilled — the dialog under the list. One at a
   * time, because each is a turn of the second, read-only CLI. */
  const [distilling, setDistilling] = useState<WorktreeChat | null>(null)
  const menuFocus = useMenuFocusHandoff()

  const listed = saved(chats, unsaved)
  const own = folderId ? chatsOf(listed, folderId) : ungroupedChats(listed)
  if (own.length === 0) return null

  return (
    <>
      {own.map((chat) => {
        const isSending = sending.includes(chat.id)
        const isWaiting = asks[chat.id] !== undefined
        // Third in the same precedence the other two keep: a chat with
        // something unread in it is, by the rule that marked it, one that has
        // stopped working — so this can never be true beside the spinner.
        const isUnread = unread[chat.id] === true

        // Outside the menu while it is a field: a right-click on a text field
        // belongs to the field, not to the row it stands in for.
        if (renamingId === chat.id) {
          return (
            <RenameRow
              key={chat.id}
              name={chat.title}
              indent={1}
              label="Chat name"
              onRename={async (name) => {
                rename(chat.id, name)
                setRenamingId(null)
                return null
              }}
              onCancel={() => setRenamingId(null)}
            />
          )
        }

        return (
          <ContextMenu key={chat.id}>
            <ContextMenuTrigger
              render={
                <SideRow
                  indent={1}
                  active={selectedId === chat.id}
                  title={
                    isWaiting
                      ? `${chat.title} — waiting for your answer`
                      : isUnread
                        ? `${chat.title} — answered since you last looked`
                        : chat.title
                  }
                  // `text-foreground` because a chat's title is the content of
                  // this list rather than a label over it — the muted default
                  // is right for a tree of filenames and wrong for a dozen
                  // sentences somebody is reading to pick between.
                  className={cn(
                    PILL,
                    "text-foreground",
                    selectedId === chat.id && PILL_ACTIVE
                  )}
                  onClick={() => {
                    select(chat.id)
                    // The shell and the tree follow, the way a project row moves
                    // them: a chat editing this project with a terminal pointed
                    // at another one is a trap, not an inconvenience. Nothing to
                    // follow for an ungrouped chat — see the note above.
                    if (!folderId) return
                    useShells.getState().showFor(folderId)
                    useProjects.getState().setActive(folderId)
                  }}
                >
                  {/* Waiting wins over working: both are true while an ask is
                      up, and only one of them is something to do. */}
                  {isWaiting ? (
                    <ShieldQuestion className="size-3 shrink-0 animate-pulse text-primary" />
                  ) : isSending ? (
                    <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    isUnread && (
                      // A dot in the slot the other two marks use, so the
                      // titles down the column stay on one left edge — a row
                      // that indented itself only when it had news would make
                      // the list ripple as chats finished.
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full bg-primary"
                      />
                    )
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-left",
                      // Unread is the one state that says something about the
                      // *content* of the row rather than about a process beside
                      // it, so the title itself carries it. Weight rather than
                      // hue: the hue is spoken for by the shield, and a column
                      // where the news is a second colour is a column read by
                      // colour.
                      isUnread && "font-medium"
                    )}
                  >
                    {chat.title}
                  </span>
                  {/*
                    `tabular-nums` so `9h` and `23h` end on the same pixel: a
                    right-aligned column that shifts by a digit reads as the
                    list twitching when a chat is answered.
                  */}
                  <span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
                    {since(chat.updatedAt)}
                  </span>
                </SideRow>
              }
            />
            <ContextMenuContent
              className="w-52"
              // Rename hands focus to the field it opens — see
              // `useMenuFocusHandoff`.
              finalFocus={menuFocus.finalFocus}
            >
              <ContextMenuItem
                onClick={() => {
                  menuFocus.handOff()
                  setRenamingId(chat.id)
                }}
              >
                <Pencil />
                Rename
              </ContextMenuItem>
              {/* Only under a project: the turn reads in the project's own
                  directory, and an ungrouped chat has none to read in. */}
              {folderId && (
                <ContextMenuItem onClick={() => setDistilling(chat)}>
                  <GraduationCap />
                  Distill learnings…
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              {/* The conversation is on disk, so this is the one way it goes. */}
              <ContextMenuItem
                variant="destructive"
                onClick={() => void remove(chat.id)}
              >
                <Trash2 />
                Delete chat
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
      {distilling && folderId && (
        <DistillDialog
          chatId={distilling.id}
          chatTitle={distilling.title}
          folderId={folderId}
          onClose={() => setDistilling(null)}
        />
      )}
    </>
  )
}
