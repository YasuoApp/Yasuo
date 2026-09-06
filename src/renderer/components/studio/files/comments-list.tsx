import { useMemo } from "react"
import {
  CheckCircle2,
  MessageSquare,
  MessageSquarePlus,
  Trash2,
} from "lucide-react"

import { nameOf, relativeTo } from "@/lib/files/paths"
import {
  anchorLabel,
  commentsPrompt,
  isDeletedOnly,
  openThreads,
  threadsOf,
  useReview,
  type ReviewThread,
} from "@/lib/files/review"
import type { FileRoot } from "@/lib/files/roots"
import { cn } from "@/lib/utils"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
import { FileIcon } from "../file-icon"
import { SideRow } from "../side-row"

/**
 * Every comment left in one checkout — the Explorer's `Comments` tab.
 *
 * **The question this answers is "where are they all".** A comment lives *in*
 * the diff, under the lines it is about, which is the right place for it and is
 * also the whole problem: before this tab the only way to find a remark was to
 * open the file it was in, so a pile of them across twelve files was twelve
 * trips through the `Changes` tree. There were `⌥↓` / `⌥↑` for a while, walking
 * them one at a time; this replaced them, and is what a walk could not be — you
 * can see how many there are, which files they are in, and which one you want,
 * rather than having to know a key exists.
 *
 * It draws nothing of the thread itself beyond its first line. A comment is
 * read where it was written, beside the code, and a second full rendering of it
 * here would be one more place for the two to disagree — the same reason the
 * changed files are listed here and the diff is in the pane. A row is a way
 * *to* the comment: it opens the checkout's diff tab on that file and focuses
 * the thread (`reveal`) and rings it.
 *
 * Grouped by file rather than flat, and by the same argument the `Changes` list
 * became a tree: `src/renderer/components/studio/files/changes-list.tsx` down
 * the column twelve times is a column of paths with the remarks hidden in it.
 * A **flat group per file** rather than a folder tree, though — there are a
 * handful of files with comments in them, not a checkout's worth, and folding a
 * two-deep tree to find one remark is the tedium this tab is for.
 */
