import type { AssistantMessage } from "../src/shared/api"
import {
  currentEntry,
  labelOf,
  outlineOf,
} from "../src/renderer/lib/worktree-chat/outline"
import { check, finish, section } from "./harness"

/**
 * A chat's table of contents — what counts as an entry, what a row says, and
 * which one the reader is in.
 */

section("only the user's lines are entries")
{
  const lines: AssistantMessage[] = [
    { id: "u1", role: "user", text: "Fix the login bug", at: "2026-10-08" },
    { id: "a1", role: "assistant", text: "Done." },
    { id: "t1", role: "thinking", text: "hmm" },
    { id: "u2", role: "user", text: "Now add a test" },
  ]
  const outline = outlineOf(lines)
  check("two entries", outline.length === 2, outline)
  check("in order, by line id", outline.map((e) => e.id).join() === "u1,u2")
  check("carries the stamp", outline[0]?.at === "2026-10-08")
}

section("a row is the first line with something on it")
{
  check("first line", labelOf("Title\nmore detail") === "Title")
  check("skips blank lines", labelOf("\n\n  \nHello") === "Hello")
  check("collapses whitespace", labelOf("a   b\tc") === "a b c")
  check(
    "drops picture tags",
    labelOf("[Image #1] why is this red?") === "why is this red?"
  )
  check(
    "a message of pictures alone",
    labelOf("[Image #1]\n[Image #2]") === "Image"
  )
  check("nothing at all", labelOf("   ") === "(empty message)")

  const long = labelOf("x".repeat(200))
  check("trimmed to a row", long.length === 80 && long.endsWith("…"), long)
}

section("the current entry")
{
  check("none at all", currentEntry([], 0) === -1)
  check("before the first, the first", currentEntry([100, 300], 50) === 0)
  check("the last one reached", currentEntry([0, 100, 300], 150) === 1)
  check("exactly on one counts", currentEntry([0, 100, 300], 300) === 2)
  check("unmeasured is skipped", currentEntry([0, null, 300], 150) === 0)
}

finish()
