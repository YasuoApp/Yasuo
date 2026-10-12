import type { WorktreeChat } from "../src/shared/api"
import {
  activityLabel,
  activityOf,
  activityTitle,
  isRunning,
} from "../src/renderer/lib/worktree-chat/running"
import { check, finish, section } from "./harness"

/**
 * How many of a project's chats are answering, and how many have stopped to
 * ask.
 *
 * Worth a test for one rule: a chat with a question up is `busy` *and* asking,
 * and counting it in both columns turns three chats into five things happening
 * — while drawing a "1 working" and a "1 waiting" that are the same
 * conversation. The row in `projects-section.tsx` already resolves that the
 * same way, and the two must not drift: the row is what somebody checks the
 * count against.
 */

/** Only the id is read, and a fixture built out of the whole record would be a
 * test that breaks when an unrelated field is added. */
const chat = (id: string): WorktreeChat => ({ id }) as WorktreeChat

const three = [chat("a"), chat("b"), chat("c")]

section("counting")
{
  const activity = activityOf(three, [], {})
  check("an idle project counts nothing", activity.working === 0)
  check("and has nothing waiting", activity.waiting === 0)
  check("so there is nothing to draw", !isRunning(activity))
}
{
  const activity = activityOf(three, ["a", "b"], {})
  check("two answering are two working", activity.working === 2)
  check("and none waiting", activity.waiting === 0)
  check("which is something to draw", isRunning(activity))
}
{
  // The case the rule is for: `b` is busy *and* has a question up.
  const activity = activityOf(three, ["a", "b"], { b: {} })
  check("a chat with a question up is not also working", activity.working === 1)
  check("it is waiting", activity.waiting === 1)
  check(
    "so the two columns sum to the chats running",
    activity.working + activity.waiting === 2
  )
}
{
  // An ask can outlive the `busy` it arrived under — a reload drops `sending`
  // and keeps nothing else — so waiting must not depend on being in `sending`.
  const activity = activityOf(three, [], { c: {} })
  check(
    "a question with no busy beside it still counts",
    activity.waiting === 1
  )
  check("and is still something to draw", isRunning(activity))
}
{
  const activity = activityOf(three, ["z"], { y: {} })
  check(
    "chats in another project are not counted here",
    activity.working === 0 && activity.waiting === 0
  )
}

section("what the row says")
{
  check(
    "working alone is the number",
    activityLabel({ working: 2, waiting: 0 }) === "2"
  )
  check(
    "waiting alone carries the mark",
    activityLabel({ working: 0, waiting: 1 }) === "1!"
  )
  check(
    "both are separated without a second colour to read",
    activityLabel({ working: 2, waiting: 1 }) === "2 · 1!"
  )
  check(
    "nothing running says nothing",
    activityLabel({ working: 0, waiting: 0 }) === ""
  )
}
{
  check(
    "the spoken version is a sentence, since the width is not the constraint",
    activityTitle({ working: 2, waiting: 1 }) ===
      "2 answering, 1 waiting for your answer"
  )
  check(
    "and says only the half that applies",
    activityTitle({ working: 0, waiting: 1 }) === "1 waiting for your answer"
  )
}

finish()
