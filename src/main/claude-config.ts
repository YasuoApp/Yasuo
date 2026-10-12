import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import type {
  ClaudeConfig,
  ClaudeConfigFile,
  ClaudeConfigProject,
  ClaudeConfigServer,
  ClaudeManagedPolicy,
  ClaudeSettingsSummary,
} from "../shared/api"

/**
 * What the user's own `claude` has written down — Settings › Claude config, a
 * listing of `~/.claude.json` and `~/.claude/settings.json` (or a profile's
 * `CLAUDE_CONFIG_DIR` pair).
 *
 * **Read off disk, which every other ask of the CLI here refuses** (see
 * `claude-auth.ts`, `mcp-servers.ts`). The difference is the question: those
 * ask whether a login or a server _works_, which only the process can say; this
 * asks what the files _say_, which only the files can. So it stays on that side
 * of the line by being **read-only, all of it**: two writers of one JSON file is
 * how it gets corrupted, and the CLI rewrites `.claude.json` on every start.
 *
 * Every field is narrowed rather than trusted — the shape is the CLI's and moves
 * between releases — and what is not recognised is left out, never thrown on.
 * **Values that can hold a secret are never read into the answer**: an env
 * entry is its name, a server is its command or URL without its env or headers.
 */
export async function claudeConfig(
  configDir: string | null,
  workspaceDirs: string[]
): Promise<ClaudeConfig> {
  const { statePath, settingsPath, remotePath } = configPaths(configDir)
  const [state, settings, remote] = await Promise.all([
    readJson(statePath),
    readJson(settingsPath),
    readJson(remotePath),
  ])
  const read = readClaudeConfig(state.json, settings.json, workspaceDirs)
  const projects = await Promise.all(
    read.projects.map(async (project) => ({
      ...project,
      exists: await isDirectory(project.path),
    }))
  )
  return {
    configDir,
    state: state.file,
    settings: settings.file,
    servers: read.servers,
    projects,
    summary: read.summary,
    remote: remote.file,
    policy: readPolicy(remote.json),
  }
}

/**
 * Where the CLI keeps the files. With `CLAUDE_CONFIG_DIR` all three are inside
 * it; without, the state file is the one in the home directory rather than in
 * `~/.claude` — a split the CLI has kept since before the variable existed.
 */
export function configPaths(configDir: string | null): {
  statePath: string
  settingsPath: string
  remotePath: string
} {
  const dir = configDir ?? path.join(homedir(), ".claude")
  return {
    statePath: configDir
      ? path.join(configDir, ".claude.json")
      : path.join(homedir(), ".claude.json"),
    settingsPath: path.join(dir, "settings.json"),
    remotePath: path.join(dir, "remote-settings.json"),
  }
}

/**
 * `remote-settings.json`: the organization's managed settings, fetched by the
 * CLI from the account and ranked above every file the user writes — so what
 * it denies is denied whatever `settings.json` says, which is the reason to
 * show it beside that file at all. The same settings shape plus the keys only
 * a policy sets.
 */
export function readPolicy(remote: unknown): ClaudeManagedPolicy | null {
  const root = record(remote)
  const summary = summaryOf(remote, {
    keys: POLICY_KEYS,
    permissions: POLICY_PERMISSION_KEYS,
  })
  if (!root || !summary) return null
  const permissions = record(root.permissions) ?? {}
  const sandbox = record(root.sandbox)
  return {
    summary,
    minimumVersion: text(root.requiredMinimumVersion),
    bypassPermissions: text(permissions.disableBypassPermissionsMode),
    managedMcpOnly: flag(root.allowManagedMcpServersOnly),
    allowedMcpServers: serverRules(root.allowedMcpServers),
    deniedMcpServers: serverRules(root.deniedMcpServers),
    sandbox: sandbox ? flag(sandbox.enabled) : null,
  }
}

/** An allow- or deny-list entry names a server by name, URL or command —
 * whichever it carries, the first of those. */
function serverRules(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const rule = record(entry)
    if (!rule) return []
    const command = Array.isArray(rule.serverCommand)
      ? strings(rule.serverCommand).join(" ")
      : text(rule.serverCommand)
    const label = text(rule.serverName) ?? text(rule.serverUrl) ?? command
    return label ? [label] : []
  })
}

