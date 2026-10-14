import type { WorktreeStatus } from "@shared/api"

/**
 * What a checkout's `WorktreeStatus` says in words — the row's tooltip and the
 * removal dialog's warnings. Pure, so `test/worktrees.ts` reads it beside the
 * main half that produces the status.
 */

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** One line for the row's tooltip: `feature/sso · 2 ahead, 1 behind main · 3
 * uncommitted`. Only what is not zero, so a checkout with nothing on it reads
 * as its branch and `up to date`. */
export function worktreeSummary(status: WorktreeStatus): string {
  const parts: string[] = []
  if (status.branch) parts.push(status.branch)

  const moved: string[] = []
  if (status.ahead) moved.push(`${status.ahead} ahead`)
  if (status.behind) moved.push(`${status.behind} behind`)
  if (moved.length > 0)
    parts.push(moved.join(", ") + (status.base ? ` ${status.base}` : ""))

  if (status.changed) parts.push(`${status.changed} uncommitted`)
  if (moved.length === 0 && !status.changed) parts.push("up to date")
  return parts.join(" · ")
}

/**
 * What removing this checkout would take that exists nowhere else, one
 * sentence each — empty when it is safe.
 *
 * `deleteBranch` decides the second: commits on a kept branch are not lost, and a
 * warning about them would be a warning about nothing.
 */
export function removalWarnings(
  status: WorktreeStatus,
  deleteBranch: boolean
): string[] {
  const warnings: string[] = []
  if (status.changed > 0)
    warnings.push(
      `${plural(status.changed, "uncommitted change")} will be deleted.`
    )
  if (deleteBranch && status.unique > 0)
    warnings.push(
      `${plural(status.unique, "commit")} ${status.unique === 1 ? "exists" : "exist"} only on ${status.branch ?? "this branch"} and will be lost.`
    )
  return warnings
}
