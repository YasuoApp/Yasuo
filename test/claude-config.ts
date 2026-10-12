import {
  configPaths,
  readClaudeConfig,
  readPolicy,
} from "../src/main/claude-config"
import { check, finish, section } from "./harness"

/**
 * Settings › Claude config, which reads two files the CLI owns and rewrites
 * between releases. What matters is that a shape it does not recognise is
 * skipped rather than thrown on, and that nothing able to hold a secret — an
 * env value, a server's env or headers — gets into the answer at all.
 */

const state = {
  numStartups: 12,
  mcpServers: {
    playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
    linear: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer secret-header" },
    },
    plain: { url: "https://example.com/mcp" },
    broken: "not an object",
  },
  projects: {
    "/repo/b": { allowedTools: ["Bash(ls)", 3], disabledMcpServers: ["x"] },
    "/repo/a/": {
      mcpServers: {
        local: { command: "node", env: { TOKEN: "secret-env" } },
      },
      enabledMcpjsonServers: ["shared"],
    },
    "/elsewhere": null,
  },
}

const settings = {
  model: "opus",
  permissions: { allow: ["Read"], deny: ["Bash(rm:*)"], defaultMode: "plan" },
  env: { ANTHROPIC_API_KEY: "secret-key", DEBUG: "1" },
  hooks: { SessionStart: [], PreToolUse: [] },
  enabledPlugins: { "a@m": true, "b@m": false },
}

section("servers")
{
  const read = readClaudeConfig(state, settings, [])
  check(
    "named, sorted, with a non-object entry kept as a bare stdio",
    read.servers.map((server) => server.name).join() ===
      "broken,linear,plain,playwright",
    read.servers
  )
  const byName = Object.fromEntries(read.servers.map((s) => [s.name, s]))
  check(
    "stdio is the command and its arguments",
    byName.playwright!.transport === "stdio" &&
      byName.playwright!.address === "npx @playwright/mcp@latest"
  )
  check(
    "a url with no type is http",
    byName.plain!.transport === "http" &&
      byName.plain!.address === "https://example.com/mcp"
  )
  check(
    "headers never reach the answer",
    !JSON.stringify(read).includes("secret-header")
  )
}

section("projects")
{
  const read = readClaudeConfig(state, settings, ["/repo/a"])
  check(
    "workspace folders first, a trailing slash ignored",
    read.projects[0]?.path === "/repo/a/" && read.projects[0].inWorkspace,
    read.projects.map((project) => project.path)
  )
  check(
    "the rest alphabetical",
    read.projects
      .slice(1)
      .map((project) => project.path)
      .join() === "/elsewhere,/repo/b"
  )
  const b = read.projects.find((project) => project.path === "/repo/b")!
  check(
    "non-string allowed tools dropped",
    b.allowedTools.join() === "Bash(ls)" && b.disabledServers.join() === "x"
  )
  const elsewhere = read.projects.find((p) => p.path === "/elsewhere")!
  check(
    "a null entry is an empty project, not a throw",
    elsewhere.allowedTools.length === 0 && elsewhere.servers.length === 0
  )
  check(
    "a local server's env never reaches the answer",
    !JSON.stringify(read).includes("secret-env")
  )
}

section("settings.json")
{
  const { summary } = readClaudeConfig(state, settings, [])
  check("model and mode", summary?.model === "opus")
  check("default mode", summary?.defaultMode === "plan")
  check(
    "permission lists",
    summary?.allow.join() === "Read" && summary.deny.join() === "Bash(rm:*)"
  )
  check(
    "env is names alone",
    summary?.env.join() === "ANTHROPIC_API_KEY,DEBUG" &&
      !JSON.stringify(summary).includes("secret-key")
  )
  check(
    "hook events, sorted",
    summary?.hooks.join() === "PreToolUse,SessionStart"
  )
  check("only enabled plugins", summary?.plugins.join() === "a@m")
  check(
    "keys it draws no row for are named, not dropped",
    readClaudeConfig(
      null,
      {
        model: "x",
        availableModels: ["opus"],
        permissions: { allow: [], additionalDirectories: ["/d"] },
      },
      []
    ).summary?.other.join() ===
      "availableModels,permissions.additionalDirectories"
  )
  check(
    "no file is null, not an empty summary",
    readClaudeConfig(null, null, []).summary === null
  )
  check(
    "garbage state is an empty listing",
    readClaudeConfig([1, 2], "x", []).projects.length === 0
  )
}

section("paths")
{
  const profile = configPaths("/p")
  check(
    "a profile keeps both files inside its directory",
    profile.statePath === "/p/.claude.json" &&
      profile.settingsPath === "/p/settings.json" &&
      profile.remotePath === "/p/remote-settings.json"
  )
  const home = configPaths(null)
  check(
    "the default login's state file is beside ~/.claude, not in it",
    home.statePath.endsWith("/.claude.json") &&
      !home.statePath.includes("/.claude/") &&
      home.settingsPath.endsWith("/.claude/settings.json") &&
      home.remotePath.endsWith("/.claude/remote-settings.json")
  )
}

section("remote-settings.json")
{
  const policy = readPolicy({
    requiredMinimumVersion: "2.1.0",
    allowManagedMcpServersOnly: true,
    allowedMcpServers: [
      { serverUrl: "https://mcp.example.com/*" },
      { serverCommand: ["npx", "-y", "tool"] },
      { serverName: "github" },
      "junk",
    ],
    permissions: {
      deny: ["Read(**/.env)"],
      disableBypassPermissionsMode: "disable",
    },
    sandbox: { enabled: true, network: { allowedDomains: ["x"] } },
    env: { ORG_TOKEN: "secret-org" },
  })
  check(
    "the policy keys",
    policy?.minimumVersion === "2.1.0" &&
      policy.bypassPermissions === "disable" &&
      policy.managedMcpOnly === true &&
      policy.sandbox === true,
    policy
  )
  check(
    "a server rule by URL, command or name, junk dropped",
    policy?.allowedMcpServers.join("|") ===
      "https://mcp.example.com/*|npx -y tool|github"
  )
  check("its settings half", policy?.summary.deny.join() === "Read(**/.env)")
  check(
    "env values stay out here too",
    !JSON.stringify(policy).includes("secret-org")
  )
  check(
    "a policy's own keys are not listed again as other",
    policy?.summary.other.length === 0,
    policy?.summary.other
  )
  check("no file is no policy", readPolicy(null) === null)
}

finish()
