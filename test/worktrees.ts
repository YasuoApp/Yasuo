import { execFile } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import {
  addWorktree,
  baseKey,
  branchFromTitle,
  copyIncluded,
  isUntitledBranch,
  mainWorktreeIn,
  removeWorktree,
  renameBranch,
  setupCommandFor,
  untitledBranch,
  worktreeDir,
  worktreeOptions,
  worktreeRepo,
  worktreeSlug,
  worktreeStatus,
} from "../src/main/worktrees"
import { removalWarnings, worktreeSummary } from "../src/renderer/lib/worktrees"
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

  const root = await mkdtemp(path.join(tmpdir(), "vsclaude-worktrees-"))
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
    "one minted while the app was called Yasuo still is",
    isUntitledBranch("yasuo/untitled-a1b2c3"),
    "a checkout made before the rename would otherwise never be named"
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

  section("cut from a base")

  await git(repo, "checkout", "-q", "-b", "develop")
  await writeFile(path.join(repo, "develop.ts"), "const d = 1\n")
  await git(repo, "add", ".")
  await git(repo, "commit", "-q", "-m", "develop only")
  await git(repo, "checkout", "-q", "main")

  const based = worktreeDir(workspace, "f1", "off-develop")
  const fromDevelop = await addWorktree({
    repo,
    dir: based,
    branch: "off-develop",
    base: "develop",
  })
  check("a base is accepted", !("error" in fromDevelop), fromDevelop)
  check(
    "and the checkout starts at it rather than at HEAD",
    await exists(path.join(based, "develop.ts"))
  )
  check(
    "the base is written beside the branch",
    (await git(repo, "config", "--get", baseKey("off-develop"))).trim() ===
      "develop",
    "what ahead and behind count against a week later"
  )
  check(
    "and is not made its upstream",
    (await run("git", ["rev-parse", "--abbrev-ref", "off-develop@{u}"], {
      cwd: repo,
    }).catch(() => null)) === null,
    "a `git push` would refuse a branch tracking one of another name"
  )
  check(
    "an empty base records the main checkout's branch",
    (await git(repo, "config", "--get", baseKey("feature/sso"))).trim() ===
      "main"
  )

  const nowhere = await addWorktree({
    repo,
    dir: worktreeDir(workspace, "f1", "from-nowhere"),
    branch: "from-nowhere",
    base: "no-such-branch",
  })
  check("a base git does not know is git's refusal", "error" in nowhere)

  section("a branch that exists only on the remote")

  const clone = path.join(root, "clone")
  await run("git", ["clone", "-q", repo, clone])
  const tracked = worktreeDir(workspace, "f3", "develop")
  const fromRemote = await addWorktree({
    repo: clone,
    dir: tracked,
    branch: "develop",
  })
  check("is checked out", !("error" in fromRemote), fromRemote)
  check(
    "tracking the remote's, not cut fresh off HEAD",
    (await git(clone, "rev-parse", "--abbrev-ref", "develop@{u}")).trim() ===
      "origin/develop" && (await exists(path.join(tracked, "develop.ts")))
  )

  section("what the dialog is offered")

  const offered = await worktreeOptions(repo)
  check(
    "local branches, and no remote ones in that list",
    offered.branches.includes("develop") &&
      offered.branches.includes("main") &&
      offered.remotes.length === 0,
    // Not the order: every commit here lands in one second, and git's sort
    // on a tie is not this test's to pin.
    offered.branches
  )
  check(
    "the main checkout's branch",
    offered.current === "main",
    offered.current
  )
  check(
    "a clone's remotes, without origin/HEAD",
    (await worktreeOptions(clone)).remotes.includes("origin/develop") &&
      !(await worktreeOptions(clone)).remotes.some((r) => r.endsWith("/HEAD"))
  )
  check("no lock file, no setup", offered.setup === null)
  check(
    "a lock file names its installer",
    setupCommandFor(["src", "bun.lock", "package.json"]) === "bun install" &&
      setupCommandFor(["pnpm-lock.yaml"]) === "pnpm install" &&
      setupCommandFor(["README.md"]) === null
  )
  check(
    "two lock files take the first listed",
    setupCommandFor(["package-lock.json", "bun.lock"]) === "bun install"
  )

  section("ignored files a checkout is given")

  await writeFile(
    path.join(repo, ".gitignore"),
    "local.json\nsecret/\nbuild/\n"
  )
  await writeFile(
    path.join(repo, ".worktreeinclude"),
    "local.json\nsecret/\nnotes.md\n"
  )
  await writeFile(path.join(repo, "local.json"), "KEY=1\n")
  await mkdir(path.join(repo, "secret"), { recursive: true })
  await writeFile(path.join(repo, "secret", "a.json"), "{}\n")
  await mkdir(path.join(repo, "build"), { recursive: true })
  await writeFile(path.join(repo, "build", "out.js"), "1\n")
  // Listed, but not ignored: work in progress belongs where it was made.
  await writeFile(path.join(repo, "notes.md"), "draft\n")

  const given = worktreeDir(workspace, "f1", "given")
  await addWorktree({ repo, dir: given, branch: "given" })
  const copied = await copyIncluded(repo, given)
  check(
    "what is both listed and ignored is copied",
    (await readFile(path.join(given, "local.json"), "utf8")) === "KEY=1\n" &&
      (await exists(path.join(given, "secret", "a.json"))),
    copied
  )
  check(
    "what is ignored but not listed is not",
    !(await exists(path.join(given, "build")))
  )
  check(
    "what is listed but not ignored is not",
    !(await exists(path.join(given, "notes.md")))
  )
  check(
    "a repository without the file copies nothing",
    (await copyIncluded(clone, tracked)).length === 0
  )

  section("how far a checkout has moved")

  check("a project is no checkout", (await worktreeStatus(repo)) === null)

  const fresh = await worktreeStatus(based)
  check(
    "a fresh one is level with its base and clean",
    fresh?.base === "develop" &&
      fresh.ahead === 0 &&
      fresh.behind === 0 &&
      fresh.changed === 0 &&
      fresh.unique === 0,
    fresh
  )

  await writeFile(path.join(based, "work.ts"), "const w = 1\n")
  await git(based, "add", ".")
  await git(based, "commit", "-q", "-m", "work")
  await writeFile(path.join(based, "develop.ts"), "const d = 2\n")
  await writeFile(path.join(based, "loose.ts"), "\n")
  // And the base moves on without it.
  await git(repo, "checkout", "-q", "develop")
  await git(repo, "commit", "-q", "--allow-empty", "-m", "elsewhere")
  await git(repo, "checkout", "-q", "main")

  const moved = await worktreeStatus(based)
  check(
    "a commit is ahead and the base's is behind",
    moved?.ahead === 1 && moved.behind === 1,
    moved
  )
  check(
    "edits and untracked files are uncommitted",
    moved?.changed === 2,
    moved
  )
  check(
    "and the commit exists on this branch alone",
    moved?.unique === 1,
    "what `git branch -D` would lose"
  )

  await git(repo, "branch", "kept-copy", "off-develop")
  check(
    "a commit another branch has is not counted as unique",
    (await worktreeStatus(based))?.unique === 0
  )
  await git(repo, "branch", "-D", "kept-copy")

  section("saying it")

  const said = worktreeSummary({
    branch: "feature/sso",
    base: "main",
    changed: 3,
    ahead: 2,
    behind: 1,
    unique: 2,
  })
  check(
    "the row's tooltip names what moved",
    said === "feature/sso · 2 ahead, 1 behind main · 3 uncommitted",
    said
  )
  check(
    "and a level, clean one says so",
    worktreeSummary({
      branch: "x",
      base: "main",
      changed: 0,
      ahead: 0,
      behind: 0,
      unique: 0,
    }) === "x · up to date"
  )
  const level = {
    branch: "x",
    base: "main",
    changed: 0,
    ahead: 0,
    behind: 0,
    unique: 0,
  }
  check(
    "nothing to lose, nothing said",
    removalWarnings(level, true).length === 0
  )
  check(
    "unique commits are warned about only when the branch goes",
    removalWarnings({ ...level, unique: 1 }, true).length === 1 &&
      removalWarnings({ ...level, unique: 1 }, false).length === 0,
    removalWarnings({ ...level, unique: 1 }, true)
  )
  check(
    "uncommitted work is warned about either way",
    removalWarnings({ ...level, changed: 2 }, false)[0] ===
      "2 uncommitted changes will be deleted."
  )

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
