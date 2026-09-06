import { create } from "zustand"

import type { ChatDigest, GitChange } from "@shared/api"

/**
 * What each chat did, as the two panels outside a conversation read it.
 *
 * A view of `main/chat-digest.ts`, held in one store because it is one call:
 * the `Changes` list asks which chat wrote which file, and the system bar sums
 * what the workspace has spent, and both are folds of the same transcripts.
 *
 * Nothing polls it. It is re-read where a chat's work becomes visible somewhere
 * else — beside the `Changes` list's own re-read, which is already behind the
 * watchers (`useWatchChanges`) — so the filter tracks a turn as it writes and
 * the total moves as turns end, without a second set of timers over the same
 * events.
 */
type DigestState = {
  digests: ChatDigest[]
  /** True only before the first answer: a re-read behind figures already on
   * screen says nothing, and a bar that blanked while it refreshed would
   * flicker on every file a turn writes. */
  loading: boolean
  refresh: () => Promise<void>
}

export const useDigests = create<DigestState>((set, get) => ({
  digests: [],
  loading: false,

  async refresh() {
    if (get().digests.length === 0) set({ loading: true })

    const digests = await window.desktop.chatDigests().catch(() => {
      // A fold that could not be read is not an empty workspace. The last
      // answer stands, which for the first call is no rows at all.
      return null
    })

    set({ loading: false, ...(digests ? { digests } : {}) })
  },
}))

/**
 * Which chats of this project wrote to files that are still changed, and how
 * many each.
 *
 * **Against the current changes rather than against the transcript**, which is
 * what makes it a filter and not a history: a file a chat edited and somebody
 * has since committed or discarded is not in this list, because there is no row
 * left for it to narrow to. A chat that touched nothing still on the list is not
 * a chip — a filter that empties the panel is a control nobody presses twice.
 */
export function touchesIn(
  digests: ChatDigest[],
  folderId: string,
  changes: GitChange[]
): { chatId: string; count: number }[] {
  return digests
    .filter((digest) => digest.folderId === folderId)
    .map((digest) => ({
      chatId: digest.chatId,
      count: new Set(keptBy(changes, digest.paths).map((change) => change.path))
        .size,
    }))
    .filter((touch) => touch.count > 0)
    .sort((a, b) => b.count - a.count || a.chatId.localeCompare(b.chatId))
}

/**
 * The rows of a change list one chat can be shown to have written.
 *
 * Compared as whole strings: both sides are absolute paths this machine wrote —
 * git's own, and the argument an edit tool was called with — so there is nothing
 * to normalise that would not also be a guess. What it does allow for is a
 * **directory row**: a wholly untracked directory is one entry in `git status`
 * (`?? public/images/`), and the chat that filled it named the files inside.
 */
export function keptBy(changes: GitChange[], paths: string[]): GitChange[] {
  const touched = new Set(paths)
  return changes.filter(
    (change) =>
      touched.has(change.path) ||
      (change.directory &&
        paths.some((path) => path.startsWith(`${trimEnd(change.path)}/`)))
  )
}

/** One project's spend, or the whole workspace's when no project is named. */
export function spentIn(
  digests: ChatDigest[],
  folderId?: string
): { costUsd: number; turns: number; unpriced: number } {
  return digests
    .filter((digest) => folderId === undefined || digest.folderId === folderId)
    .reduce(
      (sum, digest) => ({
        costUsd: sum.costUsd + digest.costUsd,
        turns: sum.turns + digest.turns,
        unpriced: sum.unpriced + digest.unpriced,
      }),
      { costUsd: 0, turns: 0, unpriced: 0 }
    )
}

/** A directory row arrives with or without its trailing slash depending on what
 * git said; both have to answer the same prefix. */
function trimEnd(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path
}
