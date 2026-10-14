/**
 * The rules a chat composer's `@` follows, with nothing behind them.
 *
 * The split is so a test can reach these: the catalogue next door reads the
 * Explorer's store as it is imported, and this half is strings and arithmetic.
 *
 * **`@` offers the chat's own folders and files, and a mention is a path.**
 * Nothing is expanded and nothing is attached: the turn runs in the checkout
 * with `Read`, so `src/main/ipc.ts` is already something the agent can open —
 * and it is what the agent would have typed itself. Pasting the file in would
 * be handing it a copy of something that may have changed by the time it looks.
 *
 * There was an `@` here that listed the workspace's databases, saved requests
 * and notes instead, on the grounds that only a studio can offer them. It is
 * gone: those three are reachable in the turn as MCP tools that take a name,
 * while the thing somebody actually reaches for mid-sentence is a path, and a
 * menu of two dozen table names is a menu without the file they meant in it.
 * See `docs/design.md`.
 *
 * So a mention is plain text — `@` and the path — and the highlight is drawn
 * behind it from the index: what is tinted is an `@path` the workspace still
 * holds, which means one typed by hand lights up as well as one picked from the
 * menu, and one whose file has been deleted stops being tinted once the index is
 * walked again.
 *
 * **The `@` is kept rather than replaced by the path.** It used to be dropped on
 * insertion, which made a mention indistinguishable from any other word and left
 * the tint with nothing to go on but the lookup — so a message that merely used
 * the word `test` or `api` lit up because the repository has a folder by that
 * name. Keeping the sigil is what lets the tint mean "this was meant as a path"
 * rather than "these letters happen to be one".
 */

/** A folder or a file — the two things the index holds. */
export type PlainMentionKind = "file" | "directory"

/** The row's right-hand word. "folder", not "directory": it is what the
 * Explorer's own menus call one. */
export const PLAIN_LABELS: Record<PlainMentionKind, string> = {
  directory: "folder",
  file: "file",
}

/** A path a chat can be pointed at, as the menu shows it. */
export type PlainMention = {
  kind: PlainMentionKind
  /** Inserted verbatim: the path relative to the chat's checkout, which is the
   * agent's cwd. */
  label: string
  /** The row's right-hand hint — what mentioning this would cost the turn. */
  detail: string
  /** The estimate behind `detail`, kept apart so the row can show it in its own
   * right and a caller can sort or cap on it. A folder's is everything indexed
   * under it. */
  tokens: number
}

/** Where the `@` being typed starts, and what has been typed after it. */
export type MentionQuery = { from: number; filter: string }

/**
 * `@` anywhere a word could start rather than only at the start of the message,
 * because a mention belongs mid-sentence ("why is @src/main/git.ts slow?"). The
 * leading boundary is what keeps an email address typed into the prompt from
 * opening a menu.
 */
const QUERY = /(?:^|\s)@([\w./:@-]*)$/

/** What marks a word as meant to be a path, both on the way in and on the way
 * back out of `markMentions`. */
export const MENTION_SIGIL = "@"

/** A path as a draft should carry it. Every caller inserting a path goes through
 * this, or the tint has nothing to recognise it by. */
export function mentionOf(path: string): string {
  return MENTION_SIGIL + path
}

/** The mention query the caret is sitting in, or null when it is not in one. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const match = QUERY.exec(text.slice(0, caret))
  if (!match) return null
  const filter = match[1] ?? ""
  return { from: caret - filter.length - "@".length, filter }
}

/**
 * The draft with the typed `@query` replaced by `label`, and where the caret
 * lands.
 *
 * `label` goes in verbatim, sigil and all — the chat's rows are inserted through
 * `mentionOf` and the review panel's one mention is `@claude-review`, which
 * carries its own. Adding the `@` here would double whichever of the two was
 * already carrying it.
 *
 * A space follows, so the next word is not typed onto the end of the path — and
 * so the tint, which ends at the path, does not appear to swallow it. Not a
 * second one where the draft already had one: picking a row in the middle of a
 * finished sentence must not push its words apart.
 */
