import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { changes, commit, fileAtHead, recentSubjects } from "../src/main/git"
import { check, finish, section } from "./harness"

/**
 * The Changes list, and the committed side of a diff — against a real
 * repository, for the reason `git-status.ts` builds one too: what is being
 * relied on is git's own output, and a fixture would only prove this file agrees
 * with itself.
 *
 * Three things here are easy to get wrong and silent when they are:
 *
 * A temporary directory on macOS is reached through a symlink, so `git` answers
 * about `/private/var/…` while the entries are addressed from `/var/…`. Keying
 * the line counts on the absolute path is what that breaks, and the row shows a
 * letter with no numbers rather than an error.
 *
 * A **deleted** file has no `realpath`, and it is exactly the file whose
 * committed side somebody wants to see — resolving the file rather than the
 * folder it is in is what makes `HEAD:` come back empty for it.
 *
 * And a folder pointed at a subdirectory of a repository has to work at all:
 * `HEAD:` takes the repository's own path, which is not the one the row carries.
 */

const run = promisify(execFile)

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir })
  return stdout
}

/** The rows, keyed by file name: the absolute paths are what the symlink above
 * makes unsafe to compare against. */
async function rowsIn(dir: string) {
  return Object.fromEntries(
    (await changes(dir)).map((change) => [path.basename(change.path), change])
  )
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "yasuo-changes-"))

  section("a folder that is not a repository")

  check("has no changes", (await changes(root)).length === 0)
  check(
    "and nothing in HEAD",
    (await fileAtHead(root, path.join(root, "anything.ts"))) === null
  )

  section("a working tree")

  await git(root, "init", "--initial-branch", "main")
  await git(root, "config", "user.email", "test@example.com")
  await git(root, "config", "user.name", "Test")

  await writeFile(path.join(root, ".gitignore"), "dist/\n")
  await writeFile(path.join(root, "kept.ts"), "const kept = 1\n")
  await writeFile(path.join(root, "edited.ts"), "one\ntwo\nthree\n")
  await writeFile(path.join(root, "removed.ts"), "gone\n")
  await git(root, "add", ".")
  await git(root, "commit", "-m", "first")

  await writeFile(path.join(root, "edited.ts"), "one\nTWO\nthree\nfour\n")
  await rm(path.join(root, "removed.ts"))
  await writeFile(path.join(root, "fresh.ts"), "a\nb\n")
  await mkdir(path.join(root, "dist"))
  await writeFile(path.join(root, "dist", "bundle.js"), "// built\n")
  // A wholly untracked directory, which plain `git status` reports as one entry
  // — `?? assets/` — and this list must not: the files are what gets read.
  await mkdir(path.join(root, "assets", "icons"), { recursive: true })
  await writeFile(path.join(root, "assets", "logo.svg"), "<svg/>\n")
  await writeFile(path.join(root, "assets", "icons", "x.svg"), "<svg/>\n<g/>\n")

  const rows = await rowsIn(root)

  check(
    // `two` became `TWO` and `four` was appended: two lines added, one gone.
    "an edited file carries the lines either way",
    rows["edited.ts"]?.added === 2 && rows["edited.ts"]?.removed === 1,
    rows["edited.ts"]
  )

  check(
    "a deleted file is every line removed",
    rows["removed.ts"]?.added === 0 && rows["removed.ts"]?.removed === 1,
    rows["removed.ts"]
  )

  check(
    "a new file is counted by being read, since it is in no diff",
    rows["fresh.ts"]?.added === 2 && rows["fresh.ts"]?.removed === 0,
    rows["fresh.ts"]
  )

  check(
    "a committed file with no changes is not a row",
    rows["kept.ts"] === undefined,
    Object.keys(rows)
  )

  check(
    "and neither is anything ignored — the tree greys those, this list is changes",
    rows["dist"] === undefined && rows["bundle.js"] === undefined,
    Object.keys(rows)
  )

  check(
    "a wholly untracked directory is its files, not one row for the folder",
    rows["assets"] === undefined &&
      rows["logo.svg"]?.state === "untracked" &&
      rows["x.svg"]?.state === "untracked",
    Object.keys(rows)
  )

  check(
    "each counted like any other new file, nested ones included",
    rows["logo.svg"]?.added === 1 && rows["x.svg"]?.added === 2,
    [rows["logo.svg"], rows["x.svg"]]
  )

  check(
    "and a file is not a directory",
    rows["fresh.ts"]?.directory === false,
    rows["fresh.ts"]
  )

  check(
    "rows are ordered by path, so the list does not move under a click",
    (await changes(root)).map((change) => path.basename(change.path)).join() ===
      "x.svg,logo.svg,edited.ts,fresh.ts,removed.ts"
  )

  section("the committed side")

  check(
    "an edited file's HEAD is what was committed, not what is on disk",
    (await fileAtHead(root, path.join(root, "edited.ts"))) ===
      "one\ntwo\nthree\n"
  )

  check(
    "a deleted file still has one — it is the whole point of its diff",
    (await fileAtHead(root, path.join(root, "removed.ts"))) === "gone\n"
  )

  check(
    "a new file has none, which is a diff of the whole file added",
    (await fileAtHead(root, path.join(root, "fresh.ts"))) === null
  )

  check(
    "a path outside the folder is not something HEAD could name",
    (await fileAtHead(root, path.join(tmpdir(), "elsewhere.ts"))) === null
  )

  section("a folder inside a repository")

  // Pointing the workspace at `packages/web` of a monorepo: git answers in the
  // repository's terms and the rows are addressed from the folder.
  const inner = path.join(root, "packages", "web")
  await mkdir(inner, { recursive: true })
  await writeFile(path.join(inner, "app.ts"), "one\ntwo\n")
  await git(root, "add", ".")
  await git(root, "commit", "-m", "second")
  await writeFile(path.join(inner, "app.ts"), "one\nTWO\nthree\n")

  const innerRows = await rowsIn(inner)

  check(
    "the counts still find the file",
    innerRows["app.ts"]?.added === 2 && innerRows["app.ts"]?.removed === 1,
    innerRows["app.ts"]
  )

  check(
    "and only what is under the folder is listed",
    Object.keys(innerRows).join() === "app.ts",
    Object.keys(innerRows)
  )

  check(
    "HEAD is reached through the repository's own path",
    (await fileAtHead(inner, path.join(inner, "app.ts"))) === "one\ntwo\n"
  )

  /*
   * The fourth write, against a real repository for the same reason the three
   * above are: what is being relied on is git's own behaviour — that `commit`
   * takes the index and not the working tree, and that it refuses rather than
   * writing an empty commit.
   */
  section("committing what is staged")

  const both = path.join(root, "staged.ts")
  await writeFile(both, "staged\n")
  await git(root, "add", "--", "staged.ts")
  // Edited again after staging, so this file is a row on each side — the case
  // where "commit the working tree" and "commit the index" differ, and the one
  // a message box above two piles has to get right.
  await writeFile(both, "staged\nand then edited\n")

  const written = await commit(root, "feat: the staged half\n\nAnd a body.")

  check("answers with a short sha", /^[0-9a-f]{7,}$/.test(written.sha), written)
  check(
    "and with the subject alone, not the body",
    written.subject === "feat: the staged half",
    written
  )
  check(
    "the commit holds what was staged, not what is on disk",
    (await fileAtHead(root, both)) === "staged\n"
  )

  const afterCommit = await rowsIn(root)
  check(
    "the later edit is still a change",
    afterCommit["staged.ts"]?.staged === false,
    afterCommit["staged.ts"]
  )

  check(
    "and the last subject is what a draft would be shown",
    (await recentSubjects(root, 1))[0] === "feat: the staged half",
    await recentSubjects(root, 1)
  )

  let refused = ""
  try {
    await commit(root, "   ")
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  // Guarded here rather than left to git, which would open an editor on an
  // empty `-m` — and an editor with no terminal to draw in never returns.
  check("an empty message is refused", refused !== "", refused)

  section("a repository with no commits")

  const fresh = await mkdtemp(path.join(tmpdir(), "yasuo-changes-empty-"))
  await git(fresh, "init", "--initial-branch", "main")
  await writeFile(path.join(fresh, "first.ts"), "a\n")

  const freshRows = await rowsIn(fresh)

  check(
    "the file is still listed — an empty panel would be the wrong answer",
    freshRows["first.ts"]?.state === "untracked",
    freshRows
  )

  check(
    "counted as new, since there is no HEAD to diff it against",
    freshRows["first.ts"]?.added === 1,
    freshRows["first.ts"]
  )

  check(
    "and HEAD has nothing at all",
    (await fileAtHead(fresh, path.join(fresh, "first.ts"))) === null
  )

  await rm(root, { recursive: true, force: true })
  await rm(fresh, { recursive: true, force: true })
  finish()
}

await main()
