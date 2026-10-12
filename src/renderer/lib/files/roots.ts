import type { WorkspaceFolder } from "@shared/api"

import { useProjects } from "../projects"
import { useStudio } from "../store"
import { isInside } from "./paths"

/**
 * A directory the Explorer draws a tree under: a workspace folder.
 *
 * A record rather than the folder itself because everything keyed by "where" —
 * the dock's shells, a chat, a file tab's scope — reads `id`, `path` and
 * `label` off it and nothing else. It carried a second kind of root while
 * `git worktree` checkouts existed beside the projects; `id` is a folder id
 * now, and `folderId` is kept as its own field so those readers did not all
 * have to change their minds about which of the two they wanted.
 */
export type FileRoot = {
  id: string
  folderId: string
  path: string
  /** The folder's name — what the row says. */
  label: string
}

/**
 * Every root there is. Pure, and tested in `test/file-roots.ts`.
 */
export function fileRootsOf(folders: WorkspaceFolder[]): FileRoot[] {
  return folders.map((folder) => ({
    id: folder.id,
    folderId: folder.id,
    path: folder.path,
    label: folder.name,
  }))
}

/**
 * Which root a path is in, or null for one in none of them.
 *
 * The longest match wins, the way `serverFor` in `main/tsserver.ts` picks a
 * tsserver: a folder pointed at a directory that already holds another folder
 * is a workspace somebody is allowed to have, and the inner one is the better
 * answer for a file inside it.
 */
export function rootOfPath(
  roots: FileRoot[],
  filePath: string
): FileRoot | null {
  let best: FileRoot | null = null
  for (const root of roots) {
    if (!isInside(root.path, filePath)) continue
    if (best === null || root.path.length > best.path.length) best = root
  }
  return best
}

/**
 * The one root the Explorer draws: the project being worked in.
 *
 * Deliberately one, and deliberately not `fileRootsOf` above.
 *
 * Every project at once was what this used to be — which is several
 * repositories stacked in one column, each with its own `src/` and its own
 * `package.json`. The question somebody has open is not "which projects exist"
 * but "the files of the thing I am working on", and the thing they are working
 * on is the row they clicked in the left column. The same choice the dock's
 * Terminal makes: one shell for the place you are in, not one per place there
 * is.
 *
 * Falls back rather than drawing nothing: the first project when none has been
 * clicked yet or the remembered one has left the workspace. Null only for a
 * workspace with no folders at all, which is the empty tree.
 *
 * `fileRootsOf` is still every root there is, and that is the right list for
 * everything that is not the tree: what may be read, which tabs survive, which
 * project a path belongs to. Switching project must not close the tabs of the
 * one being left.
 */
export function shownRootOf(
  folders: WorkspaceFolder[],
  activeFolderId: string | null
): FileRoot | null {
  const folder =
    folders.find((candidate) => candidate.id === activeFolderId) ?? folders[0]
  if (folder === undefined) return null

  return {
    id: folder.id,
    folderId: folder.id,
    path: folder.path,
    label: folder.name,
  }
}

/** The roots as the store currently holds them — for the callers that are not
 * rendering and so have nothing to subscribe with. */
export function fileRoots(): FileRoot[] {
  return fileRootsOf(useStudio.getState().folders)
}

/** What the tree is drawing right now, read through the stores. */
export function shownRoot(): FileRoot | null {
  return shownRootOf(
    useStudio.getState().folders,
    useProjects.getState().activeFolderId
  )
}

/** The root a path is in, read through the stores. */
export function rootOf(filePath: string): FileRoot | null {
  return rootOfPath(fileRoots(), filePath)
}
