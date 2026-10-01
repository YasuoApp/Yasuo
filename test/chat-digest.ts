import type { AssistantMessage, ChatDigest, TurnUsage } from "../src/shared/api"
import { digestOf, pathsTouched, spendOf } from "../src/main/chat-digest"
import { spentIn } from "../src/renderer/lib/worktree-chat/digests"
import { check, finish, section } from "./harness"

/**
 * A chat read as a whole: which files it wrote to, and what it cost.
 *
 * Worth a test for the reason `chat-usage.ts` gives about sums, and for one of
 * its own: every case below is a line the transcript *has* being read as
 * something it does not say. A `Read` is not a write. A failed `Edit` changed
 * nothing. A turn with no cost on it is not a free turn. Each of those wrong
 * would be quiet — a filter pointing at the wrong conversation, a total that
 * looks complete.
 *
 * The lines are hand-built rather than taken from a real chat: a fixture made
 * out of the real thing only checks the fields we already believed were there.
 */

let next = 0
const id = () => `m${(next += 1)}`

const tool = (
  name: string,
  path: string | undefined,
  failed?: boolean
): AssistantMessage => ({
  id: id(),
  role: "tool",
  name,
  summary: path ?? "",
  ...(path ? { path } : {}),
  ...(failed ? { failed } : {}),
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

section("which files a chat wrote to")
{
  const messages = [
    tool("Read", "/repo/src/a.ts"),
    tool("Edit", "/repo/src/a.ts"),
    tool("Write", "/repo/src/b.ts"),
  ]
  check(
    "a read is not a write",
    JSON.stringify(pathsTouched(messages)) ===
      JSON.stringify(["/repo/src/a.ts", "/repo/src/b.ts"]),
    pathsTouched(messages)
  )
}
{
  const messages = [
    tool("Edit", "/repo/a.ts"),
    tool("Edit", "/repo/a.ts"),
    tool("MultiEdit", "/repo/a.ts"),
  ]
  check(
    "one file however many edits",
    pathsTouched(messages).length === 1,
    pathsTouched(messages)
  )
}
{
  const messages = [
    tool("Edit", "/repo/a.ts", true),
    tool("Write", "/repo/b.ts"),
  ]
  check(
    "a refused edit touched nothing",
    JSON.stringify(pathsTouched(messages)) === JSON.stringify(["/repo/b.ts"]),
    pathsTouched(messages)
  )
}
{
  // No result yet, so no `failed` either way: it is about to land, and the list
  // is re-read when it does.
  const messages = [tool("Write", "/repo/a.ts")]
  check("an edit still running counts", pathsTouched(messages).length === 1)
}
{
  const messages = [
    tool("Bash", undefined),
    tool("NotebookEdit", "/repo/n.ipynb"),
  ]
  check(
    "a tool with no path is skipped",
    JSON.stringify(pathsTouched(messages)) ===
      JSON.stringify(["/repo/n.ipynb"]),
    pathsTouched(messages)
  )
}

section("what it cost")
{
  const messages = [usage(0.5), usage(0.25), usage(null)]
  const spend = spendOf(messages)
  check("priced turns are summed", Math.abs(spend.costUsd - 0.75) < 1e-9, spend)
  check("every turn is counted", spend.turns === 3, spend)
  check("a turn with no figure is not a free turn", spend.unpriced === 1, spend)
}
{
  const spend = spendOf([said("user", "hello")])
  check(
    "a chat with no usage line cost nothing and ran no turns",
    spend.turns === 0 && spend.costUsd === 0,
    spend
  )
}

section("the record a caller reads")
{
  const digest = digestOf({ id: "c1", folderId: "f1" }, [
    tool("Edit", "/repo/a.ts"),
    usage(0.1),
  ])
  check(
    "the chat and its project come through",
    digest.chatId === "c1" && digest.folderId === "f1",
    digest
  )
  check(
    "with both folds on it",
    digest.paths.length === 1 && digest.turns === 1
  )
}

/*
 * And the other side of the bridge: what the system bar makes of those folds.
 * Here rather than in a file of their own because this is the file that would
 * have to change if the shape did.
 */

const digest = (
  chatId: string,
  folderId: string | null,
  paths: string[],
  costUsd = 0
): ChatDigest => ({
  chatId,
  folderId,
  paths,
  costUsd,
  turns: costUsd > 0 ? 1 : 0,
  unpriced: 0,
})

section("what the workspace has spent")
{
  const digests = [
    digest("c1", "f1", [], 1.5),
    digest("c2", "f2", [], 0.5),
    { ...digest("c3", "f1", [], 0), unpriced: 2, turns: 2 },
  ]
  check(
    "every project by default",
    spentIn(digests).costUsd === 2,
    spentIn(digests)
  )
  check("one when it is named", spentIn(digests, "f1").costUsd === 1.5)
  check(
    "turns that could not be priced are carried, not folded in",
    spentIn(digests).unpriced === 2 && spentIn(digests).turns === 4,
    spentIn(digests)
  )
}

finish()
