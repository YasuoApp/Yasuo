import { execFile, spawn } from "node:child_process"
import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import type { WorktreeOptions, WorktreeStatus } from "../shared/api"

const run = promisify(execFile)

/**
 * A second checkout of a project, added to the workspace as a project of its
 * own.
 *
 * **This app deleted its worktree layer, deliberately** — `docs/design.md` §
 * Worktrees, removed. Reading that argument before reading this is the point of
 * this paragraph, and it does not cover what is here: what was rejected was a
 * checkout **between a project and every chat in it**, whose cost — a branch to
 * name, a directory to remove afterwards — was paid on every conversation while
 * the isolation was wanted on almost none of them. Somebody asking a question
 * about the project they already have open should not have to name a branch
 * first.
 *
 * So the layer is **not** back. There is no worktree in `ChatPlace`, no
 * `worktreeId` anywhere, and nothing in the sidebar's model knows what a
 * checkout is. What `addWorktree` produces is an ordinary **workspace folder**
 * pointed at it, and from there the Explorer, the Changes tab, the dock's shell
 * and the chats work with nothing taught about any of this — which is exactly
 * the shape the removal was in aid of. What it buys is the thing that argument
 * granted was real: two agents working on one project without standing on each
 * other's files, index and branch, for the few times that is what is wanted.
 *
 * Free of `electron`, so `test/worktrees.ts` can import `worktreeSlug`,
 * `worktreeDir` and `mainWorktreeIn`.
 */

/** Where these checkouts live: inside this app's own data directory, not beside
 * the repository. A sibling directory of somebody's project is a thing their
 * tooling will find — a watcher, a `find`, an editor's indexer — and this app
 * does not get to litter there. It is also where the deleted layer put them, so
 * a workspace that used both has one place to look. */
export const WORKTREES_DIR = "worktrees"

/**
 * A directory name from a branch name.
 *
 * Branches carry slashes (`feature/sso`), which are directories rather than a
 * name, and everything else a filesystem would rather not be handed. A run of
 * anything that is not a letter, a digit or a dash becomes one dash, leading and
 * trailing dashes are cut, and the whole is lowercased.
 *
 * Not `\w`: that keeps `_`, which reads badly beside dashes, and drops every
 * non-ASCII letter — a branch named entirely in Japanese would slug to nothing,
 * which is what the caller's fallback is for.
 */
export function worktreeSlug(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.slice(0, max).replace(/-+$/g, "")
}

/**
 * The prefix on a branch nobody has named yet.
 *
 * A worktree cannot be created without one — the branch and the directory both
 * have to exist before any work happens in them, which is the whole way a
 * checkout differs from a chat, where the `+` writes nothing down until the
 * first message. So the branch is minted here and **replaced** once the chat
 * running in it has a title of its own (`retitle` in `main/chat.ts`
 * reads the CLI's `ai-title`; `nameWorktree` below is what acts on it).
 *
 * The prefix is what makes "has anybody named this yet" a question git can
 * answer, so nothing has to be written down beside the folder — the same
 * bargain `worktreeRepo` makes. Being a `vsclaude/` ref also means a branch this
 * app minted and the user then kept is obvious in their own `git branch`.
 */
const UNTITLED_PREFIX = "vsclaude/untitled-"

/** What the same branch was called while the app was Yasuo. Still read, so a
 * checkout minted before the rename is named by its first chat like any other. */
const LEGACY_UNTITLED_PREFIX = "yasuo/untitled-"

function untitledPrefixOf(branch: string): string | null {
  if (branch.startsWith(UNTITLED_PREFIX)) return UNTITLED_PREFIX
  if (branch.startsWith(LEGACY_UNTITLED_PREFIX)) return LEGACY_UNTITLED_PREFIX
  return null
}

/**
 * A branch name for a checkout nobody has named.
 *
 * Random rather than counted: two of these can be minted in the same second
 * from two projects, and a count would need a place to live.
 */
export function untitledBranch(): string {
  return `${UNTITLED_PREFIX}${Math.random().toString(16).slice(2, 8)}`
}

