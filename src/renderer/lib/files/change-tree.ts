import type { GitChange } from "@shared/api"
import { isInside, relativeTo } from "./paths"

/**
 * A pile of changes as a folder tree — what the Explorer's `Changes` list
 * draws.
 *
 * The list was flat: one row per change, the directory dimmed ahead of the
 * name and truncated from the left when the column was narrow. That reads
 * fine for the four files a small turn touches and stops reading at twenty,
 * where `src/renderer/components/studio/` is repeated down the column and the
 * one thing being scanned for — which *area* was touched — has to be
 * reassembled by eye from paths that all begin the same way. A tree says it
 * once, and it is the shape a pull request is read in everywhere else.
 *
 * Two decisions carry the whole file:
 *
 * **A chain of single-child directories is one row.** `src/renderer/lib/files`
 * as four rows with one child each is four lines of indentation buying nothing;
 * as one row it is the same information in a tenth of the column. That is what
 * GitHub does with a pull request's tree, and it is why a directory node has a
 * `label` distinct from its path.
 *
 * **Node ids are relative, `/`-joined, and never touch the disk.** A directory
 * in this tree exists only because some file's path passed through it — git
 * named the files, not the folders — so an id here is a key for React and for
 * what is folded, not a path anything may be read from. `lib/files/paths.ts`
 * builds no paths for exactly this reason: this renderer does not know which
 * separator the machine uses. The **files** carry git's own absolute path, and
 * that is the only thing handed back over IPC.
 */

export type ChangeTreeNode =
  | {
      kind: "file"
      /** `/`-joined and relative to the root — a React key, not a path. */
      id: string
      /** The last segment, which is what the row draws. */
      label: string
      change: GitChange
    }
  | {
      kind: "dir"
      id: string
      /** One or more segments, joined by `/` where a chain was collapsed. */
      label: string
      children: ChangeTreeNode[]
    }

/**
 * The changes of one pile, under the root they belong to.
 *
 * A change whose path is not under `root` at all keeps its whole path as a
 * single segment and lands at the top level — `relativeTo` hands it back whole
 * rather than inventing a `../..` chain, and a row saying where it really is
 * beats a row filed under a folder it is not in.
 */
export function changeTree(
  changes: GitChange[],
  root: string
): ChangeTreeNode[] {
  const top: Builder = { dirs: new Map(), files: [] }

  for (const change of changes) {
    // A path from outside the checkout is one row, whole, at the top level —
    // never split. `relativeTo` hands such a path back unchanged, and splitting
    // *that* would file it under folders it is not in: `/somewhere/else/x.md`
    // would land under a `somewhere` folder of this project's tree.
    const inside = isInside(root, change.path)
    const relative = inside ? relativeTo(root, change.path) : change.path
    const segments = inside
      ? relative.split(/[/\\]/).filter(Boolean)
      : [relative]

    // Popped last, so a change sitting in the checkout's own directory has no
    // segments left and becomes a top-level row.
    const name = segments.pop() ?? change.path

    let node = top
    const trail: string[] = []
    for (const segment of segments) {
      trail.push(segment)
      const id = trail.join("/")
      const existing = node.dirs.get(id)
      if (existing) {
        node = existing
      } else {
        const made: Builder = { dirs: new Map(), files: [] }
        node.dirs.set(id, made)
        node = made
      }
    }

    node.files.push({
      kind: "file",
      id: [...segments, name].join("/"),
      label: name,
      change,
    })
  }

  return collect(top)
}

/** A directory while it is still being filled: its subdirectories by id, and
 * the files sitting directly in it. */
type Builder = { dirs: Map<string, Builder>; files: ChangeTreeNode[] }

/**
 * A builder as the rows it becomes — directories first, each side sorted by
 * name.
 *
 * Not git's own order, which is by path and so interleaves `src/a.ts` with
 * `src/b/c.ts`. A tree is read by running down the folders, and folders that
 * appear between files are folders that get missed.
 */
function collect(node: Builder): ChangeTreeNode[] {
  const dirs: ChangeTreeNode[] = []

  for (const [id, child] of node.dirs) dirs.push(collapse(id, child))

  dirs.sort((a, b) => a.label.localeCompare(b.label))
  const files = [...node.files].sort((a, b) => a.label.localeCompare(b.label))

  return [...dirs, ...files]
}

/**
 * One directory, with a chain of only-children folded into its label.
 *
 * The fold stops at a directory that holds a file as well as a subdirectory,
 * since that file has to be drawn somewhere — folding past it would lose the
 * level it sits at.
 */
function collapse(dirId: string, built: Builder): ChangeTreeNode {
  let label = nameOfId(dirId)
  let id = dirId
  let node = built

  while (node.files.length === 0 && node.dirs.size === 1) {
    const only = node.dirs.entries().next()
    if (only.done) break
    const [childId, child] = only.value
    label = `${label}/${nameOfId(childId)}`
    id = childId
    node = child
  }

  return { kind: "dir", id, label, children: collect(node) }
}

/** The last segment of a `/`-joined tree id — these are this file's own ids,
 * so unlike `lib/files/paths.ts` there is only one separator to consider. */
function nameOfId(id: string): string {
  const index = id.lastIndexOf("/")
  return index === -1 ? id : id.slice(index + 1)
}

/** Every change under a node, in the order the tree draws them — what a
 * directory row's `Stage` and `Discard` act on. */
export function changesUnder(node: ChangeTreeNode): GitChange[] {
  if (node.kind === "file") return [node.change]
  return node.children.flatMap(changesUnder)
}
