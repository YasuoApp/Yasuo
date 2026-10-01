import type { ChatBlame, Snapshot } from "../src/shared/api"
import {
  BLAME_COLORS,
  colorOf,
  hoverOf,
  labelOf,
  runsOf,
} from "../src/renderer/lib/files/blame"
import { check, finish, section } from "./harness"

/**
 * The blame gutter's pure half: how a per-line answer becomes the runs it
 * labels, the lane a chat is drawn in, and the words on a cell and its hover.
 */

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  id: "s1",
  folderId: "f1",
  chatId: "c1",
  kind: "turn",
  turn: 3,
  prompt: "Fix the build on main, the typecheck is red",
  lineId: "m7",
  tree: "t",
  changed: true,
  at: "2026-10-01T09:30:00.000Z",
  ...over,
})

const chats: ChatBlame["chats"] = { c1: { title: "Fix the build" } }

section("runsOf folds consecutive lines of one snapshot")
{
  check("empty", runsOf([]).length === 0)
  check(
    "one run per stretch, gaps are not runs",
    JSON.stringify(runsOf(["a", "a", null, "a", "b", "b"])) ===
      JSON.stringify([
        { from: 0, to: 2, snapshotId: "a" },
        { from: 3, to: 4, snapshotId: "a" },
        { from: 4, to: 6, snapshotId: "b" },
      ])
  )
  check("all unwritten is no runs", runsOf([null, null]).length === 0)
  const single = runsOf(["z"])
  check(
    "a single line is a one-line run",
    single.length === 1 && single[0]?.from === 0 && single[0]?.to === 1
  )
}

section("colorOf is stable and inside the palette")
{
  const ids = ["c1", "c2", "abc-123", "", "a-very-long-chat-identifier"]
  check(
    "same id, same lane",
    ids.every((id) => colorOf(id) === colorOf(id))
  )
  check(
    "every lane is 0..7",
    ids.every((id) => {
      const lane = colorOf(id)
      return Number.isInteger(lane) && lane >= 0 && lane < BLAME_COLORS
    })
  )
  const lanes = new Set(
    Array.from({ length: 64 }, (_, i) => colorOf(`chat-${i}`))
  )
  check("ids spread over more than one lane", lanes.size > 1, [...lanes])
}

section("labelOf names the chat and the turn")
{
  check(
    "title · turn n",
    labelOf(snapshot(), chats) === "Fix the build · turn 3"
  )
  check(
    "a chat the answer has no title for",
    labelOf(snapshot({ chatId: "gone" }), chats) === "Untitled chat · turn 3"
  )
  check(
    "a before snapshot says so",
    labelOf(snapshot({ kind: "before", turn: 2 }), chats) ===
      "Fix the build · before turn 3"
  )
  check(
    "a rewind says so",
    labelOf(snapshot({ kind: "rewind" }), chats) === "Fix the build · rewind"
  )
}

section("hoverOf is the label, the prompt and the time")
{
  const hover = hoverOf(snapshot(), chats)
  const lines = hover.split("\n")
  check("first line is the label", lines[0] === "Fix the build · turn 3")
  check(
    "second line is the prompt",
    lines[1] === "Fix the build on main, the typecheck is red"
  )
  check("third line is the time", lines.length === 3 && lines[2]!.length > 0)

  const long = hoverOf(snapshot({ prompt: "x".repeat(400) }), chats)
  const excerpt = long.split("\n")[1] ?? ""
  check(
    "a long prompt is cut with an ellipsis",
    excerpt.length <= 160 && excerpt.endsWith("…"),
    excerpt.length
  )
  check(
    "whitespace in the prompt is folded",
    hoverOf(snapshot({ prompt: "a\n\n  b" }), chats).split("\n")[1] === "a b"
  )
  check(
    "no prompt, no prompt line",
    hoverOf(snapshot({ prompt: null }), chats).split("\n").length === 2
  )
  check(
    "an unreadable time is left out",
    hoverOf(snapshot({ prompt: null, at: "never" }), chats).split("\n")
      .length === 1
  )
}

finish()
