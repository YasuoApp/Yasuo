import { useEffect, useState } from "react"

import type { GitCommit } from "@shared/api"
import { useGitStatus } from "@/lib/files/git-status"
import type { FileRoot } from "@/lib/files/roots"
import { cn } from "@/lib/utils"
import { since } from "@/lib/worktree-chat/since"

/** How many commits the list starts with, and how many each `Show more` adds. */
const PAGE = 20
/** What one `git:log` call is allowed to answer with — `MAX_LOG_PAGE` in
 * `main/ipc.ts`. A list paged past it is re-read in several calls. */
const MAX_CALL = 1000

/**
 * The first `count` commits, and whether there is one past them.
 *
 * One more than asked for, which is how the list knows whether to offer
 * `Show more` without a count of the whole history — a `rev-list --count` on a
 * large repository is the full walk this is paging to avoid.
 */
async function readCommits(
  folderId: string,
  count: number
): Promise<{ commits: GitCommit[]; more: boolean }> {
  const wanted = count + 1
  const commits: GitCommit[] = []
  while (commits.length < wanted) {
    const limit = Math.min(MAX_CALL, wanted - commits.length)
    const page = await window.desktop.gitLog(folderId, limit, commits.length)
    commits.push(...page)
    if (page.length < limit) break
  }
  return { commits: commits.slice(0, count), more: commits.length > count }
}

/**
 * The `Git` tab's `Commits` view: the branch the project has checked out,
 * newest first, `PAGE` at a time.
 *
 * A list to read and nothing more — no graph, no other branches, nothing to
 * click into. The question it answers is the one asked after a turn or a
 * commit: what has this branch had done to it lately, and is that commit there.
 *
 * Re-read off the git status rather than on a timer of its own: a commit, a
 * pull or a checkout all move the working tree's status, which is already
 * watched (`useGitStatus`), so the list follows them without a second set of
 * watchers over the same events. **The re-read covers everything shown**, not
 * the first page: a list somebody has paged to sixty would otherwise snap back
 * to twenty under them every time a turn committed.
 */
export function CommitsList({ root }: { root: FileRoot }) {
  const [read, setRead] = useState<{
    folderId: string
    /** How many were asked for, so a read still answering the last page is
     * told apart from one answering this one — see `loading`. */
    count: number
    commits: GitCommit[]
    more: boolean
  } | null>(null)
  /** How many are asked for — per folder, read back the way `read` is, so
   * another project's list opens at the first page. */
  const [paged, setPaged] = useState<{ folderId: string; count: number }>({
    folderId: root.folderId,
    count: PAGE,
  })
  const count = paged.folderId === root.folderId ? paged.count : PAGE
  const status = useGitStatus((state) => state.byRoot[root.id])
  useEffect(() => {
    let current = true
    void readCommits(root.folderId, count)
      .catch(() => ({ commits: [], more: false }))
      .then((answer) => {
        if (current) setRead({ folderId: root.folderId, count, ...answer })
      })
    return () => {
      current = false
    }
  }, [root.folderId, status, count])

  // Another project's list is not this one's, even for the frame before the
  // read lands: read back through the folder it was read for.
  const shown = read?.folderId === root.folderId ? read : undefined
  // A `Show more` whose page has not landed yet. The re-reads a commit causes
  // ask for the count already shown, so they never read as loading.
  const loading = shown !== undefined && shown.count !== count

  if (shown === undefined) return <Note>Reading…</Note>
  if (shown.commits.length === 0) {
    return (
      <Note>No commits here — not a repository, or nothing committed yet.</Note>
    )
  }

  return (
    <>
      <ul className="py-1">
        {shown.commits.map((commit) => (
          <li
            key={commit.hash}
            title={`${commit.subject}\n\n${commit.hash}\n${commit.author} — ${new Date(commit.date).toLocaleString()}`}
            className="px-3 py-1.5 hover:bg-accent/50"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs">
                {commit.subject}
              </span>
              {commit.refs.map((ref) => (
                <Ref key={ref} name={ref} />
              ))}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-[0.65rem] text-muted-foreground">
              {/* Amber, the colour `git log` itself gives a hash — the one
                  thing on the row somebody copies, so it should be the one
                  they find without reading the line. */}
              <span className="shrink-0 rounded bg-amber-500/10 px-1 font-mono font-medium text-amber-600 dark:text-amber-400">
                {commit.shortHash}
              </span>
              <span className="min-w-0 truncate">{commit.author}</span>
              <span className="ml-auto shrink-0 tabular-nums">
                {since(commit.date)}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {/* Only while there is something past the last row — the extra commit
          `readCommits` asked for is what says so — so the list ends on its
          first commit with nothing under it. */}
      {shown.more && (
        <button
          type="button"
          disabled={loading}
          onClick={() =>
            setPaged({ folderId: root.folderId, count: count + PAGE })
          }
          className="mx-3 mt-1 flex h-7 w-[calc(100%-1.5rem)] items-center justify-center rounded-md text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-60"
        >
          {loading ? "Reading…" : `Show ${PAGE} more`}
        </button>
      )}
    </>
  )
}

/** One ref beside a subject. `HEAD -> main` is drawn as `main` in the
 * primary hue, since "where I am" is the one a reader is looking for. */
function Ref({ name }: { name: string }) {
  const head = name.startsWith("HEAD -> ")
  const label = head ? name.slice("HEAD -> ".length) : name

  return (
    <span
      className={cn(
        "max-w-24 shrink-0 truncate rounded px-1 font-mono text-[0.6rem]",
        head ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
      )}
    >
      {label}
    </span>
  )
}

function Note({ children }: { children: string }) {
  return <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>
}
