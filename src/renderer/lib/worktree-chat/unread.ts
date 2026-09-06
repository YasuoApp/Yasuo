import type { WorktreeChat, WorktreeChatEvent } from "@shared/api"

/**
 * Which chats have answered since anybody last looked at them.
 *
 * The gap this fills is the one the notification cannot: a notice fires only
 * while the window is unfocused, and the case that goes unmarked is somebody
 * sending a message, switching to another chat *inside* this window to read
 * while it works, and coming back to a column that says nothing about which of
 * the three finished. The spinner is the whole story while a turn runs and
 * there is no story at all a second after it stops.
 *
 * Pure and tested (`test/chat-unread.ts`) for the reason the rest of
 * `lib/worktree-chat/` is split this way: the rule is a handful of edges over
 * an event stream, and getting one wrong looks like nothing rather than like a
 * bug — a dot that never lights, or one that never goes out.
 */

/** What the window is showing, and whether anybody is at it. Both halves are
 * needed: a chat can be the selected one for an hour while its user is in
 * another app. */
export type Attention = {
  /** `selectedId` in the store — the chat whose pane is on screen. */
  selectedId: string | null
  /** Whether this window has the user's attention. `document.hasFocus()`,
   * read at the moment the event lands rather than kept in the store: it is
   * the OS's answer and the store would only be a stale copy of it. */
  focused: boolean
}

/**
 * Whether the user is looking at this chat right now, which is what "read"
 * means here.
 *
 * Deliberately not "has scrolled to the end of the transcript". That would be
 * the truthful reading, and the pane is one instance reused across the whole
 * strip — a scroll position local to it is not per chat, so the honest version
 * would need the position tracked per chat for a dot. Selected and focused is
 * the same bargain the notification makes with the window's own focus.
 */
export function isWatched(chatId: string, attention: Attention): boolean {
  return attention.focused && attention.selectedId === chatId
}

/**
 * Whether this event leaves something unread in the chat it belongs to.
 *
 * **Quiet, not `done`** — the same rule `main/notify.ts` reads the same stream
 * by, and for the same reason: `done` ends a *turn*, and a message queued
 * behind it starts the next one without anything arriving to say so, so a chat
 * marked on `done` would light up while it was still typing. `busy: false` is
 * the chat having nothing left to do.
 *
 * A failure is marked as it happens, again like the notice: whatever was queued
 * behind a turn that failed is worth knowing about late rather than not at all.
 *
 * An `ask` is **not** here, and that is not an omission. A question up is
 * already drawn — the shield, which outranks this everywhere it is drawn — and
 * it is in `asks` until it is answered, so it needs nothing remembered for it.
 * Marking it as well would put a dot on a row that is already saying something
 * more specific.
 */
export function marksUnread(
  event: WorktreeChatEvent,
  state: Attention & {
    /** The chats main last said were busy — `sending` in the store. Read so
     * quiet can be told from a repeat: `busy` is a state and the same value
     * arrives twice. */
    sending: string[]
  }
): boolean {
  // Read as it happens, so nothing is remembered for the chat being looked at.
  if (isWatched(event.chatId, state)) return false
  if (event.type === "done") return event.error !== null
  if (event.type !== "busy") return false
  return !event.busy && state.sending.includes(event.chatId)
}

/** How many of a set of chats have something unread in them — what a shut
 * project's row draws. Kept out of `ChatActivity` on purpose: that shape is
 * shared with the menu bar's tray, which counts what is *happening*, and an
 * unread chat is one where nothing is happening any more. */
export function unreadIn(
  chats: WorktreeChat[],
  unread: Record<string, true>
): number {
  return chats.filter((chat) => unread[chat.id] === true).length
}
