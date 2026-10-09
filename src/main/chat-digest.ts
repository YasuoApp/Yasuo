import type { AssistantMessage, ChatSpend } from "../shared/api"

/**
 * A chat read as a whole rather than as a conversation: what its turns were
 * billed, for the cost dashboard.
 *
 * Free of `electron` and of the store, the way `notify.ts` and `git.ts` are —
 * it takes the lines it folds, so `test/chat-digest.ts` can import it.
 * `WorktreeChats.spend` is what holds the lines and the cache.
 *
 * A fold of the transcript, which is the one record of what a chat did.
 * Nothing here is written down: a stored copy would be a second account of the
 * same file, and the first thing a second account does is disagree.
 *
 * Searching what a chat *said* is not here: `⌘F` over the conversation on
 * screen is the renderer's (`lib/worktree-chat/search.ts`), and the left
 * column's search of every chat is `WorktreeChats.search` over
 * `content-search.ts`.
 */

/**
 * One row per usage line, for the cost dashboard — see `ChatSpend`.
 *
 * A line written before lines were stamped has no `at`, and the chat's own
 * `updatedAt` stands in: it is when the chat was last written to, which for a
 * chat nobody has touched since is the afternoon those turns ran. Wrong by at
 * most the length of the chat, and never in the future.
 */
export function spendRows(
  chat: {
    id: string
    title: string
    folderId: string | null
    updatedAt: string
  },
  messages: AssistantMessage[]
): ChatSpend[] {
  const rows: ChatSpend[] = []
  for (const message of messages) {
    if (message.role !== "usage") continue
    rows.push({
      chatId: chat.id,
      title: chat.title,
      folderId: chat.folderId,
      model: message.usage.model,
      costUsd: message.usage.costUsd,
      at: message.at ?? chat.updatedAt,
    })
  }
  return rows
}
