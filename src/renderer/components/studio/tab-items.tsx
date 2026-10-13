import { GitCompare, MessageSquare, ShieldQuestion } from "lucide-react"

import { Spinner } from "@/components/ui/spinner"
import { useChanges } from "@/lib/files/changes"
import { isDeleted, isDirty, useFiles } from "@/lib/files/store"
import { gitStateOf, GIT_TONES, useGitStatus } from "@/lib/files/git-status"
import { nameOf } from "@/lib/files/paths"
import { useSettings } from "@/lib/settings"
import { useStudio } from "@/lib/store"
import { PREFIX } from "@/lib/tabs"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
import { FileIcon } from "./file-icon"
import type { TabStripItem } from "./tab-strip"

/**
 * What every open tab looks like, by the id the strip addresses it with.
 *
 * The one thing about a tab that is genuinely its own panel's — its label, its
 * icon, the line it shows on hover, the dot on a file with unsaved edits.
 *
 * Keyed by strip id, so a caller with a list of ids has nothing left to decide.
 */
export function useTabItems(): Map<string, TabStripItem> {
  const chats = useWorktreeChats((state) => state.chats)
  const chatOpenIds = useWorktreeChats((state) => state.openIds)
  const chatSending = useWorktreeChats((state) => state.sending)
  // A held turn is not a working one, and the strip is where a chat that is
  // waiting on somebody has to say so: the pane's card is only visible to
  // whoever is already looking at that chat, and the spinner beside a tab reads
  // as "still going" — which is exactly the answer that stops you clicking it.
  const chatAsks = useWorktreeChats((state) => state.asks)
  // And which have answered since anybody looked at them. The strip needs it for
  // the same reason the column does: the tab of a chat you switched away from
  // goes back to looking exactly like the tab of one you have read.
  const chatUnread = useWorktreeChats((state) => state.unread)

  const changesOpenIds = useChanges((state) => state.openIds)
  const changesByRoot = useChanges((state) => state.byRoot)

  const fileOpenIds = useFiles((state) => state.openIds)
  // The one tab drawn in italics: a file being looked at rather than kept.
  const filePreviewId = useFiles((state) => state.previewId)
  const fileDocs = useFiles((state) => state.docs)
  const fileEntries = useFiles((state) => state.entries)
  // The whole record rather than one lookup: this builds every tab in a loop,
  // and the store changes only when a `git status` comes back.
  const gitStatus = useGitStatus()

  const workspaceFolders = useStudio((state) => state.folders)
  const allProjectTabs = useSettings((state) => state.allProjectTabs)

  const items = new Map<string, TabStripItem>()
  const add = (item: TabStripItem) => items.set(item.id, item)

  for (const filePath of fileOpenIds) {
    const git = gitStateOf(gitStatus, filePath)
    // A tab is the one place a deleted file is still visible — the tree lists
    // what is on disk, so the row went with the file. Which of git and the
    // tree's listing gets to say so is `isDeleted`, and worth reading before
    // trusting either.
    const deleted = isDeleted(git, { entries: fileEntries }, filePath)

    add({
      id: PREFIX.files + filePath,
      // The file's name, not its path: a strip of absolute paths is a strip of
      // one repeated prefix. The path is on the tab's own hover line, and in
      // the pane's header above the editor.
      label: nameOf(filePath),
      title: filePath,
      copyText: filePath,
      copyLabel: "Copy path",
      // The same icon the tree draws, so a tab and the row it came from are
      // recognisably the same file.
      icon: <FileIcon filePath={filePath} className="size-3" />,
      // The same dot the tree marks the row with: whichever of the two is being
      // looked at says the file has edits that are not on disk.
      dirty: isDirty(fileDocs[filePath]),
      // The editors' own mark for a preview tab. Nothing else in a strip is
      // italic, so it reads as "this one is not staying" without a legend.
      italic: filePath === filePreviewId,
      // And the same colour, so a tab and its row agree about what the file is.
      // `deleted` wins whatever git last said, because it is the state that
      // makes the tab the only thing left of the file.
      tone: deleted ? GIT_TONES.deleted : git ? GIT_TONES[git] : undefined,
      note: deleted ? "deleted" : undefined,
    })
  }

  /*
   * `Changes`, one per checkout — the diff of whichever file the Explorer's
   * `Changes` list has picked.
   *
   * The label is the same word for every one of them, which is the point: the
   * tab is about reviewing *here*, and *here* is said by the strip already — a
   * tab is in it only while its project is the one being worked in. Not the
   * file's name either, which would make one tab look like the twelve this
   * exists to avoid. The project goes on the hover line, as a chat's does, and
   * the count rides along as the `note`, since a tab that says how much is
   * waiting is the reason to look at it.
   */
  for (const rootId of changesOpenIds) {
    const folder = workspaceFolders.find((entry) => entry.id === rootId)?.name
    const count = changesByRoot[rootId]?.length

    add({
      id: PREFIX.changes + rootId,
      // Unless the strip holds every project's tabs, where *here* is no longer
      // said by the strip and four tabs reading `Changes` are four guesses.
      label: allProjectTabs && folder ? `Changes · ${folder}` : "Changes",
      icon: <GitCompare className="size-3 shrink-0" />,
      // Nothing until the first read, and nothing for a clean project: a badge
      // reading zero is a thing to notice saying there is nothing to notice.
      note: count ? String(count) : undefined,
      title: folder ?? "Changes",
    })
  }

  /*
   * A project's chats, named by what was first asked in them.
   *
   * `Untitled` until there is something to name it after, which is what the
   * record already says: a title asked of the model would be a second turn to
   * pay for and wait on, for something the first line says.
   */
  for (const id of chatOpenIds) {
    const chat = chats.find((candidate) => candidate.id === id)
    if (!chat) continue

    // Which project it is in, on hover, because the label cannot carry it.
    const where = workspaceFolders.find(
      (folder) => folder.id === chat.folderId
    )?.name

    const waiting = chatAsks[id] !== undefined
    const unread = chatUnread[id] === true
    const sending = chatSending.includes(id)
    const title = where ? `${chat.title} — ${where}` : chat.title

    add({
      id: PREFIX.worktree + id,
      label: chat.title,
      // The transcript's `Working…` light, run over the title too, so a chat
      // working in a tab nobody is looking at says so in words and not only
      // in a 14px mark. Not while it waits: that is held, not working.
      tone: sending && !waiting ? "text-shimmer" : undefined,
      // Waiting wins over working: both are true while an ask is up — the turn
      // is held rather than finished — and only one of them is something to do.
      // Unread comes last of the three and can never be true beside the
      // spinner: what marks a chat unread is it having stopped.
      icon: waiting ? (
        <ShieldQuestion className="size-3 shrink-0 animate-pulse text-primary" />
      ) : sending ? (
        <Spinner className="size-3 shrink-0 text-muted-foreground" />
      ) : unread ? (
        // In the icon's own slot rather than beside it, so the label starts on
        // the same pixel either way — a tab that grew by a dot would shift every
        // tab to its right as a chat finished.
        <span
          aria-hidden
          className="inline-flex size-3 shrink-0 items-center justify-center"
        >
          <span className="size-1.5 rounded-full bg-primary" />
        </span>
      ) : (
        <MessageSquare className="size-3 shrink-0" />
      ),
      title: waiting
        ? `${title} — waiting for your answer`
        : unread
          ? `${title} — answered since you last looked`
          : title,
    })
  }

  return items
}
