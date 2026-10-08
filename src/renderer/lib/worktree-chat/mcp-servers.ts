import type { McpServerInfo, McpServerState, McpToolInfo } from "@shared/api"

/**
 * The composer's MCP menu (`chat-mcp.tsx`), minus the drawing.
 *
 * Split out for the reason the other `lib/worktree-chat` halves are: what order
 * the rows go in and what each state is *called* are the two things worth being
 * sure of, and neither needs a dialog on screen to check. See
 * `test/mcp-servers.ts`.
 */

/**
 * Trouble first, then everything else by name.
 *
 * Not the CLI's own alphabetical order, because the reason somebody opens this
 * section is almost always a server that is not working: a failure eight rows
 * down in a list of twelve is a failure they have to go looking for. `needs-auth`
 * counts as trouble for the same reason — it is a thing to go and do, not a
 * state to note.
 *
 * Everything else keeps one order regardless of state: `connected` and
 * `disabled` sorted apart would move a row under the cursor the moment somebody
 * toggled a server in their own config and reopened the dialog.
 */
export function orderedServers(servers: McpServerInfo[]): McpServerInfo[] {
  return [...servers].sort((left, right) => {
    const byTrouble =
      Number(needsAttention(right)) - Number(needsAttention(left))
    return byTrouble !== 0
      ? byTrouble
      : left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  })
}

/** Whether a row is something to act on rather than something to read. */
export function needsAttention(server: McpServerInfo): boolean {
  return server.state === "failed" || server.state === "needs-auth"
}

/**
 * A server's name as a **tool call** carries it.
 *
 * The CLI normalises a configured name into the wire one — everything outside
 * `[a-zA-Z0-9_-]` becomes `_` — so the `claude.ai ClickUp` in this listing is
 * the `mcp__claude_ai_ClickUp__…` in a turn's tool call, and
 * `plugin:context7:context7` is `mcp__plugin_context7_context7__…`. Both are
 * real examples off this machine, and both are why switching a tool off cannot
 * just paste the name from the listing: `disallowedTools` is matched against the
 * wire name, so an entry built out of the pretty one silently matches nothing.
 */
