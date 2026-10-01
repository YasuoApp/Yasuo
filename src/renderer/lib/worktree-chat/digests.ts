import { create } from "zustand"

import type { ChatDigest } from "@shared/api"

/**
 * What each chat did, as the two panels outside a conversation read it.
 *
 * A view of `main/chat-digest.ts`: the system bar sums what the workspace has
 * spent. The `Changes` list used to ask it which chat wrote which file, for a
 * row of chips narrowing the list to one chat — removed, see `docs/design.md`.
 *
 * Nothing polls it. It is re-read where a chat's work becomes visible somewhere
 * else, so the total moves as turns end without a timer of its own.
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
