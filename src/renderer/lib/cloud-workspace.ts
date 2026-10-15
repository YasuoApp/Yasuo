import {
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  setDoc,
  type DocumentData,
  type DocumentReference,
} from "firebase/firestore"
import { create } from "zustand"

import type { PendingFolder } from "@shared/api"
import {
  planFolders,
  settingsToApply,
  SYNCED_SETTINGS,
  type CloudWorkspace,
} from "@shared/workspace-sync"

import { firebaseApp } from "./firebase"
import { useStudio } from "./store"
import { onWorkspaceChange } from "./workspace"

/**
 * The signed-in account's workspace, kept in Firestore at `workspaces/<uid>`.
 *
 * What follows the account is the folder list and the settings in
 * `SYNCED_SETTINGS` — never a path, which is this machine's (`planFolders`
 * says how the two lists meet). A folder another machine added shows up in
 * `pending` until this machine locates it.
 *
 * Every cycle reads the document from the server before it writes anything, so
 * a change made elsewhere is applied before this machine's own state is pushed
 * over it. Cycles run one after another for the same reason.
 *
 * A machine is linked to one account by `cloud.owner`. A second account on the
 * same machine does not inherit the first one's folders: it is asked whether to
 * take the workspace over (`adoptWorkspace`), and until then nothing is sent.
 */

/** Which account this machine's workspace belongs to. Local: a fact about the
 * machine, not something to copy. */
const OWNER_KEY = "cloud.owner"

/** The folder ids the cloud held after the last cycle — the three-way base in
 * `planFolders`. Local for the same reason as the owner. */
const SYNCED_KEY = "cloud.synced"

/** Quiet time after a local change before it is pushed, so a run of renames or
 * settings toggles is one write. */
const PUSH_DELAY_MS = 400

export type CloudSyncState = {
  /**
   * `off` while signed out or not yet known; `on` when the workspace is being
   * kept in step; `other-account` when this machine's workspace was linked to a
   * different account; `error` with the reason, which is usually the rules not
   * being deployed or the network being away.
   */
  status: "off" | "on" | "other-account" | "error"
  error: string | null
  /** Folders the account has that this machine has no path for. */
  pending: PendingFolder[]
}

export const useCloudSync = create<CloudSyncState>()(() => ({
  status: "off",
  error: null,
  pending: [],
}))

let uid: string | null = null
let unsubscribe: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let listening = false
let queue: Promise<void> = Promise.resolve()

/** Starts keeping the workspace in step with `next`, or stops when it is null.
 * Called from `watchAccount`, on every change of who is signed in. */
export function followAccount(next: string | null): void {
  if (!listening) {
    listening = true
    onWorkspaceChange(scheduleCycle)
  }
  if (next === uid) return
  stop()
  uid = next
  if (next === null) {
    useCloudSync.setState({ status: "off", error: null, pending: [] })
    return
  }
  void start(next).catch((error: unknown) => {
    useCloudSync.setState({ status: "error", error: messageOf(error) })
  })
}

/** Takes this machine's workspace over for the signed-in account, when it was
 * linked to somebody else. The folders stay here and are pushed as this
 * account's; the other account's cloud copy is left as it is. */
export async function adoptWorkspace(): Promise<void> {
  const owner = uid
  if (owner === null) return
  await window.desktop.setSetting(OWNER_KEY, owner)
  await window.desktop.setSetting(SYNCED_KEY, "[]")
  listen(owner)
  enqueue(() => cycle(owner))
}

/** Reads the pending list again, after this window located one. */
export async function refreshPending(): Promise<void> {
  const workspace = await window.desktop.getWorkspace()
  useCloudSync.setState({ pending: workspace.pending })
}

async function start(owner: string): Promise<void> {
  const linked = await window.desktop.getSetting(OWNER_KEY)
  if (uid !== owner) return
  if (linked === null) {
    await window.desktop.setSetting(OWNER_KEY, owner)
    await window.desktop.setSetting(SYNCED_KEY, "[]")
  } else if (linked !== owner) {
    useCloudSync.setState({ status: "other-account", error: null, pending: [] })
    return
  }
  listen(owner)
}

function listen(owner: string): void {
  stop()
  const ref = cloudRef(owner)
  useCloudSync.setState({ status: "on", error: null })
  unsubscribe = onSnapshot(
    ref,
    (snapshot) => {
      const cloud = snapshot.exists() ? readCloud(owner, snapshot.data()) : null
      enqueue(() => apply(owner, cloud))
    },
    (error) => {
      useCloudSync.setState({ status: "error", error: messageOf(error) })
    }
  )
}

function stop(): void {
  unsubscribe?.()
  unsubscribe = null
  if (timer !== null) clearTimeout(timer)
  timer = null
}

/** A local change, debounced into one cycle. */
function scheduleCycle(): void {
  const owner = uid
  if (owner === null || unsubscribe === null) return
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    enqueue(() => cycle(owner))
  }, PUSH_DELAY_MS)
}

