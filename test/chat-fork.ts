import { forkPointIn } from "../src/main/chat-fork"
import { check, finish, section } from "./harness"

/**
 * Where an edited message cuts the CLI's session — `main/chat-fork.ts`.
 *
 * Worth a test because the input is the CLI's transcript, which this app does
 * not own: every case below is a shape found in real ones — the abandoned
 * branch an earlier edit leaves, a message typed mid-turn filed as an
 * attachment, a Stop written as a `user` entry nobody typed.
 */

type Line = Record<string, unknown>
let parent: string | null = null
let next = 0
const entry = (fields: Line): Line => {
  const uuid = `u${(next += 1)}`
  const line = { uuid, parentUuid: parent, ...fields }
  parent = uuid
  return line
}
const asked = (text: string) =>
  entry({ type: "user", message: { role: "user", content: text } })
const answered = (text: string) =>
  entry({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  })
const result = () =>
  entry({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
    },
  })
const queued = (prompt: string) =>
  entry({ type: "attachment", attachment: { type: "queued_command", prompt } })
const jsonl = (lines: Line[]) =>
  lines.map((line) => JSON.stringify(line)).join("\n")
const restart = (at: string | null) => {
  parent = at
}

section("a plain conversation")

restart(null)
const lines: Line[] = [
  asked("one"),
  answered("1"),
  asked("two"),
  result(),
  answered("2"),
  asked("three"),
  answered("3"),
]
const text = jsonl(lines)
check(
  "the first message has nothing before it to keep",
  forkPointIn(text, ["one", "two", "three"]) === null
)
check(
  "a later message cuts at the entry before it",
  forkPointIn(text, ["two", "three"]) === lines[1]!.uuid,
  forkPointIn(text, ["two", "three"])
)
check(
  "the last message cuts after the turn before it, tool results included",
  forkPointIn(text, ["three"]) === lines[4]!.uuid
)
check(
  "the mode's sentence ahead of the text does not stop it being found",
  forkPointIn(
    jsonl([
      ...lines,
      asked("Reading is pre-approved here.\n\nfour"),
      answered("4"),
    ]),
    ["four"]
  ) === lines[6]!.uuid
)

section("an edited conversation")

{
  // The CLI keeps the branch an earlier edit abandoned: the live one is what
  // the last entry's parents reach.
  restart(null)
  const kept = [asked("one"), answered("1")]
  const abandoned = [asked("the first try"), answered("2")]
  restart(kept[1]!.uuid as string)
  const branch = [asked("two, again"), answered("2 again")]
  const file = jsonl([...kept, ...abandoned, ...branch])

  check(
    "an abandoned branch is not the conversation",
    forkPointIn(file, ["two, again"]) === kept[1]!.uuid
  )
  check(
    "and a message only on it is not found",
    (() => {
      try {
        forkPointIn(file, ["the first try"])
        return false
      } catch {
        return true
      }
    })()
  )
}

section("what the CLI writes that nobody typed")

{
  restart(null)
  const said = [
    asked("one"),
    answered("working"),
    // Typed while the turn was running: an attachment, not a `user` entry.
    queued("and also this"),
    answered("1"),
    asked("[Request interrupted by user]"),
    asked(
      "<command-message>dev:commit</command-message>\n<command-name>/dev:commit</command-name>\n<command-args>now</command-args>"
    ),
    answered("committed"),
    asked("last"),
  ]
  const file = jsonl(said)

  check(
    "a message typed mid-turn is found as the attachment it is",
    forkPointIn(file, ["and also this", "/dev:commit now", "last"]) ===
      said[1]!.uuid
  )
  check(
    "a slash command is found by its name",
    forkPointIn(file, ["/dev:commit now", "last"]) === said[4]!.uuid
  )
  check(
    "a Stop between two messages is passed over",
    forkPointIn(file, ["last"]) === said[6]!.uuid
  )
  check(
    "a later message the CLI never received does not stop the cut",
    forkPointIn(file, ["and also this", "never sent", "last"]) === said[1]!.uuid
  )
}

section("a transcript being written")

{
  restart(null)
  const said = [asked("one"), answered("1"), asked("two")]
  const file = `${jsonl(said)}\n{"type":"assistant","uuid":"half`
  check(
    "a half-written last line is ignored",
    forkPointIn(file, ["two"]) === said[1]!.uuid
  )
}

finish()
