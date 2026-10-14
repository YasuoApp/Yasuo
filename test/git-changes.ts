import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import {
  changes,
  commit,
  commitFileDiff,
  commitFiles,
  commitMatches,
  fileAtHead,
  log,
  recentSubjects,
  upstream,
} from "../src/main/git"
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
  const root = await mkdtemp(path.join(tmpdir(), "vsclaude-changes-"))

  section("a folder that is not a repository")

  check("has no changes", (await changes(root)).length === 0)
  check("and no commits", (await log(root, 10)).length === 0)
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

  section("the Commits tab")

  const commits = await log(root, 10)
  check(
    "newest first",
    JSON.stringify(commits.map((entry) => entry.subject)) ===
      JSON.stringify(["feat: the staged half", "second", "first"]),
    commits.map((entry) => entry.subject)
  )
  check(
    "the subject alone, not the body",
    commits[0]?.subject === "feat: the staged half"
  )
  check(
    "with its hashes, author and an ISO date",
    /^[0-9a-f]{40}$/.test(commits[0]?.hash ?? "") &&
      commits[0]!.hash.startsWith(commits[0]!.shortHash) &&
      commits[0]?.author === "Test" &&
      !Number.isNaN(Date.parse(commits[0]?.date ?? "")),
    commits[0]
  )
  check(
    "and the refs pointing at it",
    commits[0]?.refs.includes("HEAD -> main") === true &&
      commits[1]?.refs.length === 0,
    commits.map((entry) => entry.refs)
  )
  check("capped at the limit", (await log(root, 2)).length === 2)
  const page = await log(root, 2, 1)
  check(
    "a later page starts after the ones skipped",
    JSON.stringify(page.map((entry) => entry.subject)) ===
      JSON.stringify(["second", "first"]),
    page.map((entry) => entry.subject)
  )
  check("and is empty past the end", (await log(root, 2, 3)).length === 0)

  section("filtering the Commits tab")

  const matched = await log(root, 10, 0, "SECOND")
  check(
    "matches the subject, ignoring case",
    matched.length === 1 && matched[0]?.subject === "second",
    matched.map((entry) => entry.subject)
  )
  check("or the author", (await log(root, 10, 0, "test")).length === 3)
  const byHash = await log(root, 10, 0, commits[2]!.hash.slice(0, 8))
  check(
    "or the start of the hash",
    byHash.length === 1 && byHash[0]?.subject === "first",
    byHash.map((entry) => entry.subject)
  )
  const matchedPage = await log(root, 1, 1, "s")
  check(
    "and pages through the matches, not the log",
    matchedPage.length === 1 && matchedPage[0]?.subject === "second",
    matchedPage.map((entry) => entry.subject)
  )
  check(
    "a word nothing has is no commits",
    (await log(root, 10, 0, "no such words")).length === 0
  )
  check(
    "commitMatches does not match the middle of a hash",
    !commitMatches(commits[0]!, commits[0]!.hash.slice(3, 12))
  )

  section("a commit's files")

  await git(root, "mv", "kept.ts", "renamed.ts")
  await writeFile(path.join(root, "added.ts"), "one\ntwo\n")
  await git(root, "add", "--all", "--", "added.ts", "renamed.ts")
  await commit(root, "a rename and an addition")
  const head = (await log(root, 1))[0]!

  const files = await commitFiles(root, head.hash)
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
  check(
    "lists what the commit touched, by the repository's path",
    Object.keys(byPath).sort().join(",") === "added.ts,renamed.ts",
    files
  )
  check(
    "an addition with its counts",
    byPath["added.ts"]?.state === "added" &&
      byPath["added.ts"]?.added === 2 &&
      byPath["added.ts"]?.removed === 0,
    byPath["added.ts"]
  )
  check(
    "a rename as one row that says where it came from",
    byPath["renamed.ts"]?.from === "kept.ts" &&
      byPath["renamed.ts"]?.added === 0,
    byPath["renamed.ts"]
  )
  check(
    "the root commit is diffed against nothing",
    (await commitFiles(root, commits[2]!.hash)).every(
      (file) => file.state === "added"
    )
  )
  check(
    "a hash that is not one is no files",
    (await commitFiles(root, "--all")).length === 0
  )

  const addedDiff = await commitFileDiff(root, head.hash, "added.ts")
  check(
    "an added file has an after and no before",
    addedDiff.before === null &&
      addedDiff.after === "one\ntwo\n" &&
      addedDiff.patch?.includes("@@") === true,
    addedDiff
  )
  const renamedDiff = await commitFileDiff(
    root,
    head.hash,
    "renamed.ts",
    "kept.ts"
  )
  check(
    "a rename reads its before under the old name",
    renamedDiff.before !== null && renamedDiff.before === renamedDiff.after,
    renamedDiff
  )
  check(
    "a path climbing out of the repository is refused",
    (await commitFileDiff(root, head.hash, "../etc/passwd")).after === null
  )

  section("where the branch stands against its remote")

  check("no remote marks nothing", (await upstream(root))?.ahead.length === 0)
  const remote = await mkdtemp(path.join(tmpdir(), "vsclaude-changes-remote-"))
  await git(remote, "init", "--bare", "--initial-branch", "main")
  await git(root, "remote", "add", "origin", remote)
  const unpublished = await upstream(root)
  check(
    "a branch never pushed has every commit ahead and no upstream",
    unpublished?.name === null && unpublished.aheadCount === 4,
    unpublished
  )
  await git(root, "push", "--quiet", "-u", "origin", "HEAD~1:refs/heads/main")
  await git(root, "branch", "--set-upstream-to", "origin/main")
  const tracked = await upstream(root)
  check(
    "a tracked branch is ahead by what it has not pushed",
    tracked?.name === "origin/main" &&
      tracked.aheadCount === 1 &&
      tracked.ahead[0] === head.hash &&
      tracked.behind === 0,
    tracked
  )

  section("a repository with no commits")

  const fresh = await mkdtemp(path.join(tmpdir(), "vsclaude-changes-empty-"))
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
  check("and no commits to list", (await log(fresh, 10)).length === 0)

  await rm(root, { recursive: true, force: true })
  await rm(fresh, { recursive: true, force: true })
  await rm(remote, { recursive: true, force: true })
  finish()
}

await main()
