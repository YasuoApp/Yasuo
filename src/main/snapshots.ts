import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type { Snapshot, SnapshotDiff } from "../shared/api"

const run = promisify(execFile)

/**
 * The working tree, written down per turn — the timeline under a chat, and the
 * chain `chatBlame` reads a file's lines against.
 *
 * Every snapshot is a real git commit in the project's own object store, under
 * `refs/yasuo/snapshots/<folder>/<sha>`, and **never on a branch, never in the
 * user's index, never `HEAD`.** That is what makes it safe to take one on
 * every turn of every chat: `git status` in the dock's shell shows nothing
 * new, `git log` shows nothing new, and a `git gc` leaves the commits alone
 * because a ref points at each. The cost is a `git add -A` into a throwaway
 * index per snapshot, which hashes whatever changed since the last and is
 * cheap for the same reason `git status` is.
 *
 * **One chain per folder, across every chat, in time order.** A snapshot's
 * parent is the folder's previous snapshot whichever chat took it, because the
 * working tree is one thing — chat B's turn starts from where chat A's left
 * it, and a chain per chat would have each one's commits describing a tree the
 * other had already moved. The linear chain is also exactly what `git blame`
 * wants: walking it attributes every line to the one commit that introduced it,
 * which is the turn that wrote it.
 *
 * Free of `electron`, like `git.ts`, so `test/snapshots.ts` can drive it
 * against a real repository under plain Bun.
 */

/** Who the snapshot commits are by. Set on every call rather than read from
 * the repository's config, because a fresh clone with no `user.name` would
 * otherwise refuse `commit-tree` — and these commits are the app's, not the
 * user's, so signing them with the user's name would be wrong anyway. */
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "Yasuo",
  GIT_AUTHOR_EMAIL: "yasuo@local",
  GIT_COMMITTER_NAME: "Yasuo",
  GIT_COMMITTER_EMAIL: "yasuo@local",
}

/** Where a folder's chain lives. Per commit rather than one ref moved along
 * the chain, so a chain that is rewound — a restore followed by new turns —
 * still keeps every commit reachable. */
export function refOf(folderId: string, commit: string): string {
  return `refs/yasuo/snapshots/${slugOf(folderId)}/${commit}`
}

function slugOf(folderId: string): string {
  const slug = folderId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
  return slug || "folder"
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ["rev-parse", "--is-inside-work-tree"])
    return out.trim() === "true"
  } catch {
    return false
  }
}

/**
 * The repository's root, which every command below runs from.
 *
 * A workspace folder can be `packages/web` of a monorepo, and a snapshot of
 * only that subdirectory would be a tree git could not blame or check out
 * against the rest. So the whole repository is snapshotted, and paths in a
 * `SnapshotDiff` are the repository's own.
 */
async function rootOf(cwd: string): Promise<string> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim()
  if (!root) throw new Error(`Not a git repository: ${cwd}`)
  return root
}

/**
 * The working tree as a tree object, without touching the user's index.
 *
 * `GIT_INDEX_FILE` at a path that does not exist yet is an empty index to git,
 * and `git add -A` into it is every file the working tree has that is not
 * ignored — tracked or not, which is the point: a turn's new files are what a
 * snapshot is for, and `node_modules` is kept out by the same `.gitignore`
 * that keeps it out of the user's own commits. Nothing is copied from the real
 * index because its contents are the user's staging, which is not the working
 * tree.
 */
export async function writeTree(cwd: string): Promise<string> {
  const root = await rootOf(cwd)
  return withTempIndex(async (index) => {
    await git(root, ["add", "-A", "--", "."], index)
    return (await git(root, ["write-tree"], index)).trim()
  })
}

/**
 * The tree as a commit on the folder's chain, with a ref holding it.
 *
 * `commit-tree` rather than `commit`: it takes a tree and a parent and writes
 * nothing else — no `HEAD`, no branch, no reflog entry on anything the user
 * reads. The ref is what keeps `gc` from collecting it.
 */
