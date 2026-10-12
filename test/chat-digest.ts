import type { AssistantMessage, TurnUsage } from "../src/shared/api"
import { spendRows } from "../src/main/chat-digest"
import { check, finish, section } from "./harness"

/**
 * A chat's turns read as the cost dashboard's rows.
 *
 * Every case below is a line the transcript *has* being read as something it
 * does not say: a `Read` is not a turn, and a turn's tokens are every side of
 * its prompt plus what came back.
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

const usage = (tokens: {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}): AssistantMessage => ({
  id: id(),
  role: "usage",
  usage: {
    model: "claude-opus-5",
    ...tokens,
    thinking: 0,
    costUsd: null,
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
    ...usage({ input: 10, cacheWrite: 200, cacheRead: 3000, output: 40 }),
    at: "2026-09-29T08:00:00.000Z",
  }
  const rows = spendRows(chat, [
    said("user", "hi"),
    stamped,
    usage({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }),
    tool("Read", "/x"),
  ])
  check("usage lines only", rows.length === 2, rows)
  check(
    "a stamped line keeps its own time",
    rows[0]?.at === "2026-09-29T08:00:00.000Z" &&
      rows[0]?.tokens === 3250 &&
      rows[0]?.cacheRead === 3000 &&
      rows[0]?.output === 40,
    rows[0]
  )
  check(
    "an unstamped line falls back to the chat's updatedAt",
    rows[1]?.at === chat.updatedAt && rows[1]?.tokens === 0,
    rows[1]
  )
  check(
    "the chat's title and project ride along",
    rows.every((row) => row.title === chat.title && row.folderId === "f1"),
    rows
  )
}

finish()
