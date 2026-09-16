import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

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
 * running in it has a title of its own (`retitle` in `main/worktree-chat.ts`
 * reads the CLI's `ai-title`; `nameWorktree` below is what acts on it).
 *
 * The prefix is what makes "has anybody named this yet" a question git can
 * answer, so nothing has to be written down beside the folder — the same
 * bargain `worktreeRepo` makes. Being a `yasuo/` ref also means a branch this
 * app minted and the user then kept is obvious in their own `git branch`.
 */
const UNTITLED_PREFIX = "yasuo/untitled-"

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
  return branch !== null && branch.startsWith(UNTITLED_PREFIX)
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
 * `yasuo/untitled-…` for ever with nothing saying why. */
function withSuffix(name: string, untitled: string): string {
  const suffix = untitled.slice(UNTITLED_PREFIX.length)
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
 * Adds a checkout of `repo` at `dir`, on a new branch off the current HEAD.
 *
 * Answers with a sentence rather than throwing for the failures that are
 * ordinary — "not a git repository", "that branch is already checked out" — and
 * the caller turns it into the one the dialog shows. Every one of them is a
 * state of somebody's afternoon rather than a bug.
 *
 * A branch that already exists is **checked out** rather than an error: coming
 * back to work started last week is the same gesture as starting it, and a
 * refusal would leave somebody creating the worktree in a shell and adding the
 * folder by hand. That is what the second attempt without `-b` is for.
 */
export async function addWorktree(input: {
  repo: string
  dir: string
  branch: string
}): Promise<{ dir: string } | { error: string }> {
  const { repo, dir, branch } = input

  try {
    await run("git", ["rev-parse", "--git-dir"], {
      cwd: repo,
      windowsHide: true,
    })
  } catch {
    return { error: `${repo} is not a git repository.` }
  }

  try {
    await run("git", ["worktree", "add", "-b", branch, dir], {
      cwd: repo,
      windowsHide: true,
    })
    return { dir }
  } catch (first) {
    try {
      await run("git", ["worktree", "add", dir, branch], {
        cwd: repo,
        windowsHide: true,
      })
      return { dir }
    } catch (second) {
      return {
        error: gitSaid(second) || gitSaid(first) || "git worktree failed.",
      }
    }
  }
}

/**
 * Removes a checkout, and does **not** touch its branch.
 *
 * The branch is the work — the whole reason the checkout was made — so deleting
 * it with the directory would throw away the thing somebody asked for. `--force`
 * because a checkout somebody has been working in is dirty by definition, and a
 * refusal "because there are changes" would strand every directory this app
 * ever made under its own data folder. What that costs is stated in the dialog
 * that asks.
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

/** What git wrote on stderr, as one line. `execFile` rejects with an object
 * carrying it; the message alone is `Command failed`, which tells nobody
 * anything. */
function gitSaid(error: unknown): string {
  const said = (error as { stderr?: unknown } | null)?.stderr
  if (typeof said !== "string") return ""
  return said.trim().split("\n").at(-1)?.trim() ?? ""
}