export async function commitTree(
  cwd: string,
  tree: string,
  parent: string | null,
  message: string,
  folderId: string
): Promise<string> {
  const root = await rootOf(cwd)
  const commit = (
    await git(
      root,
      ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message],
      undefined,
      AUTHOR_ENV
    )
  ).trim()
  await git(root, ["update-ref", refOf(folderId, commit), commit])
  return commit
}

/**
 * What going from `fromTree` to `toTree` changes, per file.
 *
 * Two reads because git has two formats and neither says everything: numstat
 * has the counts and no letter, name-status the letter and no counts. Both run
 * with `-z` so a path with a tab or a newline in it is one record. `-` for a
 * count is a binary file, which is listed with zeros rather than dropped — it
 * still changes.
 */
export async function diffStat(
  cwd: string,
  fromTree: string,
  toTree: string
): Promise<SnapshotDiff> {
  const root = await rootOf(cwd)
  const [numstat, status] = await Promise.all([
    git(root, ["diff-tree", "-r", "-z", "--numstat", fromTree, toTree]),
    git(root, [
      "diff-tree",
      "-r",
      "-z",
      "--name-status",
      "--no-renames",
      fromTree,
      toTree,
    ]),
  ])

  const counts = new Map<string, { added: number; removed: number }>()
  for (const record of numstat.split("\0")) {
    if (!record) continue
    const [added, removed, file] = record.split("\t")
    if (!file) continue
    counts.set(file, {
      added: added === "-" ? 0 : Number(added),
      removed: removed === "-" ? 0 : Number(removed),
    })
  }

  const files: SnapshotDiff["files"] = []
  const parts = status.split("\0")
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const letter = parts[index]
    const file = parts[index + 1]
    if (!letter || !file) continue
    files.push({
      path: file,
      status:
        letter[0] === "A"
          ? "added"
          : letter[0] === "D"
            ? "deleted"
            : "modified",
      ...(counts.get(file) ?? { added: 0, removed: 0 }),
    })
  }

  return { files: files.sort((a, b) => a.path.localeCompare(b.path)) }
}

/**
 * Puts the working tree back to `targetTree`.
 *
 * Through a throwaway index again, so the user's index and `HEAD` are exactly
 * as they were — what was staged is still staged, and `git status` afterwards
 * reads the restored files against the same `HEAD` it did before. Only the
 * paths that differ are written, rather than `checkout-index -a` over the
 * whole tree: rewriting ten thousand unchanged files is ten thousand mtimes
 * moved, and every watcher in the app and the user's dev server would wake up
 * for it.
 *
 * Ignored files are in neither tree and so are never touched. A path git hands
 * back that would resolve outside the repository is refused rather than
 * deleted — git does not write such paths into trees, but this is the one
 * place in the app that deletes files without a trash, and it is checked.
 */
export async function restoreTree(
  cwd: string,
  targetTree: string
): Promise<void> {
  const root = await rootOf(cwd)
  const now = await writeTree(root)
  if (now === targetTree) return

  // `now → target`: `D` is a file the target lacks, `A` one it adds, `M` one
  // whose contents move.
  const out = await git(root, [
    "diff-tree",
    "-r",
    "-z",
    "--name-status",
    "--no-renames",
    now,
    targetTree,
  ])
  const remove: string[] = []
  const write: string[] = []
  const parts = out.split("\0")
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const letter = parts[index]
    const file = parts[index + 1]
    if (!letter || !file) continue
    if (!insideRoot(root, file)) continue
    if (letter[0] === "D") remove.push(file)
    else write.push(file)
  }

  await Promise.all(
    remove.map((file) => rm(path.join(root, file), { force: true }))
  )

  if (write.length === 0) return
  await withTempIndex(async (index) => {
    await git(root, ["read-tree", targetTree], index)
    await git(
      root,
      ["checkout-index", "-f", "-z", "--stdin"],
      index,
      undefined,
      write.join("\0") + "\0"
    )
  })
}

