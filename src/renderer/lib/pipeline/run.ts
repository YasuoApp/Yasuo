import type { AssistantMessage } from "@shared/api"
import type {
  PipelineRun,
  PipelineStage,
  PipelineTemplate,
  RunStage,
} from "./types"

/**
 * The pure half of a run: how a message is rendered for a stage, how a stage's
 * answer is read off its chat, and every transition a run makes. The store
 * (`store.ts`) only decides *when* to call these, which is the part that needs
 * the chat store and so cannot be tested without it. `test/pipeline.ts`.
 */

/** How much of the task becomes the run's name. A chat's tab has room for
 * about this much before it is all ellipsis. */
const NAME_LENGTH = 48

/**
 * A run's name, from the task's first line. The task is the only thing a run
 * is about, and the stage name is appended per chat — see `chatTitleFor`.
 */
export function runName(input: string): string {
  const line = input.trim().split(/\r?\n/)[0]?.trim() ?? ""
  if (!line) return "Pipeline"
  return line.length > NAME_LENGTH ? `${line.slice(0, NAME_LENGTH - 1)}…` : line
}

/** What a stage's chat is called in the column and on its tab. */
export function chatTitleFor(run: PipelineRun, stage: PipelineStage): string {
  return `${run.name} · ${stage.name}`
}

/**
 * The stage's prompt with its two slots filled.
 *
 * `{{previous}}` on the first stage is the task itself rather than an empty
 * string, so the same prompt reads sensibly whether a stage is first or
 * second in a template — a stage somebody moves to the front does not send a
 * message about nothing.
 */
export function messageFor(
  stage: PipelineStage,
  input: string,
  previousOutput: string | null
): string {
  const previous = previousOutput?.trim() || input.trim()
  return stage.prompt
    .replaceAll("{{input}}", input.trim())
    .replaceAll("{{previous}}", previous)
    .trim()
}

/**
 * What a stage's chat answered — the assistant lines since the last thing the
 * user said, joined. A turn's answer is usually several `text` lines
 * interleaved with tool rows, so "the last assistant line" alone would hand
 * the next stage the closing sentence and lose the plan above it.
 *
 * Null for a chat that has not answered at all, which the store reads as a
 * failure rather than as an empty hand-off.
 */
export function outputOf(lines: AssistantMessage[]): string | null {
  let from = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.role === "user") {
      from = index + 1
      break
    }
  }
  const texts = lines
    .slice(from)
    .filter((line) => line.role === "assistant")
    .map((line) => line.text.trim())
    .filter((text) => text.length > 0)
  return texts.length > 0 ? texts.join("\n\n") : null
}

/** Whether the chat ended on an error line — a turn that could not start, or
 * one the CLI failed. Read at the moment the chat goes quiet. */
export function failedIn(lines: AssistantMessage[]): string | null {
  const last = lines.at(-1)
  return last?.role === "error" ? last.text : null
}

export function beginRun(
  template: PipelineTemplate,
  folderId: string,
  input: string,
  id: string = crypto.randomUUID(),
  startedAt: number = Date.now()
): PipelineRun {
  return {
    id,
    templateId: template.id,
    template,
    name: runName(input),
    folderId,
    input,
    stages: template.stages.map((stage) => ({
      stageId: stage.id,
      chatId: null,
      status: "pending",
      output: null,
      message: null,
    })),
    status: "running",
    startedAt,
  }
}

/** The index of the stage a run should send next, or -1 when there is none —
 * the first stage not yet past `pending`/`waiting`. */
export function nextStage(run: PipelineRun): number {
  return run.stages.findIndex(
    (stage) => stage.status === "pending" || stage.status === "waiting"
  )
}

/** The index of the stage running right now, or -1. */
export function runningStage(run: PipelineRun): number {
  return run.stages.findIndex((stage) => stage.status === "running")
}

export function previousOutput(run: PipelineRun, index: number): string | null {
  return index > 0 ? (run.stages[index - 1]?.output ?? null) : null
}

/** The message a stage would be sent, from what the run holds now. */
export function renderStage(run: PipelineRun, index: number): string {
  const stage = run.template.stages[index]
  if (!stage) return ""
  return messageFor(stage, run.input, previousOutput(run, index))
}

