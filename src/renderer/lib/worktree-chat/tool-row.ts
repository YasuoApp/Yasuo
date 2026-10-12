import type { AssistantMessage } from "@shared/api"
import { isAgentTool } from "./activity"

/**
 * One tool call as the row says it, in one grammar for every tool.
 *
 * **Why one grammar.** A row used to be four slots — mark, lead, result,
 * chip — and what filled each slot changed with the tool: `Read` led with its
 * name and `Bash` with a sentence of description, the result sat between the
 * verb and the thing it was about (`Read · 89 lines · README.md`), and the
 * last slot was a file chip, a bare command, or a call's JSON depending on
 * which tool had made it. Six hundred rows of that in one transcript and the
 * eye cannot build a column, which is what "the tool calls look messy" meant.
 *
 * So every row is **verb · object · outcome**, in that order and that order
 * only. The verb is a short fixed word for the kind of thing that happened,
 * the object is the one thing it happened to, and the outcome is what came
 * back, drawn at the far right where a status column goes. The model's own
 * description of a command, which was the lead, is the row's hover line: it
 * is a sentence about the call rather than the call.
 *
 * Pure, and tested in `test/tool-row.ts`, because the table below is the one
 * place a tool's name becomes a word on screen — the fold's marks are the
 * other half of that, in `chat-marks.tsx`.
 */

export type ToolLine = Extract<AssistantMessage, { role: "tool" }>

/** What the row is about, drawn as one chip. */
export type RowObject =
  /** A file, drawn by name with its file-type icon and the path on hover. */
  | { kind: "file"; path: string }
  /** Something that ran or was matched — a command, a pattern, a query —
   * drawn in monospace. */
  | { kind: "code"; text: string }
  /** A sentence — a todo item, an agent's brief — drawn as prose. */
  | { kind: "text"; text: string }

export type ToolRowWords = {
  verb: string
  /**
   * Which rows this one may be merged with when consecutive — see `rowsOf`.
   * Null for a kind that is always its own row: a command is read one at a
   * time, and an agent opens onto a transcript of its own.
   */
  group: string | null
  object: RowObject | null
  /** What came back, one line: `89 lines`, `+3 −1`, the error. Empty while
   * the call is out. */
  outcome: string
  /** The model's own sentence about the call, for the hover line. */
  caption?: string
}

/** A verb and whether rows of it merge, by tool name. A tool not listed
 * reads under its own name and never merges. */
const VERBS: Record<string, { verb: string; group?: string }> = {
  Read: { verb: "Read", group: "Read" },
  NotebookRead: { verb: "Read", group: "Read" },
  Edit: { verb: "Edit", group: "Edit" },
  MultiEdit: { verb: "Edit", group: "Edit" },
  NotebookEdit: { verb: "Edit", group: "Edit" },
  Write: { verb: "Write", group: "Write" },
  Bash: { verb: "Ran" },
  BashOutput: { verb: "Read output" },
  Glob: { verb: "Searched", group: "Searched" },
  Grep: { verb: "Searched", group: "Searched" },
  WebSearch: { verb: "Searched web" },
  WebFetch: { verb: "Fetched" },
  TodoWrite: { verb: "Todo" },
  Skill: { verb: "Skill" },
}

export function rowOf(line: ToolLine): ToolRowWords {
  // The CLI's own sentence comes back only when the call failed — the one
  // time "could not find old_string" is the thing worth reading — and an
  // edit's `+3 −1` stands in for it otherwise.
  const outcome = (line.failed ? line.result : (line.stat ?? line.result)) ?? ""

  if (isAgentTool(line.name)) {
    // Which agent ran and what it was asked, as one sentence: the brief is
    // the object here, not a parameter of it.
    const brief = [line.summary, line.title].filter(Boolean).join(" · ")
    return {
      verb: "Agent",
      group: null,
      object: brief ? { kind: "text", text: brief } : null,
      outcome,
    }
  }

  const known = VERBS[line.name]
  const verb = known?.verb ?? toolLabel(line.name)
  const group = known?.group ?? null
  const caption = line.title

  if (line.path) {
    return {
      verb,
      group,
      object: { kind: "file", path: line.path },
      outcome,
      ...(caption ? { caption } : {}),
    }
  }

  // A todo's summary is the item in progress, which is a sentence; so is
  // whatever an MCP tool was given, which is its arguments' JSON and reads no
  // better in monospace. Everything else ran or matched something.
  const prose = line.todos !== undefined || line.name.startsWith("mcp__")
  const object: RowObject | null = line.summary
    ? { kind: prose ? "text" : "code", text: line.summary }
    : null

  return {
    verb,
    group,
    object,
    outcome,
    ...(caption ? { caption } : {}),
  }
}

