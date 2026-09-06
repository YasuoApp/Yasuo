import type { AssistantMessage } from "../src/shared/api"
import { hitsIn } from "../src/renderer/lib/worktree-chat/search"
import { check, finish, section } from "./harness"

/**
 * `⌘F` over the conversation on screen — what it counts as a match.
 *
 * Two things are worth a test here. What it deliberately does *not* search: a
 * transcript is mostly not speech, so tool calls carry the paths and commands a
 * conversation is about and a thinking line is the model talking to itself, and
 * taking either would answer "where did it say that" with rows nobody said.
 *
 * And the **unit**, which this got wrong once: a match is an *occurrence*, not a
 * message. The bar counts what it has painted, so a word said twice in one
 * message has to be two — a count arguing with the highlights under it is the
 * bug this file exists to keep out.
 */

let next = 0
const id = () => `m${(next += 1)}`

const said = (role: "user" | "assistant", text: string): AssistantMessage => ({
  id: id(),
  role,
  text,
})
const thought = (text: string): AssistantMessage => ({
  id: id(),
  role: "thinking",
  text,
})
const tool = (name: string, summary: string): AssistantMessage => ({
  id: id(),
  role: "tool",
  name,
  summary,
})

section("one match per occurrence")
{
  const messages = [said("user", "hi there, hi again"), said("assistant", "hi")]
  const hits = hitsIn(messages, "hi")
  check("twice in one message is two", hits.length === 3, hits)
  check(
    "each says which message and which occurrence in it",
    JSON.stringify(hits) ===
      JSON.stringify([
        { messageId: messages[0]?.id, nth: 0 },
        { messageId: messages[0]?.id, nth: 1 },
        { messageId: messages[1]?.id, nth: 0 },
      ]),
    hits
  )
}
{
  // The painter counts the same way, or the two would line up wrong: `aa` in
  // `aaaa` is two marks, not three overlapping ones.
  check(
    "overlapping runs are not counted twice",
    hitsIn([said("user", "aaaa")], "aa").length === 2
  )
}

section("what is searched")
{
  const messages = [
    said("user", "how does the migration run"),
    said("assistant", "It runs the schema migration first."),
    thought("migration migration"),
    tool("Read", "/repo/migration.ts"),
  ]
  const hits = hitsIn(messages, "migration")
  check(
    "the two voices, and nothing else",
    hits.length === 2 && hits.every((hit) => hit.messageId !== messages[2]?.id),
    hits
  )
}
{
  // The order is the count's meaning: `3 of 12` is the third one down the page.
  const messages = [
    said("assistant", "needle"),
    said("user", "nothing"),
    said("user", "needle"),
  ]
  check(
    "in the order they were said",
    JSON.stringify(hitsIn(messages, "needle").map((hit) => hit.messageId)) ===
      JSON.stringify([messages[0]?.id, messages[2]?.id])
  )
}

section("what counts as a match")
check(
  "case is not the question",
  hitsIn([said("user", "Migration")], "migration").length === 1
)
check(
  // Literal, the way `⌘F` is everywhere else — a phrase is a phrase, and the
  // words of it scattered through a line are not a match.
  "the query is one run of text, not a set of words",
  hitsIn([said("user", "the schema and the migration")], "schema migration")
    .length === 0
)
check(
  "spaces inside it are part of it",
  hitsIn([said("user", "one two")], "e t").length === 1
)
check(
  "a line that says none of it is not a match",
  hitsIn([said("user", "nothing here")], "migration").length === 0
)
check(
  "an empty query finds nothing",
  hitsIn([said("user", "x")], "").length === 0
)
check(
  "a single character is a real search",
  hitsIn([said("user", "aXa")], "x").length === 1
)

finish()
