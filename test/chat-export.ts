import type { AssistantMessage, TurnUsage } from "../src/shared/api"
import {
  chatToMarkdown,
  fileNameOf,
  toolItemOf,
} from "../src/renderer/lib/worktree-chat/export"
import { check, finish, section } from "./harness"

/**
 * A chat written out as Markdown.
 *
 * The cases are the shapes a transcript on disk holds rather than anything
 * about how the file looks: a line written before `at` existed, a tool call
 * whose result never came, a usage line that counted nothing, a change whose
 * text holds a fence of its own. Each of them has a way of producing a document
 * that renders wrong somewhere a reader cannot see from here.
 */

/** A local moment, as the ISO string a line carries — local because `timeOf`
 * draws local time and the test runs on whichever machine it runs on. */
function local(hour: number, minute: number): string {
  return new Date(2026, 8, 29, hour, minute).toISOString()
}

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  model: "claude-opus-5",
  input: 10,
  cacheWrite: 0,
  cacheRead: 38_790,
  output: 108,
  thinking: 0,
  costUsd: 0.0054,
  context: null,
  durationMs: null,
  ...over,
})

const chat = { title: "Fix the flaky test?", createdAt: local(14, 0) }

const lines: AssistantMessage[] = [
  {
    id: "u1",
    role: "user",
    text: "Look at @test/files.ts, why flaky?",
    at: local(14, 5),
  },
  {
    id: "t1",
    role: "thinking",
    text: "The watcher races the write.\n\nCheck it.",
    at: local(14, 5),
  },
  {
    id: "c1",
    role: "tool",
    name: "Bash",
    summary: "npm test",
    title: "Run the suite",
    result: "12 lines",
    input: "npm test",
    output: "…",
    at: local(14, 6),
  },
  {
    id: "c2",
    role: "tool",
    name: "Read",
    summary: "/repo/test/files.ts",
    path: "/repo/test/files.ts",
    result: "631 lines",
    at: local(14, 6),
  },
  {
    id: "c3",
    role: "tool",
    name: "Edit",
    summary: "/repo/test/files.ts",
    path: "/repo/test/files.ts",
    stat: "+3 −1",
    result: "The file /repo/test/files.ts has been updated.",
    change: "-await write()\n+await write()\n+await settled()\n```",
    at: local(14, 7),
  },
  {
    id: "c4",
    role: "tool",
    name: "Bash",
    summary: "npm test",
    failed: true,
    result: "Command failed with exit code 1",
    at: local(14, 8),
  },
  { id: "k1", role: "ask", text: "Allowed Bash: npm test", at: local(14, 8) },
  {
    id: "a1",
    role: "assistant",
    text: "Done — it **was** the watcher.",
    at: local(14, 9),
  },
  { id: "s1", role: "usage", usage: usage(), at: local(14, 9) },
  {
    id: "e1",
    role: "error",
    text: "claude exited 1\nno session",
    at: local(14, 10),
  },
  {
    id: "p1",
    role: "compact",
    trigger: "auto",
    preTokens: 120_000,
    postTokens: 30_000,
    at: local(14, 11),
  },
]

section("the heading")
{
  const md = chatToMarkdown(chat, [], { project: "yasuo" })
  check("the title is the h1", md.startsWith("# Fix the flaky test?\n"), md)
  check("the project is under it", md.includes("Project: yasuo"), md)
  check("and so is the date", md.includes("2026"), md)
  check(
    "an empty title still has a heading",
    chatToMarkdown({ title: "  ", createdAt: "" }, []).startsWith(
      "# Untitled chat"
    )
  )
  check(
    "a chat with no usage lines has no totals footer",
    !md.includes("Total:"),
    md
  )
}

