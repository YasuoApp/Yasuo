import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { changes, discard, discardAll, stage, unstage } from "../src/main/git"
import { check, finish, section } from "./harness"

/**
 * The Changes list's three writes, against a real repository.
 *
 * Against a real one for the reason every other git test here is: what is being
 * relied on is git's own behaviour — which of `restore`, `rm --cached` and
 * `add` applies to a file in which state — and a fixture would only prove this
 * file agrees with itself.
 *
 * The cases that are easy to get wrong and quiet when they are:
 *
 * A file `HEAD` does not have cannot be restored from it. A new file and the
 * destination of a rename both look like ordinary rows and neither can be
 * `git restore`d, so `discard` answers with them instead of deleting them — the
 * trash is `ipc.ts`'s, since `git.ts` may not import `electron`.
 *
 * A repository with **no commit** has no `HEAD` at all, so unstaging there is
 * `rm --cached` and not `restore --staged`.
 *
 * And a rename is two records in porcelain and one row in the list. Discarding
 * the row has to put the old name back, or the discard leaves the working tree
 * in a state nobody asked for.
 */

const run = promisify(execFile)

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir })
  return stdout
}

/** The rows, keyed by `name` for an unstaged row and `name (staged)` for the
 * staged one — the two a single path can be. */
async function rowsIn(dir: string) {
  return Object.fromEntries(
    (await changes(dir)).map((change) => [
      change.staged
        ? `${path.basename(change.path)} (staged)`
        : path.basename(change.path),
      change,
    ])
  )
}

async function exists(target: string): Promise<boolean> {
  return readFile(target, "utf8").then(
    () => true,
    () => false
  )
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "yasuo-git-write-"))
  await git(root, "init", "--initial-branch", "main")
  await git(root, "config", "user.email", "test@example.com")
  await git(root, "config", "user.name", "Test")
  return root
}