/** Whether a branch is one of the above — still waiting for a name. */
export function isUntitledBranch(branch: string | null): boolean {
  return branch !== null && untitledPrefixOf(branch) !== null
}

/**
 * The branch a chat's own title becomes, or null when there is nothing in it to
 * make a branch out of.
 *
 * The title is a sentence the CLI wrote about the first thing asked, so it goes
 * through the same slug a directory name does. Null for a title that slugs to
 * nothing — one written entirely in Japanese, say — where the placeholder is a
 * better name than the empty string.
 */
export function branchFromTitle(title: string): string | null {
  return worktreeSlug(title) || null
}

/** The same name with the untitled branch's own suffix on it, for the second
 * attempt — see `renameBranch`. Two runs at one task slug identically, and a
 * rename that gave up on the collision would leave a checkout called
 * `vsclaude/untitled-…` for ever with nothing saying why. */
function withSuffix(name: string, untitled: string): string {
  const suffix = untitled.slice((untitledPrefixOf(untitled) ?? "").length)
  return suffix ? `${name}-${suffix}` : name
}

/**
 * Renames the branch a checkout is on, and answers with the name it ended up
 * with.
 *
 * **The one write this app makes to a branch**, and it is narrow on purpose:
 * `main/git.ts` keeps branch, amend, log and push out on the ground that the
 * dock's shell is the git client. What is renamed here is a branch this app
 * minted itself minutes ago, which nobody has pushed and no other checkout can
 * be on, from a placeholder to what the conversation in it turned out to be
 * about. A branch the user named is never one of these — `isUntitledBranch` is
 * checked by the caller before this is reached.
 *
 * Null when git refused: the checkout keeps the placeholder, which is what it
 * had, and the user renames it in the shell if they care.
 */
export async function renameBranch(
  dir: string,
  from: string,
  to: string
): Promise<string | null> {
  for (const name of [to, withSuffix(to, from)]) {
    if (name === from) return from
    try {
      // `-m` without a source renames the branch **that is checked out here**,
      // which is the one this worktree holds. Naming both would rename it from
      // whichever worktree ran the command, and this one always is.
      await run("git", ["branch", "-m", name], { cwd: dir, windowsHide: true })
      return name
    } catch {
      // Taken, almost always: the second pass carries the placeholder's own
      // suffix and cannot collide with anything but itself.
    }
  }
  return null
}

/**
 * Where one project's checkout of a branch goes.
 *
 * Keyed by the **project** as well as the branch, since the same branch name in
 * two repositories is two checkouts — and since a folder id is unique, two
 * projects that happen to be clones of one repository cannot collide either.
 */
export function worktreeDir(
  workspaceDir: string,
  folderId: string,
  branch: string
): string {
  return path.join(
    workspaceDir,
    WORKTREES_DIR,
    folderId,
    worktreeSlug(branch) || "branch"
  )
}

/**
 * Adds a checkout of `repo` at `dir`, on a new branch off `base` or the
 * current HEAD.
 *
 * Answers with a sentence rather than throwing for the failures that are
 * ordinary — "not a git repository", "that branch is already checked out" — and
 * the caller turns it into the one the dialog shows. Every one of them is a
 * state of somebody's afternoon rather than a bug.
 *
 * A branch that already exists is **checked out** rather than an error: coming
 * back to work started last week is the same gesture as starting it, and a
 * refusal would leave somebody creating the worktree in a shell and adding the
 * folder by hand. That includes one that exists only on a remote — git's own
 * DWIM makes the local branch tracking it — which `-b` tried first would have
 * shadowed with a fresh branch off HEAD. `base` only ever applies to a branch
 * this call creates.
 *
 * `--no-track` beside a base: git would otherwise make `origin/main` the new
 * branch's upstream, and a `git push` from the checkout would then refuse
 * because the names differ. The base is recorded as `baseKey` instead, which
 * is what `worktreeStatus` counts ahead and behind against.
 */
