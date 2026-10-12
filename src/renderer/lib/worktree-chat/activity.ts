import type { AssistantMessage, TurnUsage } from "@shared/api"
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
  /** Calls that came back an error. Absent at zero, like `todo`: a failure is
   * what a closed fold most needs to say, and a `0 failed` on every turn would
   * teach the eye to skip the place it is said. */
  failed?: number
  /**
   * The latest call with no result yet, by the name the summary says it with.
   *
   * Only *meaningful* while the turn is running — a call with no result in a
   * finished turn is one that was interrupted, not one still going — which is
   * why `summaryOf` is told whether it is live rather than this guessing.
   */
  pending?: string
}

/** A call still waiting on its result. `recordResult` in main writes `""` for
 * a call that printed nothing, so absence is the only way to be unanswered. */
export function isPending(line: AssistantMessage): boolean {
  return line.role === "tool" && line.result === undefined
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

/**
 * The transcript with every subagent's lines taken out, and those lines filed
 * under the call that ran them.
 *
 * Out of the main flow **before** anything else reads it, because everything
 * else is about the main loop: a subagent's last sentence is not the turn's
 * answer (`answerIndexOf` would have taken it for one), its calls are not the
 * turn's calls, and the find bar has nowhere to land on a line that is drawn
 * inside a row. Keyed by the parent's `toolId`, so a subagent that ran a
 * subagent nests by the same lookup one level down.
 */
export function splitSubagents(messages: AssistantMessage[]): {
  own: AssistantMessage[]
  steps: ReadonlyMap<string, AssistantMessage[]>
} {
  const own: AssistantMessage[] = []
  const steps = new Map<string, AssistantMessage[]>()
  for (const line of messages) {
    if (!line.parent) {
      own.push(line)
      continue
    }
    const under = steps.get(line.parent)
    if (under) under.push(line)
    else steps.set(line.parent, [line])
  }
  return { own, steps }
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
     * A turn that has said nothing yet has none — everything so far is
     * working, and a fold that closed over the answer the moment it arrived
     * would be the pane hiding what it just finished writing.
     */
    /*
     * What the turn cost, taken out of the flow and put back once, at the end.
     *
     * A "turn" here is everything after one prompt, and that is not always one
     * CLI turn: background subagents wake the CLI as each one finishes, and
     * every wake ends with a usage line of its own. Left where they landed,
     * three agents cut one question's working into a fold, a coin, a fold of
     * one sentence, a coin, and so on down the pane. One question, one cost —
     * summed by `usageOfAll`, under the answer.
     */
    const spent = turn.lines.filter((line) => line.role === "usage")
    const lines = turn.lines.filter((line) => line.role !== "usage")
    const answer = answerIndexOf(lines)

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

    /*
     * Lines the turn produced *after* its last word — the tool calls it went
     * back to — join the fold above that word rather than following it.
     *
     * The alternative was `answerIndexOf` deciding the sentence had not been
     * the last word after all and folding it: a running turn said something,
     * the pane drew it under the fold, the turn made one more call, and the
     * sentence vanished into `2 messages` while the reader was still on it.
     * Pinned, the slot under the fold holds the latest thing said until a
     * newer sentence replaces it, and never empties mid-turn. The fold's
     * rows stay in the order they happened; only the answer sits past the
     * calls that followed it. Errors and refusals after the answer still
     * follow it, since what they say is that the turn ended that way.
     */
    const after: AssistantMessage[] = []
    lines.forEach((line, index) => {
      if (index === answer) return
      if (alwaysShown(line)) {
        if (index > answer && answer !== -1) after.push(line)
        else {
          flush()
          blocks.push({ kind: "line", id: line.id, line })
        }
        return
      }
      run.push(line)
    })
    flush()
    if (answer !== -1) {
      const line = lines[answer]!
      blocks.push({ kind: "line", id: line.id, line })
    }
    for (const line of after) blocks.push({ kind: "line", id: line.id, line })

    const usage = usageOfAll(spent)
    if (usage) blocks.push({ kind: "line", id: usage.id, line: usage })
  }

  return blocks
}

/**
 * What the turn ending at `blocks[index]` answered, as one string to copy — or
 * null when it said nothing outside its fold.
 *
 * One copy per turn rather than one per message: a turn that works says
 * something between its calls, every one of those is a line of its own, and a
 * button on each of them — in the fold and out of it — copied a paragraph of
 * what somebody wanted all of. So it is everything the model said in the turn,
 * in order, the folded narration included: that is the response, the way the
 * CLI would have printed it. A subagent's lines are not in `blocks` at all
 * (`splitSubagents`), so they are not the turn's words either.
 */