async function main() {
  section("staging")

  const root = await repository()
  await writeFile(path.join(root, "edited.ts"), "one\ntwo\n")
  await writeFile(path.join(root, "removed.ts"), "gone\n")
  await git(root, "add", ".")
  await git(root, "commit", "-m", "first")

  await writeFile(path.join(root, "edited.ts"), "one\nTWO\nthree\n")
  await writeFile(path.join(root, "fresh.ts"), "a\n")
  await rm(path.join(root, "removed.ts"))

  await stage(root, [path.join(root, "edited.ts")])
  let rows = await rowsIn(root)

  check(
    "a staged edit is the staged row and not the unstaged one",
    rows["edited.ts (staged)"]?.staged === true &&
      rows["edited.ts"] === undefined,
    Object.keys(rows)
  )

  check(
    "carrying its own side's counts",
    rows["edited.ts (staged)"]?.added === 2 &&
      rows["edited.ts (staged)"]?.removed === 1,
    rows["edited.ts (staged)"]
  )

  // Edited again after being staged: the file is now both, which is the case
  // the collapsed state in the tree cannot express.
  await writeFile(path.join(root, "edited.ts"), "one\nTWO\nthree\nfour\n")
  rows = await rowsIn(root)

  check(
    "a file staged and then edited again is two rows",
    rows["edited.ts (staged)"]?.added === 2 &&
      rows["edited.ts"]?.added === 1 &&
      rows["edited.ts"]?.removed === 0,
    [rows["edited.ts (staged)"], rows["edited.ts"]]
  )

  await stage(root, [
    path.join(root, "fresh.ts"),
    path.join(root, "removed.ts"),
  ])
  rows = await rowsIn(root)

  check(
    "a new file stages as added",
    rows["fresh.ts (staged)"]?.state === "added",
    rows["fresh.ts (staged)"]
  )

  check(
    "and a deletion stages as one — `--all`, not just what is on disk",
    rows["removed.ts (staged)"]?.state === "deleted",
    rows["removed.ts (staged)"]
  )

  section("unstaging")

  await unstage(root, [
    path.join(root, "fresh.ts"),
    path.join(root, "removed.ts"),
  ])
  rows = await rowsIn(root)

  check(
    "a new file goes back to being untracked",
    rows["fresh.ts"]?.state === "untracked" &&
      rows["fresh.ts (staged)"] === undefined,
    Object.keys(rows)
  )

  check(
    "and the file is still on disk — unstaging is not deleting",
    !(await exists(path.join(root, "fresh.ts"))) === false
  )

  check(
    "a deletion goes back to being an unstaged one",
    rows["removed.ts"]?.state === "deleted" &&
      rows["removed.ts (staged)"] === undefined,
    Object.keys(rows)
  )

  section("discarding")

  check(
    "a tracked file goes back to HEAD, both sides at once",
    await discard(root, [path.join(root, "edited.ts")]).then(
      async (trash) =>
        trash.length === 0 &&
        (await readFile(path.join(root, "edited.ts"), "utf8")) === "one\ntwo\n"
    )
  )

  check(
    "a deleted file is put back",
    await discard(root, [path.join(root, "removed.ts")]).then(
      async (trash) =>
        trash.length === 0 &&
        (await readFile(path.join(root, "removed.ts"), "utf8")) === "gone\n"
    )
  )

  check(
    // The caller trashes it; `git.ts` may not import `electron`.
    "a new file is answered with rather than deleted here",
    (await discard(root, [path.join(root, "fresh.ts")])).join() ===
      path.join(root, "fresh.ts"),
    await discard(root, [path.join(root, "fresh.ts")])
  )

  // Staged and new: out of the index, and still the caller's to trash.
  await writeFile(path.join(root, "added.ts"), "a\n")
  await stage(root, [path.join(root, "added.ts")])
  const addedTrash = await discard(root, [path.join(root, "added.ts")])

  check(
    "a staged new file is taken out of the index and handed back",
    addedTrash.join() === path.join(root, "added.ts") &&
      (await rowsIn(root))["added.ts (staged)"] === undefined,
    addedTrash
  )

  // The list draws each file of a new directory as its own row, where plain
  // status says only `?? nested/` — so the row's path has to be found anyway.
  await mkdir(path.join(root, "nested", "deeper"), { recursive: true })
  await writeFile(path.join(root, "nested", "deeper", "one.ts"), "a\n")
  const nestedTrash = await discard(root, [
    path.join(root, "nested", "deeper", "one.ts"),
  ])

  check(
    "a file inside a wholly new directory is handed back on its own",
    nestedTrash.join() === path.join(root, "nested", "deeper", "one.ts"),
    nestedTrash
  )
  await rm(path.join(root, "nested"), { recursive: true })

  section("a rename")

  await git(root, "mv", "edited.ts", "renamed.ts")
  const renameTrash = await discard(root, [path.join(root, "renamed.ts")])

  check(
    "the new name is handed back to be trashed",
    renameTrash.join() === path.join(root, "renamed.ts"),
    renameTrash
  )

  check(
    "and the old name is restored — a half-undone rename is not an answer",
    (await readFile(path.join(root, "edited.ts"), "utf8")) === "one\ntwo\n"
  )

  section("everything at once")

  await writeFile(path.join(root, "edited.ts"), "changed\n")
  await writeFile(path.join(root, "one.ts"), "a\n")
  await mkdir(path.join(root, "assets"), { recursive: true })
  await writeFile(path.join(root, "assets", "logo.svg"), "<svg/>\n")
  await stage(root, [path.join(root, "one.ts")])

  const allTrash = await discardAll(root)

  check(
    "tracked work is back at HEAD",
    (await readFile(path.join(root, "edited.ts"), "utf8")) === "one\ntwo\n"
  )

  check(
    "the untracked file and the untracked directory are both handed back",
    allTrash.includes(path.join(root, "one.ts")) &&
      allTrash.includes(path.join(root, "assets")),
    allTrash
  )

  check(
    "and nothing tracked is left in the list once they are gone",
    // A row may be a file inside a directory handed back whole.
    (await changes(root)).every((change) =>
      allTrash.some(
        (trashed) =>
          change.path === trashed || change.path.startsWith(trashed + path.sep)
      )
    ),
    await changes(root)
  )

  section("a repository with no commits")

  const fresh = await repository()
  await writeFile(path.join(fresh, "first.ts"), "a\n")
  await stage(fresh, [path.join(fresh, "first.ts")])

  check(
    "a file can be staged with no HEAD to compare it against",
    (await rowsIn(fresh))["first.ts (staged)"]?.state === "added",
    await rowsIn(fresh)
  )

  await unstage(fresh, [path.join(fresh, "first.ts")])

  check(
    "and unstaged again, where `restore --staged` has no HEAD to work from",
    (await rowsIn(fresh))["first.ts"]?.state === "untracked",
    await rowsIn(fresh)
  )

  check(
    "with the file still on disk",
    (await readFile(path.join(fresh, "first.ts"), "utf8")) === "a\n"
  )

  section("outside the folder")

  const outside = await mkdtemp(path.join(tmpdir(), "yasuo-git-outside-"))
  await writeFile(path.join(outside, "theirs.ts"), "not yours\n")

  await stage(root, [path.join(outside, "theirs.ts")])

  check(
    // `ipc.ts` checks the workspace's roots; this is the second, narrower gate,
    // and the one that keeps a folder's write inside that folder.
    "a path outside the folder is refused rather than adjusted",
    await exists(path.join(outside, "theirs.ts"))
  )

  check(
    "and nothing of it reaches the repository",
    (await changes(root)).every((change) => !change.path.startsWith(outside)),
    await changes(root)
  )

  await rm(root, { recursive: true, force: true })
  await rm(fresh, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
  finish()
}

await main()
