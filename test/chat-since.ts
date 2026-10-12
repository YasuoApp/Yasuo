import {
  dateTimeOf,
  dayBreak,
  dayLabel,
  elapsed,
  since,
  timeOf,
} from "../src/renderer/lib/worktree-chat/since"
import { check, finish, section } from "./harness"

/**
 * The `9h` in the corner of a chat's row.
 *
 * Worth a test for the boundaries rather than the arithmetic: every one of them
 * is a `<` against a constant, and the failure they guard against is the label
 * that reads as missing data — a `0m` on a chat answered a second ago, an empty
 * corner where a record's field was written by an older build, a `-1m` on a
 * machine whose clock has just been corrected backwards.
 *
 * `now` is passed in rather than mocked, which is the reason this is a function
 * of two arguments at all: a helper that read the clock itself could only be
 * tested by waiting.
 */

const NOW = Date.parse("2026-08-26T12:00:00.000Z")

/** `ms` before `NOW`, as the ISO string a record holds. */
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const YEAR = 365 * DAY

section("since: the width a row can spare")

check("under a minute is a word, not a zero", since(ago(30_000), NOW) === "now")
check("a minute is a minute", since(ago(MINUTE), NOW) === "1m")
check("and it counts down to the hour", since(ago(59 * MINUTE), NOW) === "59m")
check("an hour turns over", since(ago(HOUR), NOW) === "1h")
check("the screenshot's 9h", since(ago(9 * HOUR), NOW) === "9h")
check("and its 23h, one short of a day", since(ago(23 * HOUR), NOW) === "23h")
check("a day turns over", since(ago(DAY), NOW) === "1d")
check("days run to the week", since(ago(6 * DAY), NOW) === "6d")
check("then weeks", since(ago(WEEK), NOW) === "1w")
check("weeks run to the year", since(ago(51 * WEEK), NOW) === "51w")

section("the ends")

check("a year is not a count", since(ago(YEAR), NOW) === "1y+")
check("nor is a decade", since(ago(12 * YEAR), NOW) === "1y+")
check(
  "a clock that went backwards is still now",
  since(new Date(NOW + HOUR).toISOString(), NOW) === "now"
)
check("a field that never arrived draws nothing", since("", NOW) === "")
check("and neither does one holding something else", since("soon", NOW) === "")

section("truncation, not rounding")

check(
  "90 minutes is 1h rather than 2h",
  since(ago(HOUR + 30 * MINUTE), NOW) === "1h"
)
check(
  "and 47 hours is 1d rather than 2d",
  since(ago(2 * DAY - HOUR), NOW) === "1d"
)

/**
 * The stopwatch beside `Working…`. Every case here is a carry — the field
 * widths are what the label lives or dies by, since it is read while it moves.
 */
section("elapsed: the clock under the spinner")

check("a turn that has just started", elapsed(NOW, NOW) === "0s")
check("a second in", elapsed(NOW - 1_000, NOW) === "1s")
check("truncated, not rounded", elapsed(NOW - 7_900, NOW) === "7s")
check("seconds run to the minute", elapsed(NOW - 59_000, NOW) === "59s")
check("a minute carries", elapsed(NOW - MINUTE, NOW) === "1m0s")
check("and keeps the seconds beside it", elapsed(NOW - 65_000, NOW) === "1m5s")
check(
  "minutes run to the hour",
  elapsed(NOW - (59 * MINUTE + 59_000), NOW) === "59m59s"
)
check("an hour carries", elapsed(NOW - HOUR, NOW) === "1h0m0s")
check(
  "the middle unit is kept even at zero",
  elapsed(NOW - (HOUR + 5_000), NOW) === "1h0m5s"
)
check(
  "an hour, a minute and six seconds",
  elapsed(NOW - (HOUR + MINUTE + 6_000), NOW) === "1h1m6s"
)
check("and no cap on the hours", elapsed(NOW - 30 * HOUR, NOW) === "30h0m0s")
check(
  "a clock that went backwards reads zero, not -1",
  elapsed(NOW + MINUTE, NOW) === "0s"
)

/**
 * The stamp on a line. Built in **local** time, so the fixtures are made from
 * local parts rather than ISO literals: a `T14:05Z` literal is `14:05` in
 * London and `23:05` in Tokyo, and the test has to pass on both machines.
 */
section("timeOf and dateTimeOf: the stamp on a line")

/** A local moment, as the ISO string a line carries. */
function local(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0
): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

check(
  "the hour and minute, padded",
  timeOf(local(2026, 9, 29, 9, 5)) === "09:05"
)
check(
  "twenty-four hours, no AM",
  timeOf(local(2026, 9, 29, 23, 59)) === "23:59"
)
check("a line without a readable stamp draws nothing", timeOf("") === "")
check("and neither does nonsense", timeOf("soon") === "")
check(
  "the full form names the year",
  dateTimeOf(local(2026, 9, 29, 9, 5)).includes("2026"),
  dateTimeOf(local(2026, 9, 29, 9, 5))
)
check("and is empty for nothing", dateTimeOf("") === "")

/**
 * The divider between days. The cases are the calendar's edges rather than
 * spans of hours: ten minutes across midnight is two days, and twenty-three
 * hours inside one is none.
 */
section("dayLabel and dayBreak: the divider between days")

const TODAY = new Date(2026, 8, 30, 15, 0).getTime() // Wed 30 Sep 2026, 15:00

check("today is a word", dayLabel(local(2026, 9, 30, 1), TODAY) === "Today")
check(
  "so is yesterday, even at 23:59",
  dayLabel(local(2026, 9, 29, 23, 59), TODAY) === "Yesterday"
)
check(
  "earlier this year is weekday, day and month",
  dayLabel(local(2026, 9, 28), TODAY) === "Mon 28 Sep",
  dayLabel(local(2026, 9, 28), TODAY)
)
check(
  "and another year says which",
  dayLabel(local(2025, 12, 31), TODAY) === "Wed 31 Dec 2025",
  dayLabel(local(2025, 12, 31), TODAY)
)
check("an unreadable stamp has no label", dayLabel("", TODAY) === "")

check(
  "ten minutes across midnight is a break",
  dayBreak(local(2026, 9, 29, 23, 55), local(2026, 9, 30, 0, 5))
)
check(
  "twenty-three hours inside a day is not",
  !dayBreak(local(2026, 9, 30, 0, 30), local(2026, 9, 30, 23, 30))
)
check(
  "a line without a stamp never breaks the day",
  !dayBreak(undefined, local(2026, 9, 30)) &&
    !dayBreak(local(2026, 9, 29), undefined)
)
check("nor does an unreadable one", !dayBreak("soon", local(2026, 9, 30)))

finish()