/**
 * A tool's name as a row says it.
 *
 * The CLI names an MCP tool `mcp__linear__create_issue`, which is precise and
 * unreadable; what a row wants is the server it came from and what it did.
 */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!mcp) return name
  return `${mcp[1]!} · ${mcp[2]!.replaceAll("_", " ")}`
}

/** One row of an *open* fold: a run of like calls merged into one row, or a
 * line drawn as itself. */
export type ActivityRow =
  | { kind: "group"; id: string; verb: string; lines: ToolLine[] }
  | { kind: "line"; id: string; line: AssistantMessage }

/**
 * An open fold's own rows, with consecutive calls of one kind merged.
 *
 * **Why merge rather than fold.** The rows used to be gathered behind a second
 * fold — every run of calls one `3 tool calls` line, so that the narration
 * between runs stayed on one screen. The narration did, but a `Read` was two
 * clicks from a closed turn and a run of one was a fold onto one row. Merging
 * keeps the narration on one screen by the other route: five reads are one
 * row of five chips, which is what the turn did in the words it would be said
 * in, and the row opens onto the five only when one of them is wanted.
 *
 * Only *like* calls merge — reads with reads, searches with searches — and
 * by the verb, so a row never says two things. A failed call is never merged:
 * a failure is what an open fold most needs to show, and inside a row of six
 * chips it would be one chip in red. A run of one is the row itself.
 *
 * A subagent, a command and an MCP call are never merged (`group` is null):
 * each is read on its own, and an agent opens onto its own transcript.
 */
export function rowsOf(lines: AssistantMessage[]): ActivityRow[] {
  const rows: ActivityRow[] = []

  let run: ToolLine[] = []
  let key: string | null = null
  const flush = () => {
    if (run.length === 0) return
    if (run.length === 1) {
      const line = run[0]!
      rows.push({ kind: "line", id: line.id, line })
    } else {
      rows.push({
        // The first line's id: stable across a re-render, and unique because a
        // line id is.
        id: `group-${run[0]!.id}`,
        kind: "group",
        verb: rowOf(run[0]!).verb,
        lines: run,
      })
    }
    run = []
    key = null
  }

  for (const line of lines) {
    const group =
      line.role === "tool" && !line.failed ? rowOf(line).group : null
    if (group === null) {
      flush()
      rows.push({ kind: "line", id: line.id, line })
      continue
    }
    if (key !== group) flush()
    key = group
    run.push(line as ToolLine)
  }
  flush()

  return rows
}

/**
 * A merged row's own outcome: how many of what, and — for a row of edits —
 * how much they moved, summed. Files for a row of file chips, since that is
 * what it looks like; calls otherwise.
 */
export function groupOutcome(lines: ToolLine[]): string {
  const files = lines.every((line) => line.path)
  const n = lines.length
  const count = files ? `${n} files` : `${n} calls`
  const stats = lines.map((line) => (line.failed ? null : statOf(line.stat)))
  if (stats.some((stat) => stat === null)) return count
  const added = stats.reduce((sum, stat) => sum + stat!.added, 0)
  const removed = stats.reduce((sum, stat) => sum + stat!.removed, 0)
  const sum = statText({ added, removed })
  return sum ? `${count} · ${sum}` : count
}

/** How much an edit moved, read back out of the `+3 −1` main wrote it as. */
export type Stat = { added: number; removed: number }

/**
 * The `+3 −1` an edit's row carries, as numbers — or null for an outcome
 * that is not one (`89 lines`, an error), which is what lets the row colour
 * the two halves without a second field on the line. The minus is U+2212,
 * the one `changeOf` in `main/claude-agent.ts` writes; a hyphen is not
 * matched, so a sentence that happens to start with `+` stays a sentence.
 */
export function statOf(text: string | undefined): Stat | null {
  if (!text) return null
  const match = /^(?:\+(\d+))?(?: ?−(\d+))?$/.exec(text)
  if (!match || (match[1] === undefined && match[2] === undefined)) return null
  return { added: Number(match[1] ?? 0), removed: Number(match[2] ?? 0) }
}

/**
 * An outcome split at the stat on its end: `3 files · +20 −5` is a head of
 * `3 files · ` and a stat; `+3 −1` is no head and a stat; `89 lines` is all
 * head and no stat. For the row, which colours the stat and nothing else.
 */
export function splitStat(text: string): { head: string; stat: Stat | null } {
  const match = /(?:^|\s)((?:\+\d+)?(?: ?−\d+)?)$/.exec(text)
  const stat = match ? statOf(match[1]!) : null
  if (!stat) return { head: text, stat: null }
  return { head: text.slice(0, text.length - match![1]!.length), stat }
}

/** The same words back — `+3 −1`, `+3`, `−1` — or nothing for no change. */
export function statText({ added, removed }: Stat): string {
  return [added > 0 ? `+${added}` : "", removed > 0 ? `−${removed}` : ""]
    .filter(Boolean)
    .join(" ")
}