/**
 * Which commit of the chain each line of `text` was introduced by.
 *
 * `--contents -` blames the buffer handed over rather than the file on disk,
 * against `head` — the chain's last commit — rather than the branch's `HEAD`.
 * A line the buffer has that `head` does not is attributed to the all-zero
 * "not yet committed" sha, which reads as null: written since the last turn.
 * A file `head` has no version of at all makes git fail, and that is null for
 * every line — nothing in the chain wrote any of it.
 *
 * Porcelain is parsed for the header line alone: `<sha> <orig> <final>
 * [<count>]` opens each group and the tab-prefixed content line closes it, so
 * the line number is read off the header rather than counted.
 */
export async function blame(
  cwd: string,
  filePath: string,
  text: string,
  head: string
): Promise<(string | null)[]> {
  const lines = text.split("\n")
  // A trailing newline is not a line, the same count git prints.
  const count = lines.at(-1) === "" ? lines.length - 1 : lines.length
  const none: (string | null)[] = new Array<string | null>(count).fill(null)
  if (count === 0) return none

  const root = await rootOf(cwd)
  const relative = await inRepository(root, filePath)
  if (relative === null) return none

  let out: string
  try {
    out = await git(
      root,
      ["blame", "--porcelain", "--contents", "-", head, "--", relative],
      undefined,
      undefined,
      text
    )
  } catch {
    return none
  }

  const shas = [...none]
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line)
    if (!header) continue
    const sha = header[1]!
    const at = Number(header[2]) - 1
    if (at < 0 || at >= count) continue
    shas[at] = /^0+$/.test(sha) ? null : sha
  }
  return shas
}

/** A file in the repository's own terms — see `inRepository` in `git.ts`,
 * which this repeats rather than exports: that one resolves through a folder,
 * this one is already at the root. Null for a path outside it. */
async function inRepository(
  root: string,
  filePath: string
): Promise<string | null> {
  const resolvedRoot = await realpath(root).catch(() => root)
  // The directory rather than the file: a deleted file has no realpath, and
  // the buffer being blamed can be of a file that is not on disk any more.
  const dir = await realpath(path.dirname(filePath)).catch(() =>
    path.dirname(filePath)
  )
  const relative = path.relative(
    resolvedRoot,
    path.join(dir, path.basename(filePath))
  )
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return null
  return relative.split(path.sep).join("/")
}

function insideRoot(root: string, file: string): boolean {
  const relative = path.relative(root, path.resolve(root, file))
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  )
}

