import { execFile } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import type {
  GitBlame,
  GitBlameCommit,
  GitChange,
  GitCommit,
  GitFileState,
  GitStatusEntry,
} from "../shared/api"

const run = promisify(execFile)

/**
 * What is left of the git integration: the branch name beside a folder, the
 * state of the files under it, and the three writes the Changes list makes.
 *
 * The panel that read a working tree — staging, commits, and the GitHub pull
 * requests beside them — was removed, and most of *that* is still not coming
 * back through here: nothing talks to a forge, and the history read is one
 * list of the checked-out branch's commits (`log`). What is answered is what a file **is** — which Explorer
 * colours its rows with, since a file nobody has committed reads differently
 * from one that has been edited, and a `node_modules` the same grey as `src` is
 * a tree that makes somebody read the names to find the code — and, for the
 * Changes list, which files those are and how far each has moved.
 *
 * **Staging came back, and committing did not.** The line between them is not
 * arbitrary: `stage`, `unstage` and `discard` are answers to "which of these
 * files do I keep", which is the question the Changes list exists to be read
 * for and is answered by pointing at rows. A commit is a sentence somebody
 * writes, with a shell already open in the same folder two panels down — and a
 * studio that stages but does not commit stops exactly where the shell is
 * better, rather than growing a second, worse git client.
 */
export async function currentBranch(dir: string): Promise<string | null> {
  try {
    const branch = (await git(dir, ["branch", "--show-current"])).trim()
    // Empty output means a detached HEAD rather than no branch at all.
    if (branch) return branch
    const sha = (await git(dir, ["rev-parse", "--short", "HEAD"])).trim()
    return sha ? `detached @ ${sha}` : null
  } catch {
    return null
  }
}

/**
 * How many entries are carried back before the rest are dropped.
 *
 * A ceiling rather than a promise, like the palette's index. It is here for the
 * repository somebody has just run a formatter over, or checked out a branch
 * across: the renderer holds this in a store and looks a path up in it per row,
 * and past a certain size the colours stop being information anyway.
 */
export const MAX_STATUS_ENTRIES = 5000

/**
 * A status entry with the path git itself used still on it.
 *
 * `path` is absolute and rooted at the folder, which is what the tree's rows
 * are addressed by; `relative` is the repository's own term for the same file,
 * which is what every other git command answers in. `changes` matches one
 * against the other, and the alternative — rebuilding the absolute path from a
 * second command's output — is how a repository reached through a symlink ends
 * up with two spellings of one file (`/tmp` on macOS is `/private/tmp`).
 */
export type StatusEntry = GitStatusEntry & {
  relative: string
  /**
   * Porcelain's own two columns, kept raw — the index against `HEAD`, and the
   * working tree against the index.
   *
   * `state` beside them is the two collapsed into one, which is what the tree
   * draws: a row there says "changed and not committed" and has no room to say
   * more. The Changes list is the one place the difference is the whole point,
   * so the letters travel with the entry rather than being read twice from two
   * parsers that could disagree.
   */
  x: string
  y: string
  /**
   * Where a rename came from, absolute, for the one caller that needs it.
   *
   * Porcelain reports a rename as the destination followed by the source, and
   * the source is not a row: no file is there any more. Discarding the
   * destination has to put it back, though — a rename half undone is a working
   * tree in a state nobody asked for — so it is carried here rather than
   * dropped.
   */
  from?: string
}

/**
 * Every path under `dir` git has something to say about — changed, new,
 * conflicted, or ignored.
 *
 * `--ignored` without a mode is `traditional`, and that is the point: paired
 * with the default untracked mode it reports a wholly ignored directory as one
 * entry — `node_modules/` — instead of the hundred thousand files under it. The
 * renderer treats a directory entry as a prefix, so one line greys the subtree.
 * A new directory arrives the same way (`?? build-output/`), which is also why
 * the tree can colour a folder without aggregating anything.
 *
 * Paths come back absolute, and rooted at `dir` rather than at the repository:
 * porcelain output is relative to the repository root, which is not necessarily
 * the folder — somebody can point the studio at `packages/web` of a monorepo —
 * and `rev-parse` answers with the *resolved* root, so a folder reached through
 * a symlink would otherwise come back under a prefix no row in the tree has.
 * Both are corrected here, where git's own answers are, rather than guessed at
 * in the renderer.
 *
 * A folder that is not a repository at all is not an error: it is the ordinary
 * case for a directory somebody keeps notes in, and it has no state to report.
 *
 * `expandUntracked` is `changes()`'s: a list of changes that says `?? src/new/`
 * hides the files somebody has to read, so there every new file is its own row.
 * It drops `--ignored` in the same breath — `traditional` paired with `all`
 * expands every ignored directory too, which is `node_modules` file by file.
 */
