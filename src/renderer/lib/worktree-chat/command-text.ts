import type { AgentCommand } from "@shared/api"

/**
 * The rules a chat composer's `/` follows, with nothing behind them.
 *
 * Split out from the drawing for the reason `mention-text.ts` is: the catalogue
 * next door reaches for `window.desktop`, and this half is strings and
 * arithmetic a test can call.
 *
 * **`/` offers the user's own `claude`'s commands, and a command is plain
 * text.** Nothing is expanded here: `/code-review high` goes to the CLI as the
 * message, exactly as it would be typed in a terminal, and the CLI is what turns
 * it into a prompt. The one thing this app does with a slash command is decide
 * whether it is *its* to answer instead — see `LOCAL_COMMANDS` below — because a
 * handful of them are about the conversation rather than about the code.
 */

/** Where the `/` being typed starts, and what has been typed after it. */
export type CommandQuery = { from: number; filter: string }

/**
 * `/` at the very start of the message and nowhere else.
 *
 * Deliberately narrower than `@`, which opens a menu anywhere a word can start.
 * A slash is punctuation in ordinary prose — `src/main`, `and/or`, a URL — so a
 * menu that opened mid-sentence would open on almost every message about a file,
 * and it would be *wrong* to as well: the CLI only reads a slash command at the
 * head of a message, so a menu offering one in the middle would insert text that
 * runs as literal prose.
 *
 * Leading whitespace is allowed, and only whitespace: a draft that starts with a
 * stray newline is still a message that begins with a command.
 */
const QUERY = /^\s*\/([\w:.-]*)$/

/** The command query the caret is sitting in, or null when it is not in one. */
export function commandQuery(text: string, caret: number): CommandQuery | null {
  const match = QUERY.exec(text.slice(0, caret))
  if (!match) return null
  const filter = match[1] ?? ""
  return { from: caret - filter.length - "/".length, filter }
}

/**
 * The draft with the typed `/query` replaced by the command, and where the caret
 * lands.
 *
 * A space follows so an argument can be typed straight on, which is the reason
 * this differs from `insertMention`'s rule in one way: the space goes in even
 * where the text after the caret already has one, because a command's argument
 * belongs immediately after it and a caret parked before somebody else's
 * whitespace is a caret in the wrong place. The `/` is written back rather than
 * kept, so this works whether the query came from a typed `/` or from the `+`
 * menu putting one there.
 */
export function insertCommand(
  text: string,
  query: CommandQuery,
  caret: number,
  name: string
): { text: string; caret: number } {
  const inserted = `/${name} `
  return {
    text: text.slice(0, query.from) + inserted + text.slice(caret),
    caret: query.from + inserted.length,
  }
}

/**
 * The command a draft names, if it names one, with whatever follows it.
 *
 * Parsed from the draft rather than from the menu's pick, and that is the point:
 * `/clear` typed in full and never picked from a row has to mean the same thing
 * as `/clear` chosen with Enter. The argument is the rest of the *first line* —
 * a command's argument does not run over a line break in the CLI either, and a
 * `/rename` followed by two paragraphs is a rename plus a message somebody meant
 * to send separately.
 */
export function parseCommand(
  text: string
): { name: string; argument: string } | null {
  const match = /^\s*\/([\w:.-]+)[ \t]*(.*)$/.exec(text.split("\n")[0] ?? "")
  if (!match?.[1]) return null
  return { name: match[1], argument: (match[2] ?? "").trim() }
}

/**
 * The commands this app answers itself instead of sending.
 *
 * **Kept to the two that are about the conversation rather than about the
 * code.** Everything else the CLI names — `/compact`, `/context`, `/init`,
 * `/code-review`, every skill and every plugin's command — goes over as the
 * message and is run by the CLI in the session, which is both less code here and
 * the only way those stay correct as the CLI changes them.
 *
 * `clear` is here because the CLI's own is a *terminal* action: it swaps the
 * session the terminal is attached to, and there is no terminal here to swap.
 * Sent as a message it would be read as prose, and the transcript on screen —
 * which is this app's file, not the CLI's — would still be full. See
 * `clearWorktreeChat`, which is the half that has to close the session too.
 *
 * `rename` is here because this app already owns what a chat is called: it is in
 * the tab and in the project's list, and the CLI renaming its own session
 * transcript would leave the two disagreeing.
 */
export const LOCAL_COMMANDS = ["clear", "rename"] as const

export type LocalCommand = (typeof LOCAL_COMMANDS)[number]

/** The local command a draft names, or null when it is a message for the CLI —
 * including when it is a slash command the CLI should run. */
