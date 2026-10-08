import { readPlanUsage } from "../src/main/plan-usage"
import {
  headlineWindow,
  percent,
  planName,
  resetLabel,
  usageTone,
  windowLabel,
  windowShort,
} from "../src/renderer/lib/worktree-chat/plan-usage"
import { check, finish, section } from "./harness"

/**
 * The composer's plan-usage meter: what the CLI's `/usage` answer is narrowed
 * to (`readPlanUsage`, main's half) and the words the button and popover say.
 *
 * The answer comes off an API the SDK itself marks experimental, so what is
 * worth a test is the narrowing: an unknown window kept, a malformed one
 * dropped, an account with no plan read as "not available" rather than as zero.
 */

const now = new Date("2026-10-08T10:00:00Z")

section("readPlanUsage")
{
  const answer = readPlanUsage(
    {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.4, resets_at: "2026-10-08T12:30:00Z" },
        seven_day: { utilization: 130, resets_at: null },
        seven_day_opus: { utilization: 7, resets_at: "not a date" },
        seven_day_oauth_apps: null,
        future_window: { utilization: 3 },
        broken: { utilization: "lots" },
      },
    },
    now
  )
  check("available", answer.available && answer.error === null)
  check("subscription", answer.subscription === "max")
  check(
    "keeps every window with a number, unknown ones too",
    answer.windows.map((w) => w.id).join() ===
      "five_hour,seven_day,seven_day_opus,future_window",
    answer.windows
  )
  check(
    "clamps to 0–100",
    answer.windows.find((w) => w.id === "seven_day")?.utilization === 100
  )
  check(
    "an unreadable reset time is no reset time",
    answer.windows.find((w) => w.id === "seven_day_opus")?.resetsAt === null
  )
  check("stamped", answer.at === now.toISOString())

  const apiKey = readPlanUsage(
    {
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    },
    now
  )
  check(
    "an API key is not available, and not an error",
    !apiKey.available && apiKey.error === null && apiKey.windows.length === 0
  )
  check("nothing readable is an error", readPlanUsage(null, now).error !== null)
}

section("words")
{
  check("labels", windowLabel("five_hour") === "5-hour")
  check("an unknown key", windowLabel("ten_day_haiku") === "ten day haiku")
  check(
    "short",
    windowShort("five_hour") === "5h" && windowShort("seven_day") === "7d"
  )
  check("percent", percent(42.6) === "43%")
  check("plan name", planName("max") === "Max" && planName(null) === null)
  check(
    "tone",
    usageTone(10) === "ok" &&
      usageTone(80) === "warn" &&
      usageTone(95) === "high"
  )
}

section("the headline window")
{
  check("none", headlineWindow([]) === null)
  check(
    "five-hour first",
    headlineWindow([
      { id: "seven_day", utilization: 90, resetsAt: null },
      { id: "five_hour", utilization: 10, resetsAt: null },
    ])?.id === "five_hour"
  )
  check(
    "otherwise the fullest",
    headlineWindow([
      { id: "seven_day", utilization: 20, resetsAt: null },
      { id: "seven_day_opus", utilization: 60, resetsAt: null },
    ])?.id === "seven_day_opus"
  )
}

section("resetLabel")
{
  check("none", resetLabel(null, now) === null)
  check("past", resetLabel("2026-10-08T09:00:00Z", now) === "resets now")
  check("minutes", resetLabel("2026-10-08T10:12:30Z", now) === "resets in 13m")
  check(
    "hours and minutes",
    resetLabel("2026-10-08T12:30:00Z", now) === "resets in 2h 30m"
  )
  check(
    "whole hours",
    resetLabel("2026-10-08T13:00:00Z", now) === "resets in 3h"
  )
  check(
    "past a day it names the day",
    resetLabel("2026-10-11T10:00:00Z", now)?.startsWith("resets ") === true &&
      !resetLabel("2026-10-11T10:00:00Z", now)?.includes(" in ")
  )
}

finish()
