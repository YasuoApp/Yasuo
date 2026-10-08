import type { AssistantMessage } from "@shared/api"
import { isAgentTool } from "./activity"
import { dateTimeOf, timeOf } from "./since"
import { money, totalOf, usageLine } from "./usage"
import { compactLine } from "./window"

/**
 * A chat as a Markdown document: the file `Export as Markdown…` writes, and
 * what `Copy as Markdown` puts on the clipboard.
 *
 * **Why Markdown and not the JSON on disk.** The transcript file is this app's
 * own shape, read by this app, and what somebody exporting a chat wants is to
 * paste it into a pull request, an issue or a wiki — places that render
 * Markdown and nothing else. So the reply is carried *verbatim*, since it is
 * already Markdown, and everything that is not a reply is written in the
 * smallest form the destination still renders: a tool call is one list item, a
 * change is a `diff` fence, thinking is a `<details>` the reader can leave shut,
 * which is the fold the pane draws it in.
 *
 * Pure, so `test/chat-export.ts` can feed it the shapes a transcript holds —
 * a line written before `at` existed, a tool call still waiting on its result,
 * a usage line that counted nothing — rather than anything about the dialog.
 */

export type ExportChat = {
  title: string
  createdAt: string
}

export type ExportOptions = {
  /** The project's name for the heading — the folder the chat ran in. */
  project?: string
}

export function chatToMarkdown(
  chat: ExportChat,
  lines: AssistantMessage[],
  options: ExportOptions = {}
): string {
  const blocks: string[] = [headingOf(chat, options)]

  // Consecutive tool calls are one list; anything else between them is a
  // paragraph that ends the list. Tracked so the item after a change's fence
  // starts a list of its own rather than a line dangling under a fence.
  let listing = false

  for (const line of lines) {
    const block = blockOf(line)
    if (block === null) continue
    if (line.role === "tool" && listing && !line.change) {
      // Continue the list without the blank line a new block gets.
      blocks[blocks.length - 1] += `\n${block}`
    } else {
      blocks.push(block)
    }
    listing = line.role === "tool" && !line.change
  }

  const footer = footerOf(lines)
  if (footer) blocks.push("---", footer)

  return blocks.join("\n\n") + "\n"
}

function headingOf(chat: ExportChat, options: ExportOptions): string {
  const facts: string[] = []
  if (options.project) facts.push(`Project: ${options.project}`)
  const when = dateTimeOf(chat.createdAt)
  if (when) facts.push(when)
  const title = `# ${chat.title.trim() || "Untitled chat"}`
  return facts.length > 0 ? `${title}\n\n_${facts.join(" · ")}_` : title
}

function blockOf(line: AssistantMessage): string | null {
  switch (line.role) {
    case "user":
      // The `@path` mentions stay as typed: they were the words of the message
      // and a reader of the export is owed exactly what was asked.
      return `${speaker(line.step ? `Workflow · ${line.step}` : "You", line.at)}\n\n${line.text}`
    case "step": {
      const mark = line.status === "failed" ? "❌" : "⚙️"
      const item = `- ${mark} **${line.label}** — \`${line.summary}\``
      return line.output ? `${item}\n\n${fence("", line.output)}` : item
    }
    case "assistant":
      return `${speaker("Claude", line.at)}\n\n${line.text}`
    case "thinking":
      // The blank lines inside are what lets Markdown render the body as
      // Markdown — without them GitHub shows the raw text in one run.
      return `<details>\n<summary>Thinking</summary>\n\n${line.text}\n\n</details>`
    case "tool": {
      const item = `- ${toolItemOf(line)}`
      return line.change ? `${item}\n\n${fence("diff", line.change)}` : item
    }
    case "error":
      return quote(`⚠️ **Error:** ${line.text}`)
    case "ask":
      return quote(`🛡️ ${line.text}`)
    case "usage": {
      const cost =
        line.usage.costUsd === null ? "" : ` · ${money(line.usage.costUsd)}`
      return `_${usageLine(line.usage)}${cost}_`
    }
    case "compact":
      return `---\n\n_${compactLine(line)}_`
    case "workflow":
      return quote(
        `⚙️ Workflow ${line.status}${line.error ? ` — ${line.error}` : ""}`
      )
  }
}

