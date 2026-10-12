import { execFile } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import type {
  EffectiveSettings,
  ManagedSource,
  SettingsLayer,
  SettingsSource,
} from "../shared/api"

const run = promisify(execFile)

/**
 * Settings › Claude config › Effective settings: every settings file `claude`
 * would read in one directory, folded into the one set of values a session
 * there starts with — the CLI's own precedence, as its settings docs state it
 * (code.claude.com/docs/en/settings § Settings precedence, and
 * /en/managed-settings § How Claude Code combines managed sources).
 *
 * **An account of the documented rules, not the CLI's answer.** The CLI keeps
 * per-key scope rules for well over a hundred keys, and the ones encoded here
 * are the ones the docs single out; `/status` (`Setting sources`) stays the
 * authority, and the page says so. What is not modelled: `--settings` and
 * flags (a session's, not a file's), shell environment variables that pair
 * with a key (`ANTHROPIC_MODEL` over `model`), the Windows registry, an
 * embedding host's parent settings, and folder trust — a project's `allow`
 * rules and most of its `env` only apply once the folder is trusted.
 */

/** Lowest first: each layer is folded over the ones before it. */
const ORDER: SettingsSource[] = ["user", "project", "local", "managed"]

/** Keys only a managed source can set — `/en/managed-settings` § Keys only a
 * managed source can set. Anywhere else they are dropped, and said to be. */
const MANAGED_ONLY = new Set([
  "allowAllClaudeAiMcps",
  "allowedChannelPlugins",
  "allowManagedHooksOnly",
  "allowManagedMcpServersOnly",
  "allowManagedPermissionRulesOnly",
  "blockedMarketplaces",
  "channelsEnabled",
  "disableCommandPluginSources",
  "disableSideloadFlags",
  "forceRemoteSettingsRefresh",
  "managedMcpServers",
  "managedSourcesBehavior",
  "parentSettingsBehavior",
  "pluginSuggestionMarketplaces",
  "pluginTrustMessage",
  "policyHelper",
  "sandbox.filesystem.allowManagedReadPathsOnly",
  "sandbox.network.allowManagedDomainsOnly",
  "strictKnownMarketplaces",
  "strictPluginOnlyCustomization",
  "wslInheritsWindowsSettings",
])

/** Lists whose order is their meaning, taken whole from the highest layer
 * rather than combined. */
const WHOLE_LISTS = new Set(["fallbackModel", "modelPicker"])

const EFFORT = ["low", "medium", "high", "xhigh", "max"]
const INBOUND = ["accept", "hold", "refuse"]

type Json = Record<string, unknown>

/**
 * The pure half (`test/effective-settings.ts`): parsed layers in, the folded
 * settings, where each value came from, and which rules changed the result.
 */
