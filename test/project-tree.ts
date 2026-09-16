import type { WorkspaceFolder } from "../src/shared/api"
import { projectTree } from "../src/renderer/lib/project-tree"
import { check, finish, section } from "./harness"

/**
 * Which projects the left column draws at the top level, and which are drawn
 * under one of them.
 *
 * Worth a test because the failure is a row that is *somewhere else* rather than
 * a row that is missing: a checkout filed under the wrong project, or under
 * nothing, reads as an ordinary project somebody added by hand, which is exactly
 * the confusion this grouping was written against. And a checkout whose parent
 * has left the workspace has to keep a row of its own — losing it would be the
 * one failure that deletes a project from the only list that reaches it.
 */

/** Only `id` and `path` are read; a whole record would be a fixture that breaks
 * when an unrelated field is added. */
const folder = (id: string, path: string): WorkspaceFolder =>
  ({ id, path, name: id }) as WorkspaceFolder

const api = folder("api", "/src/api")
const web = folder("web", "/src/web")
const sso = folder("sso", "/data/worktrees/api/add-sso")
const perf = folder("perf", "/data/worktrees/api/perf")

section("a checkout is filed under the project it was cut from")

{
  const tree = projectTree([api, sso, web], {
    api: null,
    sso: "/src/api",
    web: null,
  })
  check(
    "the checkout leaves the top level",
    tree.map((branch) => branch.folder.id).join(",") === "api,web",
    tree.map((branch) => branch.folder.id)
  )
  check(
    "and is under its own project",
    tree[0]?.checkouts.map((entry) => entry.id).join(",") === "sso"
  )
  check("which is the only one with any", tree[1]?.checkouts.length === 0)
}

{
  // The path git answers with may carry a trailing separator; the manifest's
  // does not. Two rows for one project is what that used to look like.
  const tree = projectTree([api, sso], { api: null, sso: "/src/api/" })
  check(
    "a trailing separator is not a different repository",
    tree.length === 1 && tree[0]?.checkouts.length === 1
  )
}

{
  const tree = projectTree([api, sso, perf], {
    api: null,
    sso: "/src/api",
    perf: "/src/api",
  })
  check(
    "several checkouts keep the workspace's own order",
    tree[0]?.checkouts.map((entry) => entry.id).join(",") === "sso,perf"
  )
}

section("a checkout with no project here keeps a row")

{
  // The repository was never added, or was removed afterwards. The checkout is
  // a project like any other from where every panel sits, and the column is the
  // only way to reach it.
  const tree = projectTree([sso, web], { sso: "/src/api", web: null })
  check(
    "it stays at the top level",
    tree.map((branch) => branch.folder.id).join(",") === "sso,web",
    tree.map((branch) => branch.folder.id)
  )
}

{
  // Missing rather than null: the pair is read a round of git after the folders
  // land, so the first paint has neither answer for any of them.
  const tree = projectTree([api, sso], {})
  check(
    "and so does one whose repository has not been asked about yet",
    tree.length === 2
  )
}

{
  // `worktreeRepo` answers null for a main worktree, so this cannot happen —
  // but a folder filed under itself would be a row that draws itself forever.
  const tree = projectTree([api], { api: "/src/api" })
  check("a folder is never its own parent", tree.length === 1)
}

finish()