export function insertMention(
  text: string,
  query: MentionQuery,
  caret: number,
  label: string
): { text: string; caret: number } {
  const inserted = /^\s/.test(text.slice(caret)) ? label : `${label} `
  return {
    text: text.slice(0, query.from) + inserted + text.slice(caret),
    caret: query.from + inserted.length,
  }
}

/**
 * How many bytes of source a token is worth.
 *
 * Four is the figure Anthropic's own docs give for English and it holds close
 * enough for code. Deliberately an estimate from the size rather than a count
 * from the text: the index walks twenty thousand paths and reads none of them,
 * and a menu row does not need to be right to the token — it needs to say
 * whether this is a hundred tokens or a hundred thousand.
 */
const BYTES_PER_TOKEN = 4

/** Roughly what a file of `bytes` costs a turn. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / BYTES_PER_TOKEN)
}

/**
 * A token count as a row shows it — `~820`, `~12.4k`, `~1.3M` tokens.
 *
 * Rounded hard on purpose. The number is an estimate of an estimate, and
 * `~12,431 tokens` beside a path would be claiming a precision the walk never
 * had.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`
  if (tokens < 1_000_000) return `~${trim(tokens / 1000)}k tokens`
  return `~${trim(tokens / 1_000_000)}M tokens`
}

/** One decimal below ten, none above: `~1.2k`, `~48k`. */
function trim(value: number): string {
  return value < 10
    ? value.toFixed(1).replace(/\.0$/, "")
    : String(Math.round(value))
}

/** What the menu needs of an indexed path — `FileIndexEntry` cut to the part
 * this file can be tested with. */
export type IndexedPath = {
  /** Relative to the chat's checkout, with forward slashes. */
  relative: string
  kind: PlainMentionKind
  bytes: number
}

/**
 * The index as menu rows, with a folder carrying what is under it.
 *
 * A folder's estimate is the sum of every indexed file below it, because that
 * is the question being asked of the row: mentioning `src/main` is asking the
 * turn to read a directory, and the number that matters is the directory's, not
 * the zero bytes of the entry itself. Summed by walking each file's ancestors
 * once, so this is one pass over the index rather than a scan per folder.
 *
 * The walk's own ceiling and its ignored directories (`node_modules`, `dist`,
 * `.git` — `IGNORED_DIRECTORIES` in `main/files.ts`) mean a folder's total is a
 * floor, not an audit. That is the right direction to be wrong in: nothing here
 * promises a budget, it warns about an order of magnitude.
 */
export function pathMentions(entries: readonly IndexedPath[]): PlainMention[] {
  const totals = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind !== "file") continue
    const parts = entry.relative.split("/")
    // The file's own name is not a folder; every segment above it is one.
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folder = parts.slice(0, depth).join("/")
      totals.set(folder, (totals.get(folder) ?? 0) + entry.bytes)
    }
  }

  return entries.map((entry) => {
    const bytes =
      entry.kind === "directory"
        ? (totals.get(entry.relative) ?? 0)
        : entry.bytes
    const tokens = estimateTokens(bytes)
    return {
      kind: entry.kind,
      label: entry.relative,
      detail: formatTokens(tokens),
      tokens,
    }
  })
}

/** A run of the draft, tinted when it names a path the workspace holds. */
export type MentionSegment = { text: string; kind: PlainMentionKind | null }

/** Punctuation a path can be wrapped in without stopping being one: a path in
 * brackets, or at the end of a sentence. A full stop is only shed from the end,
 * so `src/main/ipc.ts` keeps its extension. */
const OPENERS = "('\"`[{<"
const CLOSERS = ")'\"`]}>,;:!?."

/**
 * The draft cut into tinted and untinted runs.
 *
 * **Only a word starting with `@` is a candidate**, and the `@` is part of the
 * tinted run. Tinting any word that happened to be in the index meant that in a
 * repository holding `src/api` or `test`, a sentence using either of those words
 * lit up as if a file had been pointed at — the tint claimed an intent the text
 * never had. The sigil is the intent, and it survives to the CLI, which reads
 * `@path` as a file reference itself.
 *
 * Word by word against a lookup, rather than the one regexp of every known name
 * this used to build: the catalogue was a few dozen table names and the index is
 * twenty thousand paths, so a pattern rebuilt on every keystroke is the one
 * thing here that would be felt while typing.
 *
 * Matched whole and case-sensitively — `@src/main` does not tint the `src/main`
 * inside `@src/main/ipc.ts`, which is its own row and tints as itself.
 */