section("the lines")
{
  const md = chatToMarkdown(chat, lines)
  check(
    "a user line is You with its time",
    md.includes("**You** · 14:05\n\nLook at @test/files.ts, why flaky?"),
    md
  )
  check(
    "a reply is Claude with the markdown verbatim",
    md.includes("**Claude** · 14:09\n\nDone — it **was** the watcher."),
    md
  )
  check(
    "thinking is a details block that renders its body",
    md.includes(
      "<details>\n<summary>Thinking</summary>\n\nThe watcher races the write.\n\nCheck it.\n\n</details>"
    ),
    md
  )
  check(
    "a tool call is one list item with the description leading",
    md.includes("- 🔧 Run the suite — `npm test` → 12 lines"),
    md
  )
  check(
    "consecutive calls share a list",
    md.includes(
      "- 🔧 Run the suite — `npm test` → 12 lines\n- 🔧 Read — `/repo/test/files.ts` → 631 lines"
    ),
    md
  )
  check(
    "an edit says how much it moved, not the CLI's sentence",
    md.includes("- 🔧 Edit — `/repo/test/files.ts` → +3 −1") &&
      !md.includes("has been updated"),
    md
  )
  check(
    "and its change is a diff fence longer than the fence inside it",
    md.includes(
      "````diff\n-await write()\n+await write()\n+await settled()\n```\n````"
    ),
    md
  )
  check(
    "a failed call is marked and keeps the error",
    md.includes("- ❌ Bash — `npm test` → Command failed with exit code 1"),
    md
  )
  check(
    "the call after a change starts a list of its own",
    md.includes("````\n\n- ❌ Bash"),
    md
  )
  check("an ask is a quote", md.includes("> 🛡️ Allowed Bash: npm test"), md)
  check(
    "an error is a quote on every line",
    md.includes("> ⚠️ **Error:** claude exited 1\n> no session"),
    md
  )
  check(
    "a usage line is muted, with the estimate",
    md.includes("_Opus 5 · 38.8k prompt, 100% cached · 108 out · $0.0054_"),
    md
  )
  check(
    "a compaction is a rule with the window's figures",
    md.includes("---\n\n_Auto-compacted · 120k → 30.0k_"),
    md
  )
  check(
    "the totals close the file",
    md
      .trimEnd()
      .endsWith(
        "_Total: 1 turn · Opus 5 · 38.8k prompt, 100% cached · 108 out · $0.0054_"
      ),
    md.slice(-120)
  )
  check(
    "and the file ends in one newline",
    md.endsWith("_\n") && !md.endsWith("\n\n")
  )
}

section("lines written before stamps, and other gaps")
{
  const md = chatToMarkdown(chat, [
    { id: "u", role: "user", text: "hello" },
    { id: "c", role: "tool", name: "Grep", summary: "foo" },
    {
      id: "g",
      role: "tool",
      name: "Agent",
      summary: "Explore",
      title: "Find the watcher",
      result: "done",
    },
    { id: "a", role: "assistant", text: "hi" },
    {
      id: "s",
      role: "usage",
      usage: usage({
        model: null,
        input: 0,
        cacheRead: 0,
        output: 0,
        costUsd: null,
      }),
    },
  ])
  check(
    "a user line without a stamp is the name alone",
    md.includes("**You**\n\nhello"),
    md
  )
  check("and so is a reply", md.includes("**Claude**\n\nhi"), md)
  check(
    "a call still waiting on its result has no arrow",
    md.includes("- 🔧 Grep — `foo`\n"),
    md
  )
  check(
    "a subagent names itself and its errand",
    md.includes("- 🤖 Agent — Explore — Find the watcher → done"),
    md
  )
  check(
    "a turn that counted nothing says so, with no price",
    md.includes("_nothing counted_") && !md.includes("$"),
    md
  )
}

section("the item's code span")
{
  check(
    "a backtick in the argument widens the span",
    toolItemOf({ id: "x", role: "tool", name: "Bash", summary: "echo `x`" }) ===
      "🔧 Bash — `` echo `x` ``",
    toolItemOf({ id: "x", role: "tool", name: "Bash", summary: "echo `x`" })
  )
  check(
    "a multi-line command is one line",
    toolItemOf({
      id: "x",
      role: "tool",
      name: "Bash",
      summary: "cd a &&\n  npm test",
    }) === "🔧 Bash — `cd a && ⏎ npm test`"
  )
  check(
    "an MCP tool is named by server and verb",
    toolItemOf({
      id: "x",
      role: "tool",
      name: "mcp__linear__create_issue",
      summary: "",
    }) === "🔧 linear · create issue"
  )
}

section("the file name")
{
  check(
    "a title slugs",
    fileNameOf("Fix the flaky test?", "md") === "fix-the-flaky-test.md"
  )
  check(
    "accents fold",
    fileNameOf("Café résumé", "html") === "cafe-resume.html"
  )
  check("nothing left is chat", fileNameOf("???", "md") === "chat.md")
  check(
    "and a long one is cut without a trailing hyphen",
    fileNameOf("a".repeat(59) + " bcd", "md") === "a".repeat(59) + ".md"
  )
}

finish()
