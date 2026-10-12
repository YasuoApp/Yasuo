import type { ChatPermission } from "@shared/api"

/**
 * A pipeline: chats chained into stages, each stage a conversation of its own
 * with its own permission mode, the previous stage's answer feeding the next.
 *
 * Renderer-only orchestration over the chat store — no new channel, no main
 * process state. A stage *is* an ordinary chat, which is the whole bargain:
 * every stage is readable, resumable and stoppable with the controls a chat
 * already has, and what the pipeline adds is only the order and the hand-off.
 */

export type PipelineStage = {
  id: string
  name: string
  /** The mode this stage's chat opens on — `plan` for a planner, `edits` for
   * the implementer. Written to the chat's own options, so the composer draws
   * the same answer the pipeline gave. */
  permission: ChatPermission
  /** `--model`, or null for whatever a new chat would open on. */
  model: string | null
  /**
   * The message sent to open the stage. `{{input}}` is the task typed into the
   * dialog; `{{previous}}` is the previous stage's last answer, or the task
   * again for the first stage, so one template reads sensibly in either slot.
   */
  prompt: string
  /** Whether the run stops and asks before this stage is sent — the gate before
   * a stage that writes, so a plan can be read before it is carried out. */
  gate: boolean
}

export type PipelineTemplate = {
  id: string
  name: string
  stages: PipelineStage[]
}

export type RunStageStatus =
  "pending" | "waiting" | "running" | "done" | "failed"

export type RunStage = {
  stageId: string
  /** The chat this stage runs in, once it has one. */
  chatId: string | null
  status: RunStageStatus
  /** What the stage's chat answered last, which is the next stage's
   * `{{previous}}`. */
  output: string | null
  /** The message rendered for this stage — editable while it is `waiting`,
   * and what was actually sent once it is past that. */
  message: string | null
}

export type PipelineRunStatus =
  "running" | "waiting" | "done" | "failed" | "stopped"

export type PipelineRun = {
  id: string
  templateId: string
  /**
   * The stages as they were when the run started — the template with this
   * run's own toggles applied. A snapshot rather than a lookup, so editing a
   * template cannot change a run already half-way through it.
   */
  template: PipelineTemplate
  /** What the run is called in the dialog and on each stage's chat. */
  name: string
  folderId: string
  input: string
  stages: RunStage[]
  status: PipelineRunStatus
  startedAt: number
}