export function replyOf(blocks: ChatBlock[], index: number): string | null {
  const said: string[] = []
  for (let at = index - 1; at >= 0; at--) {
    const block = blocks[at]!
    const lines = block.kind === "line" ? [block.line] : block.lines
    if (lines.some((line) => line.role === "user")) break
    said.unshift(
      ...lines.flatMap((line) => (line.role === "assistant" ? [line.text] : []))
    )
  }
  return said.length > 0 ? said.join("\n\n") : null
}

/**
 * Several usage lines as one: the spends summed, the levels taken from the
 * last. Null for none, and the line itself for one, so a turn that was one CLI
 * turn draws exactly what it always did.
 */
export function usageOfAll(lines: AssistantMessage[]): AssistantMessage | null {
  const usages = lines.flatMap((line) =>
    line.role === "usage" ? [{ line, usage: line.usage }] : []
  )
  if (usages.length === 0) return null
  if (usages.length === 1) return usages[0]!.line

  const last = usages[usages.length - 1]!
  const sum = (pick: (usage: TurnUsage) => number) =>
    usages.reduce((total, { usage }) => total + pick(usage), 0)
  const costs = usages.flatMap(({ usage }) =>
    usage.costUsd === null ? [] : [usage.costUsd]
  )
  const durations = usages.flatMap(({ usage }) =>
    usage.durationMs ? [usage.durationMs] : []
  )
  const context = usages
    .map(({ usage }) => usage.context)
    .filter(Boolean)
    .at(-1)

  return {
    // The first line's id, which is stable while later wakes add to the sum.
    id: usages[0]!.line.id,
    role: "usage",
    ...(last.line.at ? { at: last.line.at } : {}),
    usage: {
      model: last.usage.model,
      input: sum((usage) => usage.input),
      cacheWrite: sum((usage) => usage.cacheWrite),
      cacheRead: sum((usage) => usage.cacheRead),
      output: sum((usage) => usage.output),
      thinking: sum((usage) => usage.thinking),
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
      // A level, not a spend: where the chat stands after the last wake.
      context: context ?? null,
      durationMs:
        durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : null,
    },
  }
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
  let failed = 0
  let pending: string | undefined

  for (const line of lines) {
    if (line.role === "tool") {
      if (isAgentTool(line.name)) subagents += 1
      else tools += 1
      if (line.failed) failed += 1
      if (isPending(line))
        pending = isAgentTool(line.name) ? "Agent" : line.name
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

  return {
    tools,
    messages,
    subagents,
    ...(todo ? { todo } : {}),
    ...(failed > 0 ? { failed } : {}),
    ...(pending ? { pending } : {}),
  }
}

/** The folded line's own words. Left out of the component so the phrasing is
 * testable and so a count of zero is dropped rather than drawn as `0 tools`.
 *
 * `live` is whether the turn the fold belongs to is still running: only then
 * is a call without a result one that is *running* rather than one that was
 * cut off. */
export function summaryOf(counts: ActivityCounts, live = false): string {
  const parts: string[] = []
  if (counts.tools > 0) parts.push(plural(counts.tools, "tool call"))
  if (counts.messages > 0) parts.push(plural(counts.messages, "message"))
  if (counts.subagents > 0) parts.push(plural(counts.subagents, "subagent"))
  // Nothing but the lines that are never folded can produce this, and a run of
  // those is never made — so it is a fallback rather than a case.
  let line = parts.join(", ") || "working"
  // Before the todo: what went wrong and what is moving now are about the
  // calls the counts just named, and the todo is about the turn.
  if (counts.failed) line += ` · ${counts.failed} failed`
  if (live && counts.pending) line += ` · running ${counts.pending}`
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
 * Where a turn's last word is, or `-1` while it has not said one.
 *
 * The last thing the turn *said*, whether or not it is the last thing there
 * is. It used to count only while nothing but the never-folded lines came
 * after it — a tool call after a sentence meant the sentence had been working
 * after all — and that rule was right about the sentence and wrong about the
 * reader: the line they were reading under the fold disappeared into it the
 * moment the turn made another call. `blocksOf` now folds what came after
 * *above* the word instead, which is what keeps the summary counting every
 * row while the slot under it stays put.
 */
function answerIndexOf(lines: AssistantMessage[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.role === "assistant") return index
  }
  return -1
}
