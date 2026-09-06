import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * A `git worktree` per agent run, and nothing else.
 *
 * **This app deleted its worktree layer, deliberately** — `docs/design.md` §
 * Worktrees, removed. Reading that argument before adding this back is the
 * point of this paragraph, and the argument does not cover this: what was
 * rejected was a checkout **between a project and every chat in it**, whose
 * cost — a branch to name, a directory to remove afterwards — was paid on every
 * conversation while the isolation was wanted on almost none of them. A person
 * asking a question about the project they already have open should not have to
 * name a branch first.
 *
 * An agent starting work off a ClickUp task is the case that argument leaves
 * standing, and it inverts every term of it. Nobody names anything — the branch
 * is the task's id, which is the one name that is already unique and already
 * meaningful. Nobody is looking, so an agent editing the tree somebody is in
 * the middle of reading is the failure that has no undo. And the isolation is
 * not a nice-to-have: it is what makes it safe to press Run on a card at all,
 * because the result is a branch to read rather than a working tree that has
 * moved under you.
 *
 * So the layer is **not** back. There is no worktree in `ChatPlace`, no
 * `worktreeId` anywhere, nothing in the sidebar's model and no dialog. What a
 * run produces is an ordinary **workspace folder** pointed at the checkout, and
 * from there the Explorer, the Changes tab, the dock's shell and the chat
 * itself work with nothing taught about any of this — which is exactly the
 * shape the removal was in aid of.
 *
 * Free of `electron`, so `test/clickup-agents.ts` can import `branchFor` and
 * `worktreeSlug`.
 */

/** Where an agent's checkouts live: inside this app's own data directory, not
 * beside the repository. A sibling directory of somebody's project is a thing
 * their tooling will find — a watcher, a `find`, an editor's indexer — and this
 * app does not get to litter there. It is also where the deleted layer put
 * them, so a workspace that used both has one place to look. */
export const WORKTREES_DIR = "worktrees"

/**
 * A branch and directory name from a ClickUp task.
 *
 * The task **id** leads, because it is the only part that is unique and stable:
 * a name is renamed, and two tasks called "Fix login" are two branches called
 * `fix-login` and one collision. The name rides along, cut short, because a
 * branch list of bare ids is unreadable.
 *
 * Everything git refuses in a ref goes: a run of anything other than a letter,
 * a digit or a dash becomes one dash, leading and trailing dashes are cut, and
 * the whole is lowercased. Checked in `test/clickup-agents.ts` against the
 * shapes ClickUp task names actually take — Japanese, emoji, slashes, dots.
 */
export function worktreeSlug(text: string, max = 32): string {
  const slug = text
    .toLowerCase()
    // Not `\w`: that keeps `_`, which is legal in a ref but reads badly beside
    // dashes, and drops every non-ASCII letter — a task named entirely in
    // Japanese would slug to nothing at all, which is why the caller below
    // always has the id in front.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.slice(0, max).replace(/-+$/g, "")
}

/** `clickup/86eutavc5-add-sso-login`. The prefix is what makes these findable
 * and deletable as a group in a repository somebody else also works in. */
export function branchFor(taskId: string, taskName: string): string {
  const name = worktreeSlug(taskName)
  const id = worktreeSlug(taskId) || "task"
  return name ? `clickup/${id}-${name}` : `clickup/${id}`
}

/** Where one task's checkout goes, under this app's data directory. Keyed by
 * the **project** as well as the task, since one task can only ever be about
 * one repository but the same id could be watched again after a project is
 * removed and re-added. */
export function worktreeDir(
  workspaceDir: string,
  folderId: string,
  taskId: string
): string {
  return path.join(
    workspaceDir,
    WORKTREES_DIR,
    folderId,
    worktreeSlug(taskId) || "task"
  )
}

/**
 * Adds a checkout of `repo` at `dir`, on a new branch off the current HEAD.
 *
 * Answers with a sentence rather than throwing, the way `main/clickup.ts` does:
 * every one of these failures is a card in the pane that has to say why, and
 * "not a git repository" and "that branch exists" are both ordinary states of
 * somebody's afternoon rather than bugs.
 *
 * A branch that already exists is **reused** rather than an error — pressing
 * Run twice on the same task, or running it again a week later, should land in
 * the work that was started rather than refuse. That is what the second attempt
 * without `-b` is for.
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
    // Already on that branch, or a checkout of it is already there. Try again
    // without minting the branch, which is the "run it again next week" case.
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
 * The branch is the work — the whole reason the run happened — so deleting it
 * with the directory would throw away the thing somebody pressed Run for. What
 * this is for is the directory, and `--force` because an agent leaves a dirty
 * tree behind by definition and a refusal to clean up "because there are
 * changes" would strand every checkout this app ever made.
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

/** What git wrote on stderr, as one line. `execFile` rejects with an object
 * carrying it; the message alone is `Command failed`, which tells nobody
 * anything. */
function gitSaid(error: unknown): string {
  const said = (error as { stderr?: unknown } | null)?.stderr
  if (typeof said !== "string") return ""
  return said.trim().split("\n").at(-1)?.trim() ?? ""
}
