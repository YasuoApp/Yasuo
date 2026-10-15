import type { AssistantMessage } from "@shared/api"

/**
 * The files the turns after message `at` wrote — what an edit of it puts back.
 *
 * The putting back is the CLI's (its file checkpoints, `rewindSessionFiles`
 * in main) and costs a process, so it is asked for only when this is not
 * empty. Off the tool rows' own `path`s, subagents' included: a subagent's
 * edit is the turn's edit too. A call that failed wrote nothing. The same
 * tools the CLI checkpoints, so a `Bash` write is in neither.
 */
export function editedAfter(
  messages: AssistantMessage[],
  at: number
): string[] {
  let seen = -1
  const paths = new Set<string>()
  for (const line of messages) {
    if (line.role === "user" && !line.parent) seen += 1
    if (seen < at) continue
    if (line.role !== "tool" || line.failed || !line.path) continue
    if (WRITES.has(line.name) || line.stat !== undefined) paths.add(line.path)
  }
  return [...paths]
}

/** The CLI's tools that write a file. `stat` covers an edit by another name. */
export const WRITES = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])
