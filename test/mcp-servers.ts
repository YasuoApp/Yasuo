import { readServer } from "../src/main/mcp-servers"
import {
  CONNECTOR_SETTINGS_URL,
  isRemovable,
  isServerOff,
  isToolOff,
  needsAttention,
  orderedServers,
  serverCaption,
  serverPromptTokens,
  signIn,
  stateLabel,
  wireName,
  wireServer,
  withServerOff,
  withToolOff,
} from "../src/renderer/lib/worktree-chat/mcp-servers"
import { check, finish, section } from "./harness"

/**
 * The MCP listing, which is the CLI's answer rather than this app's list.
 *
 * Worth a test for the reason `chat-models.ts` is: every field here was written
 * by a process this app does not control and crosses into the renderer typed as
 * something the dialog will `switch` on. The cases that matter are the ones the
 * CLI is free to change under us — a status word this app has never seen, a
 * `config` shape it does not recognise, an error left on a row that connected —
 * and the ordering, whose whole job is that a broken server is the first thing
 * on screen.
 */

const row = (over: Record<string, unknown> = {}) => ({
  name: "linear",
  status: "connected",
  scope: "user",
  config: { type: "http", url: "https://mcp.linear.app/mcp" },
  tools: [{ name: "create_issue", description: "Creates an issue" }],
  ...over,
})

section("readServer: one row of the CLI's answer")
{
  const linear = readServer(row())
  check("keeps the configured name", linear.name === "linear", linear)
  check("and the status it reported", linear.state === "connected", linear)
  check("with its scope", linear.scope === "user", linear)
  check("its transport", linear.transport === "http", linear)
  check(
    "and the URL behind it",
    linear.address === "https://mcp.linear.app/mcp",
    linear
  )
  check("tools come through", linear.tools[0]?.name === "create_issue", linear)

  const stdio = readServer(
    row({
      config: { type: "stdio", command: "npx", args: ["-y", "@some/server"] },
    })
  )
  check(
    "a local server is addressed by its command line",
    stdio.address === "npx -y @some/server",
    stdio
  )

  // The one thing deliberately not read out of a config: a remote server's
  // headers are where its token is.
  const secret = readServer(
    row({ config: { type: "http", url: "https://x/mcp", headers: { a: "b" } } })
  )
  check(
    "and nothing else of the config is drawn",
    JSON.stringify(secret).includes('"b"') === false,
    secret
  )

  const grown = readServer(row({ status: "quantum-entangled" }))
  check(
    "a status this app has no word for is unknown",
    grown.state === "unknown",
    grown
  )

  const failed = readServer(row({ status: "failed", error: "spawn ENOENT" }))
  check("a failure keeps its message", failed.error === "spawn ENOENT", failed)

  // A row that connected with an `error` still on it: the CLI reuses these
  // records, and a stale message would read as a live failure.
  const stale = readServer(row({ error: "spawn ENOENT" }))
  check("but a connected server has none", stale.error === null, stale)

  const bare = readServer({})
  check("a row with nothing in it still draws", bare.name === "unknown", bare)
  check("with no tools", bare.tools.length === 0, bare)
  check("and no address", bare.address === null, bare)
  check("nothing at all is a row too", readServer(null).state === "unknown")

  const odd = readServer(row({ tools: [{ name: 7 }, { name: "ok" }] }))
  check(
    "a tool the CLI named oddly is still a row",
    odd.tools.map((tool) => tool.name).join() === "unknown,ok",
    odd
  )
}

section("orderedServers: trouble first")
{
  const servers = [
    readServer(row({ name: "zed", status: "connected" })),
    readServer(row({ name: "asana", status: "disabled" })),
    readServer(row({ name: "notion", status: "failed" })),
    readServer(row({ name: "atlassian", status: "needs-auth" })),
    readServer(row({ name: "beta", status: "connected" })),
  ]
  const order = orderedServers(servers).map((server) => server.name)
  check(
    "a failure and a sign-in come first, by name between them",
    order.slice(0, 2).join() === "atlassian,notion",
    order
  )
  check(
    "and the rest keep one order whatever their state",
    order.slice(2).join() === "asana,beta,zed",
    order
  )
  check("nothing is dropped", order.length === servers.length)
  check("an empty answer is an empty list", orderedServers([]).length === 0)
  check(
    "the caller's array is not reordered under it",
    servers[0]?.name === "zed",
    servers.map((server) => server.name)
  )
  check(
    "connected is not attention",
    !needsAttention(readServer(row())),
    "connected"
  )
}

section("stateLabel: the CLI's words, in a person's")
{
  check("connected", stateLabel("connected").tone === "good")
  check("failed is loud", stateLabel("failed").tone === "bad")
  check(
    "needs-auth says what to do",
    stateLabel("needs-auth").label === "Needs sign-in"
  )
  check(
    "pending is in progress",
    stateLabel("pending").label === "Connecting" &&
      stateLabel("pending").tone === "waiting"
  )
  check("disabled is quiet", stateLabel("disabled").tone === "off")
  check(
    "and a word this app has no row for is quiet too",
    stateLabel("unknown").tone === "off"
  )
}

