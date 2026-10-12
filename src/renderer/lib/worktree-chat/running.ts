import type { WorktreeChat } from "@shared/api"
import type { ChatActivity } from "@shared/chat-activity"

/**
 * How many of a set of chats are working, and how many have stopped to ask.
 *
 * Pure and tested (`test/chat-running.ts`) for the reason the rest of
 * `lib/worktree-chat/` is split this way: the counting has one rule in it that
 * is easy to get wrong in two places at once, and neither way of getting it
 * wrong looks broken.
 *
 * The rule itself, the shape and the two labels moved to
 * `@shared/chat-activity` when the menu bar's tray started drawing the same
 * count from the main process — see the header there. Re-exported so this file
 * is still the one place the sidebar asks about it.
 */
export {
  NOTHING_RUNNING,
  isRunning,
  activityLabel,
  activityTitle,
  type ChatActivity,
} from "@shared/chat-activity"

/** The counts for one set of chats, read off the store. **Waiting wins over
 * working** — see `ChatActivity`. This is the same precedence the chat row
 * itself draws with, and they must not disagree: the row is what somebody
 * checks the count against. */
export function activityOf(
  chats: WorktreeChat[],
  /** The chats main last said were busy — `sending` in the store. */
  sending: string[],
  /** The questions that are up, keyed by chat — `asks` in the store. */
  asks: Record<string, unknown>
): ChatActivity {
  let working = 0
  let waiting = 0
  for (const chat of chats) {
    if (asks[chat.id] !== undefined) waiting += 1
    else if (sending.includes(chat.id)) working += 1
  }
  return { working, waiting }
}
