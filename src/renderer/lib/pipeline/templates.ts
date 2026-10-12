import type { PipelineStage, PipelineTemplate } from "./types"

/**
 * The templates every workspace has, before anybody has written one.
 *
 * Ids are fixed words rather than uuids so a custom template can never shadow
 * one, and so a run's `templateId` still names something after a reload. They
 * are not persisted: what is written down is only what the user made
 * (`pipelineTemplates` in `lib/settings.ts`), and a built-in changed here lands
 * for everybody at the next launch.
 */

const PLAN: PipelineStage = {
  id: "plan",
  name: "Plan",
  permission: "plan",
  model: null,
  gate: false,
  prompt:
    "Plan the following task. Read the code it touches, then answer with a " +
    "numbered plan: the files to change, what changes in each, and how to " +
    "verify it. Do not make any change.\n\n{{input}}",
}

const IMPLEMENT: PipelineStage = {
  id: "implement",
  name: "Implement",
  permission: "edits",
  model: null,
  gate: true,
  prompt:
    "Implement this plan exactly. Make the changes it names and nothing " +
    "else, then answer with a short summary of what you changed and " +
    "anything you had to decide that the plan left open.\n\n{{previous}}",
}

const REVIEW: PipelineStage = {
  id: "review",
  name: "Review",
  permission: "read",
  model: null,
  gate: false,
  prompt:
    "Review the changes just made in this checkout (`git diff`) for bugs, " +
    "missed cases and anything that contradicts the summary below. Do not " +
    "change anything: answer with a list of findings, most serious first, " +
    "each naming the file and what is wrong. Say so plainly if there are " +
    "none.\n\n{{previous}}",
}

const TEST: PipelineStage = {
  id: "test",
  name: "Test",
  permission: "edits",
  model: null,
  gate: true,
  prompt:
    "Run the test suite and the type checker, and fix any failures the " +
    "recent changes caused. Address the review findings below where they " +
    "are real. Answer with what you ran, what failed, and what you " +
    "changed.\n\n{{previous}}",
}

export const BUILTIN_TEMPLATES: PipelineTemplate[] = [
  {
    id: "plan-implement-review-test",
    name: "Plan → Implement → Review → Test",
    stages: [PLAN, IMPLEMENT, REVIEW, TEST],
  },
  {
    id: "plan-implement",
    name: "Plan → Implement",
    stages: [PLAN, IMPLEMENT],
  },
]

export function isBuiltinTemplate(id: string): boolean {
  return BUILTIN_TEMPLATES.some((template) => template.id === id)
}

/** A copy somebody can edit, with ids of its own so the copy and the original
 * can be told apart everywhere a template is looked up by id. */
export function duplicateTemplate(
  template: PipelineTemplate,
  id: string = crypto.randomUUID()
): PipelineTemplate {
  return {
    id,
    name: `${template.name} (copy)`,
    stages: template.stages.map((stage) => ({
      ...stage,
      id: crypto.randomUUID(),
    })),
  }
}

/** A stage to append to a template being edited: the plain shape, in the mode
 * a new chat opens on. */
export function blankStage(id: string = crypto.randomUUID()): PipelineStage {
  return {
    id,
    name: "Stage",
    permission: "edits",
    model: null,
    gate: false,
    prompt: "{{previous}}",
  }
}