export async function workingTree(
  dir: string,
  { expandUntracked = false }: { expandUntracked?: boolean } = {}
): Promise<StatusEntry[]> {
  let root: string
  try {
    root = (await git(dir, ["rev-parse", "--show-toplevel"])).trim()
    if (!root) return []
  } catch {
    return []
  }

  // Where the folder sits inside the repository, in the repository's own terms.
  // `realpath` because that is what git answered with, and comparing a resolved
  // path to an unresolved one is how `/tmp` on macOS becomes "outside the repo".
  const inRepo = await realpath(dir)
    .then((resolved) => path.relative(root, resolved))
    .catch(() => "")

  let stdout: string
  try {
    stdout = await git(dir, [
      // Git's own flag for a program that reads status in the background, and
      // load-bearing here: a plain `git status` refreshes the index and writes
      // `.git/index` when it does, which is a directory this app watches —
      // status would report a change to itself, and the read would run again.
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      ...(expandUntracked
        ? ["--untracked-files=all"]
        : [
            "--ignored",
            // Explicit rather than inherited: `status.showUntrackedFiles=all`
            // in somebody's config would expand every ignored directory into
            // its files, which is the one output size this cannot afford.
            "--untracked-files=normal",
          ]),
    ])
  } catch {
    return []
  }

  // Back onto the path the tree actually holds: what is under the folder is
  // addressed from the folder, and anything else in the repository keeps the
  // repository's own path — it matches no row either way, and inventing one
  // for it would be worse than carrying it.
  const absolute = (relative: string) =>
    isUnder(inRepo, relative)
      ? path.join(dir, path.relative(inRepo, relative))
      : path.join(root, relative)

  return parseStatus(stdout).map((entry) => ({
    ...entry,
    path: absolute(entry.relative),
    ...(entry.from === undefined ? {} : { from: absolute(entry.from) }),
  }))
}

/** Whether a repo-relative path is inside a repo-relative directory. `""` is
 * the root, and holds everything. */
/**
 * How many untracked files are worth counting the lines of.
 *
 * An untracked file is not in any diff, so the only way to say `+N` for one is
 * to read it. That is cheap for the handful somebody has just written and not
 * cheap for a directory of generated output that is untracked rather than
 * ignored — so past this the rows say the letter and no number, which is what
 * they would say for a binary file anyway.
 */
const MAX_COUNTED_NEW_FILES = 200

/** And how large one of those may be. A minified bundle is one line and twelve
 * megabytes; reading it to print `+1` is the read that is not worth making. */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024

/**
 * What has changed in a checkout, with how far each file has moved.
 *
 * `workingTree` is the same `git status` read from the same place, and this is
 * deliberately built on it rather than beside it: which files are changed is one
 * question with one answer, and two readers of porcelain output disagreeing
 * about a conflict or a rename is the kind of bug nobody finds. What is added
 * here is the counts, and what is taken away is the ignored — a repository's
 * ignored files are not anybody's changes, and they are most of the entries.
 *
 * The counts come from `--numstat`, which covers everything git is already
 * tracking. An untracked file appears in no diff at all, so it is counted by
 * reading it, under the two caps above. A repository with no commit yet has no
 * `HEAD` to diff against: the files are still listed, with no numbers, which is
 * the honest answer rather than an empty panel.
 *
 * **One path can be two rows.** Porcelain's two columns are the index against
 * `HEAD` and the working tree against the index, and a file can have both —
 * `MM` is work that was staged and then edited again. The tree collapses them,
 * because a row there has nothing useful to say beyond "not committed"; this
 * list cannot, because staging is done from it. So a `MM` file is a staged row
 * and an unstaged row, each with the count of *its own* side: `--cached` for
 * the first, a plain `git diff` for the second. Summing the two would be the
 * number for neither, and taking `HEAD` for both would say the same number
 * twice.
 */
