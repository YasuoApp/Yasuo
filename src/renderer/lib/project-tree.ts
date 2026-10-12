import type { WorkspaceFolder } from "@shared/api"

/**
 * One project and the checkouts cut from it, as the left column draws them.
 *
 * Only the column's shape — there is no worktree in the data model and this does
 * not add one. `main/worktrees.ts` still hands back an ordinary workspace
 * folder, `FileRoot` still has nothing nullable on it, and Explorer, Changes,
 * the dock's shell and the chats still work on a checkout knowing nothing about
 * any of this. What was wrong was only that the column *said* nothing about it:
 * a second checkout of the project somebody is in landed at the bottom of the
 * list, a stranger among the repositories they had added by hand.
 */
export type ProjectBranch = {
  folder: WorkspaceFolder
  /** In workspace order, and never nested further — see `projectTree`. */
  checkouts: WorkspaceFolder[]
}

/**
 * Trailing separators only. Not a `realpath`: the renderer cannot reach the
 * filesystem, and both sides of the comparison are absolute paths git and the
 * manifest already agree on for the ordinary case.
 */
function key(path: string): string {
  return path.replace(/[\\/]+$/, "")
}

/**
 * The projects, with each `git worktree` checkout filed under the project it
 * was cut from.
 *
 * The parent is found by **asking git**, not by remembering: `worktrees` is the
 * studio store's map of folder id to the repository that folder is a checkout
 * of (`worktreeRepo` in `main/worktrees.ts`), so a checkout somebody made in
 * their own shell and then added as a folder files itself under its project
 * exactly like one this app made. That is the same property `Remove worktree`
 * relies on, and this deliberately reuses it rather than reading the
 * `workspace/worktrees/<folder id>/` path a checkout this app made happens to
 * sit at — the renderer cannot see that directory anyway.
 *
 * **One level, always.** A checkout's parent is git's *main* worktree, which is
 * the repository itself however many checkouts are cut from it, so a chain
 * cannot form. A checkout whose repository is not in the workspace stays at the
 * top level: it is a project like any other from here, and hiding it under a
 * row that does not exist would lose it.
 *
 * Parents keep the workspace's own order and so do the checkouts under each —
 * the order things were added is the one thing this list has always meant, and
 * a child that jumped its parent would be a row moving for a reason nobody can
 * see.
 */
export function projectTree(
  folders: WorkspaceFolder[],
  worktrees: Record<string, string | null>
): ProjectBranch[] {
  const byPath = new Map<string, WorkspaceFolder>()
  for (const folder of folders) byPath.set(key(folder.path), folder)

  /** Which project each checkout belongs under, for the ones that have one. */
  const parentOf = new Map<string, string>()
  for (const folder of folders) {
    const repo = worktrees[folder.id]
    if (!repo) continue
    const parent = byPath.get(key(repo))
    // Not itself: `worktreeRepo` already answers null for a main worktree, but
    // a folder filed under itself would be an infinite row rather than a bug
    // report.
    if (!parent || parent.id === folder.id) continue
    parentOf.set(folder.id, parent.id)
  }

  const branches: ProjectBranch[] = []
  const at = new Map<string, ProjectBranch>()
  for (const folder of folders) {
    if (parentOf.has(folder.id)) continue
    const branch: ProjectBranch = { folder, checkouts: [] }
    branches.push(branch)
    at.set(folder.id, branch)
  }
  for (const folder of folders) {
    const parentId = parentOf.get(folder.id)
    if (parentId === undefined) continue
    // The parent is a top-level row by construction — a checkout of a checkout
    // is not a thing git produces — but a `??` here would silently drop a row
    // rather than leave it where it can be seen.
    const branch = at.get(parentId)
    if (branch) branch.checkouts.push(folder)
    else branches.push({ folder, checkouts: [] })
  }

  return branches
}
