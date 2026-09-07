import { homedir } from "node:os"

import { query } from "@anthropic-ai/claude-agent-sdk"

import type { AgentCommand, AgentCommandListing } from "../shared/api"
import { claudeBinary } from "./claude-bin"
import { locate, spawnEnvironment } from "./shell-env"

/**
 * Which slash commands the user's own `claude` has — the list pressing `/` in
 * the CLI draws.
 *
 * **Why this is asked rather than written down.** The set is the CLI's built-ins
 * plus the user's `~/.claude/commands`, plus this repository's own
 * `.claude/commands`, plus every skill of every enabled plugin — measured here,
 * seventy-odd rows of which fewer than thirty are the CLI's own. A written list
 * would hold none of the four that are the user's, and would go stale against
 * the CLI's with every release. Same argument as `agent-models.ts`.
 *
 * **What it costs.** A `claude` process and no tokens: `supportedCommands()` is
 * a control request over the SDK's stdin channel, answered out of what the CLI
 * has already loaded. The prompt handed to `query()` is an async iterable that
 * never yields, so the process comes up, initialises, answers, and is closed
 * without a turn ever running.
 *
 * **Asked in a directory**, like the MCP listing and unlike the model list: a
 * repository's `.claude/commands` and its skills belong to that checkout, so the
 * commands a chat in one project can run are not the commands a chat in another
 * can.
 *
 * **What it cannot tell you.** The SDK's `init` frame carries a
 * `terminal_slash_commands` — the ones a non-terminal UI is meant to hide — and
 * that frame is emitted when a *turn* starts. A never-yielding prompt never
 * starts one, so no init frame arrives here (verified: the message stream stays
 * empty for the whole call). Which commands make no sense in this composer is
 * therefore the renderer's own list, in `lib/worktree-chat/command-text.ts`, and
 * this module hands over everything the CLI named.
 */

/** Asks in flight or finished, by directory. A directory whose ask failed is
 * dropped, so the next `/` typed tries again — see `agentModels`. */
const asking = new Map<string, Promise<AgentCommandListing>>()

/**
 * A spawn that never answers must not leave the menu empty for ever.
 *
 * Between `agentModels`' ten seconds and the MCP listing's thirty: this pays
 * for the same login-shell resolve and CLI startup as both, but nothing here
 * waits on a network the way a connector does.
 */
const TIMEOUT_MS = 15_000

export function agentCommands(
  cwd: string | null
): Promise<AgentCommandListing> {
  const where = cwd ?? homedir()
  const held = asking.get(where)
  if (held) return held

  const ask = list(where).catch((error: unknown) => {
    // Not cached: a CLI that was missing when the app launched is found once it
    // is installed, and the menu is opened often enough to notice.
    asking.delete(where)
    return {
      cwd: where,
      commands: [],
      // The message reaches the menu rather than only the log, for the reason
      // the MCP listing's does: "no commands" and "your `claude` could not be
      // run" are the same empty list, and only one is actionable.
      error: error instanceof Error ? error.message : String(error),
    }
  })

  asking.set(where, ask)
  return ask
}

async function list(cwd: string): Promise<AgentCommandListing> {
  // The same resolve every other `claude` in this app goes through: a GUI app
  // inherits almost none of the user's PATH.
  const binary = await locate(claudeBinary())
  if (!binary) {
    return {
      cwd,
      commands: [],
      error: `Could not find \`${claudeBinary()}\` on your PATH. Set CLAUDE_BIN if it is installed somewhere unusual.`,
    }
  }

  const held = new AbortController()

  /*
   * A prompt that never arrives — the same construction as `agent-models.ts`.
   * `query()` starts the CLI on the first read of this, and a prompt that
   * *ended* would let the process exit before the control request had been
   * answered.
   */
  const nothing: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<never, undefined>>((resolve) => {
          held.signal.addEventListener(
            "abort",
            () => resolve({ done: true, value: undefined }),
            { once: true }
          )
        }),
    }),
  }

  const conversation = query({
    prompt: nothing,
    options: {
      cwd,
      pathToClaudeCodeExecutable: binary,
      env: await spawnEnvironment(),
      abortController: held,
    },
  })

  try {
    const commands = await Promise.race([
      conversation.supportedCommands(),
      timeout(),
    ])
    return { cwd, commands: commands.map(readCommand), error: null }
  } finally {
    // Both, in this order: the abort is what the never-arriving prompt above is
    // waiting on, and `return()` is what tears the transport down.
    held.abort()
    await conversation.return?.(undefined).catch(() => {})
  }
}

/**
 * One row of the CLI's answer, narrowed to what a menu row draws.
 *
 * Field by field for the reason `readModel` and `readServer` are: every value
 * here was written by a process this app does not control — and a third of them
 * originate in a plugin's or a repository's own frontmatter, which is further
 * still from anything this app can vouch for. A command with no description is a
 * row with an empty second line rather than one reading `undefined`.
 *
 * Exported for `test/chat-commands.ts`.
 */
export function readCommand(raw: unknown): AgentCommand {
  const command = (raw ?? {}) as Record<string, unknown>
  return {
    name: typeof command.name === "string" ? command.name : "",
    description:
      typeof command.description === "string" ? command.description.trim() : "",
    argumentHint:
      typeof command.argumentHint === "string"
        ? command.argumentHint.trim()
        : "",
    aliases: Array.isArray(command.aliases)
      ? command.aliases.filter(
          (alias): alias is string => typeof alias === "string"
        )
      : [],
  }
}

function timeout(): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(`\`claude\` did not answer in ${TIMEOUT_MS / 1000}s.`)
        ),
      TIMEOUT_MS
    ).unref()
  })
}
