import type {
  PendingFolder,
  WorkspaceFolder,
  WorkspaceRecord,
  WorktreeOptions,
  WorktreeStatus,
} from "@shared/api"
import { SYNCED_SETTINGS } from "@shared/workspace-sync"

export type { PendingFolder, WorkspaceFolder, WorkspaceRecord }

/*
 * Who needs to know the workspace changed here. The account's cloud copy
 * (`cloud-workspace.ts`) is the only listener, and it is a listener rather than
 * a call from here because it imports this module: the arrow goes the other way.
 * Only calls made from this side are reported; the sync's own writes go through
 * `window.desktop` so they do not echo back as local changes.
 */
const changeListeners = new Set<() => void>()

/** Calls `listener` after this window changes the workspace's folders, or a
 * setting that follows the account. Returns how to stop. */
export function onWorkspaceChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

function changed<T>(result: Promise<T>): Promise<T> {
  return result.then((value) => {
    for (const listener of changeListeners) listener()
    return value
  })
}

/** The workspace and the folders in it. */
export async function getWorkspace(): Promise<WorkspaceRecord> {
  return window.desktop.getWorkspace()
}

export async function addFolder(input: {
  path: string
  name: string
  id?: string
}): Promise<WorkspaceRecord> {
  return changed(window.desktop.addFolder(input))
}

export async function renameFolder(
  id: string,
  name: string
): Promise<WorkspaceRecord> {
  return changed(window.desktop.renameFolder(id, name))
}

export async function removeFolder(id: string): Promise<WorkspaceRecord> {
  return changed(window.desktop.removeFolder(id))
}

/** The sync's own list of folders this machine has no path for. Not a local
 * change: it is what the cloud said, written down. */
export async function setPendingFolders(
  folders: PendingFolder[]
): Promise<WorkspaceRecord> {
  return window.desktop.setPendingFolders(folders)
}

/** A second checkout of a project, which becomes a project of its own — see
 * `main/worktrees.ts`. */
export async function addWorktree(input: {
  folderId: string
  branch: string
  name: string
  base?: string
}): Promise<WorkspaceRecord> {
  return changed(window.desktop.addWorktree(input))
}

/** The checkout removed and the project dropped; the branch only when
 * `deleteBranch` says so. */
export async function removeWorktree(
  folderId: string,
  options: { deleteBranch: boolean }
): Promise<WorkspaceRecord> {
  return changed(window.desktop.removeWorktree(folderId, options))
}

/** Branches and a setup command for the New worktree dialog. */
export async function worktreeOptions(
  folderId: string
): Promise<WorktreeOptions> {
  return window.desktop.worktreeOptions(folderId)
}

/** How far a checkout has moved, or null for a folder that is not one. */
export async function worktreeStatus(
  folderId: string
): Promise<WorktreeStatus | null> {
  return window.desktop.worktreeStatus(folderId)
}

/** Names a checkout nobody has named yet after the chat running in it, or
 * answers null for everything that is not that — see `DesktopApi`. */
export async function nameWorktree(
  folderId: string,
  title: string
): Promise<WorkspaceRecord | null> {
  return changed(window.desktop.nameWorktree(folderId, title))
}

/** Opens the system folder picker. Resolves with null when cancelled. */
export async function pickDirectory(): Promise<string | null> {
  return window.desktop.pickDirectory()
}

/** The branch checked out in a folder, or null when it is not a git
 * repository. */
export async function gitBranch(folderId: string): Promise<string | null> {
  return window.desktop.gitBranch(folderId)
}

/** The repository a folder is a `git worktree` checkout of, or null for an
 * ordinary folder. */
export async function gitWorktreeRepo(
  folderId: string
): Promise<string | null> {
  return window.desktop.gitWorktreeRepo(folderId)
}

export async function getSetting(key: string): Promise<string | null> {
  return window.desktop.getSetting(key)
}

export async function setSetting(key: string, value: string): Promise<void> {
  await window.desktop.setSetting(key, value)
  // Only the keys that follow the account: a tab's memory is this machine's.
  if ((SYNCED_SETTINGS as readonly string[]).includes(key)) {
    for (const listener of changeListeners) listener()
  }
}
