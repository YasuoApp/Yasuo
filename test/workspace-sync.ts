import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { check, finish, section } from "./harness"

import { CHAT_NOTIFICATIONS_KEY } from "../src/shared/api"
import { planFolders, settingsToApply } from "../src/shared/workspace-sync"

/**
 * The folder reconciling between a machine and the account's cloud copy, and
 * the locate path through the store.
 *
 * The three-way base is the part that matters: a machine whose first sync finds
 * the cloud without its folders must keep them, and a folder that another
 * machine removed must go. Both look like "in the local list, not in the
 * cloud" from one side, which is why the base is checked.
 */

const at = "2026-01-01T00:00:00.000Z"
const folder = (id: string, name = id) => ({ id, name, addedAt: at })

section("a first sync keeps the folders this machine already has")
{
  const plan = planFolders({
    located: [folder("a"), folder("b")],
    pending: [],
    cloud: [],
    synced: [],
  })
  check("nothing removed", plan.removed.length === 0, plan)
  check(
    "both folders are pushed",
    plan.folders.map((f) => f.id).join() === "a,b",
    plan.folders
  )
}

section("a folder removed on another machine is dropped here")
{
  const plan = planFolders({
    located: [folder("a"), folder("b")],
    pending: [],
    cloud: [folder("a")],
    synced: ["a", "b"],
  })
  check("b is removed", plan.removed.join() === "b", plan)
  check("a stays", plan.folders.map((f) => f.id).join() === "a", plan)
}

section("a folder added on another machine is pending here")
{
  const plan = planFolders({
    located: [folder("a")],
    pending: [],
    cloud: [folder("a"), folder("x", "Api")],
    synced: ["a"],
  })
  check("x is pending", plan.pending.map((f) => f.id).join() === "x", plan)
  check("nothing removed", plan.removed.length === 0, plan)
  check(
    "pushed list keeps the pending folder",
    plan.folders.map((f) => f.id).join() === "a,x",
    plan.folders
  )
}

section("a rename in the cloud is taken, and a local-only rename is pushed")
{
  const plan = planFolders({
    located: [folder("a", "Old"), folder("b", "Local")],
    pending: [],
    cloud: [folder("a", "New"), folder("b", "Cloud")],
    synced: ["a", "b"],
  })
  check(
    "a takes the cloud name",
    plan.renamed.some((r) => r.id === "a" && r.name === "New"),
    plan
  )
  check(
    "the pushed list carries the cloud name",
    plan.folders.find((f) => f.id === "a")?.name === "New",
    plan.folders
  )
}

section("a folder located here leaves the pending list")
{
  const plan = planFolders({
    located: [folder("a")],
    pending: [folder("a")],
    cloud: [folder("a")],
    synced: ["a"],
  })
  check("no pending", plan.pending.length === 0, plan)
}

section("settings: only the synced keys, and only when the cloud has them")
{
  const changes = settingsToApply(
    {
      [CHAT_NOTIFICATIONS_KEY]: "off",
      "tab.secret": "x",
    },
    { [CHAT_NOTIFICATIONS_KEY]: "on" }
  )
  check(
    "notifications follow the cloud",
    changes[CHAT_NOTIFICATIONS_KEY] === "off",
    changes
  )
  check("a local-only key is not applied", !("tab.secret" in changes), changes)

  const unset = settingsToApply({}, { [CHAT_NOTIFICATIONS_KEY]: "on" })
  check("a key the cloud lacks is left alone", Object.keys(unset).length === 0)
}

section("the store: a pending folder is located with its own id")
{
  const dir = await mkdtemp(path.join(tmpdir(), "vsc-sync-"))
  process.env.VSCLAUDE_DATA_DIR = path.join(dir, "data")
  const { Store } = await import("../src/main/store")
  const repo = path.join(dir, "repo")
  await mkdir(repo)

  try {
    const store = new Store()
    await store.setPendingFolders([
      folder("11111111-1111-4111-8111-111111111111", "Api"),
    ])
    const before = await store.getWorkspace()
    check("pending is listed", before.pending.length === 1, before)

    const located = await store.addFolder({
      path: repo,
      name: "Api",
      id: "11111111-1111-4111-8111-111111111111",
    })
    check(
      "the folder keeps the cloud id",
      located.folders[0]?.id === "11111111-1111-4111-8111-111111111111",
      located
    )
    check("it leaves pending", located.pending.length === 0, located)

    let refused = false
    try {
      await store.addFolder({
        path: repo,
        name: "Again",
        id: "22222222-2222-4222-8222-222222222222",
      })
    } catch {
      refused = true
    }
    check("an id with no pending folder is refused", refused)
  } finally {
    delete process.env.VSCLAUDE_DATA_DIR
    await rm(dir, { recursive: true, force: true })
  }
}

finish()