/** A fresh, empty index for one job, removed afterwards whatever happened. */
async function withTempIndex<T>(
  job: (indexFile: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "yasuo-index-"))
  try {
    return await job(path.join(dir, "index"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function git(
  cwd: string,
  args: string[],
  indexFile?: string,
  env?: Record<string, string>,
  stdin?: string
): Promise<string> {
  const child = run("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
      ...env,
    },
  })
  if (stdin !== undefined) {
    child.child.stdin?.end(stdin)
  }
  const { stdout } = await child
  return stdout
}

/*
 * The records, and the queue in front of them.
 */

/** What a snapshot is taken for — everything on the record that git does not
 * supply. */
export type SnapshotMeta = {
  chatId: string
  kind: Snapshot["kind"]
  turn: number
  prompt: string | null
  lineId: string | null
}

export type SnapshotSource = {
  /** One folder's records, oldest first; empty for a folder with none. */
  read: (folderId: string) => Promise<Snapshot[]>
  write: (folderId: string, snapshots: Snapshot[]) => Promise<void>
}

/** How much of a prompt a snapshot carries — enough for a hover, not the
 * message. */
export const PROMPT_EXCERPT = 200

/**
 * The folder's chains, with one writer per folder.
 *
 * A queue per folder rather than one for all, because two chats in two
 * projects have nothing to wait on each other for, while two in one project do:
 * each `take` reads the chain's tail to parent on, and two turns ending
 * together would otherwise both parent on the same commit and fork the chain
 * that blame needs linear.
 */
export class Snapshots {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly source: SnapshotSource,
    private readonly emit: (folderId: string) => void
  ) {}

  list(folderId: string): Promise<Snapshot[]> {
    return this.source.read(folderId)
  }

  /**
   * Writes the working tree down. Null for a folder that is not a repository,
   * which is the whole of how a non-git project opts out: nothing is written
   * and no timeline is drawn.
   */
  take(
    folderId: string,
    cwd: string,
    meta: SnapshotMeta
  ): Promise<Snapshot | null> {
    return this.enqueue(folderId, async () => {
      if (!(await isRepo(cwd))) return null
      const snapshot = await this.record(folderId, cwd, meta)
      this.emit(folderId)
      return snapshot
    })
  }

  /** Inside the queue: the chain's tail is read and written under one lock. */
  private async record(
    folderId: string,
    cwd: string,
    meta: SnapshotMeta
  ): Promise<Snapshot> {
    const snapshots = await this.source.read(folderId)
    const last = snapshots.at(-1) ?? null
    const tree = await writeTree(cwd)
    const id = await commitTree(
      cwd,
      tree,
      last?.id ?? null,
      `yasuo: ${meta.kind} turn ${meta.turn} (${meta.chatId})`,
      folderId
    )
    const snapshot: Snapshot = {
      id,
      folderId,
      chatId: meta.chatId,
      kind: meta.kind,
      turn: meta.turn,
      prompt: meta.prompt ? meta.prompt.slice(0, PROMPT_EXCERPT) : null,
      lineId: meta.lineId,
      tree,
      changed: last === null || last.tree !== tree,
      at: new Date().toISOString(),
    }
    await this.source.write(folderId, [...snapshots, snapshot])
    return snapshot
  }

  /** What restoring `snapshotId` would do to the working tree as it is now. */
  async diff(
    folderId: string,
    cwd: string,
    snapshotId: string
  ): Promise<SnapshotDiff> {
    const target = (await this.source.read(folderId)).find(
      (entry) => entry.id === snapshotId
    )
    if (!target) return { files: [] }
    const now = await writeTree(cwd)
    return diffStat(cwd, now, target.tree)
  }

  /**
   * The working tree back to a snapshot, with a `rewind` snapshot of where it
   * stood taken first and answered with — the undo. Null when the snapshot is
   * not on this folder's chain.
   */
  restore(
    folderId: string,
    cwd: string,
    snapshotId: string,
    meta: Omit<SnapshotMeta, "kind">
  ): Promise<Snapshot | null> {
    return this.enqueue(folderId, async () => {
      const target = (await this.source.read(folderId)).find(
        (entry) => entry.id === snapshotId
      )
      if (!target || !(await isRepo(cwd))) return null
      const rewind = await this.record(folderId, cwd, {
        ...meta,
        kind: "rewind",
      })
      try {
        await restoreTree(cwd, target.tree)
      } finally {
        this.emit(folderId)
      }
      return rewind
    })
  }

  /**
   * Which snapshot wrote each line, as ids into the folder's chain.
   *
   * Two shas read as null on purpose. The chain's root has no parent, so git
   * attributes every line older than the first snapshot to it — which says
   * nothing about who wrote them. And a `before` or `rewind` snapshot's own
   * additions are what changed between turns, which is work done by hand, or
   * by a restore: not a turn's.
   */
  async blame(
    folderId: string,
    cwd: string,
    filePath: string,
    text: string
  ): Promise<{ lines: (string | null)[]; snapshots: Snapshot[] } | null> {
    const chain = await this.source.read(folderId)
    const head = chain.at(-1)
    if (!head) return null

    const byId = new Map(chain.map((entry) => [entry.id, entry]))
    const root = chain[0]!.id
    const lines = (await blame(cwd, filePath, text, head.id)).map((sha) => {
      if (!sha || sha === root) return null
      const snapshot = byId.get(sha)
      return snapshot && snapshot.kind === "turn" ? sha : null
    })

    const named = new Set(lines.filter((sha): sha is string => sha !== null))
    return {
      lines,
      snapshots: chain.filter((entry) => named.has(entry.id)),
    }
  }

  private enqueue<T>(folderId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(folderId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(
      folderId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }
}