export function CommentsList({ root }: { root: FileRoot }) {
  const threads = useReview((state) => state.threads)
  const focused = useReview((state) => state.focused)

  /** By file, each file's own in the order they are drawn down the diff, which
   * is the order they are read in. */
  const files = useMemo(() => {
    const byPath = new Map<string, ReviewThread[]>()
    for (const thread of threadsOf({ threads }, root.id)) {
      const held = byPath.get(thread.path)
      if (held) held.push(thread)
      else byPath.set(thread.path, [thread])
    }
    return [...byPath.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, rows]) => ({
        path,
        // Resolved ones **stay**, unlike in every count in the app: a count is
        // read as "how much is left", and a list is read as "what was said".
        // Dropping them here would make this the one place a settled remark
        // cannot be found again.
        threads: [...rows].sort((a, b) => lineOf(a) - lineOf(b)),
      }))
  }, [threads, root.id])

  if (files.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No comments in this checkout. Pick a range in a diff — the `+` in the
        column beside the code — to leave one.
      </p>
    )
  }

  return (
    <>
      <HandOver root={root} threads={threads} />
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            {/* Not a button: there is nothing a file heading here could do that
              its comments do not already do better — clicking one of them opens
              this file *at that remark*, and opening it at the top would be a
              row that loses the reader's place. */}
            <div className="flex h-6 items-center gap-1.5 pr-2 pl-3 text-xs">
              <FileIcon filePath={file.path} className="size-3.5" />
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                title={relativeTo(root.path, file.path) || file.path}
              >
                {nameOf(file.path)}
              </span>
              <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground tabular-nums">
                {file.threads.length}
              </span>
            </div>

            <ul>
              {file.threads.map((thread) => (
                <li key={thread.id}>
                  <Row
                    thread={thread}
                    active={focused === thread.id}
                    where={anchorLabel(thread.anchor)}
                  />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * The whole pile handed to a chat — `Ask AI to fix…`, back because it was asked
 * for.
 *
 * What it does is `commentsPrompt` into a **new chat in this project**, in the
 * composer and unsent. Three decisions in that sentence, and each is the one the
 * deleted version got argued about:
 *
 * - **Unsent**, because a prompt assembled by a button is exactly the kind that
 *   wants a sentence added before it goes, and a turn nobody typed is a turn
 *   nobody asked for.
 * - **A new chat**, and not one of the project's existing ones. The composer is
 *   deliberately uncontrolled and keyed by chat (see `initialDraft`), so writing
 *   into a conversation already on screen would mean remounting its field —
 *   which throws away whatever was half-typed in it. A new tab has no field to
 *   lose, and a fix-up pass is a fresh conversation more often than not. Copying
 *   the message into an older chat is still a `⌘A` away, which was the whole of
 *   the argument for deleting this button in the first place.
 * - **The comments stay here.** This is a copy: nothing is resolved, moved or
 *   deleted by pressing it, and pressing it twice sends them twice.
 *
 * Only the open ones are handed over, which is why the count here can differ
 * from the tab's: that one lists everything ever said, and this is a list of
 * things to do.
 */
function HandOver({
  root,
  threads,
}: {
  root: FileRoot
  threads: ReviewThread[]
}) {
  const open = openThreads(threadsOf({ threads }, root.id))
  if (open.length === 0) return null

  return (
    <div className="px-2 pt-2 pb-1">
      <button
        type="button"
        onClick={() => {
          void useWorktreeChats
            .getState()
            .create(
              { folderId: root.id },
              { draft: commentsPrompt(open, root.path) }
            )
        }}
        className="flex h-6 w-full items-center justify-center gap-1.5 rounded-md border border-dashed text-[0.7rem] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <MessageSquarePlus aria-hidden className="size-3 shrink-0" />
        Send {open.length} {open.length === 1 ? "comment" : "comments"} to a new
        chat
      </button>
    </div>
  )
}

/**
 * One comment: where it is, what it opened with, and how many replies it grew.
 *
 * The **first note only**, on one line. A thread is a conversation and its last
 * word is often the useful one, but the first is the one that says what the
 * remark is *about* — and a row that showed the latest reply would change under
 * the reader every time somebody answered, which is not what a list of places
 * should do.
 */
function Row({
  thread,
  active,
  where,
}: {
  thread: ReviewThread
  active: boolean
  where: string
}) {
  const first = thread.notes[0]?.body ?? ""
  const replies = thread.notes.length - 1

  return (
    <div className="group/row relative">
      <SideRow
        active={active}
        indent={1}
        title={`${where}${isDeletedOnly(thread.anchor) ? " (deleted lines)" : ""} — ${first}`}
        onClick={() => useReview.getState().reveal(thread.id)}
      >
        {/* A settled conversation keeps its row and says so, rather than being
            filtered out — see the note on `threads` above. The tick is the same
            glyph the folded thread in the diff carries. */}
        {thread.resolved ? (
          <CheckCircle2
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : (
          <MessageSquare aria-hidden className="size-3 shrink-0" />
        )}
        <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground tabular-nums">
          {where}
        </span>
        {/* The remark itself, dimmed on a resolved row and struck through on
            nothing: a line through a sentence somebody has to be able to read
            is a sentence nobody reads. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left text-xs",
            thread.resolved && "text-muted-foreground/70"
          )}
        >
          {firstLine(first)}
        </span>
        {/* Steps aside for the delete button the way the Changes rows' counts
            do. `invisible` and not `hidden`: the row's width must not change
            under the pointer. */}
        <span
          aria-hidden
          className="flex shrink-0 items-center gap-1 text-muted-foreground group-focus-within/row:invisible group-hover/row:invisible"
        >
          {replies > 0 && (
            <span className="font-mono text-[0.65rem] tabular-nums">
              +{replies}
            </span>
          )}
          {thread.stale && (
            <span
              className="text-[0.65rem]"
              title="The lines this was written about are no longer in the file"
            >
              outdated
            </span>
          )}
        </span>
      </SideRow>

      {/* The one action a row here has, and the reason it is here rather than
          only in the diff: a remark whose code has gone is one you want rid of
          from the list you found it in, without opening the file to do it. A
          sibling positioned over the row rather than a child of it, because a
          `SideRow` is a `<button>` — the same wall the Changes list's actions
          ran into. */}
      <button
        type="button"
        title="Delete this comment"
        aria-label="Delete this comment"
        onClick={(event) => {
          event.stopPropagation()
          useReview.getState().remove(thread.id)
        }}
        className="pointer-events-none absolute inset-y-0 right-2 my-auto flex size-4.5 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 hover:bg-background/80 hover:text-foreground [&_svg]:size-3.5"
      >
        <Trash2 />
      </button>
    </div>
  )
}

/** Which row a thread is drawn on in the diff — the working file's line where
 * it has one, the commit's otherwise. */
function lineOf(thread: ReviewThread): number {
  return thread.anchor.new?.fromLine ?? thread.anchor.old?.fromLine ?? 0
}

/** The remark's first line, since a row is one line high. Markdown is not
 * rendered here for the same reason the body is not: this is a way *to* the
 * comment, and the comment is drawn beside its code. */
function firstLine(body: string): string {
  const line = body.trim().split("\n")[0] ?? ""
  return line || "(empty)"
}
