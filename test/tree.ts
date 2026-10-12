import {
  ancestorFolderIds,
  buildTree,
  deleteImpact,
  descendantFolderIds,
  flattenFolders,
  isDescendant,
} from "../src/renderer/lib/tree"
import { check, finish, section } from "./harness"

/**
 * The tree the API and Notes sidebars are both drawn from.
 *
 * What breaks here breaks quietly and destructively: `isDescendant` is the only
 * thing stopping a folder being dropped into its own subtree, which detaches
 * everything under it from the root and takes it off the screen with no way
 * back; `deleteImpact` is the sentence somebody reads before confirming a
 * delete that cannot be undone. Both walk a parent chain held as flat records,
 * so a cycle or a missing parent is a wrong answer rather than a crash.
 */

type Folder = { id: string; parentId: string | null; name: string }
type Item = { id: string; folderId: string | null; name: string }

const folder = (id: string, parentId: string | null): Folder => ({
  id,
  parentId,
  name: id,
})
const item = (id: string, folderId: string | null): Item => ({
  id,
  folderId,
  name: id,
})

/*
 *  root
 *  ├── a          ├── loose
 *  │   ├── a1
 *  │   │   └── deep
 *  │   └── a-item
 *  └── b
 */
const folders = [
  folder("a", null),
  folder("a1", "a"),
  folder("deep", "a1"),
  folder("b", null),
]
const items = [
  item("a-item", "a"),
  item("deep-item", "deep"),
  item("loose", null),
]

section("buildTree")
{
  const tree = buildTree(folders, items)

  check(
    "folders come before the items beside them",
    tree
      .map((node) => (node.type === "folder" ? node.folder.id : node.item.id))
      .join() === "a,b,loose",
    tree
  )

  const a = tree.find(
    (node) => node.type === "folder" && node.folder.id === "a"
  )
  check(
    "a folder holds its own subfolders and items",
    a?.type === "folder" &&
      a.children
        .map((node) => (node.type === "folder" ? node.folder.id : node.item.id))
        .join() === "a1,a-item",
    a
  )

  // Pinned rather than endorsed: a record naming a parent that is not there is
  // dropped from the tree entirely rather than surfacing at the root. Both
  // panels delete a folder and its subtree in one commit, so this is only
  // reachable through a hand-edited or half-written file — and a note that
  // reappeared at the top level after its folder was deleted would be the more
  // surprising of the two answers.
  const orphaned = buildTree([folder("gone-child", "missing")], [])
  check(
    "a folder whose parent is missing is not shown",
    orphaned.length === 0,
    orphaned
  )
}

section("descendants")
{
  check(
    "a folder is its own descendant, plus everything under it",
    [...descendantFolderIds("a", folders)].sort().join() === "a,a1,deep",
    [...descendantFolderIds("a", folders)]
  )
  check(
    "a leaf folder is only itself",
    [...descendantFolderIds("b", folders)].join() === "b"
  )
  check("a folder is a descendant of itself", isDescendant("a", "a", folders))
  check("nesting is followed to any depth", isDescendant("deep", "a", folders))
  check("siblings are not related", !isDescendant("b", "a", folders))
  check(
    "an ancestor is not a descendant of its own child",
    !isDescendant("a", "deep", folders)
  )

  // The guard runs against records already on screen, and a cycle written by
  // an older build would otherwise be walked forever.
  const cyclic = [folder("x", "y"), folder("y", "x")]
  check(
    "a cycle terminates rather than hanging",
    [...descendantFolderIds("x", cyclic)].sort().join() === "x,y"
  )
}

section("ancestorFolderIds")

check(
  "an item's own folder comes first",
  ancestorFolderIds("deep", folders)[0] === "deep"
)
check(
  "and every folder above it follows, innermost first",
  ancestorFolderIds("deep", folders).join() === "deep,a1,a",
  ancestorFolderIds("deep", folders)
)
check(
  "a top-level folder is only itself",
  ancestorFolderIds("b", folders).join() === "b"
)
check(
  "an item in no folder has no chain",
  ancestorFolderIds(null, folders).length === 0
)
check(
  "a cycle terminates rather than hanging",
  ancestorFolderIds("a", [
    { id: "a", parentId: "b" },
    { id: "b", parentId: "a" },
  ]).length === 2
)

section("deleteImpact")
{
  const all = deleteImpact("a", folders, items)
  check("counts the subfolders it would take", all.folderCount === 2, all)
  check(
    "counts items nested at any depth, and not the folder's own siblings'",
    all.itemCount === 2,
    all
  )

  const leaf = deleteImpact("b", folders, items)
  check(
    "an empty folder takes nothing with it",
    leaf.folderCount === 0 && leaf.itemCount === 0,
    leaf
  )

  // `folderId ?? ""` is how an item at the top level is compared; a folder
  // whose id was somehow "" must not sweep those up.
  const topLevel = deleteImpact("a", folders, [item("loose", null)])
  check("a top-level item belongs to no folder", topLevel.itemCount === 0)
}

section("flattenFolders")
{
  const flat = flattenFolders(folders)
  check(
    "a folder is always listed before its own children",
    flat.map(({ folder: f }) => f.id).join() === "a,a1,deep,b",
    flat
  )
  check(
    "depth counts from the root",
    flat.map(({ depth }) => depth).join() === "0,1,2,0",
    flat
  )
}

finish()
