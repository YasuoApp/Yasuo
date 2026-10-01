import type { ChatSpend } from "../src/shared/api"
import {
  byChat,
  byDay,
  byModel,
  byProject,
  dayKey,
  daysIn,
  NONE,
  OTHER,
  rangeOf,
  stacksOf,
  totals,
} from "../src/renderer/lib/worktree-chat/spend"
import {
  budgetLabel,
  capLabel,
  overBudget,
} from "../src/renderer/lib/worktree-chat/usage"
import { check, finish, section } from "./harness"

/**
 * The cost dashboard's folds.
 *
 * The cases are the two quiet failures `spend.ts` is written against: a turn
 * near midnight filed under the wrong day because the day was cut in UTC, and
 * a turn that reported no estimate counted as a free one. Everything here is
 * built with the local-time `Date` constructor, so the checks hold in whatever
 * zone the test runs in — a fixture written as ISO strings would pass in UTC
 * and fail in Tokyo, which is the bug under test.
 */

/** Tuesday 2026-09-29, mid-morning local. */
const now = new Date(2026, 8, 29, 10, 30)

const local = (
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0
) => new Date(year, month - 1, day, hour, minute).toISOString()

let n = 0
const row = (
  partial: Partial<ChatSpend> & { at: string; costUsd: number | null }
): ChatSpend => ({
  chatId: `chat-${(n += 1)}`,
  title: `Chat ${n}`,
  folderId: "f1",
  model: "claude-sonnet-4-5-20250929",
  ...partial,
})

const rows: ChatSpend[] = [
  // Today, two turns in one chat, two models.
  row({
    chatId: "a",
    title: "Fix the build",
    at: local(2026, 9, 29, 9),
    costUsd: 0.5,
  }),
  row({
    chatId: "a",
    title: "Fix the build (renamed)",
    at: local(2026, 9, 29, 10),
    costUsd: 1.5,
    model: "claude-opus-4-1-20250805",
  }),
  // Yesterday, one minute before midnight local — the row the UTC cut moves.
  row({
    chatId: "b",
    title: "Late night",
    at: local(2026, 9, 28, 23, 59),
    costUsd: 2,
    folderId: "f2",
  }),
  // Six days ago, the last day inside `7d`; no project, no model, unpriced.
  row({
    chatId: "c",
    title: "Crashed",
    at: local(2026, 9, 23, 8),
    costUsd: null,
    folderId: null,
    model: null,
  }),
  // Seven days ago, the first day outside `7d`.
  row({
    chatId: "d",
    title: "Last week",
    at: local(2026, 9, 22, 8),
    costUsd: 4,
  }),
  // Forty days ago, outside `30d`.
  row({ chatId: "e", title: "Old", at: local(2026, 8, 20, 8), costUsd: 8 }),
]

section("days are local calendar days")

check("dayKey pads", dayKey(new Date(2026, 0, 5)) === "2026-01-05")

const week = byDay(rows, 7, now)
check(
  "seven days, oldest first, every one present",
  week.length === 7 &&
    week[0]!.day === "2026-09-23" &&
    week[6]!.day === "2026-09-29",
  week.map((d) => d.day)
)
check(
  "23:59 last night is yesterday, not today",
  week[5]!.total === 2 && week[6]!.total === 2,
  week.map((d) => [d.day, d.total])
)
check(
  "an unpriced turn is counted but adds nothing",
  week[0]!.turns === 1 && week[0]!.total === 0,
  week[0]
)
check(
  "a day is broken down by model and by project",
  week[6]!.models["claude-opus-4-1-20250805"] === 1.5 &&
    week[6]!.models["claude-sonnet-4-5-20250929"] === 0.5 &&
    week[6]!.projects.f1 === 2,
  week[6]
)
check(
  "rows outside the window are left out",
  week.reduce((sum, d) => sum + d.turns, 0) === 4
)
check("at least one day", byDay(rows, 0, now).length === 1)

section("the stack is the top series, then Other")

const stack = stacksOf(week, "models", 1)
check(
  "the dearest key is kept and the rest fold",
  stack.series.length === 2 &&
    stack.series[0] === "claude-sonnet-4-5-20250929" &&
    stack.series[1] === OTHER,
  stack.series
)
check(
  "values follow the series order per day",
  stack.values[6]!.length === 2 &&
    stack.values[6]![0] === 0.5 &&
    stack.values[6]![1] === 1.5,
  stack.values
)
check(
  "no Other when everything fits",
  !stacksOf(week, "models", 5).series.includes(OTHER)
)
check(
  "a quiet day is zeroes in every series",
  stacksOf(week, "projects").values[1]!.every((v) => v === 0)
)

section("ranges")

check("today is one day", rangeOf(rows, "today", now).length === 2)
check(
  "7d is today and the six before it",
  rangeOf(rows, "7d", now)
    .map((r) => r.chatId)
    .join() === "a,a,b,c"
)
check(
  "30d drops the forty-day-old turn",
  rangeOf(rows, "30d", now).length === 5
)
check("all is everything", rangeOf(rows, "all", now).length === rows.length)
check(
  "all spans from the earliest turn, never under a week",
  daysIn("all", rows, now) === 41 && daysIn("all", [], now) === 7,
  daysIn("all", rows, now)
)
check(
  "a row with an unreadable date is left out of a range",
  rangeOf([row({ at: "nope", costUsd: 1 })], "7d", now).length === 0
)

section("groups are sorted dearest first, with a share of the priced total")

const projects = byProject(rows)
check(
  "by project",
  projects.map((g) => g.key).join() === "f1,f2," + NONE &&
    projects[0]!.costUsd === 14 &&
    projects[0]!.turns === 4,
  projects
)
check(
  "share is of what was priced",
  Math.abs(projects[0]!.share - 14 / 16) < 1e-9 &&
    projects[2]!.share === 0 &&
    projects[2]!.turns === 1,
  projects
)
check(
  "by model keys a missing model as NONE",
  byModel(rows).some((g) => g.key === NONE && g.turns === 1)
)

const chats = byChat(rows)
check(
  "by chat, dearest first, under the latest title",
  chats[0]!.key === "e" &&
    chats.find((c) => c.key === "a")!.title === "Fix the build (renamed)",
  chats.map((c) => [c.key, c.title, c.costUsd])
)
check(
  "a chat's project rides along",
  chats.find((c) => c.key === "c")!.folderId === null
)

section("totals")

const sum = totals(rows)
check(
  "spend, turns, chats, unpriced",
  sum.costUsd === 16 &&
    sum.turns === 6 &&
    sum.chats === 5 &&
    sum.unpriced === 1,
  sum
)
check(
  "nothing is nothing",
  JSON.stringify(totals([])) ===
    JSON.stringify({ costUsd: 0, turns: 0, chats: 0, unpriced: 0 })
)

section("the budget button's words")

check(
  "a cap is a round figure",
  capLabel(5) === "$5" && capLabel(2.5) === "$2.50"
)
check("spent of cap", budgetLabel(1.234, 5) === "$1.23 / $5")
check("nothing spent yet", budgetLabel(null, 20) === "$0 / $20")
check(
  "over budget on the cap itself, never without one",
  overBudget(5, 5) &&
    !overBudget(4.99, 5) &&
    !overBudget(50, null) &&
    !overBudget(null, 5)
)

finish()
