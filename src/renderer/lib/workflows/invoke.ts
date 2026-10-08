import type { Workflow } from "@shared/workflows"
import type { PlainMention } from "../worktree-chat/mention-text"

/**
 * How a chat calls a workflow: `@` and the workflow's name as a slug, at the
 * **head** of the message — `@create-pr fix the login` runs `Create PR` in
 * that chat, with `fix the login` as `Start`'s output.
 *
 * At the head and nowhere else, like a slash command: a workflow mid-sentence
 * ("don't @create-pr yet") would be a run nobody meant. And `@` rather than
 * `/` because `/` is the CLI's own list, asked of the user's `claude`; this
 * one is the workspace's.
 *
 * Strings only, so `test/workflow-invoke.ts` can reach it.
 */

/**
 * A name as something typed after `@`: lower case, accents dropped, anything
 * that is not a letter or a digit a dash — `Tạo PR (staging)` is `tao-pr-staging`.
 * A name with nothing left is called by its id's head, so it can still be
 * called at all.
 */
export function workflowSlug(workflow: Pick<Workflow, "id" | "name">): string {
  const slug = workflow.name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // The one Vietnamese letter NFKD leaves whole.
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || `workflow-${workflow.id.slice(0, 6)}`
}

/** The workflow a message calls, and what was written after its name — or
 * null for a message that calls none. The first workflow with the slug wins,
 * which is the list's own order. */
export function workflowInvocation(
  text: string,
  workflows: readonly Workflow[]
): { workflow: Workflow; input: string } | null {
  const match = /^\s*@(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return null
  const slug = match[1]!
  const workflow = workflows.find((entry) => workflowSlug(entry) === slug)
  if (!workflow) return null
  return { workflow, input: (match[2] ?? "").trim() }
}

/** The workflows as the composer's `@` menu shows them: the slug is what is
 * inserted, the name under it is what it was called. */
export function workflowRows(workflows: readonly Workflow[]): PlainMention[] {
  return workflows.map((workflow) => ({
    kind: "workflow",
    label: workflowSlug(workflow),
    detail: workflow.name,
    tokens: 0,
  }))
}
