import type { WorkspaceFolder, WorkspaceRecord } from "@shared/api"

export type { WorkspaceFolder, WorkspaceRecord }

/** The workspace and the folders in it. */
export async function getWorkspace(): Promise<WorkspaceRecord> {
  return window.desktop.getWorkspace()
}

export async function addFolder(input: {
  path: string
  name: string
}): Promise<WorkspaceRecord> {
  return window.desktop.addFolder(input)
}

export async function renameFolder(
  id: string,
  name: string
): Promise<WorkspaceRecord> {
  return window.desktop.renameFolder(id, name)
}

export async function removeFolder(id: string): Promise<WorkspaceRecord> {
  return window.desktop.removeFolder(id)
}

/** A second checkout of a project, which becomes a project of its own — see
 * `main/worktrees.ts`. */
export async function addWorktree(input: {
  folderId: string
  branch: string
  name: string
}): Promise<WorkspaceRecord> {
  return window.desktop.addWorktree(input)
}

/** The checkout removed and the project dropped. The branch is left alone. */
export async function removeWorktree(
  folderId: string
): Promise<WorkspaceRecord> {
  return window.desktop.removeWorktree(folderId)
}

/** Names a checkout nobody has named yet after the chat running in it, or
 * answers null for everything that is not that — see `DesktopApi`. */
export async function nameWorktree(
  folderId: string,
  title: string
): Promise<WorkspaceRecord | null> {
  return window.desktop.nameWorktree(folderId, title)
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
}
