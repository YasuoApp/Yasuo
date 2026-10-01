import type { AssistantMessage } from "@shared/api"
import { dayBreak, dayLabel } from "./since"

/**
 * A turn's working, folded away from its answer.
 *
 * **Why a fold rather than a switch.** A `showToolCalls` setting hid the tool
 * rows outright, which answers the wrong question: the rows are noise while
 * reading the answer and are the entire point five minutes later, when what is
 * being asked is "what did it actually do to my branch". A fold is both — one
 * line saying how much happened, and the whole of it a click away — so the
 * switch was deleted and the rows are always drawn.
 *
 * **What counts as working.** Everything a turn produced except its last word:
 * the tool calls, the thinking, and the narration between them ("let me check
 * the composer first"), which reads as working precisely because the answer
 * came after it. Three things are never folded — an error, a refusal, and what
 * the turn cost — the first two for the reason the old switch made an exception
 * for refusals: both are the turn telling you it did *less* than you asked, and
 * that cannot be behind a fold somebody has to know to open. The third is
 * `alwaysShown`'s own paragraph.
 *
 * The whole of this is pure and tested in `test/chat-activity.ts`, because the
 * cases that matter are the shapes of a transcript rather than anything on
 * screen: a turn still running has no last word yet, a turn that only talked has
 * no working at all, and a chat read back from disk is several turns in a row.
 */

/** One thing the pane draws: a line on its own, or a run of them folded. */
export type ChatBlock =
  | { kind: "line"; id: string; line: AssistantMessage }
  | {
      kind: "activity"
      id: string
      lines: AssistantMessage[]
      counts: ActivityCounts
    }

/** What the folded line says there is. */
export type ActivityCounts = {
  /** Tool calls, not counting the subagents — those are counted as agents. */
  tools: number
  /** What the turn said on the way: its narration and its thinking. */
  messages: number
  subagents: number
  /** Where the turn's own list had got to, when it kept one. Absent for a run
   * with no `TodoWrite` in it, which is most of them. */
  todo?: ActivityTodo
}

/**
 * A todo list as the folded line says it.
 *
 * **Why this is on the closed fold at all**, when nothing else about the working
 * is. A todo list is the one tool call whose argument is about the *turn* rather
 * than about a file — it is the model saying what it is going to do and how far
 * through it is — and a long turn's working is folded precisely while that is
 * the question being asked. The alternative was drawing the latest list outside
 * the fold, which is a checklist per turn in the transcript for ever, most of
 * them stale and none of them the answer somebody came back for.
 *
 * The **last** list in the run, not the first: `TodoWrite` is called again for
 * every item that starts and finishes, so the run holds the same list five times
 * and only its final state is true.
 */
export type ActivityTodo = {
  done: number
  total: number
  /** The item that was in progress, if one was. */
  running: string | null
}

/**
 * The tool a subagent runs under, which is counted and drawn as an agent rather
 * than as one more tool call.
 *
 * **Two names, because the CLI renamed it.** It was `Task` and is now `Agent`,
 * and both are real: which one a turn sends is the user's own `claude`'s
 * business, and a transcript on disk holds whichever was current when it was
 * written. Testing for one of them was the whole of the bug — every subagent
 * counted as an ordinary tool call, drawn with the wrong glyph and the whole
 * prompt as its argument. `main/claude-agent.ts` keeps the same pair for the
 * side of it main decides: the two processes never import each other.
 */
export const AGENT_TOOLS = ["Agent", "Task"]

export function isAgentTool(name: string): boolean {
  return AGENT_TOOLS.includes(name)
}

export function blocksOf(messages: AssistantMessage[]): ChatBlock[] {
  const blocks: ChatBlock[] = []

  for (const turn of turnsOf(messages)) {
    // The user's own line is never part of a turn's working: it is what the
    // working was for.
    if (turn.prompt)
      blocks.push({ kind: "line", id: turn.prompt.id, line: turn.prompt })

    /*
     * The turn's last word, which is the answer and stays out of the fold.
     *
     * A turn still being answered has none — everything so far is working, and
     * a fold that closed over the answer the moment it arrived would be the
     * pane hiding what it just finished writing. So this is the index to fold
     * *up to*, and while a turn is running that is all of it: see
     * `answerIndexOf`, which is what "last word" has to mean for a turn that
     * carried on working after saying something.
     */
    const answer = answerIndexOf(turn.lines)

    let run: AssistantMessage[] = []
    const flush = () => {
      if (run.length === 0) return
      blocks.push({
        kind: "activity",
        // The first line's id: stable across a re-render, and unique because a
        // line id is.
        id: `activity-${run[0]!.id}`,
        lines: run,
        counts: countsOf(run),
      })
      run = []
    }

    turn.lines.forEach((line, index) => {
      if (answer !== -1 && index >= answer) {
        flush()
        blocks.push({ kind: "line", id: line.id, line })
        return
      }
      if (alwaysShown(line)) {
        flush()
        blocks.push({ kind: "line", id: line.id, line })
        return
      }
      run.push(line)
    })
    flush()
  }

  return blocks
}

