import type { AssistantMessage } from "../src/shared/api"
import {
  commandOf,
  distinctFiles,
  groupOutcome,
  splitStat,
  statOf,
  rowOf,
  rowsOf,
  toolLabel,
  type ToolLine,
} from "../src/renderer/lib/worktree-chat/tool-row"
import { check, finish, section } from "./harness"

/**
 * A tool call as a row — verb, object, outcome — and an open fold's rows,
 * with runs of like calls merged into one.
 *
 * Worth a test because the table in `rowOf` is the one place a tool's name
 * becomes a word on screen, and the merge is a shape of transcript: which
 * calls sit together, which never do, and what breaks a run.
 */

let next = 0
const id = () => `l${(next += 1)}`

const tool = (
  name: string,
  fields: Partial<Omit<ToolLine, "id" | "role" | "name">> = {}
): ToolLine => ({ id: id(), role: "tool", name, summary: "", ...fields })
const said = (text: string): AssistantMessage => ({
  id: id(),
  role: "assistant",
  text,
})

section("one grammar for every tool")

{
  const row = rowOf(
    tool("Read", {
      summary: "/a/README.md",
      path: "/a/README.md",
      result: "89 lines",
    })
  )
  check(
    "a read is a verb, a file and a count",
    row.verb === "Read" &&
      row.object?.kind === "file" &&
      row.object.path === "/a/README.md" &&
      row.outcome === "89 lines",
    row
  )
}

{
  const row = rowOf(
    tool("Bash", {
      summary: "bun test",
      title: "Run the suite",
      result: "12 lines",
    })
  )
  check(
    "a command leads with a verb, not with its description",
    row.verb === "Ran" &&
      row.object?.kind === "code" &&
      row.object.text === "bun test",
    row
  )
  check(
    "and the description is the hover line",
    row.caption === "Run the suite"
  )
}

check(
  "a command's chip drops the CLI's leading cd",
  commandOf("cd /Users/x/repo; bun test") === "bun test" &&
    commandOf("cd /Users/x/repo && bun test") === "bun test" &&
    commandOf('cd "/Users/x/my repo"; ls') === "ls"
)
check(
  "but not a cd that is the command",
  commandOf("cd /tmp") === "cd /tmp" &&
    commandOf("ls; cd /tmp") === "ls; cd /tmp"
)
{
  const object = rowOf(tool("Bash", { summary: "cd /r; git status" })).object
  check(
    "and the row's chip is the command, not the hop",
    object?.kind === "code" && object.text === "git status",
    object
  )
}

{
  const row = rowOf(
    tool("Edit", {
      summary: "/a/b.ts",
      path: "/a/b.ts",
      stat: "+3 −1",
      result: "The file /a/b.ts has been updated.",
    })
  )
  check("an edit's outcome is how much it moved", row.outcome === "+3 −1")
  check(
    "but the sentence comes back when it failed",
    rowOf(
      tool("Edit", {
        summary: "/a/b.ts",
        path: "/a/b.ts",
        stat: "+3 −1",
        result: "old_string not found",
        failed: true,
      })
    ).outcome === "old_string not found"
  )
}

{
  const row = rowOf(
    tool("Agent", { summary: "Explore", title: "Find the watcher" })
  )
  check(
    "an agent's object is which agent and its brief, as a sentence",
    row.verb === "Agent" &&
      row.object?.kind === "text" &&
      row.object.text === "Explore · Find the watcher",
    row
  )
}

check(
  "an MCP tool reads as its server and what it did",
  rowOf(tool("mcp__linear__create_issue", { summary: '{"title":"x"}' }))
    .verb === "linear · create issue"
)
check(
  "and its arguments are prose, not code",
  rowOf(tool("mcp__linear__create_issue", { summary: '{"title":"x"}' })).object
    ?.kind === "text"
)
check("a plain name survives toolLabel", toolLabel("Skill") === "Skill")

check(
  "a tool this app has no word for reads under its own name",
  rowOf(tool("Frobnicate", { summary: "x" })).verb === "Frobnicate"
)
check(
  "a call with nothing to say has no object",
  rowOf(tool("Skill")).object === null
)
check(
  "a call still out has no outcome",
  rowOf(tool("Read", { summary: "/a", path: "/a" })).outcome === ""
)

section("an open fold's rows")

