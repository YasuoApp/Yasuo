/**
 * The tree two sidebars draw: folders that nest, and items filed under them.
 *
 * The API panel had all of this to itself until the Notes panel wanted the same
 * shape — the same nesting, the same cycle guard on a drag, the same "what does
 * deleting this take with it". It stayed generic when that panel was deleted:
 * a folder is anything with a `parentId`, an item anything with a `folderId`,
 * and the panel keeps its own types.
 *
 * Nothing here touches the DOM or a store, which is what lets `test/tree.ts`
 * ask about it without a renderer.
 */

import { descendantFolderIds, type TreeFolder } from "@shared/tree"

/*
 * The two that are about the shape of the tree rather than about drawing it
 * moved to `@shared/tree`, because the main process needs the same cascade when
 * an agent deletes a folder through the MCP server. Re-exported so this file is
 * still the one place a panel asks about its tree.
 */
export {
  descendantFolderIds,
  isDescendant,
  type TreeFolder,
} from "@shared/tree"

/** A leaf filed under one of those folders, or null at the top. */
export type TreeItem = { id: string; folderId: string | null }

export type TreeNode<F extends TreeFolder, I extends TreeItem> =
  | { type: "folder"; folder: F; children: TreeNode<F, I>[] }
  | { type: "item"; item: I }

/**
 * Groups folders and items by parent, folders first.
 *
 * Order within a group is left as given — creation order, the same as each
 * panel's flat list before it had folders at all — rather than resorted
 * alphabetically, so adding a folder never reshuffles a collection somebody
 * has already arranged.
 */
export function buildTree<F extends TreeFolder, I extends TreeItem>(
  folders: F[],
  items: I[]
): TreeNode<F, I>[] {
  function childrenOf(parentId: string | null): TreeNode<F, I>[] {
    const childFolders: TreeNode<F, I>[] = folders
      .filter((folder) => (folder.parentId ?? null) === parentId)
      .map((folder) => ({
        type: "folder",
        folder,
        children: childrenOf(folder.id),
      }))
    const childItems: TreeNode<F, I>[] = items
      .filter((item) => (item.folderId ?? null) === parentId)
      .map((item) => ({ type: "item", item }))
    return [...childFolders, ...childItems]
  }
  return childrenOf(null)
}

/** Every folder, paired with how deep it sits — for a flat picker where
 * indentation stands in for nesting, a folder always listed before its own
 * children. */
export function flattenFolders<F extends TreeFolder>(
  folders: F[]
): { folder: F; depth: number }[] {
  const out: { folder: F; depth: number }[] = []
  function walk(parentId: string | null, depth: number) {
    for (const folder of folders.filter(
      (candidate) => (candidate.parentId ?? null) === parentId
    )) {
      out.push({ folder, depth })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/**
 * The folder an item sits in, and every folder above that one.
 *
 * For revealing what the pane is showing: a request picked from the tab strip
 * or the search palette may be three folders deep in a sidebar that has all
 * three shut, and a list that marks a row inside a folded folder has marked
 * nothing. Includes `folderId` itself, since that is the innermost thing that
 * has to be open, and is empty for an item at the top level.
 *
 * Guarded against a cycle the same way `descendantFolderIds` is — a parent
 * chain is data on disk, and this must not be the thing that hangs on a
 * malformed one.
 */
export function ancestorFolderIds(
  folderId: string | null,
  folders: TreeFolder[]
): string[] {
  const chain: string[] = []
  const seen = new Set<string>()

  let current = folderId
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = folders.find((folder) => folder.id === current)?.parentId ?? null
  }
  return chain
}

/** What deleting a folder would take with it, for the confirmation dialog. */
export function deleteImpact(
  id: string,
  folders: TreeFolder[],
  items: TreeItem[]
): { folderCount: number; itemCount: number } {
  const ids = descendantFolderIds(id, folders)
  return {
    folderCount: ids.size - 1,
    itemCount: items.filter((item) => ids.has(item.folderId ?? "")).length,
  }
}