/**
 * Which block a line is drawn in, or null if the transcript has no such line.
 *
 * For the one caller that has a **line** id and needs the thing on screen: a
 * chat opened from a search of what was said in it (`searchChats`) has to land
 * somewhere, and the sentence it matched is not always a row — a message the
 * model wrote mid-turn is folded into that turn's working, and only the last
 * word of a turn stays out (see `blocksOf`). So the answer is the fold rather
 * than nothing: it is where the line is, and opening it is one click.
 */
export function blockOf(blocks: ChatBlock[], lineId: string): string | null {
  for (const block of blocks) {
    if (block.kind === "line") {
      if (block.line.id === lineId) return block.id
      continue
    }
    if (block.lines.some((line) => line.id === lineId)) return block.id
  }
  return null
}

/**
 * The divider's label where two consecutive blocks fall on different local
 * days, or null where no divider belongs between them.
 *
 * Read off each block's **first** line: a fold holds a run of lines, and the
 * run began when its first one did. Null when either side has no stamp — see
 * `dayBreak` — so a transcript that spans the day the field was added gets no
 * divider claiming a jump it cannot date.
 */
export function dayDividerBetween(
  prev: ChatBlock,
  next: ChatBlock,
  now: number = Date.now()
): string | null {
  const after = firstStampOf(next)
  if (!after || !dayBreak(firstStampOf(prev), after)) return null
  return dayLabel(after, now) || null
}

function firstStampOf(block: ChatBlock): string | undefined {
  return block.kind === "line" ? block.line.at : block.lines[0]?.at
}

/** One row of an *open* fold: a run of tool calls that folds again, or a line
 * drawn as itself. */
export type ActivityRow =
  | {
      kind: "tools"
      id: string
      lines: AssistantMessage[]
      counts: ActivityCounts
    }
  | { kind: "line"; id: string; line: AssistantMessage }

/**
 * An open fold's own rows, with each run of tool calls gathered behind a second
 * fold.
 *
 * **Why a fold inside a fold.** Opening the working answers "what did it do",
 * and the thing that says *why* it did any of it is the narration between the
 * calls — which is exactly what a flat list buries: eleven tool rows and the two
 * sentences that explain them, in the order they happened, is two sentences
 * nobody scrolls to. Folding the calls puts a turn's reasoning back on one
 * screen and leaves the calls one more click away, which is the same bargain the
 * outer fold makes and the reason it works.
 *
 * A run of one folds too. A row that is sometimes the call and sometimes a line
 * about the call makes the reader work out which of the two they are looking at
 * before they can read it, and the count is the thing being scanned either way.
 *
 * Subagents are not split out from the run: they are tool calls in the
 * transcript, and `summaryOf` already names them separately in the line.
 */
export function rowsOf(lines: AssistantMessage[]): ActivityRow[] {
  const rows: ActivityRow[] = []

  let run: AssistantMessage[] = []
  const flush = () => {
    if (run.length === 0) return
    rows.push({
      kind: "tools",
      // Same reasoning as `blocksOf`'s id: the first line's, which is stable
      // across a re-render and unique because a line id is.
      id: `tools-${run[0]!.id}`,
      lines: run,
      counts: countsOf(run),
    })
    run = []
  }

  for (const line of lines) {
    if (line.role === "tool") {
      run.push(line)
      continue
    }
    flush()
    rows.push({ kind: "line", id: line.id, line })
  }
  flush()

  return rows
}

/**
 * A line that is never folded.
 *
 * Two of the four are the turn saying it did *less* than was asked, and the
 * third is what it cost — which is not part of the working either: a turn's own
 * price is about the turn rather than in it, and it is on the line for the turns
 * that never got as far as an answer too, which is where the fold would
 * otherwise have swallowed it.
 *
 * A **compaction boundary** is the fourth, and the strongest case of the rule:
 * everything above it is something the model now knows only as a summary, so it
 * is the one line whose whole meaning is *where in the transcript it sits*.
 * Folded into a run of tool calls it would be a divider inside a fold, dividing
 * nothing a reader can see.
 */