export async function changes(dir: string): Promise<GitChange[]> {
  const entries = (await workingTree(dir, { expandUntracked: true })).filter(
    (entry) => entry.state !== "ignored"
  )
  if (entries.length === 0) return []

  const [stagedCounts, unstagedCounts] = await Promise.all([
    numstat(dir, true),
    numstat(dir, false),
  ])

  // Newest work first would need a stat per row; alphabetical by path is what a
  // list of files in a repository is expected to be, and is stable while
  // somebody is reading it — a row that moves as it is clicked is worse than a
  // row in the wrong order.
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))

  let counted = 0
  const changed: GitChange[] = []
  for (const entry of sorted) {
    // The staged row first, so the two rows for one path arrive in the order
    // they are drawn in.
    for (const staged of sidesOf(entry)) {
      const numbers = (staged ? stagedCounts : unstagedCounts).get(
        entry.relative
      )
      const state = staged ? letterState(entry.x) : letterState(entry.y)

      if (numbers) {
        changed.push({
          path: entry.path,
          state,
          staged,
          directory: entry.directory,
          ...numbers,
        })
        continue
      }

      // Not in the diff: either untracked, or a repository with no `HEAD`.
      const newLines =
        !entry.directory &&
        state === "untracked" &&
        counted < MAX_COUNTED_NEW_FILES
          ? await countLines(entry.path)
          : null
      if (newLines !== null) counted += 1

      changed.push({
        path: entry.path,
        state,
        staged,
        directory: entry.directory,
        added: newLines,
        removed: newLines === null ? null : 0,
      })
    }
  }

  return changed
}

/**
 * Which rows one status entry is: `[true]`, `[false]`, or both.
 *
 * A conflict is the one entry that is neither. Its two letters are not an index
 * state and a working-tree state — `UU`, `AA`, `DU` say who touched what during
 * the merge — so splitting it into a "staged" half would be inventing a
 * distinction git is not making. It is one unstaged row, and `git add` on it
 * means what it means everywhere else: this is resolved.
 */
function sidesOf(entry: StatusEntry): boolean[] {
  if (entry.state === "conflicted") return [false]

  const sides: boolean[] = []
  // `!` never reaches here (ignored is filtered out) and `?` is the working
  // tree's own column, so anything else in the first column is staged work.
  if (entry.x !== " " && entry.x !== "?" && entry.x !== "!") sides.push(true)
  if (entry.y !== " " && entry.y !== "!") sides.push(false)
  // A rename with nothing since — `R ` — has no second column, and neither
  // has a plain `M `. Both are one staged row, which is what the loop above
  // already produced.
  return sides
}

/** One porcelain column as a state. The vocabulary is `stateOf`'s, so a staged
 * row and an unstaged one are drawn in the same colours as everywhere else. */
function letterState(letter: string): GitFileState {
  if (letter === "?") return "untracked"
  if (letter === "A") return "added"
  if (letter === "D") return "deleted"
  if (letter === "U") return "conflicted"
  // `M`, `R`, `C`, `T` — a retyped or renamed file is, to a list of changes, an
  // edited one.
  return "modified"
}

/**
 * `--numstat` for one side of the change, keyed by git's own path.
 *
 * `--cached` is the index against `HEAD` — what a staged row moved — and the
 * plain form is the working tree against the **index**, which is what an
 * unstaged row moved. Neither names `HEAD` as an argument, deliberately: a
 * repository with no commit has none to name, and `git diff --cached` there
 * still reports the staged files against the empty tree rather than failing.
 *
 * `--no-renames` on purpose: porcelain status reports a rename as one entry for
 * the new name, so a numstat that split it into `old => new` would key a count
 * under a path no row has and leave the row that exists with none.
 */
async function numstat(
  dir: string,
  cached: boolean
): Promise<Map<string, { added: number; removed: number }>> {
  const counts = new Map<string, { added: number; removed: number }>()

  let stdout: string
  try {
    stdout = await git(dir, [
      // For the reason in `workingTree`: this app watches `.git`, and a read
      // that writes the index would report a change to itself.
      "--no-optional-locks",
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      ...(cached ? ["--cached"] : []),
      "--",
    ])
  } catch {
    // No commits yet, or not a repository. Both mean no numbers.
    return counts
  }

  // `added\tremoved\tpath` per NUL-terminated record, with `-` for either
  // number when git will not count a binary file's lines.
  for (const record of stdout.split("\0")) {
    if (!record) continue
    const [added, removed, relative] = record.split("\t")
    if (added === undefined || removed === undefined || !relative) continue
    if (added === "-" || removed === "-") continue

    // Keyed by git's own path, which is what the status entries carry beside
    // their absolute one — see `StatusEntry`.
    counts.set(relative, {
      added: Number(added),
      removed: Number(removed),
    })
  }

  return counts
}

/**
 * The lines in a file somebody has just written, or null for one there is no
 * point counting.
 *
 * A trailing newline is not a line of its own, so `a\nb\n` is two — the same
 * count git would print for adding that file.
 */
