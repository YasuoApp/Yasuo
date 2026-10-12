import type { GitChange } from "../src/shared/api"
import {
  changeTree,
  changesUnder,
  type ChangeTreeNode,
} from "../src/renderer/lib/files/change-tree"
import { check, finish, section } from "./harness"

/**
 * The Changes list's tree: which rows a pile of git paths becomes.
 *
 * The failures worth a test here are the quiet ones. A directory chain folded
 * one step too far loses the level a file sits at; a path from outside the
 * checkout filed under a folder it is not in is a row that lies; and a
 * directory's counts are the one number in the panel nobody can check by eye,
 * so a binary file blanking a folder's `+112 −8` would go unreported. Pure, so
 * this asks without a store or a repository.
 */

const ROOT = "/home/dev/project"

function change(path: string, extra: Partial<GitChange> = {}): GitChange {
  return {
    path: `${ROOT}/${path}`,
    state: "modified",
    staged: false,
    directory: false,
    added: 1,
    removed: 1,
    ...extra,
  }
}

function labels(nodes: ChangeTreeNode[]): string[] {
  return nodes.map((node) =>
    node.kind === "dir" ? `${node.label}/` : node.label
  )
}

function dir(nodes: ChangeTreeNode[], label: string) {
  const found = nodes.find(
    (node) => node.kind === "dir" && node.label === label
  )
  if (!found || found.kind !== "dir") throw new Error(`no directory ${label}`)
  return found
}

section("shape")
{
  const tree = changeTree(
    [
      change("src/renderer/lib/files/paths.ts"),
      change("src/renderer/lib/files/roots.ts"),
      change("README.md"),
    ],
    ROOT
  )

  check(
    "a file in the checkout's own directory is a top-level row",
    labels(tree).includes("README.md"),
    labels(tree)
  )
  check(
    "a chain of single-child directories is one row",
    labels(tree).includes("src/renderer/lib/files/"),
    labels(tree)
  )
  check(
    "directories come before files",
    labels(tree)[0] === "src/renderer/lib/files/",
    labels(tree)
  )
  check(
    "the folded row holds both files",
    labels(dir(tree, "src/renderer/lib/files").children).join(",") ===
      "paths.ts,roots.ts"
  )
}

{
  const tree = changeTree(
    [change("src/main/git.ts"), change("src/renderer/lib/store.ts")],
    ROOT
  )

  check(
    "the fold stops where the tree branches",
    labels(tree).join(",") === "src/",
    labels(tree)
  )
  check(
    "and both branches are folded on their own",
    labels(dir(tree, "src").children).join(",") === "main/,renderer/lib/",
    labels(dir(tree, "src").children)
  )
}

{
  // The fold must not pass a directory that holds a file of its own: `src` has
  // `index.ts` in it, so folding `src/lib` into one row would leave that file
  // with nowhere to be drawn.
  const tree = changeTree(
    [change("src/index.ts"), change("src/lib/a.ts")],
    ROOT
  )

  check(
    "a directory holding a file as well as a folder is not folded",
    labels(tree).join(",") === "src/",
    labels(tree)
  )
  check(
    "so the file keeps its level",
    labels(dir(tree, "src").children).join(",") === "lib/,index.ts",
    labels(dir(tree, "src").children)
  )
}

section("paths this renderer did not choose")
{
  const outside: GitChange = {
    ...change("x"),
    path: "/somewhere/else/notes.md",
  }
  const tree = changeTree([outside, change("a.ts")], ROOT)

  check(
    "a path outside the root stays whole and stays at the top",
    labels(tree).join(",") === "/somewhere/else/notes.md,a.ts",
    labels(tree)
  )
}

{
  // Windows, where main hands over what `node:path` produced — backslashes and
  // all, root included.
  const tree = changeTree(
    [{ ...change("git.ts"), path: "C:\\project\\src\\main\\git.ts" }],
    "C:\\project"
  )

  check(
    "a Windows path splits on its own separator",
    labels(tree).join(",") === "src/main/",
    labels(tree)
  )
}

{
  const tree = changeTree(
    [change("public/images/building", { directory: true, state: "untracked" })],
    ROOT
  )

  check(
    "a wholly untracked directory is a leaf, not a folder to open",
    labels(tree).join(",") === "public/images/" &&
      labels(dir(tree, "public/images").children).join(",") === "building",
    labels(tree)
  )
}

section("what a directory row acts on")
{
  const tree = changeTree(
    [
      change("src/a.ts", { added: 10, removed: 2 }),
      change("src/deep/b.ts", { added: 100, removed: 6 }),
      change("src/deep/logo.png", { added: null, removed: null }),
    ],
    ROOT
  )
  const src = dir(tree, "src")

  check(
    "every change under a row, however deep",
    changesUnder(src).length === 3,
    changesUnder(src).map((entry) => entry.path)
  )
}

finish()
