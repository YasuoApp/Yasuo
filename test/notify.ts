import type { WorktreeChatEvent } from "../src/shared/api"
import { ChatNotices, noticeText, type ChatNotice } from "../src/main/notify"
import { check, finish, section } from "./harness"

/**
 * Which transitions in a chat's event stream are worth interrupting somebody
 * for.
 *
 * Worth a test because every case here is an *edge* read off a stream of
 * states, and the two ways of getting that wrong are both silent: ringing twice
 * for one turn, or holding a chat as working forever so its next quiet is
 * swallowed. Neither shows up in a screenshot.
 *
 * The event fixtures are hand-built rather than taken from a running chat, for
 * the reason `chat-usage.ts` gives: a fixture made out of the real thing only
 * checks the fields we already believed were there.
 */

const busy = (chatId: string, working: boolean): WorktreeChatEvent => ({
  chatId,
  type: "busy",
  busy: working,
})

const done = (
  chatId: string,
  error: string | null = null
): WorktreeChatEvent => ({ chatId, type: "done", error })

const decision = (chatId: string): WorktreeChatEvent => ({
  chatId,
  type: "decision",
  text: "Allowed",
})

/** An ask carries the question, which nothing here reads — only that one is up.
 * Built through `as` rather than filling in a `WorktreeChatAsk` this test would
 * then have to keep up to date. */
const asks = (chatId: string): WorktreeChatEvent =>
  ({ chatId, type: "ask", ask: { chatId } }) as unknown as WorktreeChatEvent

const same = (
  label: string,
  got: ChatNotice | null,
  want: ChatNotice | null
): void => check(label, JSON.stringify(got) === JSON.stringify(want), got)

section("quiet, not done")
{
  const notices = new ChatNotices()
  same("starting work rings nothing", notices.read(busy("a", true)), null)
  same("going quiet does", notices.read(busy("a", false)), {
    kind: "done",
    chatId: "a",
  })
}
{
  const notices = new ChatNotices()
  notices.read(busy("a", true))
  notices.read(busy("a", true))
  same("a repeated busy is not a second turn", notices.read(busy("a", false)), {
    kind: "done",
    chatId: "a",
  })
  same("and the quiet does not repeat", notices.read(busy("a", false)), null)
}
{
  const notices = new ChatNotices()
  notices.read(busy("a", true))
  // A message sent mid-turn is queued behind it, so this is a turn ending and
  // not a chat with nothing left to do.
  same(
    "a turn ending is not the chat going quiet",
    notices.read(done("a")),
    null
  )
}

section("failures")
{
  const notices = new ChatNotices()
  notices.read(busy("a", true))
  same("a failure rings as it happens", notices.read(done("a", "exited 1")), {
    kind: "failed",
    chatId: "a",
    error: "exited 1",
  })
  same(
    "and the quiet behind it is the same turn",
    notices.read(busy("a", false)),
    null
  )
}
{
  const notices = new ChatNotices()
  notices.read(busy("a", true))
  notices.read(done("a", "boom"))
  notices.read(busy("a", false))
  notices.read(busy("a", true))
  same(
    "a failed turn does not swallow the next one's quiet",
    notices.read(busy("a", false)),
    { kind: "done", chatId: "a" }
  )
}

section("questions")
{
  const notices = new ChatNotices()
  same("a question rings", notices.read(asks("a")), {
    kind: "asks",
    chatId: "a",
  })
  same("a redrawn card does not", notices.read(asks("a")), null)
  notices.read(decision("a"))
  same("the next question does", notices.read(asks("a")), {
    kind: "asks",
    chatId: "a",
  })
}
{
  const notices = new ChatNotices()
  notices.read(asks("a"))
  // Stop, or a failure: the process that would have taken the answer is gone,
  // and so is the card.
  notices.read(done("a"))
  same("a turn ending takes the question with it", notices.read(asks("a")), {
    kind: "asks",
    chatId: "a",
  })
}

section("one watcher, several chats")
{
  const notices = new ChatNotices()
  notices.read(busy("a", true))
  notices.read(busy("b", true))
  same("b's quiet is b's", notices.read(busy("b", false)), {
    kind: "done",
    chatId: "b",
  })
  same("and a is still working", notices.read(busy("a", false)), {
    kind: "done",
    chatId: "a",
  })
}
{
  const notices = new ChatNotices()
  notices.read(busy("a", true))
  // Deleted mid-turn: no `busy: false` is coming, and an entry left behind
  // would swallow the first quiet of whatever reused the id.
  notices.forget("a")
  same("a forgotten chat holds nothing", notices.read(busy("a", false)), null)
}

/*
 * The same watcher read the other way round — as a standing count rather than
 * as edges, which is what the menu bar's icon draws. Worth its own section
 * because the two readings share the sets underneath: a bug in `forget` or in
 * "waiting wins" shows up here as a number nobody can clear, and the icon is
 * exactly where a stuck number is most visible.
 */
section("what is happening right now")
{
  const notices = new ChatNotices()
  const pending = (label: string, working: string[], waiting: string[]) =>
    check(
      label,
      JSON.stringify(notices.pending()) ===
        JSON.stringify({ working, waiting }),
      notices.pending()
    )

  pending("nothing to begin with", [], [])
  notices.read(busy("a", true))
  notices.read(busy("b", true))
  pending("two chats answering", ["a", "b"], [])

  notices.read(asks("b"))
  // b is still `busy` — the turn has not ended — and it is one thing to do, not
  // two things happening.
  pending("a question takes its chat out of working", ["a"], ["b"])

  notices.read(decision("b"))
  pending("answering it puts the chat back to work", ["a", "b"], [])

  notices.read(busy("a", false))
  pending("quiet leaves the count", ["b"], [])

  notices.forget("b")
  pending("and so does being deleted mid-turn", [], [])
}

section("what a notice says")
{
  const say = (notice: ChatNotice) => noticeText(notice, "Fix the parser")
  check(
    "the chat's name is the title",
    say({ kind: "done", chatId: "a" }).title === "Fix the parser"
  )
  check(
    "quiet says so plainly",
    say({ kind: "done", chatId: "a" }).body === "Finished."
  )
  check(
    "a question says what is wanted",
    say({ kind: "asks", chatId: "a" }).body === "Waiting for your answer."
  )
  check(
    "a failure carries the error rather than a word for it",
    say({ kind: "failed", chatId: "a", error: "exited 1" }).body === "exited 1"
  )
}

finish()