/** The pure half: two parsed files in, the listing out — `test/claude-config.ts`. */
export function readClaudeConfig(
  state: unknown,
  settings: unknown,
  workspaceDirs: string[]
): {
  servers: ClaudeConfigServer[]
  projects: ClaudeConfigProject[]
  summary: ClaudeSettingsSummary | null
} {
  const root = record(state)
  const inWorkspace = new Set(workspaceDirs.map(trimSlash))
  const projects = Object.entries(record(root?.projects) ?? {})
    .map(([dir, value]): ClaudeConfigProject => {
      const entry = record(value) ?? {}
      return {
        path: dir,
        exists: true,
        inWorkspace: inWorkspace.has(trimSlash(dir)),
        allowedTools: strings(entry.allowedTools),
        servers: serversOf(entry.mcpServers),
        disabledServers: strings(entry.disabledMcpServers),
        enabledMcpjsonServers: strings(entry.enabledMcpjsonServers),
        disabledMcpjsonServers: strings(entry.disabledMcpjsonServers),
      }
    })
    // The workspace's own folders first: they are why somebody opened this
    // from here. The rest is every directory `claude` was ever started in.
    .sort(
      (a, b) =>
        Number(b.inWorkspace) - Number(a.inWorkspace) ||
        a.path.localeCompare(b.path)
    )

  return {
    servers: serversOf(root?.mcpServers),
    projects,
    summary: summaryOf(settings),
  }
}

/** What `summaryOf` draws a row for; `permissions` is read key by key below. */
const SUMMARY_KEYS = ["model", "env", "hooks", "enabledPlugins"]
const PERMISSION_KEYS = ["defaultMode", "allow", "ask", "deny"]

/** The keys only a policy carries that `readPolicy` draws a row for. */
const POLICY_KEYS = [
  "requiredMinimumVersion",
  "allowManagedMcpServersOnly",
  "allowedMcpServers",
  "deniedMcpServers",
  "sandbox",
]
const POLICY_PERMISSION_KEYS = ["disableBypassPermissionsMode"]

function summaryOf(
  settings: unknown,
  alsoRead: { keys: string[]; permissions: string[] } = {
    keys: [],
    permissions: [],
  }
): ClaudeSettingsSummary | null {
  const root = record(settings)
  if (!root) return null
  const permissions = record(root.permissions) ?? {}
  const read = new Set([...SUMMARY_KEYS, ...alsoRead.keys])
  const readPermissions = new Set([...PERMISSION_KEYS, ...alsoRead.permissions])
  return {
    // Named rather than dropped: the settings reference has well over a
    // hundred keys and grows every release, and a listing that went quiet
    // about one would read as "this file does not set it".
    other: [
      ...Object.keys(root).filter(
        (key) => key !== "permissions" && !read.has(key)
      ),
      ...Object.keys(permissions)
        .filter((key) => !readPermissions.has(key))
        .map((key) => `permissions.${key}`),
    ].sort(),
    model: text(root.model),
    defaultMode: text(permissions.defaultMode),
    allow: strings(permissions.allow),
    ask: strings(permissions.ask),
    deny: strings(permissions.deny),
    // Names alone: an env block is where an API key goes.
    env: Object.keys(record(root.env) ?? {}).sort(),
    hooks: Object.keys(record(root.hooks) ?? {}).sort(),
    plugins: Object.entries(record(root.enabledPlugins) ?? {})
      .filter(([, on]) => on === true)
      .map(([name]) => name)
      .sort(),
  }
}

function serversOf(value: unknown): ClaudeConfigServer[] {
  return Object.entries(record(value) ?? {})
    .map(([name, config]) => {
      const entry = record(config) ?? {}
      const url = text(entry.url)
      const command = text(entry.command)
      // `type` is optional for stdio, which is the CLI's own default.
      const transport = text(entry.type) ?? (url ? "http" : "stdio")
      const address = url
        ? url
        : command
          ? [command, ...strings(entry.args)].join(" ")
          : null
      return { name, transport, address }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function readJson(
  file: string
): Promise<{ file: ClaudeConfigFile; json: unknown }> {
  const blank = { path: file, exists: false, bytes: null, modifiedAt: null }
  let stats
  try {
    stats = await stat(file)
  } catch {
    return { file: { ...blank, error: null }, json: null }
  }
  const found = {
    ...blank,
    exists: true,
    bytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  }
  try {
    return {
      file: { ...found, error: null },
      json: JSON.parse(await readFile(file, "utf8")),
    }
  } catch (error) {
    // Caught mid-write by the CLI is the likely case, and the next Refresh is
    // the fix — said rather than drawn as an empty config.
    return {
      file: {
        ...found,
        error: `Could not read it: ${error instanceof Error ? error.message : String(error)}`,
      },
      json: null,
    }
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  return stat(dir)
    .then((stats) => stats.isDirectory())
    .catch(() => false)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function trimSlash(dir: string): string {
  return dir.length > 1 ? dir.replace(/[\\/]+$/, "") : dir
}