{
  const rows = rowsOf([
    tool("Read", { summary: "/a", path: "/a" }),
    tool("Read", { summary: "/b", path: "/b" }),
    tool("Read", { summary: "/c", path: "/c" }),
    said("now the edit"),
    tool("Edit", { summary: "/a", path: "/a", stat: "+1" }),
  ])
  check(
    "three reads are one row, the narration its own, one edit itself",
    rows.map((row) => row.kind).join(" ") === "group line line",
    rows.map((row) => row.kind)
  )
  check(
    "the merged row says its verb and holds its calls",
    rows[0]?.kind === "group" &&
      rows[0].verb === "Read" &&
      rows[0].lines.length === 3
  )
  check(
    "and counts files when every call was about one",
    rows[0]?.kind === "group" && groupOutcome(rows[0].lines) === "3 files"
  )
}

check(
  "a run of one is the row itself",
  rowsOf([tool("Read", { summary: "/a", path: "/a" })])[0]?.kind === "line"
)

check(
  "a read and a search do not merge",
  rowsOf([
    tool("Read", { summary: "/a", path: "/a" }),
    tool("Grep", { summary: "foo" }),
  ]).length === 2
)

check(
  "two searches do, whichever tool made them",
  rowsOf([tool("Grep", { summary: "foo" }), tool("Glob", { summary: "*.ts" })])
    .length === 1
)
check(
  "and a row of searches counts calls",
  groupOutcome([
    tool("Grep", { summary: "foo" }),
    tool("Glob", { summary: "*" }),
  ]) === "2 calls"
)

check(
  "commands never merge",
  rowsOf([tool("Bash", { summary: "a" }), tool("Bash", { summary: "b" })])
    .length === 2
)

check(
  "an agent is a row of its own between two reads",
  rowsOf([
    tool("Read", { summary: "/a", path: "/a" }),
    tool("Agent", { summary: "Explore" }),
    tool("Read", { summary: "/b", path: "/b" }),
  ])
    .map((row) => row.kind)
    .join() === "line,line,line"
)

check(
  "a failed call is never folded into a run",
  rowsOf([
    tool("Read", { summary: "/a", path: "/a" }),
    tool("Read", { summary: "/b", path: "/b", failed: true, result: "ENOENT" }),
    tool("Read", { summary: "/c", path: "/c" }),
  ])
    .map((row) => row.kind)
    .join() === "line,line,line"
)

check("an empty fold is no rows", rowsOf([]).length === 0)

section("how much an edit moved")

check(
  "a stat is read back as numbers",
  JSON.stringify(statOf("+3 −1")) === JSON.stringify({ added: 3, removed: 1 })
)
check(
  "one side alone",
  statOf("+83")?.removed === 0 && statOf("−2")?.added === 2 - 2
)
check("a count is not a stat", statOf("89 lines") === null)
check("nor is a hyphen", statOf("-1") === null)

{
  const split = splitStat("3 files · +20 −5")
  check(
    "a merged row splits at its stat",
    split.head === "3 files · " &&
      split.stat?.added === 20 &&
      split.stat.removed === 5,
    split
  )
  check("a bare stat has no head", splitStat("+3 −1").head === "")
  check("a count has no stat", splitStat("89 lines").stat === null)
}

check(
  "a row of edits sums what they moved",
  groupOutcome([
    tool("Edit", { summary: "/a", path: "/a", stat: "+3 −1" }),
    tool("Edit", { summary: "/b", path: "/b", stat: "+2" }),
  ]) === "2 files · +5 −1"
)
{
  const edits = [
    tool("Edit", { summary: "/a", path: "/a", stat: "+3 −1" }),
    tool("Edit", { summary: "/a", path: "/a", stat: "+2" }),
    tool("Edit", { summary: "/b", path: "/b", stat: "−4" }),
  ]
  check(
    "five edits to one file are one file, summed",
    groupOutcome(edits.slice(0, 2)) === "1 file · +5 −1"
  )
  check(
    "and a row's chips are one per file",
    distinctFiles(edits)
      .map((line) => line.path)
      .join() === "/a,/b"
  )
  check(
    "while calls with no path keep a chip each",
    distinctFiles([
      tool("Grep", { summary: "a" }),
      tool("Grep", { summary: "a" }),
    ]).length === 2
  )
}
check(
  "and says only the count when one of them has none",
  groupOutcome([
    tool("Edit", { summary: "/a", path: "/a", stat: "+3 −1" }),
    tool("Edit", { summary: "/b", path: "/b" }),
  ]) === "2 files"
)

finish()
