import { CHAT_NOTIFICATIONS_KEY, type PendingFolder } from "./api"

/**
 * What the signed-in account's workspace keeps in the cloud, and how one
 * machine's folders are reconciled with it.
 *
 * Shared by the renderer, which talks to Firestore, and the tests, which need
 * the reconciling without a network. Nothing in here touches a path: a folder
 * in the cloud is an id, a name and a date, and the path is this machine's own.
 */

/**
 * The settings that follow the account to every machine. Everything else in the
 * manifest is a fact about this machine — the tabs open in its window, the
 * folder paths, where a Claude profile's login lives — and would be wrong on the
 * next one.
 */
export const SYNCED_SETTINGS = [
  CHAT_NOTIFICATIONS_KEY,
  "plugins.enabled",
  "plugins.disabled",
] as const

/**
 * The document at `workspaces/<uid>`. `updatedAt` is when the machine that
 * wrote it last changed something, as an ISO string like every other date that
 * crosses the contract.
 */
export type CloudWorkspace = {
  ownerUid: string
  name: string
  folders: PendingFolder[]
  settings: Record<string, string>
  updatedAt: string
}

export type FolderPlan = {
  /** Located here and absent from the cloud now, though the cloud held them at
   * the last sync: another machine removed them. Dropped here, the directory
   * untouched. */
  removed: string[]
  /** Located here, renamed in the cloud: the name the cloud has. */
  renamed: { id: string; name: string }[]
  /** Cloud folders this machine has no path for. */
  pending: PendingFolder[]
  /** What the cloud should hold once this is applied: every folder here, with
   * the cloud's names, and the pending ones. */
  folders: PendingFolder[]
}

/**
 * Three-way reconciling of the folder list, with `synced` as the base.
 *
 * The base is what the cloud held after the last sync. Without it, a folder
 * that is in the cloud but not here could mean "removed elsewhere" or "added
 * elsewhere and not yet seen", and the first sync of a machine would delete
 * folders it has just been given. With it, only a folder this machine saw
 * arrive and then sees leave is removed; a folder that was never in the base is
 * the local machine's to push.
 */
export function planFolders(input: {
  located: PendingFolder[]
  pending: PendingFolder[]
  cloud: PendingFolder[]
  synced: string[]
}): FolderPlan {
  const cloudById = new Map(input.cloud.map((folder) => [folder.id, folder]))
  const synced = new Set(input.synced)

  const removed = input.located
    .filter((folder) => synced.has(folder.id) && !cloudById.has(folder.id))
    .map((folder) => folder.id)
  const kept = input.located.filter((folder) => !removed.includes(folder.id))
  const keptIds = new Set(kept.map((folder) => folder.id))

  const renamed: FolderPlan["renamed"] = []
  const named = kept.map((folder) => {
    const cloud = cloudById.get(folder.id)
    if (!cloud || cloud.name === folder.name) return folder
    renamed.push({ id: folder.id, name: cloud.name })
    return { ...folder, name: cloud.name }
  })

  // Pending is recomputed from the cloud every time rather than kept from the
  // last sync, so a folder that is located here, or gone from the cloud, drops
  // out of it without a separate step.
  const pending = input.cloud.filter((folder) => !keptIds.has(folder.id))

  return {
    removed,
    renamed,
    pending,
    folders: [...named, ...pending],
  }
}

/**
 * The settings the cloud holds that differ from this machine's, for the keys
 * that sync. A key the cloud does not hold is left alone: a machine that has
 * never set one keeps its own value, and the first machine to set one publishes
 * it.
 */
export function settingsToApply(
  cloud: Record<string, string>,
  local: Record<string, string | null>
): Record<string, string> {
  const changes: Record<string, string> = {}
  for (const key of SYNCED_SETTINGS) {
    const value = cloud[key]
    if (value !== undefined && value !== local[key]) changes[key] = value
  }
  return changes
}