/** Reads the document from the server, then applies it — see the header. */
async function cycle(owner: string): Promise<void> {
  const snapshot = await getDoc(cloudRef(owner))
  await apply(
    owner,
    snapshot.exists() ? readCloud(owner, snapshot.data()) : null
  )
}

/**
 * One reconciling pass: applies what the cloud says to this machine, then
 * pushes this machine's view if it differs. `cloud` is null when the document
 * does not exist yet.
 */
async function apply(
  owner: string,
  cloud: CloudWorkspace | null
): Promise<void> {
  if (uid !== owner) return

  const workspace = await window.desktop.getWorkspace()
  // Without a document there is no base: a machine must not treat every folder
  // it has as "removed elsewhere" because somebody deleted the cloud copy.
  const synced = cloud
    ? parseIds(await window.desktop.getSetting(SYNCED_KEY))
    : []
  const plan = planFolders({
    located: workspace.folders,
    pending: workspace.pending,
    cloud: cloud?.folders ?? [],
    synced,
  })

  for (const id of plan.removed) await window.desktop.removeFolder(id)
  for (const rename of plan.renamed) {
    await window.desktop.renameFolder(rename.id, rename.name)
  }

  if (cloud) {
    const local = Object.fromEntries(
      await Promise.all(
        SYNCED_SETTINGS.map(async (key) => [
          key,
          await window.desktop.getSetting(key),
        ])
      )
    )
    for (const [key, value] of Object.entries(
      settingsToApply(cloud.settings, local)
    )) {
      await window.desktop.setSetting(key, value)
    }
  }

  await window.desktop.setPendingFolders(plan.pending)
  await push(owner, cloud)

  if (plan.removed.length > 0 || plan.renamed.length > 0) {
    await useStudio.getState().reloadWorkspace()
  }
  useCloudSync.setState({
    status: "on",
    error: null,
    pending: (await window.desktop.getWorkspace()).pending,
  })
}

/**
 * Writes this machine's folders and synced settings to the cloud when they
 * differ from `seen`, and records the folder ids as the base for next time.
 */
async function push(owner: string, seen: CloudWorkspace | null): Promise<void> {
  const workspace = await window.desktop.getWorkspace()
  const settings: Record<string, string> = {}
  for (const key of SYNCED_SETTINGS) {
    const value = await window.desktop.getSetting(key)
    if (value !== null) settings[key] = value
  }

  const folders: PendingFolder[] = [
    ...workspace.folders.map(({ id, name, addedAt }) => ({
      id,
      name,
      addedAt,
    })),
    ...workspace.pending,
  ]
  const next = { ownerUid: owner, name: workspace.name, folders, settings }

  if (seen === null || canonical(seen) !== canonical(next)) {
    await setDoc(cloudRef(owner), {
      ...next,
      updatedAt: new Date().toISOString(),
    })
  }
  await window.desktop.setSetting(
    SYNCED_KEY,
    JSON.stringify(folders.map((folder) => folder.id))
  )
}

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((error: unknown) => {
    useCloudSync.setState({ status: "error", error: messageOf(error) })
  })
}

function cloudRef(owner: string): DocumentReference<DocumentData> {
  return doc(getFirestore(firebaseApp()), "workspaces", owner)
}

/** What the document holds, checked field by field: a document written by
 * something else, or an older build, must not be able to break a cycle. */
function readCloud(owner: string, data: DocumentData): CloudWorkspace {
  const folders: PendingFolder[] = Array.isArray(data.folders)
    ? data.folders.filter(isFolder)
    : []
  const settings: Record<string, string> = {}
  if (typeof data.settings === "object" && data.settings !== null) {
    for (const [key, value] of Object.entries(data.settings)) {
      if (typeof value === "string") settings[key] = value
    }
  }
  return {
    ownerUid: owner,
    name: typeof data.name === "string" ? data.name : "Workspace",
    folders,
    settings,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
  }
}

function isFolder(value: unknown): value is PendingFolder {
  if (typeof value !== "object" || value === null) return false
  const folder = value as Record<string, unknown>
  return (
    typeof folder.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(folder.id) &&
    typeof folder.name === "string" &&
    typeof folder.addedAt === "string"
  )
}

function parseIds(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return []
  }
}

/** The part of a document the sync compares — not `updatedAt`, which every
 * write changes — with its order fixed, since Firestore does not promise one. */
function canonical(value: {
  ownerUid: string
  name: string
  folders: PendingFolder[]
  settings: Record<string, string>
}): string {
  return JSON.stringify({
    ownerUid: value.ownerUid,
    name: value.name,
    folders: [...value.folders]
      .map(({ id, name, addedAt }) => ({ id, name, addedAt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    settings: Object.keys(value.settings)
      .sort()
      .map((key) => [key, value.settings[key]]),
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
