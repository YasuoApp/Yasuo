import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { promisify } from "node:util"

import { query } from "@anthropic-ai/claude-agent-sdk"

import type {
  McpListing,
  McpServerInfo,
  McpServerState,
  McpToolInfo,
} from "../shared/api"
import { claudeBinary } from "./claude-bin"
import { locate, spawnEnvironment } from "./shell-env"

const run = promisify(execFile)

/**
 * Which MCP servers the user's own `claude` has — the listing `/mcp` draws.
 *
 * **Why this is asked rather than read.** This app configures none of these any
 * more (see `docs/design.md`), so the only list it could assemble itself would
 * be a parse of the files the CLI reads: `~/.claude.json`, a repository's own
 * `.mcp.json`, the enabled plugins' manifests, whatever a claude.ai connector
 * amounts to. That parse would go stale with every CLI release, and it would
 * still not answer the questions somebody opens this section with — did it
 * connect, what did it fail with, which tools does it actually offer. The CLI
 * knows all three because it is the thing that connected.
 *
 * **What it costs.** A `claude` process and no tokens, exactly like
 * `agent-models.ts` — `mcpServerStatus()` is a control request over the SDK's
 * own stdin channel, answered out of what the CLI knows. The prompt handed to
 * `query()` is an async iterable that never yields, so the process comes up,
 * initialises, answers, and is closed without a turn.
 *
 * **Asked in a directory**, unlike the model list: an MCP config is per
 * directory, so the servers a chat in one project can reach are not the servers
 * a chat in another can. The answer is true of the `cwd` it was asked in and
 * says so.
 *
 * **Not cached across asks.** The model list is held for the run because the
 * answer only changes when the user installs a different CLI; this one changes
 * the moment they run `claude mcp add`, which is generally *why* they are
 * looking at it. What is shared is only an ask already in flight for the same
 * directory — Strict Mode mounts an effect twice, and two windows can open
 * Settings at once.
 */

/** Asks in flight, by directory. Deleted when one settles, cached or not. */
const asking = new Map<string, Promise<McpListing>>()

/**
 * A spawn that never answers must not leave the section spinning.
 *
 * Longer than `agentModels`' ten seconds because more has to happen: the login
 * shell resolve both pay for, then the CLI's own MCP startup, which connects
 * each server with a five-second cap of its own. A workspace with half a dozen
 * servers where two are down is the case this is sized for.
 */
const TIMEOUT_MS = 30_000

/**
 * Startup is not blocking for the CLI, so the first answer can be all `pending`.
 *
 * Asked again rather than waited out blind: a re-ask is another control request
 * on a process that is already up, so the cost of being wrong about the timing
 * is milliseconds. Stops as soon as nothing is pending.
 *
 * **Sized against a real install**, because the first version of this was not
 * and it showed: measured in this repository, a local stdio server settles by
 * ~1.4s, a plugin's HTTP server by ~2.4s, and an account's **claude.ai
 * connectors** — a ClickUp, a Figma — take **~4.4s**, since each is a proxy
 * that has to reach out. A budget of two seconds left exactly those two drawn
 * as *Connecting* for ever while `/mcp` in a terminal, whose session has been
 * up for minutes, showed them connected. Eight seconds covers the measured case
 * with room, and is a **deadline** rather than a retry count so the cadence and
 * the budget can be read apart.
 *
 * It is still a ceiling and not "until they all settle": a server that never
 * connects must not hold the whole listing, so what is past the deadline is
 * drawn as *Connecting* and **Refresh** asks again.
 */
const PENDING_BUDGET_MS = 8_000
const PENDING_DELAY_MS = 600