async function countLines(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size > MAX_COUNTED_BYTES) return null

    const text = await readFile(filePath, "utf8")
    if (text === "") return 0
    // A NUL in the first stretch of a file is what every tool uses to decide it
    // is not text, and `+12000` for a PNG is worse than no number.
    if (text.slice(0, 8000).includes("\0")) return null

    const lines = text.split("\n")
    return lines.at(-1) === "" ? lines.length - 1 : lines.length
  } catch {
    return null
  }
}

/**
 * A file as `HEAD` has it, or null when `HEAD` does not have it.
 *
 * `git show` rather than reading anything: the point of a diff's left-hand side
 * is the committed content, which is in the object store and not on disk. The
 * path is turned into the repository's own terms first, since that is the only
 * form `HEAD:` takes.
 */
export async function fileAtHead(
  dir: string,
  filePath: string
): Promise<string | null> {
  const relative = await inRepository(dir, filePath)
  if (relative === null) return null

  try {
    return await git(dir, ["show", `HEAD:${relative}`])
  } catch {
    // Not in HEAD, which is what a file somebody has just written looks like.
    return null
  }
}

/**
 * The patch between `HEAD` and the working tree for one file, or null when
 * there is none to be had.
 *
 * This is the diff the pane actually draws, where `fileAtHead` is only its
 * left-hand side. The renderer used to compute the difference between the two
 * texts itself; it now reads the ranges off these `@@` headers instead, so that
 * what is on screen and the `+`/`-` counts beside the row come from one
 * algorithm rather than two that agree most of the time.
 *
 * **`--unified=0` because nothing here reads context.** With no context lines a
 * hunk header *is* the changed range, and the renderer turns each straight into
 * a pair of ranges rather than counting context back off it.
 *
 * **`HEAD` is named, unlike in `numstat`.** The left-hand side on screen is the
 * commit, so the patch has to span the index and the working tree at once or it
 * would describe a different pair than the one being drawn. A repository with
 * no commits has no `HEAD` to name and fails into null here — the same nothing
 * an untracked file gets, and the same thing both mean to a diff.
 *
 * `--no-textconv` because the renderer checks this patch against the two texts
 * it holds and drops it whole if it does not describe them: a patch of what
 * some `diff=` driver made of a file describes a pair nobody has.
 */
export async function fileDiff(
  dir: string,
  filePath: string
): Promise<string | null> {
  const relative = await inRepository(dir, filePath)
  if (relative === null) return null

  try {
    return await git(dir, [
      // For the reason in `workingTree`: this app watches `.git`, and a read
      // that writes the index would report a change to itself.
      "--no-optional-locks",
      "diff",
      "HEAD",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      // One path is being asked about, so a rename has nothing to pair it with
      // here — and `--find-renames` would answer about the other name.
      "--no-renames",
      "--",
      relative,
    ])
  } catch {
    // No commits yet, or not a repository.
    return null
  }
}

/**
 * Who last changed each line of a file, for the editor's line annotation and
 * its hover — or null for a file no blame can be had for: outside a
 * repository, never committed, or in a repository with no commit at all.
 *
 * **The editor's text, not the disk's** (`--contents -`, fed on stdin): the
 * answer is indexed by line, and a buffer with three unsaved lines typed above
 * the caret would otherwise be annotated three lines off. Lines nobody has
 * committed come back as git's all-zero hash, and are null here.
 *
 * A read, like `log`: this is the history of a line rather than a git client.
 * `webUrl` is the forge the history can be opened on, when `origin` is one this
 * knows how to address — see `webUrlOf`.
 */
