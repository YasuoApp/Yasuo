import type { WorktreeChat, WorktreeChatEvent } from "../src/shared/api"
import {
  isWatched,
  marksUnread,
  unreadIn,
} from "../src/renderer/lib/worktree-chat/unread"
import { check, finish, section } from "./harness"

/**
 * Which chats are left with something unread in them.
 *
 * Worth a test because both ways of getting it wrong look like nothing rather
 * than like a bug: a dot that never lights is a feature that appears not to
 * exist, and one that never goes out is a column permanently claiming news.
 *
 * The rule it holds is the same one `test/notify.ts` holds for the banner —
 * **quiet, not `done`** — and the two must not drift: a dot and a notification
 * disagreeing about one turn is the app contradicting itself about whether
 * anything happened.
 */

/** Only the id is read, and a fixture built out of the whole record would be a
 * test that breaks when an unrelated field is added. */
const chat = (id: string): WorktreeChat => ({ id }) as WorktreeChat

/** Nobody is looking at anything — the case a background chat finishes in. */
const away = { selectedId: null, focused: false }

const quiet = (chatId: string): WorktreeChatEvent => ({
  type: "busy",
  busy: false,
  chatId,
})
const busy = (chatId: string): WorktreeChatEvent => ({
  type: "busy",
  busy: true,
  chatId,
})

section("what leaves a chat unread")
{
  check(
    "a working chat going quiet is the mark",
    marksUnread(quiet("a"), { ...away, sending: ["a"] })
  )
  check(
    "a chat starting work is not",
    !marksUnread(busy("a"), { ...away, sending: [] })
  )
  check(
    "and neither is quiet repeated — `busy` is a state, and the same value arrives twice",
    !marksUnread(quiet("a"), { ...away, sending: [] })
  )
}
{
  // The rule the notice is read by, held here for the same reason: a turn
  // ending is not the chat going quiet, because a message sent mid-turn is
  // queued and the turn behind it starts on its own.
  check(
    "a turn ending is not the chat finishing",
    !marksUnread(
      { type: "done", error: null, chatId: "a" },
      {
        ...away,
        sending: ["a"],
      }
    )
  )
  check(
    "but a turn that failed is marked as it happens",
    marksUnread(
      { type: "done", error: "claude died", chatId: "a" },
      {
        ...away,
        sending: ["a"],
      }
    )
  )
}
{
  // The shield outranks the dot everywhere it is drawn, and an ask stays in
  // `asks` until it is answered — so there is nothing here to remember for it.
  check(
    "a question up is drawn by the shield, not by this",
    !marksUnread(
      { type: "ask", ask: {} as never, chatId: "a" },
      {
        ...away,
        sending: ["a"],
      }
    )
  )
  check(
    "a line landing mid-turn is not news yet",
    !marksUnread(
      { type: "text", text: "hello", chatId: "a" },
      {
        ...away,
        sending: ["a"],
      }
    )
  )
}

section("what counts as looking at it")
{
  check(
    "the selected chat in a focused window is being read",
    isWatched("a", { selectedId: "a", focused: true })
  )
  check(
    "the same chat with the window in the background is not",
    !isWatched("a", { selectedId: "a", focused: false })
  )
  check(
    "and neither is another chat in a focused window",
    !isWatched("b", { selectedId: "a", focused: true })
  )
}
{
  check(
    "so the chat on screen is never marked",
    !marksUnread(quiet("a"), {
      selectedId: "a",
      focused: true,
      sending: ["a"],
    })
  )
  check(
    "the chat behind the one on screen is",
    marksUnread(quiet("b"), {
      selectedId: "a",
      focused: true,
      sending: ["b"],
    })
  )
  check(
    "and so is the one on screen while the window is in the background — which is the notification's case too",
    marksUnread(quiet("a"), {
      selectedId: "a",
      focused: false,
      sending: ["a"],
    })
  )
}

section("what a shut project's row counts")
{
  const three = [chat("a"), chat("b"), chat("c")]
  check("nothing unread counts nothing", unreadIn(three, {}) === 0)
  check("two of three", unreadIn(three, { a: true, c: true }) === 2)
  check(
    "a chat in another project is not counted here",
    unreadIn(three, { z: true }) === 0
  )
}

finish()
