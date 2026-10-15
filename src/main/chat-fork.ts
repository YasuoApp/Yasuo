/**
 * Where to cut a CLI session so that a message can be sent again, edited.
 *
 * Editing a message is not editing a line: a chat's id is the CLI's session id,
 * and the conversation the model will answer from is the CLI's transcript, not
 * this app's. So an edit is a **truncating resume** — `resumeSessionAt`, the
 * SDK's own rewind — at the last entry before the prompt being replaced, and
 * then the edited prompt sent into it.
 *
 * The uuid of that entry is read out of the CLI's transcript rather than kept
 * on this app's lines, for two reasons. Chats written before this existed have
 * no uuids, and an edit has to work on them too. And the transcript is the
 * only party that knows where its chain *is*: a session that has been edited
 * before still holds the abandoned branch, the file is append-only, and the
 * live conversation is the one reached by walking `parentUuid` back from the
 * last entry — not the file read top to bottom.
 *
 * Pure and free of `electron` and the filesystem, so `test/chat-fork.ts` can
 * hand it a transcript.
 */

type Entry = {
  type?: string
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  message?: { role?: string; content?: unknown }
  attachment?: { type?: string; prompt?: unknown }
}

/**
 * The uuid to resume at so that `prompts[0]` is the next thing said — or null
 * when it was the first thing said, and there is nothing before it to keep.
 *
 * `prompts` are this app's own user lines from the one being edited to the
 * last, in order. They are matched against the transcript's prompts **from
 * the end**, each one required to contain this app's text: the CLI heads a
 * message with the mode's sentence (`headed` in `chat.ts`), and a
 * pairing that drifted by one — a message the CLI folded, a slash command it
 * answered itself — has to be refused rather than cut the conversation at the
 * wrong turn. Throws with a sentence for the line in the chat when it cannot
 * be sure.
 */
export function forkPointIn(jsonl: string, prompts: string[]): string | null {
  // The first thing said: the chain starts at it. Anything else with no parent
  // is a compaction boundary, and a prompt is never one.
  return promptIn(jsonl, prompts).parentUuid ?? null
}

/**
 * The uuid of the prompt being edited itself — what `rewindFiles` takes. The
 * CLI files a turn's file checkpoint under the prompt that started it, so
 * rewinding to it puts the files back as they were *before* that turn, which
 * is the state the edited message is about to be said into. Same matching and
 * same refusals as `forkPointIn`.
 */
export function promptIdIn(jsonl: string, prompts: string[]): string {
  const target = promptIn(jsonl, prompts)
  if (!target.uuid)
    throw new Error("That message has no id in the CLI's copy of this chat.")
  return target.uuid
}

function promptIn(jsonl: string, prompts: string[]): Entry {
  const said = chainOf(jsonl).filter(isPrompt)

  /*
   * Aligned from the end, skipping what the CLI wrote and this app did not.
   *
   * Not paired by position: the transcript has `user` entries nobody typed — a
   * Stop is `[Request interrupted by user]`, a slash command is a
   * `<command-name>` entry and its output another — and on this app's own
   * chats a positional pairing refused a third of the messages it was asked
   * about. The later prompts are anchors, found in order so that the one being
   * edited is looked for *before* them; one the CLI never recorded — a command
   * it refused, a send that failed before it started — is passed over, since
   * it is about to be cut anyway. The edited one has to be found, so a message
   * the CLI never received is a refusal rather than a cut one turn off.
   */
  let at = said.length
  const later = prompts.slice(1).reverse()
  for (const prompt of later) {
    const found = lastIndexBefore(said, at, prompt)
    if (found !== -1) at = found
  }
  const index = lastIndexBefore(said, at, prompts[0] ?? "")
  if (index === -1)
    throw new Error(
      "That message is not in the CLI's copy of this conversation — it was compacted away, or never reached it — so it cannot be edited."
    )
  return said[index]!
}

/** The last prompt before `before` that this app's `prompt` is, or -1. */
function lastIndexBefore(
  said: Entry[],
  before: number,
  prompt: string
): number {
  const text = prompt.trim()
  if (!text) return -1
  // A slash command is written down as `<command-name>/x</command-name>` with
  // its arguments in a tag of their own, so it is found by its name too — and
  // by its text as well, since a line that merely starts with a `/` is prose.
  const command = text.startsWith("/")
    ? `<command-name>${text.split(/\s/)[0]}</command-name>`
    : null
  for (let at = before - 1; at >= 0; at--) {
    const spoken = textOf(said[at]!)
    if (spoken.includes(text) || (command && spoken.includes(command)))
      return at
  }
  return -1
}

/** The live conversation, oldest first: the last entry and its ancestors. */
function chainOf(jsonl: string): Entry[] {
  const byId = new Map<string, Entry>()
  let leaf: Entry | undefined
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue
    let entry: Entry
    try {
      entry = JSON.parse(raw) as Entry
    } catch {
      // A line half-written by a CLI that is still appending. Nothing after it
      // is complete either, and nothing before it is affected.
      continue
    }
    if (!entry.uuid || entry.isSidechain) continue
    byId.set(entry.uuid, entry)
    leaf = entry
  }

  const chain: Entry[] = []
  const seen = new Set<string>()
  for (let at = leaf; at?.uuid && !seen.has(at.uuid);) {
    seen.add(at.uuid)
    chain.push(at)
    at = at.parentUuid ? byId.get(at.parentUuid) : undefined
  }
  return chain.reverse()
}

/**
 * Something somebody typed, as against a tool's result, which the CLI also
 * files as a `user` entry, or a line the CLI wrote for itself.
 *
 * **Two shapes.** A message sent while a turn was running is not a `user`
 * entry at all: the CLI folds it into the running turn as a `queued_command`
 * attachment. Leaving those out was every chat with a message typed
 * mid-answer refusing to be edited past it, which on this app's own chats was
 * most of them.
 */
function isPrompt(entry: Entry): boolean {
  if (isQueued(entry)) return textOf(entry).trim() !== ""
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary)
    return false
  const content = entry.message?.content
  if (Array.isArray(content) && content.some(isToolResult)) return false
  return textOf(entry).trim() !== ""
}

function isToolResult(block: unknown): boolean {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "tool_result"
  )
}

function isQueued(entry: Entry): boolean {
  return (
    entry.type === "attachment" && entry.attachment?.type === "queued_command"
  )
}

function textOf(entry: Entry): string {
  const content = isQueued(entry)
    ? entry.attachment?.prompt
    : entry.message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : []
    )
    .join("\n")
}
