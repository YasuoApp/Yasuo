/**
 * What nests, and what deleting a folder takes with it.
 *
 * The pieces of `renderer/lib/tree.ts` the main process also needs. A second
 * reader arrived the same way `shared/http-request.ts` got one: the MCP server
 * writes the API panel's folders for an agent (`main/mcp.ts`), and "the folder,
 * its subfolders and their requests" has to mean there exactly what it means
 * when the panel's own confirmation dialog counts it up. Two implementations of
 * a cascade is two answers to "what did I just delete".
 *
 * Only the two functions that are about the shape of the tree rather than about
 * drawing it: building the nodes, laying them out and revealing a row are the
 * sidebar's business and stay in the renderer, which re-exports these so the
 * panels still reach them where they always have.
 */

/** A node that nests: it names the folder it sits in, or null at the top. */
export type TreeFolder = { id: string; parentId: string | null }

/**
 * `id` itself, plus every folder nested under it at any depth.
 *
 * Iterated to a fixed point rather than walked recursively: a parent chain is
 * data on disk, and a malformed one — a cycle written by an older build, or by
 * hand — must not be the thing that hangs the app. Each pass can only add
 * folders, so it terminates whatever the data says.
 */
export function descendantFolderIds(
  id: string,
  folders: TreeFolder[]
): Set<string> {
  const result = new Set<string>([id])
  let added = true
  while (added) {
    added = false
    for (const folder of folders) {
      if (
        folder.parentId &&
        result.has(folder.parentId) &&
        !result.has(folder.id)
      ) {
        result.add(folder.id)
        added = true
      }
    }
  }
  return result
}

/** Whether `nodeId` is `ancestorId` itself, or nested anywhere under it — the
 * cycle guard for a reparent, whether it comes from a drag in the sidebar or
 * from a tool call: a folder can't be moved into its own subtree. */
export function isDescendant(
  nodeId: string,
  ancestorId: string,
  folders: TreeFolder[]
): boolean {
  return descendantFolderIds(ancestorId, folders).has(nodeId)
}