export async function addWorktree(input: {
  repo: string
  dir: string
  branch: string
  base?: string
}): Promise<{ dir: string } | { error: string }> {
  const { repo, dir, branch } = input
  const base = input.base?.trim() || null

  try {
    await run("git", ["rev-parse", "--git-dir"], {
      cwd: repo,
      windowsHide: true,
    })
  } catch {
    return { error: `${repo} is not a git repository.` }
  }

  const [local, remotes] = await Promise.all([
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]),
    git(repo, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/remotes/*/${branch}`,
    ]),
  ])
  // Exactly one remote, as git's DWIM requires: two would be a guess.
  const existing = !!local || remotes.split("\n").filter(Boolean).length === 1

  if (existing) {
    try {
      await run("git", ["worktree", "add", dir, branch], {
        cwd: repo,
        windowsHide: true,
      })
      return { dir }
    } catch (error) {
      return { error: gitSaid(error) || "git worktree failed." }
    }
  }

  // What the branch is cut from, named — the main checkout's branch when the
  // field was left empty, since `HEAD` would mean nothing a week later.
  const from = base ?? (await git(repo, ["branch", "--show-current"]))

  try {
    await run(
      "git",
      base
        ? ["worktree", "add", "--no-track", "-b", branch, dir, base]
        : ["worktree", "add", "-b", branch, dir],
      { cwd: repo, windowsHide: true }
    )
  } catch (error) {
    return { error: gitSaid(error) || "git worktree failed." }
  }
  if (from) await git(repo, ["config", baseKey(branch), from])
  return { dir }
}

/**
 * Removes a checkout. Its branch is `deleteBranch`'s, below.
 *
 * `--force` because a checkout somebody has been working in is dirty by
 * definition, and a refusal "because there are changes" would strand every
 * directory this app ever made under its own data folder. What that costs is
 * stated in the dialog that asks.
 */
export async function removeWorktree(
  repo: string,
  dir: string
): Promise<{ error: string } | null> {
  try {
    await run("git", ["worktree", "remove", "--force", dir], {
      cwd: repo,
      windowsHide: true,
    })
    return null
  } catch (error) {
    return { error: gitSaid(error) || "git worktree remove failed." }
  }
}

/**
 * Deletes the branch a removed checkout was on — `-D`, since the work on it is
 * usually unmerged and removing the worktree is meant to take all of it.
 *
 * Best effort: the checkout is already gone by now, and a branch git will not
 * drop (checked out in another worktree, say) is left rather than turned into
 * an error about a removal that succeeded.
 */
export async function deleteBranch(repo: string, branch: string) {
  try {
    await run("git", ["branch", "-D", branch], { cwd: repo, windowsHide: true })
  } catch {
    // Kept — see above.
  }
}

/**
 * Which repository a folder is a `git worktree` checkout **of**, or null for an
 * ordinary folder.
 *
 * Asked of git rather than recorded on the folder, and that is the whole reason
 * this is cheap: the manifest holds a path and nothing else, a checkout made in
 * somebody's own shell is answered for exactly like one this app made, and a
 * folder whose checkout has since been removed says null rather than carrying a
 * flag that outlived what it described.
 *
 * `git worktree list` names the main worktree first, whichever of them it is run
 * in — that, against this folder's own top level, is the whole test. Compared
 * through `realpath` because a repository reached through a symlink is the
 * common case on macOS (`/tmp`, and anything under a home directory that has
 * moved), and two spellings of one directory would read as two worktrees.
 */
export async function worktreeRepo(dir: string): Promise<string | null> {
  try {
    const listed = await run("git", ["worktree", "list", "--porcelain"], {
      cwd: dir,
      windowsHide: true,
    })
    const main = mainWorktreeIn(listed.stdout)
    if (!main) return null

    // The folder itself may be a directory *inside* the repository rather than
    // its root, and every path git answers with is a root: comparing against
    // `dir` would call `repo/src` a checkout of `repo`.
    const top = (
      await run("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir,
        windowsHide: true,
      })
    ).stdout.trim()
    if (!top) return null

    return (await resolved(main)) === (await resolved(top)) ? null : main
  } catch {
    // Not a repository, or no git at all. Neither is a worktree.
    return null
  }
}

/**
 * The main worktree's path out of `git worktree list --porcelain`, or null.
 *
 * The porcelain format is one paragraph per checkout, each opening with a
 * `worktree <path>` line, and **the main one is always first** — which is what
 * makes this three lines rather than a parser. Split out and free of any
 * process so `test/worktrees.ts` can put git's own output through it.
 */
export function mainWorktreeIn(listed: string): string | null {
  for (const line of listed.split("\n")) {
    if (line.startsWith("worktree "))
      return line.slice("worktree ".length).trim()
  }
  return null
}

async function resolved(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * Where a checkout's base is written: `branch.<name>.vsclaudeBase` in the
 * repository's own config.
 *
 * Git's own place for what a branch is relative to, and the one place a fact
 * about a branch follows it: `git branch -m` moves the section — so a checkout
 * named after its first chat keeps its base — and `git branch -D` drops it.
 */
export function baseKey(branch: string): string {
  return `branch.${branch}.vsclaudeBase`
}

/**
 * The file listing which of a repository's **ignored** files a new checkout
 * gets a copy of — `.env`, a local config — in `.gitignore` syntax.
 *
 * The name Claude Code's own worktrees read, so a repository set up for one is
 * set up for the other. Only ignored files are taken: a tracked one is already
 * in the checkout, and an untracked one nobody ignored is work in progress
 * that belongs to the checkout it was made in.
 */
export const INCLUDE_FILE = ".worktreeinclude"

/**
 * Copies `INCLUDE_FILE`'s matches from the main checkout into `dir`, and
 * answers with the paths copied.
 *
 * Best effort and never an error: the checkout already exists by now, and a
 * missing `.env` is something the setup command or the user will say out loud.
 * A file already there is left alone.
 */
export async function copyIncluded(repo: string, dir: string) {
  const include = path.join(repo, INCLUDE_FILE)
  if (!(await exists(include))) return []

  let listed = ""
  try {
    // `-o -i` against the include file alone: every untracked file it matches,
    // ignored or not. Walks `node_modules` once — under a second here — which
    // is why it is only run for a repository that asked.
    listed = (
      await run(
        "git",
        ["ls-files", "-z", "-o", "-i", `--exclude-from=${include}`],
        { cwd: repo, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
      )
    ).stdout
  } catch {
    return []
  }
  const matched = listed.split("\0").filter(Boolean)
  if (matched.length === 0) return []

  const ignored = await checkIgnored(repo, matched)
  const copied: string[] = []
  for (const relative of ignored) {
    const target = path.join(dir, relative)
    if (await exists(target)) continue
    try {
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(path.join(repo, relative), target)
      copied.push(relative)
    } catch {
      // One unreadable file is not a reason to skip the rest.
    }
  }
  return copied
}

/** Which of `paths` git ignores, asked on stdin so a long list is not a long
 * command line. Exit 1 is git saying "none of them". */
function checkIgnored(repo: string, paths: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("git", ["check-ignore", "-z", "--stdin"], {
      cwd: repo,
      windowsHide: true,
    })
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
    child.on("error", () => resolve([]))
    child.on("close", () => resolve(out.split("\0").filter(Boolean)))
    child.stdin.end(paths.join("\0") + "\0")
  })
}

/**
 * The command a new checkout of a project probably wants run before anything
 * works in it, read off the lock file at its root — or null.
 *
 * A suggestion for the dialog's field and nothing more: it is shown, it can be
 * cleared, and it runs in a dock shell somebody can watch, never behind the
 * user's back. First match wins, so a repository carrying two lock files gets
 * the one listed first here.
 */
export function setupCommandFor(names: Iterable<string>): string | null {
  const present = new Set(names)
  for (const [file, command] of SETUP_COMMANDS)
    if (present.has(file)) return command
  return null
}

const SETUP_COMMANDS: [string, string][] = [
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["pnpm-lock.yaml", "pnpm install"],
  ["yarn.lock", "yarn install"],
  ["package-lock.json", "npm install"],
  ["uv.lock", "uv sync"],
  ["poetry.lock", "poetry install"],
  ["Gemfile.lock", "bundle install"],
  ["composer.lock", "composer install"],
]

/**
 * What the New worktree dialog offers: the branches there are, newest first, to
 * check out or to cut from; the branch the main checkout is on, which is what
 * an empty base means; a setup command; and whether `INCLUDE_FILE` exists.
 */
export async function worktreeOptions(repo: string): Promise<WorktreeOptions> {
  const [refs, current, names] = await Promise.all([
    git(repo, [
      "for-each-ref",
      "--sort=-committerdate",
      "--count=300",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ]),
    git(repo, ["branch", "--show-current"]),
    readdir(repo).catch(() => [] as string[]),
  ])
  const listed = refs.split("\n")
  const under = (prefix: string) =>
    listed
      // `origin/HEAD` is a pointer, not a branch anybody means.
      .filter((ref) => ref.startsWith(prefix) && !ref.endsWith("/HEAD"))
      .map((ref) => ref.slice(prefix.length))
  return {
    branches: under("refs/heads/"),
    remotes: under("refs/remotes/"),
    current: current || null,
    setup: setupCommandFor(names),
    includes: names.includes(INCLUDE_FILE),
  }
}

/**
 * How far a checkout has moved, or null for a folder that is not one: what is
 * uncommitted, how far ahead and behind its base, and how many commits exist
 * on its branch **alone** — the ones `git branch -D` would lose.
 *
 * The base is `BASE_KEY` when this app made the branch, and otherwise the main
 * checkout's branch, which is what a checkout made in a shell is normally cut
 * from. Ahead and behind are null when there is nothing to count against.
 */
export async function worktreeStatus(
  dir: string
): Promise<WorktreeStatus | null> {
  const repo = await worktreeRepo(dir)
  if (!repo) return null

  const branch = (await git(dir, ["branch", "--show-current"])) || null
  const [porcelain, recorded, mainBranch] = await Promise.all([
    git(dir, ["status", "--porcelain"]),
    branch ? git(dir, ["config", "--get", baseKey(branch)]) : "",
    git(repo, ["branch", "--show-current"]),
  ])
  const base = recorded || mainBranch || null

  let ahead: number | null = null
  let behind: number | null = null
  if (base && base !== branch) {
    const counts = await git(dir, [
      "rev-list",
      "--left-right",
      "--count",
      `${base}...HEAD`,
    ])
    const [left, right] = counts.split(/\s+/).map(Number)
    if (
      left !== undefined &&
      right !== undefined &&
      Number.isFinite(left) &&
      Number.isFinite(right)
    ) {
      behind = left
      ahead = right
    }
  }

  // Every other branch and every remote, so a commit already pushed or already
  // merged does not count as one this removal would take.
  const unique = Number(
    await git(dir, [
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      // Without `refs/heads/`: an exclude before `--branches` is matched
      // against the short name, and the full one silently excludes nothing.
      ...(branch ? [`--exclude=${branch}`] : []),
      "--branches",
      "--remotes",
    ])
  )

  return {
    branch,
    base,
    changed: porcelain.split("\n").filter(Boolean).length,
    ahead,
    behind,
    unique: Number.isFinite(unique) ? unique : 0,
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Stdout, trimmed, or the empty string for anything git refused — every read
 * here has an ordinary answer for "could not say". */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    return (await run("git", args, { cwd, windowsHide: true })).stdout.trim()
  } catch {
    return ""
  }
}

/** What git wrote on stderr, as one line. `execFile` rejects with an object
 * carrying it; the message alone is `Command failed`, which tells nobody
 * anything. */
function gitSaid(error: unknown): string {
  const said = (error as { stderr?: unknown } | null)?.stderr
  if (typeof said !== "string") return ""
  return said.trim().split("\n").at(-1)?.trim() ?? ""
}
