import { execFile } from "node:child_process"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import {
  addWorktree,
  branchFromTitle,
  isUntitledBranch,
  mainWorktreeIn,
  removeWorktree,
  renameBranch,
  untitledBranch,
  worktreeDir,
  worktreeRepo,
  worktreeSlug,
} from "../src/main/worktrees"
import { check, finish, section } from "./harness"

/**
 * A second checkout of a project, against a real repository — for the reason
 * `git-changes.ts` builds one: what is relied on here is git's own behaviour,
 * and a fixture would only prove this file agrees with itself.
 *
 * The one that is silent when it is wrong is `worktreeRepo`. A temporary
 * directory on macOS is reached through a symlink (`/var` → `/private/var`), so
 * git answers about one spelling while the folder record carries the other —
 * comparing those two strings makes the **main** worktree look like a checkout
 * of itself, which puts `Remove worktree` on the menu of the project somebody's
 * work is actually in.
 */

const run = promisify(execFile)

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir })
  return stdout
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function main() {
  section("a branch name as a directory name")

  check("an ordinary one is itself", worktreeSlug("sso") === "sso")
  check(
    "a slash is not a directory here",
    worktreeSlug("feature/sso-login") === "feature-sso-login",
    "one branch is one directory, however many segments git reads in it"
  )
  check(
    "punctuation runs collapse and the ends are trimmed",
    worktreeSlug("  Fix: the__login (again)  ") === "fix-the-login-again"
  )
  check(
    "a name with nothing ASCII in it slugs to nothing",
    worktreeSlug("日本語") === "",
    "which is what the caller's fallback is for — see `worktreeDir`"
  )
  check("and is cut to length", worktreeSlug("a".repeat(80)).length === 40)

  section("where a checkout goes")

  check(
    "under the workspace's own directory, keyed by project and branch",
    worktreeDir("/data/workspace", "f1", "feature/sso") ===
      path.join("/data/workspace", "worktrees", "f1", "feature-sso")
  )
  check(
    "two projects on one branch name are two directories",
    worktreeDir("/data/workspace", "f1", "main") !==
      worktreeDir("/data/workspace", "f2", "main"),
    "the same branch name in two repositories is two checkouts"
  )
  check(
    "a branch that slugs to nothing still has a directory",
    worktreeDir("/data/workspace", "f1", "日本語") ===
      path.join("/data/workspace", "worktrees", "f1", "branch")
  )

  section("git worktree list, read")

  check(
    "the main worktree is the first paragraph's path",
    mainWorktreeIn(
      [
        "worktree /repo",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /data/worktrees/f1/sso",
        "HEAD def",
        "branch refs/heads/sso",
        "",
      ].join("\n")
    ) === "/repo"
  )
  check(
    "a path with spaces in it survives",
    mainWorktreeIn("worktree /Users/me/My Repo\nHEAD abc\n") ===
      "/Users/me/My Repo"
  )
  check("nothing at all is null", mainWorktreeIn("") === null)

  section("a real repository")

  const root = await mkdtemp(path.join(tmpdir(), "yasuo-worktrees-"))
  const repo = path.join(root, "repo")
  const workspace = path.join(root, "workspace")
  await run("git", ["init", "--initial-branch", "main", repo])
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Test")
  await writeFile(path.join(repo, "kept.ts"), "const kept = 1\n")
  await git(repo, "add", ".")
  await git(repo, "commit", "-m", "first")

  check(
    "the project itself is not a checkout of anything",
    (await worktreeRepo(repo)) === null,
    "the symlinked temporary directory is the case this is written for"
  )

  const dir = worktreeDir(workspace, "f1", "feature/sso")
  const made = await addWorktree({ repo, dir, branch: "feature/sso" })

  check("a new branch is checked out", !("error" in made), made)
  check(
    "the file is there, at the commit it was branched off",
    await exists(path.join(dir, "kept.ts"))
  )
  check(
    "on the branch that was asked for",
    (await git(dir, "branch", "--show-current")).trim() === "feature/sso"
  )
  check(
    "and it knows which repository it is a checkout of",
    (await worktreeRepo(dir)) !== null,
    await worktreeRepo(dir)
  )

  section("a checkout nobody has named")

  check(
    "the placeholder is recognisable as one",
    isUntitledBranch(untitledBranch())
  )
  check(
    "two minted at once are two branches",
    untitledBranch() !== untitledBranch(),
    "a count would need somewhere to live; two projects can mint in one second"
  )
  check(
    "a branch somebody named is not one",
    !isUntitledBranch("feature/sso") && !isUntitledBranch(null)
  )
  check(
    "and a title becomes a branch through the same slug a directory gets",
    branchFromTitle("Fix the diff not refreshing") ===
      "fix-the-diff-not-refreshing"
  )
  check(
    "a title with nothing ASCII in it names nothing",
    branchFromTitle("日本語") === null,
    "the placeholder is a better name than the empty string"
  )

  const placeholder = untitledBranch()
  const unnamed = worktreeDir(workspace, "f1", placeholder)
  await addWorktree({ repo, dir: unnamed, branch: placeholder })

  check(
    "the checkout is on it",
    (await git(unnamed, "branch", "--show-current")).trim() === placeholder
  )

  const renamed = await renameBranch(unnamed, placeholder, "add-sso-login")
  check("renaming answers with the name it took", renamed === "add-sso-login")
  check(
    "and the checkout is on that branch",
    (await git(unnamed, "branch", "--show-current")).trim() === "add-sso-login"
  )
  check(
    "the placeholder is gone rather than left beside it",
    (await git(repo, "branch", "--list", placeholder)).trim() === "",
    "`-m` moves the branch; a copy would leave a ref nobody deletes"
  )

  section("two runs at one task")

  const twice = untitledBranch()
  const twin = worktreeDir(workspace, "f1", twice)
  await addWorktree({ repo, dir: twin, branch: twice })
  const suffixed = await renameBranch(twin, twice, "add-sso-login")

  check(
    "the second keeps the placeholder's own suffix rather than failing",
    suffixed !== null && suffixed.startsWith("add-sso-login-"),
    suffixed
  )
  check(
    "which is what the checkout is on",
    (await git(twin, "branch", "--show-current")).trim() === suffixed
  )

  section("a branch that already exists")

  await git(repo, "branch", "later")
  const second = await addWorktree({
    repo,
    dir: worktreeDir(workspace, "f1", "later"),
    branch: "later",
  })
  check(
    "is checked out rather than refused",
    !("error" in second),
    "coming back to work started last week is the same gesture as starting it"
  )

  const clash = await addWorktree({
    repo,
    dir: worktreeDir(workspace, "f2", "later"),
    branch: "later",
  })
  check(
    "but a branch already checked out somewhere is git's own refusal",
    "error" in clash && clash.error.length > 0,
    clash
  )

  section("a folder that is not a repository")

  const plain = path.join(root, "plain")
  await run("mkdir", ["-p", plain])
  check(
    "says so rather than throwing",
    "error" in (await addWorktree({ repo: plain, dir, branch: "x" })),
    "every failure here is a sentence for the dialog that asked"
  )
  check("and is no checkout either", (await worktreeRepo(plain)) === null)

  section("removing one")

  // Uncommitted work in it, which is the ordinary state of a checkout somebody
  // has been working in and the reason the removal is forced.
  await writeFile(path.join(dir, "kept.ts"), "const kept = 2\n")

  check("git does not refuse it", (await removeWorktree(repo, dir)) === null)
  check("the directory is gone", !(await exists(dir)))
  check(
    "the branch is not",
    (await git(repo, "branch", "--list", "feature/sso")).trim().length > 0,
    "the branch is the work — the whole reason the checkout was made"
  )
  check(
    "and the repository still has its own files",
    (await readdir(repo)).includes("kept.ts")
  )

  await rm(root, { recursive: true, force: true })
  finish()
}

void main()
