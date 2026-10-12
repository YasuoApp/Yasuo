import type { WorkspaceFolder } from "../src/shared/api"
import {
  fileRootsOf,
  rootOfPath,
  shownRootOf,
} from "../src/renderer/lib/files/roots"
import { check, finish, section } from "./harness"

/**
 * What the Explorer is allowed to draw a tree under.
 *
 * The part worth a test is that a path is resolved to the *narrowest* root that
 * holds it — a workspace can hold a folder added inside another folder, and the
 * inner one is where a file under it belongs. Get it wrong and a file is
 * coloured by the wrong repository's `git status`, or filed under the wrong tab
 * group.
 *
 * Pure, so there is nothing on disk here: a list and a path.
 */

const folder = (
  id: string,
  name: string,
  dirPath: string
): WorkspaceFolder => ({
  id,
  name,
  path: dirPath,
  addedAt: "2026-01-01T00:00:00.000Z",
})

const folders = [
  folder("f-app", "app", "/code/app"),
  folder("f-api", "api", "/code/app/api"),
]

section("fileRootsOf")

const roots = fileRootsOf(folders)

check(
  "every folder is a root, in the workspace's own order",
  roots.map((root) => root.id).join(",") === "f-app,f-api",
  roots.map((root) => root.id)
)

check(
  "a root is keyed by its folder, and keeps the folder id beside it",
  roots[0]!.id === "f-app" && roots[0]!.folderId === "f-app"
)

check(
  "the label is the folder's name",
  roots[0]!.label === "app" && roots[1]!.label === "api"
)

section("rootOfPath")

check(
  "a file in a folder resolves to that folder",
  rootOfPath(roots, "/code/app/src/index.ts")?.id === "f-app"
)

check(
  "a folder nested inside another wins for a file inside it",
  rootOfPath(roots, "/code/app/api/src/main.ts")?.id === "f-api"
)

check(
  "the root directory itself is in the root",
  rootOfPath(roots, "/code/app")?.id === "f-app"
)

check(
  "a sibling whose path merely starts the same is outside",
  rootOfPath(roots, "/code/app-old/src/index.ts") === null
)

check(
  "a path in no root is in no root",
  rootOfPath(roots, "/etc/passwd") === null
)

section("shownRootOf")

check(
  "with nothing chosen, the first project is drawn",
  shownRootOf(folders, null)?.path === "/code/app"
)

check(
  "the project that was clicked is the one drawn",
  shownRootOf(folders, "f-api")?.path === "/code/app/api"
)

check(
  "a remembered project that has left the workspace falls back to the first",
  shownRootOf(folders, "f-gone")?.path === "/code/app"
)

check(
  "a workspace with no folders draws nothing",
  shownRootOf([], null) === null
)

finish()