section("signIn: only where signing in is the whole of the ask")
{
  const connector = readServer(
    row({
      name: "claude.ai Notion",
      status: "needs-auth",
      scope: "claudeai",
      config: { type: "claudeai-proxy", url: "https://claude.ai/api/mcp" },
    })
  )
  const action = signIn(connector)
  check(
    "a claude.ai connector links to the account's own page",
    action?.kind === "connector",
    action
  )
  check(
    "which is claude.ai and not the server's endpoint",
    action?.kind === "connector" && action.url === CONNECTOR_SETTINGS_URL,
    action
  )
  // Either half is enough: a CLI that stops naming the scope must not turn a
  // connector into a `/mcp` instruction that will not work for it.
  const scopeless = readServer(
    row({
      status: "needs-auth",
      scope: undefined,
      config: { type: "claudeai-proxy", url: "https://claude.ai/api/mcp" },
    })
  )
  check(
    "recognised by the transport alone",
    signIn(scopeless)?.kind === "connector",
    signIn(scopeless)
  )

  const own = readServer(
    row({
      name: "sentry",
      status: "needs-auth",
      scope: "user",
      config: { type: "http", url: "https://mcp.sentry.dev/mcp" },
    })
  )
  check(
    "anything else is the CLI's own flow",
    signIn(own)?.kind === "cli",
    signIn(own)
  )

  check(
    "a connected server has nothing to do",
    signIn(readServer(row())) === null
  )
  check(
    "and a failure is a message, not an action",
    signIn(readServer(row({ status: "failed", error: "boom" }))) === null
  )
}

section("wireName: the name a tool call actually carries")
{
  // Both off this machine: the configured name is not the wire name, and an
  // entry built out of the pretty one matches nothing at all.
  check(
    "a space and a dot become underscores",
    wireServer("claude.ai ClickUp") === "claude_ai_ClickUp"
  )
  check(
    "so do a plugin's colons",
    wireServer("plugin:context7:context7") === "plugin_context7_context7"
  )
  check("a plain name is left alone", wireServer("linear") === "linear")
  check("a dash survives", wireServer("my-figma") === "my-figma")
  check(
    "one tool",
    wireName("claude.ai ClickUp", "clickup_search") ===
      "mcp__claude_ai_ClickUp__clickup_search"
  )
  check(
    "and a whole server",
    wireName("claude.ai ClickUp") === "mcp__claude_ai_ClickUp"
  )
}

section("switching tools off: what the setting becomes")
{
  const off = withToolOff([], "claude.ai ClickUp", "clickup_search", true)
  check(
    "one tool is one wire entry",
    off.join() === "mcp__claude_ai_ClickUp__clickup_search",
    off
  )
  check(
    "and reads back as off",
    isToolOff(off, "claude.ai ClickUp", "clickup_search")
  )
  check(
    "while its neighbour does not",
    !isToolOff(off, "claude.ai ClickUp", "clickup_create_task")
  )
  check(
    "switching it off twice does not double the entry",
    withToolOff(off, "claude.ai ClickUp", "clickup_search", true).length === 1
  )
  check(
    "and on again empties it",
    withToolOff(off, "claude.ai ClickUp", "clickup_search", false).length === 0
  )

  const server = withServerOff(off, "claude.ai ClickUp", true)
  check(
    "a whole server is one entry, replacing its tools'",
    server.join() === "mcp__claude_ai_ClickUp",
    server
  )
  check(
    "which covers every tool on it",
    isToolOff(server, "claude.ai ClickUp", "anything_at_all") &&
      isServerOff(server, "claude.ai ClickUp")
  )
  check(
    "and leaves another server alone",
    withServerOff(server, "linear", true).length === 2
  )
  // The case this exists for: a server switched back on must not leave the
  // three tools somebody had switched off individually still refused.
  const revived = withServerOff(
    withToolOff(server, "linear", "create_issue", true),
    "claude.ai ClickUp",
    false
  )
  check(
    "switching a server on clears everything under it",
    revived.join() === "mcp__linear__create_issue",
    revived
  )
}

section("what the tools cost a turn: a floor")
{
  // Descriptions sized so name + description divides by four exactly, keeping
  // every expectation below free of rounding.
  const tool = (name: string, chars: number) => ({
    name,
    description: "d".repeat(chars),
  })
  // `mcp__claude_ai_ClickUp__a` is 25 characters; 25 + 103 = 32 tokens.
  const heavy = readServer(
    row({ name: "claude.ai ClickUp", tools: [tool("a", 103), tool("b", 103)] })
  )

  const each = (wireName("claude.ai ClickUp", "a").length + 103) / 4
  check(
    "a server is its tools' names and descriptions over four",
    serverPromptTokens(heavy) === each * 2,
    serverPromptTokens(heavy)
  )
  check(
    "nothing on it is nothing",
    serverPromptTokens(readServer(row({ tools: [] }))) === 0
  )
}

section("isRemovable: only a scope the CLI can remove from")
{
  const scoped = (scope: unknown) => readServer(row({ scope }))
  check("user", isRemovable(scoped("user")))
  check("project", isRemovable(scoped("project")))
  check("local", isRemovable(scoped("local")))
  check("but not a claude.ai connector", !isRemovable(scoped("claudeai")))
  check("nor a plugin's own server", !isRemovable(scoped("dynamic")))
  check("nor one with no scope at all", !isRemovable(scoped(undefined)))
}

section("serverCaption: what the CLI said, and only that")
{
  check(
    "both halves",
    serverCaption(readServer(row())) === "user · http",
    serverCaption(readServer(row()))
  )
  check(
    "one where the CLI named one",
    serverCaption(readServer(row({ scope: undefined }))) === "http"
  )
  check(
    "and nothing rather than a stray separator",
    serverCaption(readServer(row({ scope: undefined, config: {} }))) === ""
  )
}

finish()
