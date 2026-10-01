import type { AssistantMessage, ChatDigest } from "../shared/api"

/**
 * A chat read as a whole rather than as a conversation: which files it wrote to,
 * and what its turns were billed.
 *
 * Free of `electron` and of the store, the way `notify.ts` and `git.ts` are —
 * every function here takes the lines it folds, so `test/chat-digest.ts` can
 * import it. `WorktreeChats.digests` is what holds the lines and the cache.
 *
 * Both are folds of the transcript, which is the one record of what a chat did.
 * Nothing here is written down: a stored copy would be a second account of the
 * same file, and the first thing a second account does is disagree.
 *
 * Searching what a chat *said* is not here: `⌘F` over the conversation on
 * screen is the renderer's (`lib/worktree-chat/search.ts`), and the left
 * column's search of every chat is `WorktreeChats.search` over
 * `content-search.ts`.
 */

/**
 * The tools whose call is a write to the file it names.
 *
 * The same four `worktree-chat.ts` pre-approves as edits, and the list is a
 * ceiling rather than a promise: a file rewritten by a `Bash` line — `sed -i`, a
 * formatter, `git checkout` — leaves nothing in the transcript saying so. That
 * is why `paths` narrows a list of changed files and never divides one up: a
 * file no chat is shown to have touched is a file nobody here can account for,
 * not one somebody else changed.
 */
const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"]

/**
 * The files a chat's edits named, absolute, first write first.
 *
 * A call that came back an **error** is dropped: a refused write and a failed
 * one changed nothing, and a file listed for a chat that could not write to it
 * is the filter above the `Changes` list pointing at the wrong conversation. A
 * call still in flight has no `failed` either way and is kept — it is about to
 * land, and the list is re-read when it does.
 */
export function pathsTouched(messages: AssistantMessage[]): string[] {
  const paths: string[] = []
  const seen = new Set<string>()

  for (const message of messages) {
    if (message.role !== "tool") continue
    if (message.failed) continue
    if (!message.path || !EDIT_TOOLS.includes(message.name)) continue
    if (seen.has(message.path)) continue

    seen.add(message.path)
    paths.push(message.path)
  }

  return paths
}

/**
 * What a chat's turns were billed, summed off their own usage lines.
 *
 * The same sum `lib/worktree-chat/usage.ts` makes for one chat's footer, made
 * again here rather than shared: that module is the renderer's and main does not
 * import it (see the IPC contract in `CLAUDE.md`), and what is duplicated is one
 * addition rather than a rule with edges in it.
 *
 * `unpriced` is kept apart instead of being counted as zero, because those two
 * are different statements: a turn from before the CLI reported a cost, or one
 * that crashed before it had one, is a turn this app cannot price — and a total
 * that quietly folded them in would be a figure that reads as complete.
 */
export function spendOf(messages: AssistantMessage[]): {
  costUsd: number
  turns: number
  unpriced: number
} {
  let costUsd = 0
  let turns = 0
  let unpriced = 0

  for (const message of messages) {
    if (message.role !== "usage") continue
    turns += 1
    if (message.usage.costUsd === null) unpriced += 1
    else costUsd += message.usage.costUsd
  }

  return { costUsd, turns, unpriced }
}

/** One chat's lines as the record a caller reads them by. */
export function digestOf(
  chat: { id: string; folderId: string | null },
  messages: AssistantMessage[]
): ChatDigest {
  return {
    chatId: chat.id,
    folderId: chat.folderId,
    paths: pathsTouched(messages),
    ...spendOf(messages),
  }
}
