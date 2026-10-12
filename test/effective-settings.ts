import { foldSettings, pickManaged } from "../src/main/effective-settings"
import { check, finish, section } from "./harness"

/**
 * The effective-settings fold, against the rules the CLI's settings docs
 * state: which level wins a value, which lists combine, which keys a level
 * may not set, and the handful where a stricter lower value beats managed.
 */

const origin = (result: ReturnType<typeof foldSettings>, key: string) =>
  result.origins.find((row) => row.key === key)

section("precedence")
{
  const result = foldSettings(
    [
      { source: "user", json: { model: "opus", spinnerTipsEnabled: false } },
      { source: "project", json: { spinnerTipsEnabled: true } },
      { source: "local", json: { spinnerTipsEnabled: false } },
      { source: "managed", json: null },
    ],
    null
  )
  check(
    "local beats project beats user",
    result.settings.spinnerTipsEnabled === false &&
      origin(result, "spinnerTipsEnabled")?.sources.join() === "local"
  )
  check("an unset key keeps the lower value", result.settings.model === "opus")
  const managed = foldSettings(
    [
      { source: "user", json: { model: "opus" } },
      { source: "managed", json: { model: "sonnet" } },
    ],
    "remote"
  )
  check("managed beats everything", managed.settings.model === "sonnet")
}

section("lists combine")
{
  const result = foldSettings(
    [
      { source: "user", json: { permissions: { allow: ["Read", "Edit"] } } },
      {
        source: "local",
        json: { permissions: { allow: ["Bash(ls)", "Read"] } },
      },
      { source: "managed", json: { permissions: { deny: ["Bash(rm:*)"] } } },
    ],
    "remote"
  )
  const permissions = result.settings.permissions as Record<string, string[]>
  check(
    "allow is the union, deduplicated",
    permissions.allow!.join() === "Read,Edit,Bash(ls)",
    permissions.allow
  )
  check(
    "and says every level it came from, highest first",
    origin(result, "permissions.allow")?.sources.join() === "local,user"
  )
  check(
    "deny from managed lands beside it",
    permissions.deny!.join() === "Bash(rm:*)"
  )
  const chain = foldSettings(
    [
      { source: "user", json: { fallbackModel: ["a", "b"] } },
      { source: "project", json: { fallbackModel: ["c"] } },
    ],
    null
  )
  check(
    "fallbackModel is taken whole, not combined",
    JSON.stringify(chain.settings.fallbackModel) === '["c"]'
  )
}

section("what a level may not set")
{
  const result = foldSettings(
    [
      { source: "user", json: { permissions: { defaultMode: "acceptEdits" } } },
      {
        source: "project",
        json: {
          permissions: { defaultMode: "bypassPermissions" },
          allowManagedHooksOnly: true,
          remoteControlAtStartup: true,
        },
      },
    ],
    null
  )
  check(
    "bypassPermissions from a project is ignored",
    (result.settings.permissions as Record<string, unknown>).defaultMode ===
      "acceptEdits"
  )
  check(
    "a managed-only key from a project is ignored",
    !("allowManagedHooksOnly" in result.settings)
  )
  check(
    "a project's remoteControlAtStartup true is ignored",
    !("remoteControlAtStartup" in result.settings)
  )
  check("and each is said", result.notes.length === 2, result.notes)
}

section("managed locks")
{
  const result = foldSettings(
    [
      { source: "user", json: { permissions: { allow: ["Bash(*)"] } } },
      {
        source: "managed",
        json: {
          allowManagedPermissionRulesOnly: true,
          permissions: { allow: ["Read"] },
          availableModels: ["sonnet"],
        },
      },
      { source: "project", json: { availableModels: ["opus"] } },
    ],
    "remote"
  )
  const permissions = result.settings.permissions as Record<string, string[]>
  check(
    "permission rules come from managed alone",
    permissions.allow!.join() === "Read"
  )
  check(
    "a managed availableModels stands as it is",
    JSON.stringify(result.settings.availableModels) === '["sonnet"]'
  )
}

section("stricter wins")
{
  const result = foldSettings(
    [
      {
        source: "user",
        json: { disableClaudeAiConnectors: true, maxEffortLevel: "high" },
      },
      { source: "project", json: { syncClaudeAiSkills: false } },
      { source: "local", json: { crossSessionInbound: "refuse" } },
      {
        source: "managed",
        json: {
          disableClaudeAiConnectors: false,
          maxEffortLevel: "max",
          syncClaudeAiSkills: true,
          crossSessionInbound: "accept",
        },
      },
    ],
    "remote"
  )
  check(
    "a user's true beats managed false",
    result.settings.disableClaudeAiConnectors === true
  )
  check(
    "the lowest effort cap applies",
    result.settings.maxEffortLevel === "high"
  )
  check(
    "a project's false for syncClaudeAiSkills is ignored",
    result.settings.syncClaudeAiSkills === true
  )
  check(
    "a stricter local crossSessionInbound wins",
    result.settings.crossSessionInbound === "refuse"
  )
}

section("env")
{
  const result = foldSettings(
    [
      { source: "user", json: { env: { A: "secret-a", B: "1" } } },
      { source: "managed", json: { env: { A: "secret-managed" } } },
    ],
    "remote"
  )
  check(
    "merged per variable",
    origin(result, "env.A")?.sources.join() === "managed" &&
      origin(result, "env.B")?.sources.join() === "user"
  )
  check(
    "values never leave",
    !JSON.stringify(result).includes("secret"),
    result.settings.env
  )
}

section("managed sources")
{
  const first = pickManaged([
    { source: "remote", json: { model: "a" } },
    { source: "file", json: { model: "b", permissions: { deny: ["X"] } } },
  ])
  check(
    "first-wins: the highest with a policy key is the whole policy",
    first.source === "remote" &&
      first.json?.model === "a" &&
      !("permissions" in (first.json ?? {})) &&
      first.notes.length === 1
  )
  const control = pickManaged([
    { source: "remote", json: { managedSourcesBehavior: "first-wins" } },
    { source: "file", json: { model: "b" } },
  ])
  check(
    "a source with only control keys does not count",
    control.source === "file"
  )
  const merged = pickManaged([
    {
      source: "remote",
      json: { managedSourcesBehavior: "merge", permissions: { deny: ["A"] } },
    },
    { source: "file", json: { permissions: { deny: ["B"] }, model: "m" } },
  ])
  check(
    "merge: lists combine across sources",
    ((merged.json?.permissions as Record<string, string[]>).deny ?? [])
      .slice()
      .sort()
      .join() === "A,B" && merged.json?.model === "m"
  )
  check("none at all", pickManaged([]).source === null)
}

finish()
