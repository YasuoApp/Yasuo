import type { AssistantMessage } from "@shared/api"

/**
 * What editing message `at` would leave behind it: the files the turns after
 * it wrote, which the edit puts back when its box is ticked.
 *
 * The putting back is the CLI's (its file checkpoints, `rewindSessionFiles`
 * in main), and it answers with counts rather than a list until it is asked —
 * so the bubble names the files off the transcript before somebody presses
 * Send, rather than a model that no longer remembers an edit looking at a file
 * that still has it. Off the tool rows' own `path`s, subagents' included: a
 * subagent's edit is the turn's edit too. A call that failed wrote nothing.
 * The same tools the CLI checkpoints, so a `Bash` write is in neither.
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
