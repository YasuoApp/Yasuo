import type { WorktreeChatEvent } from "../shared/api"

/**
 * What is worth interrupting somebody for, read off the stream of chat events.
 *
 * Free of `electron` on purpose, the way `git.ts` and `updater.ts` are: the
 * decision of *whether* a notice is due is the part with edges in it, and
 * `test/notify.ts` imports this. Ringing the bell is `ipc.ts`'s.
 */
export type ChatNotice =
  /** The turn stopped on a question and nothing will move until it is answered.
   * The one notice that is about a chat which has not finished. */
  | { kind: "asks"; chatId: string }
  /** The chat has gone quiet — not the same thing as a turn ending; see
   * `ChatNotices.read`. */
  | { kind: "done"; chatId: string }
  | { kind: "failed"; chatId: string; error: string }

/**
 * The transitions in a chat's event stream that deserve a notification.
 *
 * A watcher over the same events the renderer gets, keeping only what it takes
 * to tell an edge from a repeat. It is deliberately not the renderer's job: a
 * notification is wanted precisely when nobody is looking at the window, and a
 * hidden renderer is one the compositor may have stopped scheduling.
 */
export class ChatNotices {
  /** Chats last heard to be working. `busy` is a state and the same value
   * arrives twice, so the notice is the transition rather than the event. */
  private readonly working = new Set<string>()

  /** Chats with a question up. Kept so a card redrawn — or an `ask` repeated —
   * does not ring twice for one question. */
  private readonly asking = new Set<string>()

  /**
   * Chats whose turn failed and has already been announced as such.
   *
   * Without this a failure rings twice: once on `done` carrying the error, and
   * again a beat later when the chat falls quiet. The set is cleared by the
   * quiet it suppresses, so a second failure in the same chat still rings.
   */
  private readonly reported = new Set<string>()

  /**
   * The notice this event is, or none.
   *
   * **Quiet, not `done`.** The moment worth interrupting somebody for is the
   * chat having nothing left to do, and that is `busy: false` — a `done` only
   * ends a *turn*, and a message sent mid-turn is queued behind it, so
   * announcing `done` would call somebody back to a chat that is still typing.
   * A failure is the exception and is announced as it happens: whatever is
   * queued behind a turn that failed is worth knowing about late rather than
   * not at all.
   */
  read(event: WorktreeChatEvent): ChatNotice | null {
    const { chatId } = event

    if (event.type === "ask") {
      if (this.asking.has(chatId)) return null
      this.asking.add(chatId)
      return { kind: "asks", chatId }
    }

    // The question is off the screen either way — answered, or dead with the
    // process that asked it.
    if (event.type === "decision") {
      this.asking.delete(chatId)
      return null
    }

    if (event.type === "done") {
      this.asking.delete(chatId)
      if (!event.error) return null
      this.reported.add(chatId)
      return { kind: "failed", chatId, error: event.error }
    }

    if (event.type !== "busy") return null

    if (event.busy) {
      this.working.add(chatId)
      return null
    }

    if (!this.working.delete(chatId)) return null
    // The failure already rang; this is the same turn arriving as silence.
    if (this.reported.delete(chatId)) return null
    return { kind: "done", chatId }
  }

  /** Everything held about a chat that has been deleted, or whose session was
   * closed. A chat reaped mid-thought would otherwise leave a `working` entry
   * that never clears, and its next turn would ring one notice short. */
  forget(chatId: string): void {
    this.working.delete(chatId)
    this.asking.delete(chatId)
    this.reported.delete(chatId)
  }
}

/** What a notice says, given the chat's name. The wording is here rather than
 * at the call site so `test/notify.ts` can hold it to it. */
export function noticeText(
  notice: ChatNotice,
  title: string
): { title: string; body: string } {
  if (notice.kind === "asks") return { title, body: "Waiting for your answer." }
  if (notice.kind === "failed") return { title, body: notice.error }
  return { title, body: "Finished." }
}