export async function blame(
  dir: string,
  filePath: string,
  text: string
): Promise<GitBlame | null> {
  const relative = await inRepository(dir, filePath)
  if (relative === null) return null

  let out: string
  try {
    const pending = run(
      "git",
      ["blame", "--porcelain", "--contents", "-", "--", relative],
      { cwd: dir, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    )
    pending.child.stdin?.end(text)
    out = (await pending).stdout
  } catch {
    // Untracked, or no `HEAD` to blame against.
    return null
  }

  const remote = await git(dir, ["remote", "get-url", "origin"]).catch(() => "")
  return {
    ...parseBlame(out),
    path: relative.split(path.sep).join("/"),
    webUrl: webUrlOf(remote.trim()),
  }
}

const UNCOMMITTED = /^0{40}$/

/**
 * `git blame --porcelain`, read: a header per line — `<hash> <orig> <final>`,
 * with a fourth number when it starts a group — then, the first time a commit
 * is named, its `key value` lines, then the line itself behind a tab.
 *
 * Exported for `test/git-blame.ts`.
 */
export function parseBlame(out: string): Omit<GitBlame, "webUrl" | "path"> {
  const lines: (string | null)[] = []
  const commits: Record<string, GitBlameCommit> = {}
  let current: { hash: string; final: number } | null = null
  let fields: Record<string, string> = {}

  for (const row of out.split("\n")) {
    if (row.startsWith("\t")) {
      if (!current) continue
      const { hash, final } = current
      if (!UNCOMMITTED.test(hash) && !commits[hash]) {
        const time = Number(fields["author-time"])
        commits[hash] = {
          hash,
          author: fields.author ?? "",
          email: (fields["author-mail"] ?? "").replace(/^<|>$/g, ""),
          date: Number.isFinite(time)
            ? new Date(time * 1000).toISOString()
            : "",
          summary: fields.summary ?? "",
        }
      }
      lines[final - 1] = UNCOMMITTED.test(hash) ? null : hash
      current = null
      continue
    }

    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row)
    if (header) {
      current = { hash: header[1]!, final: Number(header[2]) }
      // A commit's fields are printed once, on its first line; a later line of
      // the same commit has a bare header and keeps what was read then.
      if (!commits[header[1]!]) fields = {}
      continue
    }

    const space = row.indexOf(" ")
    if (space > 0) fields[row.slice(0, space)] = row.slice(space + 1)
  }

  // A buffer git was handed may end without a newline, and a line it never
  // reached is not a line anybody committed.
  return { lines: Array.from(lines, (hash) => hash ?? null), commits }
}

/**
 * Where a repository's commits can be opened in a browser: GitHub, GitLab and
 * Bitbucket all answer `<base>/commit/<hash>`, so one base is the whole
 * address. Null for anything else — a self-hosted remote under another name, a
 * path on disk — rather than a guess at a URL that is a 404.
 *
 * **An SSH host alias is the forge it names.** Somebody with two GitHub
 * accounts reaches them as `github.com-personal` and `github.com-work` through
 * `~/.ssh/config`, and the first cut of this read that as an unknown host —
 * so the hover's links were missing on exactly the machines that juggle the
 * most repositories. A suffix after `-` is the alias's and is dropped; a forge's
 * own domain with anything else on it (`gitlab.example.com`) is still not
 * the forge.
 *
 * Exported for `test/git-blame.ts`.
 */
export function webUrlOf(remote: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)(github|gitlab|bitbucket)(?:\.(?:com|org))?(?:-[\w.-]+)?(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(
      remote
    )
  if (!match) return null
  const host = match[1] === "bitbucket" ? "bitbucket.org" : `${match[1]}.com`
  return `https://${host}/${match[2]}`
}

/**
 * A file in the repository's own terms, or null for one no git command could
 * name.
 *
 * Both halves of a diff need this and neither can use the absolute path a row
 * carries: `HEAD:` takes a path from the repository root, and so does the
 * `-- <path>` a `git diff` is narrowed with.
 *
 * Turned around the same way `workingTree` turns git's answers back, and
 * through `dir` rather than through the file: a **deleted** file has no
 * `realpath` to resolve, and it is exactly the file whose committed side
 * somebody wants to see. Resolving one path and not the other is what made
 * `/tmp` on macOS answer with `../../private/tmp/…`.
 */
async function inRepository(
  dir: string,
  filePath: string
): Promise<string | null> {
  let root: string
  try {
    root = (await git(dir, ["rev-parse", "--show-toplevel"])).trim()
    if (!root) return null
  } catch {
    return null
  }

  const inRepo = await realpath(dir)
    .then((resolved) => path.relative(root, resolved))
    .catch(() => "")
  const relative = path.join(inRepo, path.relative(dir, filePath))

  // Outside the repository the folder is in — nothing git could name.
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return null

  // Forward slashes always: `HEAD:src\main.ts` is not a path git knows, even on
  // Windows.
  return relative.split(path.sep).join("/")
}

/**
 * The three writes: staging, unstaging, and throwing work away.
 *
 * The studio deliberately had none of these — the panel that staged and
 * committed was removed, and the tree still collapses the index and the working
 * tree into one state because a row there has nothing more to say. What brought
 * them back is the Changes list: it is what somebody reads after an agent has
 * run a turn, and "keep this file, throw that one away" is the sentence being
 * said at that moment. `commit` below is the fourth now, and the note on it
 * says what moved and what did not.
 *
 * Every path is a **pathspec relative to `dir`**, not to the repository root.
 * Git resolves a pathspec against its own cwd, and `dir` is the cwd of every
 * call in this file — so this is the one form that needs no `rev-parse`, and
 * the one that cannot be thrown off by a folder reached through a symlink,
 * which is what `/private/var` on macOS makes of `/var`.
 *
 * Anything not under `dir` is refused rather than adjusted. These write to
 * somebody's working tree, and `ipc.ts` has already checked the path against
 * the workspace's roots; a second, narrower check here is what keeps a bug in
 * the caller from becoming a `git restore` in the wrong repository.
 */