function alwaysShown(line: AssistantMessage): boolean {
  return (
    line.role === "error" ||
    line.role === "usage" ||
    line.role === "compact" ||
    (line.role === "ask" && refused(line))
  )
}

/** The wording `main/worktree-chat.ts` composes a refusal with. Matched rather
 * than flagged because the line is a sentence somebody reads, and it is the
 * same test the row's own colour uses. */
export function refused(line: AssistantMessage): boolean {
  return line.role === "ask" && line.text.startsWith("Refused")
}

export function countsOf(lines: AssistantMessage[]): ActivityCounts {
  let tools = 0
  let messages = 0
  let subagents = 0
  let todo: ActivityTodo | undefined

  for (const line of lines) {
    if (line.role === "tool") {
      if (isAgentTool(line.name)) subagents += 1
      else tools += 1
      // Overwritten rather than kept from the first: the same list is written
      // again every time an item starts or finishes, and only the last of them
      // says where the turn actually is.
      if (line.todos) {
        todo = {
          done: line.todos.filter((one) => one.status === "completed").length,
          total: line.todos.length,
          running:
            line.todos.find((one) => one.status === "in_progress")?.content ??
            null,
        }
      }
      continue
    }
    if (line.role === "assistant" || line.role === "thinking") messages += 1
  }

  return { tools, messages, subagents, ...(todo ? { todo } : {}) }
}

/** The folded line's own words. Left out of the component so the phrasing is
 * testable and so a count of zero is dropped rather than drawn as `0 tools`. */
export function summaryOf(counts: ActivityCounts): string {
  const parts: string[] = []
  if (counts.tools > 0) parts.push(plural(counts.tools, "tool call"))
  if (counts.messages > 0) parts.push(plural(counts.messages, "message"))
  if (counts.subagents > 0) parts.push(plural(counts.subagents, "subagent"))
  // Nothing but the lines that are never folded can produce this, and a run of
  // those is never made — so it is a fallback rather than a case.
  const line = parts.join(", ") || "working"
  if (!counts.todo) return line

  /* After the counts rather than instead of them, and separated the way a tool
     row separates its own second label: the counts say how much happened, and
     this says what it was for. The item being worked on carries the progress in
     brackets, because "3/7" on its own is the fact somebody wanted only until
     there is a sentence to put beside it. */
  const { done, total, running } = counts.todo
  return running
    ? `${line} · ${running} (${done}/${total})`
    : `${line} · ${done}/${total} done`
}

function plural(count: number, what: string): string {
  return `${count} ${what}${count === 1 ? "" : "s"}`
}

/** The conversation split at the user's lines: a prompt and what followed it. */
function turnsOf(messages: AssistantMessage[]): {
  prompt: AssistantMessage | null
  lines: AssistantMessage[]
}[] {
  const turns: {
    prompt: AssistantMessage | null
    lines: AssistantMessage[]
  }[] = []
  // A chat can open with lines that follow no prompt — a turn retried as a
  // resume writes its own — so the first turn may have none.
  let current: { prompt: AssistantMessage | null; lines: AssistantMessage[] } =
    {
      prompt: null,
      lines: [],
    }

  for (const line of messages) {
    if (line.role === "user") {
      if (current.prompt || current.lines.length > 0) turns.push(current)
      current = { prompt: line, lines: [] }
      continue
    }
    current.lines.push(line)
  }
  if (current.prompt || current.lines.length > 0) turns.push(current)

  return turns
}

/**
 * Where a turn's last word starts, or `-1` while it has not said one.
 *
 * The last thing the turn *said* only counts as its answer while it is still the
 * last thing there is: a tool call after it means the narration was working
 * after all, and the turn has gone back to it. Taking the last assistant line
 * regardless left every line a running turn produced after its latest sentence
 * outside the fold — a tool row, then another, growing down the pane under a
 * summary that was not counting them.
 *
 * Lines that are never folded do not count as something coming after: a usage
 * line lands under a finished turn's answer, and an error or a refusal is drawn
 * on its own wherever it happened.
 */
function answerIndexOf(lines: AssistantMessage[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (line.role === "assistant") return index
    if (!alwaysShown(line)) return -1
  }
  return -1
}
