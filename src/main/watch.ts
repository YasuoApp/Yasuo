import { watch } from "node:fs"
import path from "node:path"

/**
 * The Explorer's watchers: one per directory the tree has open.
 *
 * The panel used to have none at all, and Refresh was the whole answer — the
 * thing being avoided was a watcher on the *workspace*, which on a repository
 * with a `node_modules` in it means thousands of handles and a tree rebuilt by
 * every `npm install`. Watching only what is expanded keeps that bargain: the
 * number of handles is the number of open rows, none of them recursive, and a
 * folder nobody has looked in costs nothing. Collapsing a folder closes its
 * watcher, which is why the renderer sends the whole set rather than a diff —
 * `expanded` is the set, and one message that replaces it cannot drift from
 * what is on screen the way an add/remove pair can.
 *
 * What is reported is a directory, not a change: `fs.watch` says different
 * things on every platform — a rename here is two events, one event, or an
 * event naming the wrong half — and the tree re-reads the directory anyway. So
 * the event carries the one thing every platform agrees on.
 *
 * This is deliberately not the reliable path. `fs.watch` misses writes on
 * network and virtualised filesystems, the same caveat `transcript.ts` polls
 * around; Refresh is still in the header for when it stays quiet.
 */

/**
 * Long enough that one save — which is a write, a rename and a truncate on some
 * editors — is read once, short enough that the row appears while the hand is
 * still on the mouse.
 */
const DEBOUNCE_MS = 120

export class DirectoryWatchers {
  /** Watched directory to what closes it — the watcher, and any debounce still
   * pending, which would otherwise report a directory nobody is watching. */
  private readonly watched = new Map<string, () => void>()

  constructor(private readonly emit: (dir: string) => void) {}

  /** Watches exactly these directories: whatever is new is opened, whatever is
   * no longer here is closed. */
  set(dirs: string[]): void {
    const wanted = new Set(dirs)
    for (const dir of [...this.watched.keys()]) {
      if (!wanted.has(dir)) this.close(dir)
    }
    for (const dir of wanted) this.open(dir)
  }

  closeAll(): void {
    for (const dir of [...this.watched.keys()]) this.close(dir)
  }

  private open(dir: string): void {
    if (this.watched.has(dir)) return

    try {
      let debounce: NodeJS.Timeout | null = null

      // `persistent: false`, like the transcript's: a watcher must not be the
      // reason the process has something left to do.
      const watcher = watch(dir, { persistent: false }, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          debounce = null
          this.emit(dir)
        }, DEBOUNCE_MS)
      })

      // A directory that goes while it is being watched — a branch switched
      // under it — surfaces as an error on some platforms and silence on
      // others. Closing is all there is to do either way; the tree keeps
      // drawing whatever it last read until something asks for it again.
      watcher.on("error", () => this.close(dir))

      this.watched.set(dir, () => {
        watcher.close()
        if (debounce) clearTimeout(debounce)
      })
    } catch {
      // Unreadable, or gone between the renderer expanding it and this. The
      // read behind the same row already failed and the tree says so there;
      // a second complaint from here would be about the same directory.
    }
  }

  private close(dir: string): void {
    this.watched.get(dir)?.()
    this.watched.delete(dir)
  }
}

/**
 * Whether a recursive watch is one handle rather than one per directory.
 *
 * FSEvents and `ReadDirectoryChangesW` watch a subtree natively; Linux's
 * `recursive` is Node walking the tree and opening an inotify watch on every
 * directory, `node_modules` included — exactly the cost `DirectoryWatchers` was
 * written to avoid. There the expanded folders and `.git` stay the whole answer.
 */
const NATIVE_RECURSIVE =
  process.platform === "darwin" || process.platform === "win32"

/** Paths carried per report. Past it the report says `overflow` instead: a
 * burst that size is an install or a checkout, and one re-read covers it. */
const MAX_REPORTED = 200

/** Longer than the tree's: nothing here is a row appearing under the mouse,
 * only a `git status` that the renderer debounces again. */
const ROOT_DEBOUNCE_MS = 250

/**
 * One recursive watcher per workspace folder, for the `Changes` list alone.
 *
 * `DirectoryWatchers` only sees what the tree has open, so a chat writing into
 * a collapsed folder changed what git says and told nobody — the list stayed
 * stale until Refresh. This reports **paths**, not directories, because the
 * renderer is the side holding git's ignored entries and drops anything under
 * them: a `dist/` rebuilt on every save must not be a `git status` on every save.
 *
 * `.git` is skipped: `DirectoryWatchers` already watches each root's own, and
 * `objects/` alone is hundreds of writes per commit.
 */
export class RootWatchers {
  private readonly watched = new Map<string, () => void>()

  constructor(
    private readonly emit: (
      root: string,
      paths: string[],
      overflow: boolean
    ) => void
  ) {}

  set(roots: string[]): void {
    if (!NATIVE_RECURSIVE) return
    const wanted = new Set(roots)
    for (const root of [...this.watched.keys()]) {
      if (!wanted.has(root)) this.close(root)
    }
    for (const root of wanted) this.open(root)
  }

  closeAll(): void {
    for (const root of [...this.watched.keys()]) this.close(root)
  }

  private open(root: string): void {
    if (this.watched.has(root)) return

    try {
      let debounce: NodeJS.Timeout | null = null
      const pending = new Set<string>()
      let overflow = false

      const watcher = watch(
        root,
        { persistent: false, recursive: true },
        (_event, name) => {
          const relative = name?.toString() ?? ""
          const top = relative.split(/[\\/]/)[0]
          if (top === ".git") return

          // No name is a platform saying "something, somewhere": the root
          // itself stands for it, which nothing ignores.
          const full = relative ? path.join(root, relative) : root
          if (pending.size < MAX_REPORTED) pending.add(full)
          else overflow = true

          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            debounce = null
            const paths = [...pending]
            const over = overflow
            pending.clear()
            overflow = false
            this.emit(root, paths, over)
          }, ROOT_DEBOUNCE_MS)
        }
      )

      watcher.on("error", () => this.close(root))

      this.watched.set(root, () => {
        watcher.close()
        if (debounce) clearTimeout(debounce)
      })
    } catch {
      // Gone or unreadable; the tree reports that folder on its own.
    }
  }

  private close(root: string): void {
    this.watched.get(root)?.()
    this.watched.delete(root)
  }
}
