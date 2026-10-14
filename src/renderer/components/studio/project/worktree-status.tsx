import { useEffect, useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"

import { cn } from "@/lib/utils"
import { GIT_TONES, useGitStatus } from "@/lib/files/git-status"
import { worktreeStatus } from "@/lib/workspace"
import { worktreeSummary } from "@/lib/worktrees"
import type { WorktreeStatus } from "@shared/api"

/**
 * A checkout's `WorktreeStatus`, or null while it is asked or for a folder that
 * is not one (`folderId` null).
 *
 * Re-read off the folder's git status rather than on a timer of its own, the
 * way the Commits list is: a commit, a pull or an edit all move the working
 * tree's status, which the watchers already refresh. A file root's id is its
 * folder's id, so the folder is the key.
 */
export function useWorktreeStatus(
  folderId: string | null
): WorktreeStatus | null {
  const signal = useGitStatus((state) =>
    folderId ? state.byRoot[folderId] : undefined
  )
  // Kept with the folder it answers for, so a row that stops being a checkout
  // reads null without an effect having to clear it.
  const [answer, setAnswer] = useState<{
    folderId: string
    status: WorktreeStatus | null
  } | null>(null)

  useEffect(() => {
    if (!folderId) return
    let current = true
    void worktreeStatus(folderId)
      .then((status) => {
        if (current) setAnswer({ folderId, status })
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [folderId, signal])

  return folderId && answer?.folderId === folderId ? answer.status : null
}

/**
 * The marks on a checkout's row: commits ahead and behind its base, and how
 * many files are uncommitted — what says, with the project shut, which
 * checkouts still have work in them. Nothing at all for one that is level and
 * clean: a row of zeroes is a row somebody has to read to learn nothing.
 */
export function WorktreeMarks({
  status,
  className,
}: {
  status: WorktreeStatus
  className?: string
}) {
  const { ahead, behind, changed } = status
  if (!ahead && !behind && !changed) return null

  return (
    <span
      title={worktreeSummary(status)}
      className={cn(
        "flex shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground tabular-nums",
        className
      )}
    >
      {!!ahead && (
        <span className="flex items-center">
          <ArrowUp className="size-2.5" />
          {ahead}
        </span>
      )}
      {!!behind && (
        <span className="flex items-center">
          <ArrowDown className="size-2.5" />
          {behind}
        </span>
      )}
      {/* The Changes list's own hue for a modified file, so the count reads as
          the same thing it is there. */}
      {!!changed && <span className={GIT_TONES.modified}>●{changed}</span>}
    </span>
  )
}