export async function stage(dir: string, paths: string[]): Promise<void> {
  const specs = pathspecs(dir, paths)
  if (specs.length === 0) return

  // `--all` so a deletion is staged as one. Plain `git add` does that too on
  // any git this decade, but the flag is what says so.
  await git(dir, ["add", "--all", "--", ...specs])
}

export async function unstage(dir: string, paths: string[]): Promise<void> {
  const specs = pathspecs(dir, paths)
  if (specs.length === 0) return

  try {
    await git(dir, ["restore", "--staged", "--", ...specs])
  } catch {
    // A repository with no commit has no `HEAD` for the index to be restored
    // from, and everything in that index is an addition — so dropping it from
    // the index is the whole of unstaging there. `--cached` leaves the file on
    // disk, which is the difference between unstaging and deleting.
    await git(dir, ["rm", "--cached", "-r", "--quiet", "--", ...specs])
  }
}

/**
 * Throws away the uncommitted work in each path, and answers with the ones the
 * caller has to put in the trash.
 *
 * **Back to `HEAD`, both sides.** Not "the working tree back to the index":
 * that is a second, similar thing to explain — and a `Discard` that left a
 * staged copy of what it just discarded would be the answer nobody expects.
 * Whichever of a file's two rows is clicked, the file ends up as `HEAD` has it.
 *
 * A file `HEAD` does not have cannot be restored from it — a new file, staged
 * or not, and the destination of a rename. There, discarding is taking it out
 * of the index and then deleting it, and **this function does not delete it**:
 * it returns it. Deleting is `shell.trashItem` in `ipc.ts` — the studio has no
 * undo and every desktop has a trash (the same rule the Explorer's Delete
 * follows) — and `electron` must not be imported here, or this module stops
 * being loadable by the tests under plain Bun.
 */
export async function discard(dir: string, paths: string[]): Promise<string[]> {
  const wanted = new Set(pathspecs(dir, paths).map((spec) => spec))
  if (wanted.size === 0) return []

  const tree = (await workingTree(dir)).filter(
    (entry) => entry.state !== "ignored"
  )
  const entries = tree.filter((entry) => wanted.has(specOf(dir, entry.path)))

  const restore: string[] = []
  const drop: string[] = []
  const trash: string[] = []

  for (const entry of entries) {
    // The old name of a rename is always restored, whatever becomes of the new
    // one: it is committed work that is currently missing from the tree.
    if (entry.from) restore.push(specOf(dir, entry.from))

    if (entry.x === "?") {
      trash.push(entry.path)
      continue
    }

    if (await inHead(dir, specOf(dir, entry.path))) {
      restore.push(specOf(dir, entry.path))
      continue
    }

    // Staged, but nothing in `HEAD` to go back to: a new file that was added,
    // or where a rename landed.
    drop.push(specOf(dir, entry.path))
    trash.push(entry.path)
  }

  // A file inside a wholly untracked directory: the Changes list draws it as
  // its own row (`expandUntracked`), where this status says only `?? assets/`,
  // so nothing above matched it. It is untracked either way — the trash.
  const untrackedDirs = tree.filter(
    (entry) => entry.x === "?" && entry.directory
  )
  for (const target of paths) {
    if (trash.includes(target)) continue
    const inNew = untrackedDirs.some((entry) => {
      const relative = path.relative(entry.path, target)
      return (
        relative !== "" &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      )
    })
    if (inNew && wanted.has(specOf(dir, target))) trash.push(target)
  }

  // The index first: a path that is dropped and then restored would be
  // restored from an index it is no longer in.
  if (drop.length > 0)
    await git(dir, ["rm", "--cached", "-r", "--quiet", "--", ...drop])
  if (restore.length > 0)
    await git(dir, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ...restore,
    ])

  return trash
}

/**
 * The same, for everything the Changes list is showing.
 *
 * Built on `discard` rather than on `git reset --hard`, which would be one
 * command and the wrong one twice over: it leaves untracked files exactly where
 * they are — the ones an agent's turn most often adds — and it deletes the
 * tracked ones outright, past the trash.
 */
export async function discardAll(dir: string): Promise<string[]> {
  const entries = (await workingTree(dir)).filter(
    (entry) => entry.state !== "ignored"
  )
  if (entries.length === 0) return []

  return discard(
    dir,
    entries.map((entry) => entry.path)
  )
}