export function markMentions(
  text: string,
  known: readonly PlainMention[]
): MentionSegment[] {
  const kinds = new Map<string, PlainMentionKind>()
  for (const mention of known) {
    if (!kinds.has(mention.label)) kinds.set(mention.label, mention.kind)
  }
  if (text === "" || kinds.size === 0) return [{ text, kind: null }]

  const segments: MentionSegment[] = []
  let at = 0
  for (const match of text.matchAll(/\S+/g)) {
    const { value, offset } = unwrap(match[0])
    if (!value.startsWith(MENTION_SIGIL)) continue
    const kind = kinds.get(value.slice(MENTION_SIGIL.length))
    if (!kind) continue

    const start = match.index + offset
    if (start > at) segments.push({ text: text.slice(at, start), kind: null })
    segments.push({ text: value, kind })
    at = start + value.length
  }
  if (at < text.length) segments.push({ text: text.slice(at), kind: null })

  return segments
}

/** A word without the punctuation around it, and how far in what is left
 * starts. */
function unwrap(word: string): { value: string; offset: number } {
  let start = 0
  let end = word.length
  while (start < end && OPENERS.includes(word[start]!)) start += 1
  while (end > start && CLOSERS.includes(word[end - 1]!)) end -= 1
  return { value: word.slice(start, end), offset: start }
}

/**
 * The rows worth showing for `filter`, best first.
 *
 * With nothing typed this is the top of the tree — shallowest first, folders
 * before files — because the moment after `@` the useful answer is "what is in
 * this repository", not twenty thousand paths in whatever order the walk found
 * them.
 *
 * With something typed it is the palette's kind of match, in the order somebody
 * thinks about it: the name starting with what was typed, then containing it,
 * then the directories above it, then the characters merely appearing in order
 * (`slfs` finds `src/lib/files/store.ts`). Shorter breaks a tie, which is what
 * keeps `src/store.ts` above `src/renderer/lib/db/explorer-store.ts`.
 */
export function rankPlainMentions(
  all: readonly PlainMention[],
  filter: string,
  limit = 40
): PlainMention[] {
  const needle = filter.trim().toLowerCase()

  if (needle === "") {
    return [...all]
      .sort((left, right) => {
        const depth = depthOf(left.label) - depthOf(right.label)
        if (depth !== 0) return depth
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
        return left.label.localeCompare(right.label)
      })
      .slice(0, limit)
  }

  const scored: { mention: PlainMention; score: number }[] = []
  for (const mention of all) {
    const score = scoreOf(mention.label, needle)
    if (score !== null) scored.push({ mention, score })
  }

  return scored
    .sort((left, right) =>
      left.score === right.score
        ? left.mention.label.length - right.mention.label.length
        : left.score - right.score
    )
    .slice(0, limit)
    .map((entry) => entry.mention)
}

function depthOf(label: string): number {
  let depth = 0
  for (const character of label) if (character === "/") depth += 1
  return depth
}

/** Lower is better, and null is no match at all. */
function scoreOf(label: string, needle: string): number | null {
  const path = label.toLowerCase()
  const name = path.slice(path.lastIndexOf("/") + 1)

  if (name.startsWith(needle)) return 0
  if (name.includes(needle)) return 1
  if (path.includes(needle)) return 2

  // Slashes are how a path is typed but not necessarily how it is being
  // matched: dropping them lets "libfiles" find `lib/files`.
  const loose = needle.replace(/[/\\ ]/g, "")
  return subsequence(path.replace(/\//g, ""), loose) ? 3 : null
}

/** Whether every character of `needle` appears in `text`, in order. */
function subsequence(text: string, needle: string): boolean {
  let at = 0
  for (const character of needle) {
    at = text.indexOf(character, at)
    if (at === -1) return false
    at += 1
  }
  return true
}