export function localCommand(
  text: string
): { name: LocalCommand; argument: string } | null {
  const parsed = parseCommand(text)
  if (!parsed) return null
  return (LOCAL_COMMANDS as readonly string[]).includes(parsed.name)
    ? { name: parsed.name as LocalCommand, argument: parsed.argument }
    : null
}

/**
 * Commands the CLI lists that this composer does not.
 *
 * **This list is written down because it cannot be asked for.** The SDK marks
 * terminal-bound commands in its `init` frame (`terminal_slash_commands`), and
 * that frame only arrives once a turn starts — so the control-channel ask in
 * `main/agent-commands.ts`, which deliberately never runs a turn, never sees it.
 * The alternative was starting a turn per launch to find out, which costs tokens
 * to learn something that changes once a release.
 *
 * Three kinds are in here, and the distinction is worth keeping:
 *
 * - **A terminal's own settings.** `/color` sets a prompt bar this app has none
 *   of; `/config` and `/import` edit the CLI's own; `/heapdump` writes to the
 *   Desktop of a process that is not this one.
 * - **Controls this composer already has**, and would then have twice: `/model`,
 *   `/effort` and `/fast` are the toolbar's model menu, and a session's model is
 *   moved by `setModel` here rather than by a message. `/mcp` is the toolbar's MCP menu.
 * - **Sessions this app has no notion of**: the CLI's `__`-prefixed internals
 *   and its server-launched workflow handoffs, which are for a session started
 *   by something other than a person typing.
 *
 * Anything not named here is offered, including commands this app has never
 * heard of — a plugin installed tomorrow appears in the menu without a release,
 * which is the whole reason the list is asked for.
 */
const HIDDEN = new Set([
  "autocompact",
  "color",
  "config",
  "effort",
  "extra-usage",
  "fast",
  "heapdump",
  "import",
  "mcp",
  "model",
  "usage-credits",
  "workflow-launch-exec",
])

/** The rows worth drawing: what the CLI named, minus the ones above and minus
 * its internals, which are prefixed rather than listed. */
export function visibleCommands(all: AgentCommand[]): AgentCommand[] {
  return all.filter(
    (command) =>
      command.name &&
      !command.name.startsWith("__") &&
      !HIDDEN.has(command.name)
  )
}

/**
 * The commands matching what has been typed, best first.
 *
 * The same four-tier scoring as `rankPlainMentions`, over one more surface: a
 * command's **aliases** are matched as well as its name, since the CLI offers
 * `review` for `code-review` and somebody who knows the short form should not
 * have to find out it is the long one here. An alias never becomes the row's
 * label — a command listed twice under two names is two commands to read — so
 * what a match on one does is put the command it belongs to higher.
 *
 * The last tier is a subsequence match, which is what makes `fgu` find
 * `figma:figma-use`: a namespaced command is long enough that nobody types it
 * out, and a prefix match alone would mean scrolling for every plugin's.
 */
export function rankCommands(
  all: AgentCommand[],
  filter: string,
  limit: number
): AgentCommand[] {
  const needle = filter.toLowerCase()
  const scored: { command: AgentCommand; score: number }[] = []

  for (const command of all) {
    const score = scoreOf(command, needle)
    if (score !== null) scored.push({ command, score })
  }

  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.command.name.length - b.command.name.length ||
        a.command.name.localeCompare(b.command.name)
    )
    .slice(0, limit)
    .map((entry) => entry.command)
}

/** Lower is better; null is no match at all. Every name a command answers to is
 * scored and the best one wins, so an exact alias beats a vague name match. */
function scoreOf(command: AgentCommand, needle: string): number | null {
  if (!needle) return 0

  let best: number | null = null
  for (const name of [command.name, ...command.aliases]) {
    const score = scoreName(name.toLowerCase(), needle)
    if (score !== null && (best === null || score < best)) best = score
  }
  return best
}

function scoreName(name: string, needle: string): number | null {
  if (name.startsWith(needle)) return 0
  // After the namespace too: `figma:figma-use` is what somebody typing `figma-u`
  // is reaching for, and the prefix above would not have found it.
  const bare = name.slice(name.indexOf(":") + 1)
  if (bare.startsWith(needle)) return 1
  if (name.includes(needle)) return 2
  return subsequence(name, needle) ? 3 : null
}

/** Whether every letter of the needle appears in order — `fgu` in
 * `figma:figma-use`. */
function subsequence(name: string, needle: string): boolean {
  let at = 0
  for (const letter of needle) {
    at = name.indexOf(letter, at) + 1
    if (at === 0) return false
  }
  return true
}