/**
 * What is staged, as a patch and as the summary of one.
 *
 * For the commit message Claude drafts (`draftCommitMessage` in
 * `one-turn-agent.ts`), which needs to be told what it is describing and has no
 * shell to ask git itself: a read-only tool list has no `git`. Both halves, because a large staged change is a patch nothing
 * will read whole and a `--stat` still says what the commit is: the caller
 * picks, and asking git twice here is cheaper than a second round trip for the
 * fallback.
 *
 * `-M` so a rename reads as a rename rather than as a whole file deleted and
 * another added, which is a commit message describing work nobody did.
 */
export async function stagedDiff(
  dir: string
): Promise<{ stat: string; patch: string }> {
  const [stat, patch] = await Promise.all([
    git(dir, ["diff", "--cached", "-M", "--stat"]),
    git(dir, ["diff", "--cached", "-M"]),
  ])
  return { stat, patch }
}

/**
 * The subjects of the last few commits, newest first.
 *
 * What a drafted message is shown so it writes in **this repository's** voice —
 * `feat(chat): …` where that is the convention and a bare sentence where it is
 * not. A model told only the diff writes whatever its training leans toward,
 * which is a message that has to be rewritten to be committed, which is a draft
 * nobody presses twice.
 *
 * A repository with no commits has no log and answers with none, rather than
 * failing: the first commit is exactly the one somebody has no convention to
 * follow yet.
 */
export async function recentSubjects(
  dir: string,
  limit: number
): Promise<string[]> {
  try {
    const log = await git(dir, ["log", `-n${limit}`, "--pretty=%s"])
    return log
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Fields and records are split on ASCII unit/record separators, which no
 * subject, name or ref can contain — a tab or a newline in a subject cannot. */
const UNIT = "\x1f"
const RECORD = "\x1e"

/**
 * `limit` commits of the branch that is checked out, newest first, after
 * skipping the newest `skip` — a page of the Explorer's `Commits` tab.
 *
 * **Read-only, and a list rather than a client.** It is the one place this
 * module reads history at all, and it reads only what the row draws — no
 * graph, no other branches, no diff of a commit. `docs/design.md` § Commits has
 * why a log was let in when amend, branch and push still are not.
 *
 * Empty for a folder that is not a repository and for one with no commit yet,
 * which `git log` reports as an error: both are "nothing to list".
 */
export async function log(
  dir: string,
  limit: number,
  skip = 0
): Promise<GitCommit[]> {
  let out: string
  try {
    out = await git(dir, [
      "log",
      `-n${limit}`,
      `--skip=${skip}`,
      // `%D`: the refs pointing at the commit, so the row can say which is
      // `HEAD` and where `origin` is without a second call.
      `--pretty=format:%H${UNIT}%h${UNIT}%s${UNIT}%an${UNIT}%aI${UNIT}%D${RECORD}`,
    ])
  } catch {
    return []
  }

  return out
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, subject, author, date, refs] = record.split(UNIT)
      return {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        subject: subject ?? "",
        author: author ?? "",
        date: date ?? "",
        refs: (refs ?? "")
          .split(", ")
          .map((ref) => ref.trim())
          .filter(Boolean),
      }
    })
}

/**
 * Commits what is staged, and answers with the commit.
 *
 * **This is the line moving, and it is worth saying where it now sits.** The
 * rule was that staging and discarding are answered by pointing at rows while a
 * commit is a sentence somebody writes, so the shell one click away in the dock
 * was the better place for it. What changed is that the sentence can now be
 * drafted from the staged diff by the read-only `claude` this app already runs
 * (`draftCommitMessage`), so the gesture is no longer "write a paragraph in a
 * panel with no room for one" — it is reading a diff, then ending that reading.
 * `docs/design.md` § Committing carries the whole argument.
 *
 * What is still refused is everything after it: no amend, no branch, no push.
 * This app is not becoming a second and worse git client — it finishes the one
 * gesture it already had somebody in the middle of. (A read-only list of
 * commits came later, `log` above; it writes nothing.)
 *
 * The message goes as an **argument**, never through a shell, so a backtick or
 * a `$(…)` in it is text. Hooks run: a repository that refuses a commit at
 * `pre-commit` has said something the studio has no business overriding, and its
 * output comes back as the error.
 */