export function foldSettings(
  layers: { source: SettingsSource; json: unknown }[],
  managedSource: ManagedSource | null
): EffectiveSettings {
  const notes: string[] = []
  const bySource = new Map<SettingsSource, Json>()
  for (const layer of layers) {
    const json = record(layer.json)
    if (json) bySource.set(layer.source, structuredClone(json))
  }
  const managed = bySource.get("managed") ?? null

  for (const [source, json] of bySource) {
    if (source === "managed") continue
    for (const key of MANAGED_ONLY) {
      if (deletePath(json, key)) {
        notes.push(`${key} in ${source} settings is ignored: managed only.`)
      }
    }
    if (source === "project" || source === "local") {
      const mode = getPath(json, "permissions.defaultMode")
      if (mode === "auto" || mode === "bypassPermissions") {
        deletePath(json, "permissions.defaultMode")
        notes.push(
          `permissions.defaultMode "${mode}" in ${source} settings is ignored: only user or managed settings can set it.`
        )
      }
      if (deletePath(json, "modelPicker")) {
        notes.push(`modelPicker in ${source} settings is ignored.`)
      }
      // Only `false` counts from a repository's files; a `true` there would
      // be a repository turning remote control on for whoever clones it.
      if (getPath(json, "remoteControlAtStartup") === true) {
        deletePath(json, "remoteControlAtStartup")
      }
    }
  }

  const settings: Json = {}
  const origins = new Map<string, Set<SettingsSource>>()
  for (const source of ORDER) {
    const json = bySource.get(source)
    if (json) fold(settings, json, "", source, origins)
  }

  // A managed lock keeps a list to the policy's own entries.
  const locks: [string, string[]][] = [
    [
      "allowManagedPermissionRulesOnly",
      ["permissions.allow", "permissions.ask", "permissions.deny"],
    ],
    ["allowManagedMcpServersOnly", ["allowedMcpServers"]],
    ["allowManagedHooksOnly", ["hooks"]],
    [
      "sandbox.network.allowManagedDomainsOnly",
      ["sandbox.network.allowedDomains"],
    ],
    [
      "sandbox.filesystem.allowManagedReadPathsOnly",
      ["sandbox.filesystem.allowRead"],
    ],
  ]
  for (const [lock, keys] of locks) {
    if (!managed || getPath(managed, lock) !== true) continue
    for (const key of keys) {
      const own = getPath(managed, key)
      if (own === undefined) deletePath(settings, key)
      else setPath(settings, key, structuredClone(own))
      for (const origin of [...origins.keys()]) {
        if (origin.startsWith(`${key}.`)) origins.delete(origin)
      }
      origins.set(key, new Set(own === undefined ? [] : ["managed"]))
    }
    notes.push(`${lock} is on: ${keys.join(", ")} come from managed only.`)
  }

  // A managed allowlist of models is applied as it stands.
  const models = managed && getPath(managed, "availableModels")
  if (Array.isArray(models)) {
    setPath(settings, "availableModels", structuredClone(models))
    origins.set("availableModels", new Set(["managed"]))
  }

  strictest(settings, origins, notes, bySource)

  for (const [key, sources] of [...origins]) {
    if (sources.size === 0 || getPath(settings, key) === undefined) {
      origins.delete(key)
    }
  }

  return {
    settings: redacted(settings),
    origins: [...origins]
      .map(([key, sources]) => ({
        key,
        value: display(key, getPath(settings, key)),
        sources: ORDER.filter((source) => sources.has(source)).reverse(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    managedSource,
    notes,
  }
}

/**
 * `/en/settings` § Exceptions to managed settings precedence: keys where a
 * stricter value from a lower layer beats a looser one from above.
 */
function strictest(
  settings: Json,
  origins: Map<string, Set<SettingsSource>>,
  notes: string[],
  bySource: Map<SettingsSource, Json>
) {
  const from = (key: string, sources: SettingsSource[]) =>
    sources.flatMap((source) => {
      const json = bySource.get(source)
      const value = json ? getPath(json, key) : undefined
      return value === undefined ? [] : [{ source, value }]
    })
  const force = (key: string, value: unknown, by: SettingsSource[]) => {
    if (getPath(settings, key) === value) return
    setPath(settings, key, value)
    origins.set(key, new Set(by))
    notes.push(
      `${key} is ${JSON.stringify(value)}: the stricter value from ${by.join(", ")} wins.`
    )
  }

  for (const key of [
    "disableClaudeAiConnectors",
    "isolatePeerMachines",
    "permissions.blockReadsOutsideWorkingDirectories",
  ]) {
    const on = from(key, ORDER).filter((hit) => hit.value === true)
    if (on.length > 0) force(key, true, sourcesOf(on))
  }

  const artifactOff = [
    ...from("enableArtifact", ORDER).filter((hit) => hit.value === false),
    ...from("disableArtifact", ORDER).filter((hit) => hit.value === true),
  ]
  if (artifactOff.length > 0)
    force("enableArtifact", false, sourcesOf(artifactOff))

  const shell = from("autoMode.classifyAllShell", ["user"])
  if (shell.some((hit) => hit.value === true)) {
    force("autoMode.classifyAllShell", true, ["user"])
  }

  const remoteOff = from("remoteControlAtStartup", ["project", "local"])
  if (remoteOff.some((hit) => hit.value === false)) {
    force("remoteControlAtStartup", false, sourcesOf(remoteOff))
  }

  for (const key of [
    "useAutoModeDuringPlan",
    "syncClaudeAiSkills",
    "syncClaudeAiPlugins",
  ]) {
    const off = from(key, ["managed", "user", "local"]).filter(
      (hit) => hit.value === false
    )
    if (off.length > 0) force(key, false, sourcesOf(off))
  }

  const inbound = from("crossSessionInbound", ["project", "local"])
    .filter((hit) => INBOUND.includes(String(hit.value)))
    .sort(
      (a, b) =>
        INBOUND.indexOf(String(b.value)) - INBOUND.indexOf(String(a.value))
    )[0]
  const current = INBOUND.indexOf(
    String(getPath(settings, "crossSessionInbound"))
  )
  if (inbound && INBOUND.indexOf(String(inbound.value)) > current) {
    force("crossSessionInbound", inbound.value, [inbound.source])
  }

  const cap = from("maxEffortLevel", ORDER)
    .filter((hit) => EFFORT.includes(String(hit.value)))
    .sort(
      (a, b) =>
        EFFORT.indexOf(String(a.value)) - EFFORT.indexOf(String(b.value))
    )[0]
  if (cap) force("maxEffortLevel", cap.value, [cap.source])
}

/** Objects merge key by key, lists combine, anything else is replaced by the
 * higher layer — `/en/settings` § Lists merge instead of overriding. */
function fold(
  target: Json,
  layer: Json,
  prefix: string,
  source: SettingsSource,
  origins: Map<string, Set<SettingsSource>>
) {
  for (const [key, value] of Object.entries(layer)) {
    const at = prefix ? `${prefix}.${key}` : key
    const existing = target[key]
    if (record(value) && !WHOLE_LISTS.has(at)) {
      // `env` is merged per variable and drawn per variable for that reason;
      // anything deeper than that is drawn as the object it is.
      if (prefix === "" || at === "permissions" || prefix === "sandbox") {
        const into = record(existing) ?? {}
        target[key] = into
        fold(into, value as Json, at, source, origins)
        continue
      }
      target[key] = mergeObjects(record(existing), value as Json)
      addOrigin(origins, at, source, record(existing) !== null)
      continue
    }
    if (
      Array.isArray(value) &&
      Array.isArray(existing) &&
      !WHOLE_LISTS.has(at)
    ) {
      target[key] = union(existing, value)
      addOrigin(origins, at, source, true)
      continue
    }
    target[key] = structuredClone(value)
    addOrigin(origins, at, source, false)
  }
}

function mergeObjects(base: Json | null, over: Json): Json {
  const out: Json = structuredClone(base ?? {})
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key]
    if (record(value) && record(existing)) {
      out[key] = mergeObjects(existing as Json, value as Json)
    } else if (Array.isArray(value) && Array.isArray(existing)) {
      out[key] = union(existing, value)
    } else {
      out[key] = structuredClone(value)
    }
  }
  return out
}

function union(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set(a.map((entry) => JSON.stringify(entry)))
  return [
    ...a,
    ...b.filter((entry) => {
      const key = JSON.stringify(entry)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  ].map((entry) => structuredClone(entry))
}

function addOrigin(
  origins: Map<string, Set<SettingsSource>>,
  key: string,
  source: SettingsSource,
  combined: boolean
) {
  const current = combined ? (origins.get(key) ?? new Set()) : new Set()
  current.add(source)
  origins.set(key, current as Set<SettingsSource>)
}

/**
 * Which managed source applies — `/en/managed-settings` § How Claude Code
 * combines managed sources. Under the default `"first-wins"`, the highest one
 * that sets any policy key is the whole policy and the rest are ignored. Under
 * `"merge"` (set in the highest one) every source is folded, higher over lower.
 */
export function pickManaged(
  sources: { source: ManagedSource; json: unknown }[]
): { source: ManagedSource | null; json: Json | null; notes: string[] } {
  const present = sources.flatMap(({ source, json }) => {
    const root = record(json)
    const policy =
      root &&
      Object.keys(root).some(
        (key) =>
          key !== "managedSourcesBehavior" &&
          key !== "wslInheritsWindowsSettings" &&
          root[key] !== null
      )
    return policy ? [{ source, json: root }] : []
  })
  const [first, ...rest] = present
  if (!first) return { source: null, json: null, notes: [] }
  if (first.json.managedSourcesBehavior === "merge" && rest.length > 0) {
    let merged: Json = {}
    for (const { json } of [...present].reverse()) {
      merged = mergeObjects(merged, json)
    }
    return {
      source: first.source,
      json: merged,
      notes: [
        `Managed sources merged (${present.map((entry) => entry.source).join(", ")}): lists combined, higher sources win the rest. Locks and allowlists have finer rules than this view applies.`,
      ],
    }
  }
  return {
    source: first.source,
    json: first.json,
    notes: rest.map(
      (entry) =>
        `Managed ${entry.source} settings are ignored: ${first.source} applies (first-wins).`
    ),
  }
}

/**
 * The files themselves, for one directory. The local file is read from the
 * main checkout of a worktree, where the CLI writes it; the shared one from
 * the folder, since it is committed.
 */
export async function readEffectiveSettings(input: {
  settingsPath: string
  remotePath: string
  projectDir: string | null
  localDir: string | null
}): Promise<EffectiveSettings & { layers: SettingsLayer[] }> {
  const managedDir = managedDirectory()
  const [user, remote, fileManaged, mdm, project, local] = await Promise.all([
    readLayer(input.settingsPath),
    readLayer(input.remotePath),
    managedDir ? readManagedFiles(managedDir) : Promise.resolve(null),
    readMdm(),
    input.projectDir
      ? readLayer(path.join(input.projectDir, ".claude", "settings.json"))
      : Promise.resolve(null),
    input.localDir
      ? readLayer(path.join(input.localDir, ".claude", "settings.local.json"))
      : Promise.resolve(null),
  ])

  const picked = pickManaged([
    { source: "remote", json: remote.json },
    { source: "mdm", json: mdm?.json ?? null },
    { source: "file", json: fileManaged?.json ?? null },
  ])
  const folded = foldSettings(
    [
      { source: "user", json: user.json },
      { source: "project", json: project?.json ?? null },
      { source: "local", json: local?.json ?? null },
      { source: "managed", json: picked.json },
    ],
    picked.source
  )
  const layers: SettingsLayer[] = [
    {
      source: "managed",
      label: "remote",
      path: input.remotePath,
      ...state(remote),
    },
    ...(mdm
      ? [
          {
            source: "managed" as const,
            label: "mdm",
            path: mdm.path,
            ...state(mdm),
          },
        ]
      : []),
    ...(fileManaged
      ? [
          {
            source: "managed" as const,
            label: "file",
            path: fileManaged.path,
            ...state(fileManaged),
          },
        ]
      : []),
    ...(local
      ? [
          {
            source: "local" as const,
            label: "local",
            path: local.path,
            ...state(local),
          },
        ]
      : []),
    ...(project
      ? [
          {
            source: "project" as const,
            label: "project",
            path: project.path,
            ...state(project),
          },
        ]
      : []),
    { source: "user", label: "user", path: input.settingsPath, ...state(user) },
  ]
  return { ...folded, notes: [...picked.notes, ...folded.notes], layers }
}

type Read = {
  path: string
  exists: boolean
  json: unknown
  error: string | null
}

function state(read: Read): { exists: boolean; error: string | null } {
  return { exists: read.exists, error: read.error }
}

async function readLayer(file: string): Promise<Read> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    return { path: file, exists: false, json: null, error: null }
  }
  try {
    return { path: file, exists: true, json: JSON.parse(text), error: null }
  } catch (error) {
    return {
      path: file,
      exists: true,
      json: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function managedDirectory(): string | null {
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode"
  }
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode"
  return "/etc/claude-code"
}

/** `managed-settings.json`, then `managed-settings.d/*.json` alphabetically,
 * folded in that order — `/en/managed-settings` § Split a file-based policy. */
async function readManagedFiles(dir: string): Promise<Read | null> {
  const main = await readLayer(path.join(dir, "managed-settings.json"))
  const dropDir = path.join(dir, "managed-settings.d")
  const names = await readdir(dropDir)
    .then((entries) =>
      entries
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .sort()
    )
    .catch(() => [] as string[])
  if (!main.exists && names.length === 0) return null
  let json: Json = record(main.json) ?? {}
  const errors = main.error ? [main.error] : []
  for (const name of names) {
    const drop = await readLayer(path.join(dropDir, name))
    if (drop.error) errors.push(`${name}: ${drop.error}`)
    const root = record(drop.json)
    if (root) json = mergeObjects(json, root)
  }
  return {
    path: names.length > 0 ? dir : main.path,
    exists: true,
    json,
    error: errors.length > 0 ? errors.join("; ") : null,
  }
}

/** The `com.anthropic.claudecode` managed preferences domain, macOS only —
 * read through `plutil`, since a configuration profile's plist is binary. */
async function readMdm(): Promise<Read | null> {
  if (process.platform !== "darwin") return null
  const user = process.env.USER ?? ""
  const candidates = [
    path.join(
      "/Library/Managed Preferences",
      user,
      "com.anthropic.claudecode.plist"
    ),
    "/Library/Managed Preferences/com.anthropic.claudecode.plist",
  ]
  for (const file of candidates) {
    const there = await stat(file).then(
      () => true,
      () => false
    )
    if (!there) continue
    try {
      const { stdout } = await run("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        file,
      ])
      return { path: file, exists: true, json: JSON.parse(stdout), error: null }
    } catch (error) {
      return {
        path: file,
        exists: true,
        json: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return null
}

/** `env` values are where API keys go: the names stay, the values do not. */
function redacted(settings: Json): Json {
  const env = record(settings.env)
  if (!env) return settings
  return {
    ...settings,
    env: Object.fromEntries(Object.keys(env).map((key) => [key, "•••"])),
  }
}

function display(key: string, value: unknown): string {
  if (key === "env" || key.startsWith("env.")) {
    const env = record(value)
    return env ? Object.keys(env).join(", ") : "•••"
  }
  if (typeof value === "string") return value
  // A list of rules or domains reads as a list, one per line; anything with
  // structure inside it as indented JSON, since a hook or a marketplace entry
  // on one line is unreadable past its first field.
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return value.join("\n")
  }
  return JSON.stringify(value, null, 2)
}

function sourcesOf(hits: { source: SettingsSource }[]): SettingsSource[] {
  return [...new Set(hits.map((hit) => hit.source))]
}

function record(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null
}

function getPath(json: Json, key: string): unknown {
  let at: unknown = json
  for (const part of key.split(".")) {
    const here = record(at)
    if (!here || !(part in here)) return undefined
    at = here[part]
  }
  return at
}

function setPath(json: Json, key: string, value: unknown) {
  const parts = key.split(".")
  let at = json
  for (const part of parts.slice(0, -1)) {
    const next = record(at[part]) ?? {}
    at[part] = next
    at = next
  }
  at[parts[parts.length - 1]!] = value
}

function deletePath(json: Json, key: string): boolean {
  const parts = key.split(".")
  const parent = record(getPath(json, parts.slice(0, -1).join(".")) ?? null)
  const owner = parts.length === 1 ? json : parent
  const last = parts[parts.length - 1]!
  if (!owner || !(last in owner)) return false
  delete owner[last]
  return true
}