/** `**You** · 14:05`, or the name alone for a line written before stamps. */
function speaker(name: string, at?: string): string {
  const time = at ? timeOf(at) : ""
  return time ? `**${name}** · ${time}` : `**${name}**`
}

/**
 * A chat's totals, for the last line: the same words the pane's own usage row
 * uses, with the estimate on the end. Null for a chat that never wrote a usage
 * line, so an older transcript ends on its last message rather than on a
 * footer saying it was free.
 */
function footerOf(lines: AssistantMessage[]): string | null {
  const total = totalOf(lines)
  if (!total) return null
  const cost = total.costUsd === null ? "" : ` · ${money(total.costUsd)}`
  return `_Total: ${usageLine(total)}${cost}_`
}

/** One tool call read as a row: the pieces both exports draw, in the words the
 * pane's own row uses, so a reader of the export recognises the transcript. */
export type ToolRow = {
  /** What the row leads with: the model's description, or the tool's name. */
  label: string
  /** The argument it was about — a path, a command. Empty where there is
   * none worth showing beside the label. */
  argument: string
  /** What came back, one line: a `+3 −1`, a count, the error. */
  said: string
  failed: boolean
  agent: boolean
}

export function toolRowOf(
  line: Extract<AssistantMessage, { role: "tool" }>
): ToolRow {
  const agent = isAgentTool(line.name)
  // The same rule as the pane's `ToolRow`: an edit says how much it moved, and
  // the CLI's own sentence comes back only when the call failed.
  const said = (line.failed ? line.result : (line.stat ?? line.result)) ?? ""
  return {
    label: agent ? "Agent" : (line.title ?? toolName(line.name)),
    argument: agent
      ? [line.summary, line.title].filter(Boolean).join(" — ")
      : line.summary,
    said,
    failed: line.failed === true,
    agent,
  }
}

/**
 * `- 🔧 Bash — \`npm test\` → 12 lines`.
 *
 * The glyph is the one fact the eye scans a list of calls for — what ran, or
 * failed, or was a subagent — and three emoji are the three marks a file with
 * no icons can carry.
 */
export function toolItemOf(
  line: Extract<AssistantMessage, { role: "tool" }>
): string {
  const row = toolRowOf(line)
  const mark = row.failed ? "❌" : row.agent ? "🤖" : "🔧"
  const parts = [`${mark} ${row.label}`]
  if (row.argument) parts.push(row.agent ? row.argument : code(row.argument))
  const head = parts.join(" — ")
  return row.said ? `${head} → ${row.said}` : head
}

/**
 * `mcp__linear__create_issue` as `linear · create issue` — the pane's
 * `toolLabel`, written again here because that one lives beside twenty SVG
 * marks in `chat-marks.tsx`, and a pure module the test imports under `bun`
 * should not have to load them to name a tool.
 */
function toolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!mcp) return name
  return `${mcp[1]!} · ${mcp[2]!.replaceAll("_", " ")}`
}

/** A code span that survives a backtick in the text, and a newline in it: a
 * multi-line command is one line in the list, with the whole of it a fence
 * away in the pane. */
function code(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ⏎ ").trim()
  const longest = Math.max(
    0,
    ...[...flat.matchAll(/`+/g)].map((m) => m[0].length)
  )
  if (longest === 0) return `\`${flat}\``
  // Padded, because a span whose text ends in a backtick would otherwise run
  // its last backtick into the closing fence.
  const ticks = "`".repeat(longest + 1)
  return `${ticks} ${flat} ${ticks}`
}

/** A fenced block whose fence is longer than any run of backticks inside it,
 * which is what keeps a diff of a Markdown file from closing it early. */
function fence(language: string, text: string): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length)
  )
  const ticks = "`".repeat(longest + 1)
  return `${ticks}${language}\n${text}\n${ticks}`
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}

/**
 * A file name for the chat: `fix-the-flaky-test.md`.
 *
 * Lower-cased ASCII and hyphens, capped at sixty characters, because the name
 * goes into a save dialog on whatever filesystem the user has and a title is a
 * sentence with a question mark in it. `chat` when nothing survives — a title
 * of only punctuation, or one in a script the fold drops.
 */
export function fileNameOf(title: string, extension: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")
  return `${slug || "chat"}.${extension}`
}
