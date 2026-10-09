import type { AssistantMessage, TurnUsage } from "../src/shared/api"
import { spendRows } from "../src/main/chat-digest"
import { check, finish, section } from "./harness"

/**
 * A chat's turns read as the cost dashboard's rows.
 *
 * Every case below is a line the transcript *has* being read as something it
 * does not say: a `Read` is not a bill, and a turn with no cost on it is not a
 * free turn.
 *
 * The lines are hand-built rather than taken from a real chat: a fixture made
 * out of the real thing only checks the fields we already believed were there.
 */

let next = 0
const id = () => `m${(next += 1)}`

const tool = (name: string, path: string): AssistantMessage => ({
  id: id(),
  role: "tool",
  name,
  summary: path,
  path,
})

const said = (role: "user" | "assistant", text: string): AssistantMessage => ({
  id: id(),
  role,
  text,
})

const usage = (costUsd: number | null): AssistantMessage => ({
  id: id(),
  role: "usage",
  usage: {
    model: "claude-opus-5",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    costUsd,
    context: null,
    durationMs: null,
  } satisfies TurnUsage,
})

section("one row per turn, for the dashboard")
{
  const chat = {
    id: "c1",
    title: "Fix the build",
    folderId: "f1",
    updatedAt: "2026-09-30T10:00:00.000Z",
  }
  const stamped: AssistantMessage = {
    ...usage(0.25),
    at: "2026-09-29T08:00:00.000Z",
  }
  const rows = spendRows(chat, [
    said("user", "hi"),
    stamped,
    usage(null),
    tool("Read", "/x"),
  ])
  check("usage lines only", rows.length === 2, rows)
  check(
    "a stamped line keeps its own time",
    rows[0]?.at === "2026-09-29T08:00:00.000Z" && rows[0]?.costUsd === 0.25,
    rows[0]
  )
  check(
    "an unstamped line falls back to the chat's updatedAt",
    rows[1]?.at === chat.updatedAt && rows[1]?.costUsd === null,
    rows[1]
  )
  check(
    "the chat's title and project ride along",
    rows.every((row) => row.title === chat.title && row.folderId === "f1"),
    rows
  )
}

finish()