export function installedMcpServers(cwd: string | null): Promise<McpListing> {
  const where = cwd ?? homedir()
  const inflight = asking.get(where)
  if (inflight) return inflight

  const ask = list(where)
    .catch((error: unknown) => ({
      cwd: where,
      servers: [],
      // The message reaches the dialog rather than only the log: "no servers"
      // and "your `claude` could not be run" are the same empty list, and only
      // one of them is something the user can do anything about.
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => {
      asking.delete(where)
    })

  asking.set(where, ask)
  return ask
}

/**
 * Removes a server from the user's own config, by running the CLI's own command.
 *
 * `claude mcp remove <name>` rather than an edit to `~/.claude.json` or a
 * repository's `.mcp.json` from here: that file is the CLI's, its shape moves
 * between releases, and two writers of one JSON file is how it gets corrupted.
 * The scope goes over only when the listing knew one — omitted, the CLI removes
 * the server from whichever scope it is actually in, which is a better answer
 * than this app guessing.
 *
 * `execFile` with an argument array, so a server named with a space or a
 * semicolon is one argument rather than a command line. The name comes from the
 * CLI's own listing, but it originates in a config file, and a config file is
 * not a thing to trust into a shell.
 *
 * Throws with the CLI's own stderr, which is what the dialog shows: "no such
 * server" and "that scope is read-only" are its sentences to write, not this
 * app's to guess at.
 */
export async function removeMcpServer(input: {
  name: string
  scope: string | null
  cwd: string | null
}): Promise<void> {
  const binary = await locate(claudeBinary())
  if (!binary) {
    throw new Error(
      `Could not find \`${claudeBinary()}\` on your PATH. Set CLAUDE_BIN if it is installed somewhere unusual.`
    )
  }

  const args = ["mcp", "remove", input.name]
  // Only the three the CLI's `--scope` takes. A `claudeai` or a plugin's
  // `dynamic` would be refused with a usage error, and those rows offer no
  // Remove button in the first place — this is the second half of that.
  if (input.scope && REMOVABLE_SCOPES.includes(input.scope)) {
    args.push("--scope", input.scope)
  }

  try {
    await run(binary, args, {
      cwd: input.cwd ?? homedir(),
      env: await spawnEnvironment(),
      timeout: REMOVE_TIMEOUT_MS,
    })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new Error(
      stderr || (error instanceof Error ? error.message : String(error))
    )
  }
}

/** The scopes `claude mcp remove --scope` accepts. A claude.ai connector and a
 * plugin's server are in neither a config file nor this list. */
export const REMOVABLE_SCOPES = ["local", "user", "project"]

/** A config edit, not a network call: this is generous already. */
const REMOVE_TIMEOUT_MS = 15_000

async function list(cwd: string): Promise<McpListing> {
  // The same resolve every other `claude` in this app goes through: a GUI app
  // inherits almost none of the user's PATH.
  const binary = await locate(claudeBinary())
  if (!binary) {
    return {
      cwd,
      servers: [],
      error: `Could not find \`${claudeBinary()}\` on your PATH. Set CLAUDE_BIN if it is installed somewhere unusual.`,
    }
  }

  const held = new AbortController()

  /*
   * A prompt that never arrives — see the same construction in
   * `agent-models.ts`. `query()` starts the CLI on the first read of this, and
   * a prompt that *ended* would let the process exit before the control request
   * had been answered.
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
    const servers = await Promise.race([settled(conversation), timeout()])
    return { cwd, servers: servers.map(readServer), error: null }
  } finally {
    // Both, in this order: the abort is what the never-arriving prompt above is
    // waiting on, and `return()` is what tears the transport down.
    held.abort()
    await conversation.return?.(undefined).catch(() => {})
  }
}

/** The CLI's answer, re-asked while anything in it is still connecting. */
async function settled(conversation: {
  mcpServerStatus: () => Promise<unknown[]>
}): Promise<unknown[]> {
  const deadline = Date.now() + PENDING_BUDGET_MS
  let servers = await conversation.mcpServerStatus()
  while (servers.some((server) => stateOf(server) === "pending")) {
    if (Date.now() >= deadline) break
    await delay(PENDING_DELAY_MS)
    servers = await conversation.mcpServerStatus()
  }
  return servers
}

/**
 * One row of the CLI's answer, narrowed to what a Settings row draws.
 *
 * Exported for `test/mcp-servers.ts` and narrowed field by field for the reason
 * `readModel` is: every value here was written by a process this app does not
 * control, and it crosses into the renderer typed as something the dialog will
 * `switch` on. A status the CLI grows later becomes `unknown` rather than a row
 * that draws nothing, and a `config` shape this app has never seen becomes a
 * missing address rather than a `[object Object]` under a server's name.
 */
export function readServer(raw: unknown): McpServerInfo {
  const server = (raw ?? {}) as Record<string, unknown>
  const config = (server.config ?? {}) as Record<string, unknown>

  return {
    name: typeof server.name === "string" ? server.name : "unknown",
    state: stateOf(raw),
    scope: typeof server.scope === "string" ? server.scope : null,
    transport: typeof config.type === "string" ? config.type : null,
    address: addressOf(config),
    // Only where it failed: a server that connected has no error, and an
    // `error` left on a row the CLI reused would read as a live failure.
    error:
      stateOf(raw) === "failed" && typeof server.error === "string"
        ? server.error
        : null,
    tools: Array.isArray(server.tools) ? server.tools.map(readTool) : [],
  }
}

/** The five the CLI names, and `unknown` for anything else — see
 * `McpServerState`. */
function stateOf(raw: unknown): McpServerState {
  const status = (raw as { status?: unknown } | null)?.status
  return typeof status === "string" && STATES.includes(status as McpServerState)
    ? (status as McpServerState)
    : "unknown"
}

const STATES: McpServerState[] = [
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
]

/**
 * What the server is, in one line under its name.
 *
 * The URL for the two remote transports and the command for a local one, which
 * is the thing that identifies a server somebody is trying to recognise. The
 * args go with the command because half of these are `npx <package>` and the
 * package is the only distinguishing part. Headers are deliberately not shown:
 * that is where a remote server's token lives.
 */
function addressOf(config: Record<string, unknown>): string | null {
  if (typeof config.url === "string") return config.url
  if (typeof config.command !== "string") return null
  const args = Array.isArray(config.args)
    ? config.args.filter((arg): arg is string => typeof arg === "string")
    : []
  return [config.command, ...args].join(" ")
}

function readTool(raw: unknown): McpToolInfo {
  const tool = (raw ?? {}) as Record<string, unknown>
  return {
    name: typeof tool.name === "string" ? tool.name : "unknown",
    description:
      typeof tool.description === "string" && tool.description.trim()
        ? tool.description.trim()
        : null,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

function timeout(): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `\`claude\` did not answer in ${TIMEOUT_MS / 1000}s. It may be waiting on a server that never connects.`
          )
        ),
      TIMEOUT_MS
    ).unref()
  })
}