export async function commit(
  dir: string,
  message: string
): Promise<{ sha: string; subject: string }> {
  const body = message.trim()
  // Guarded here as well as in the pane: git would open an editor on an empty
  // `-m`, and an editor with no terminal to draw in is a call that never
  // returns.
  if (!body) throw new Error("A commit needs a message.")

  await git(dir, ["commit", "-m", body])

  const sha = (await git(dir, ["rev-parse", "--short", "HEAD"])).trim()
  return { sha, subject: body.split("\n")[0] ?? "" }
}

/** Whether `HEAD` has this path — the question that decides whether discarding
 * it is a restore or a deletion. False for a repository with no commits, where
 * nothing is in `HEAD` at all. */
async function inHead(dir: string, spec: string): Promise<boolean> {
  try {
    const found = await git(dir, [
      "ls-tree",
      "-z",
      "--name-only",
      "HEAD",
      "--",
      spec,
    ])
    return found.replace(/\0/g, "").trim() !== ""
  } catch {
    return false
  }
}

/** Each path as a pathspec relative to `dir`, with anything outside it
 * refused — see the note above. */
function pathspecs(dir: string, paths: string[]): string[] {
  return paths
    .filter((target) => target === dir || isInsideDir(dir, target))
    .map((target) => specOf(dir, target))
}

function specOf(dir: string, target: string): string {
  const relative = path.relative(dir, target)
  // The folder itself, which is how "everything here" is spelt to git.
  return relative === "" ? "." : relative
}

function isInsideDir(dir: string, target: string): boolean {
  const relative = path.relative(dir, target)
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  )
}

function isUnder(dir: string, target: string): boolean {
  if (dir === "") return true
  return target === dir || target.startsWith(dir + "/")
}

/**
 * Porcelain v1 into entries.
 *
 * Apart from the transport so it can be read — and tested — as what it is: a
 * parser of a format with two shapes in it. Records are NUL-terminated (so
 * nothing is quoted or escaped, which is the whole reason for `-z`), and a
 * rename or a copy is two records, the destination and then the source. The
 * source is dropped: it is where the file *was*, and no row in the tree stands
 * for it.
 *
 * Paths stay as git wrote them — relative to the repository root, with forward
 * slashes — and are made absolute by the caller, which is the one that knows
 * where the folder sits in the repository.
 */
export function parseStatus(stdout: string): ParsedEntry[] {
  const records = stdout.split("\0")
  const entries: ParsedEntry[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    // The trailing empty string after the last NUL, and nothing shorter than
    // `XY ` can be a record.
    if (record === undefined || record.length < 4) continue

    const x = record[0]!
    const y = record[1]!
    const target = record.slice(3)

    // The record after a rename or a copy is where it came from, and is not a
    // record of its own — stepping over it here is what keeps it from being
    // read as a status of `R ` or a path of its own. It is kept beside the
    // destination, for a discard that has to put the old name back.
    let from: string | undefined
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      index += 1
      from = records[index] || undefined
    }

    if (entries.length >= MAX_STATUS_ENTRIES) break

    // Git ends a directory with a separator when the whole of it is untracked
    // or ignored; the renderer reads that as "and everything under it".
    const directory = target.endsWith("/")
    const relative = directory ? target.slice(0, -1) : target

    entries.push({
      relative,
      state: stateOf(x, y),
      directory,
      x,
      y,
      ...(from === undefined ? {} : { from }),
    })
  }

  return entries
}

/** What `parseStatus` answers with: an entry before the caller has made its
 * paths absolute. */
type ParsedEntry = Omit<StatusEntry, "path" | "from"> & { from?: string }

/**
 * The two status letters as one thing to draw.
 *
 * The index and the working tree are collapsed deliberately. This is a tree of
 * files and not a staging area — there is no way to stage anything in the
 * studio — so "changed, and not committed" is the whole of what a row can
 * usefully say. Conflicts are kept apart because they are the one state where
 * the file on disk is not something anybody wrote.
 */
function stateOf(x: string, y: string): GitFileState {
  if (x === "?") return "untracked"
  if (x === "!") return "ignored"
  // Both sides having an opinion, or either being `U`, is what a conflict looks
  // like in porcelain v1 — `DD`, `AU`, `UU`, and so on.
  if (
    x === "U" ||
    y === "U" ||
    (x === "A" && y === "A") ||
    (x === "D" && y === "D")
  ) {
    return "conflicted"
  }
  // The working tree first: a file staged as modified and then deleted on disk
  // is, to somebody looking at the tree, gone.
  if (y === "D" || x === "D") return "deleted"
  if (x === "A") return "added"
  return "modified"
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd: dir,
    windowsHide: true,
    // The default 1 MB is a few thousand paths, which `--ignored` can reach in
    // a repository with enough build output — and an overrun is an exception
    // rather than a truncated read.
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}