export function wireServer(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/** What `disallowedTools` is given for one tool, or for a whole server when
 * `tool` is left out — the CLI reads a bare server prefix as all of it. */
export function wireName(server: string, tool?: string): string {
  const prefix = `mcp__${wireServer(server)}`
  return tool ? `${prefix}__${tool}` : prefix
}

/**
 * Whether a tool is switched off, by its own entry or by its server's.
 *
 * The server prefix has to be honoured here and not only by the CLI, or a row
 * would draw itself as on while the turn cannot call it — which is the one way
 * this list can lie. `disabled` is the raw setting, so nothing needs to be
 * expanded when a server with fifty tools is switched off: one entry covers it,
 * and a tool added to that server later is covered too.
 */
export function isToolOff(
  disabled: string[],
  server: string,
  tool: string
): boolean {
  return (
    disabled.includes(wireName(server, tool)) || isServerOff(disabled, server)
  )
}

/** Whether the whole server is switched off — the one entry that stands for
 * every tool on it, now and later. */
export function isServerOff(disabled: string[], server: string): boolean {
  return disabled.includes(wireName(server))
}

/**
 * The setting after a switch is flipped.
 *
 * Pure, and returns the whole list, because the store writes the whole list:
 * this is the one place that knows a server going off makes its tools'
 * individual entries redundant, and that a server coming back on must not
 * resurrect entries somebody set before. So switching a server **on** clears its
 * own entry *and* every entry under it — the alternative is a server that reads
 * as on with three of its tools still silently refused.
 */
export function withToolOff(
  disabled: string[],
  server: string,
  tool: string,
  off: boolean
): string[] {
  const entry = wireName(server, tool)
  if (off) return disabled.includes(entry) ? disabled : [...disabled, entry]
  // Only its own entry. A tool under a server that is off *as a whole* cannot
  // reach here — the dialog draws those switches off and disabled, since turning
  // one back on would mean expanding the prefix into the other forty-nine and
  // then guessing which of them the user had meant to keep.
  return disabled.filter((name) => name !== entry)
}

/** The same for a whole server. Switching it off replaces its tools' own
 * entries; switching it on removes every entry beneath it. */
export function withServerOff(
  disabled: string[],
  server: string,
  off: boolean
): string[] {
  const prefix = wireName(server)
  const others = disabled.filter(
    (name) => name !== prefix && !name.startsWith(`${prefix}__`)
  )
  return off ? [...others, prefix] : others
}

/**
 * A floor on what one server's tools cost in every turn's prompt, in tokens.
 *
 * The real number is only measurable from inside a session — the window meter's
 * `System tools` slice is it — but the switch is drawn before a session has
 * necessarily run, so the listing's own material is counted instead: each tool's
 * wire name and description at the usual ~4 characters per token. What the
 * listing does not carry is the parameter schema, which often doubles a
 * definition, so this is short of the truth and said as a floor. A floor still
 * answers the question the switch is asking: a connector reading "at least 8k a
 * turn" is worth switching off whether the truth is 8k or 16k.
 */
export function serverPromptTokens(server: McpServerInfo): number {
  return Math.round(
    server.tools.reduce((sum, tool) => sum + toolChars(server, tool) / 4, 0)
  )
}

function toolChars(server: McpServerInfo, tool: McpToolInfo): number {
  return (
    wireName(server.name, tool.name).length + (tool.description?.length ?? 0)
  )
}

/** Where an account's connectors are turned on and signed in. */
export const CONNECTOR_SETTINGS_URL = "https://claude.ai/settings/connectors"

/** Whether this app can remove a server, which is whether the CLI's own
 * `mcp remove --scope` takes its scope: a claude.ai connector lives on the
 * account and a plugin's server in the plugin, and neither is a config entry.
 * Kept beside the listing so the button and the handler agree — `main/
 * mcp-servers.ts` refuses the same three. */
export function isRemovable(server: McpServerInfo): boolean {
  return (
    server.scope === "user" ||
    server.scope === "project" ||
    server.scope === "local"
  )
}

/**
 * How to sign a server in, for the one state where that is the whole of what
 * the row is asking for.
 *
 * **The URL is derived, not reported.** `mcpServerStatus()` carries no
 * authorize link — not for either kind — so the honest thing is to send somebody
 * to the page that can start the flow rather than to invent one:
 *
 * - A **claude.ai connector** (`claudeai` scope, `claudeai-proxy` transport) is
 *   signed in on claude.ai, against the account rather than this machine, and
 *   that page is a fixed address worth linking straight to.
 * - **Anything else** remote is the CLI's own OAuth dance, which needs a
 *   callback listener and a browser round trip that this app has no part in.
 *   `/mcp` in a `claude` session is where that lives, so the row says so
 *   instead of offering a link that would only be the MCP endpoint — which in a
 *   browser is a protocol error, not a sign-in page.
 *
 * Null for every other state: a connected server has nothing to do, and a
 * failure is a message to read rather than an action to take.
 */
export function signIn(
  server: McpServerInfo
): { kind: "connector"; url: string } | { kind: "cli" } | null {
  if (server.state !== "needs-auth") return null
  return server.scope === "claudeai" || server.transport === "claudeai-proxy"
    ? { kind: "connector", url: CONNECTOR_SETTINGS_URL }
    : { kind: "cli" }
}

/**
 * What a state is called, and how loudly.
 *
 * The CLI's own words are `needs-auth` and `pending`, and neither is what a
 * person would say — "needs sign-in" is the thing to do about the first, and
 * "connecting" says the second is still in progress rather than deferred for
 * ever. `unknown` is a state the CLI grew after this was written (see
 * `McpServerState`) and is drawn plainly rather than as trouble: this app not
 * having a word for it is not the server's problem.
 */
export function stateLabel(state: McpServerState): {
  label: string
  tone: "good" | "bad" | "waiting" | "off"
} {
  switch (state) {
    case "connected":
      return { label: "Connected", tone: "good" }
    case "failed":
      return { label: "Failed", tone: "bad" }
    case "needs-auth":
      return { label: "Needs sign-in", tone: "bad" }
    case "pending":
      return { label: "Connecting", tone: "waiting" }
    case "disabled":
      return { label: "Disabled", tone: "off" }
    default:
      return { label: "Unknown", tone: "off" }
  }
}

/** The line under a server's name: where it is configured and how it is
 * reached, with whichever of the two the CLI actually said. */
export function serverCaption(server: McpServerInfo): string {
  return [server.scope, server.transport].filter(Boolean).join(" · ")
}