function withStage(
  run: PipelineRun,
  index: number,
  patch: Partial<RunStage>
): PipelineRun {
  return {
    ...run,
    stages: run.stages.map((stage, at) =>
      at === index ? { ...stage, ...patch } : stage
    ),
  }
}

/**
 * A stage's chat has been opened and sent to. `message` is kept as sent, so
 * the dialog can show what the stage was asked even after the chat moves on.
 */
export function startStage(
  run: PipelineRun,
  index: number,
  chatId: string,
  message: string
): PipelineRun {
  return {
    ...withStage(run, index, { chatId, status: "running", message }),
    status: "running",
  }
}

/**
 * A stage's chat went quiet with an answer. The next stage is readied: left
 * `pending` with its message rendered when it may go at once, or `waiting`
 * with the same message when its gate is shut — and the run says which, so
 * the banner can draw Continue without reading every stage.
 */
export function finishStage(
  run: PipelineRun,
  index: number,
  output: string
): PipelineRun {
  let next = withStage(run, index, { status: "done", output })
  const following = index + 1
  const stage = next.template.stages[following]
  if (!stage) return { ...next, status: "done" }
  const message = renderStage(next, following)
  next = withStage(next, following, {
    status: stage.gate ? "waiting" : "pending",
    message,
  })
  return { ...next, status: stage.gate ? "waiting" : "running" }
}

export function failStage(
  run: PipelineRun,
  index: number,
  reason: string | null
): PipelineRun {
  return {
    ...withStage(run, index, {
      status: "failed",
      output: reason,
    }),
    status: "failed",
  }
}

/**
 * The gate opened. The message may have been edited in the field, so what was
 * approved is what goes — the stage returns to `pending` holding it, and the
 * store sends it from there.
 */
export function approveStage(
  run: PipelineRun,
  index: number,
  message?: string
): PipelineRun {
  const stage = run.stages[index]
  if (!stage || stage.status !== "waiting") return run
  const text = message?.trim() || stage.message || renderStage(run, index)
  return {
    ...withStage(run, index, { status: "pending", message: text }),
    status: "running",
  }
}

/**
 * Stopped by hand. A stage that was waiting goes back to `pending` so a
 * retry can start from it; one that was running keeps its chat and is marked
 * failed, since whatever it answers from here is nobody's input.
 */
export function stopRun(run: PipelineRun): PipelineRun {
  if (run.status === "done" || run.status === "failed") return run
  return {
    ...run,
    status: "stopped",
    stages: run.stages.map((stage) =>
      stage.status === "waiting"
        ? { ...stage, status: "pending" }
        : stage.status === "running"
          ? { ...stage, status: "failed", output: "Stopped." }
          : stage
    ),
  }
}

/**
 * A failed or stopped stage, to be sent again in a fresh chat — with the
 * message re-rendered from the stage before it, and everything after it reset,
 * since their inputs are about to change. Returns `waiting` rather than
 * `pending` when the stage is gated, so a retry gets the same look at the
 * message a first run would.
 */
export function retryStage(run: PipelineRun, index: number): PipelineRun {
  const stage = run.template.stages[index]
  if (!stage) return run
  const stages = run.stages.map((entry, at) =>
    at < index
      ? entry
      : {
          stageId: entry.stageId,
          chatId: null,
          status: "pending" as const,
          output: null,
          message: null,
        }
  )
  let next: PipelineRun = { ...run, stages, status: "running" }
  const message = renderStage(next, index)
  next = withStage(next, index, {
    status: stage.gate ? "waiting" : "pending",
    message,
  })
  return { ...next, status: stage.gate ? "waiting" : "running" }
}

/** Which run and stage a chat belongs to, if any. A chat belongs to at most
 * one stage, since every stage opens a chat of its own. */
export function stageOfChat(
  runs: PipelineRun[],
  chatId: string
): { run: PipelineRun; index: number } | null {
  for (const run of runs) {
    const index = run.stages.findIndex((stage) => stage.chatId === chatId)
    if (index >= 0) return { run, index }
  }
  return null
}

/** Whether the run is live — something is running or waiting to be approved. */
export function isActive(run: PipelineRun): boolean {
  return run.status === "running" || run.status === "waiting"
}
