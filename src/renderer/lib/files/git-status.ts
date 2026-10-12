import { create } from "zustand"

import type { GitFileState, GitStatusEntry } from "@shared/api"
import { useStudio } from "../store"
import { isInside } from "./paths"
import { fileRoots, rootOf, type FileRoot } from "./roots"

/**
 * What git says about the workspace's files, for the colours Explorer draws.
 *
 * Kept apart from the files store, which is the disk: that one answers "what is
 * in this directory" and holds the tabs, and this one answers "and what is that
 * file to git". A row reads both, and neither has to be re-read when the other
 * changes — an editor keystroke marks a tab dirty without touching this, and a
 * commit in the terminal repaints the tree without a `readdir`.
 *
 * One `git status` per **root**, which is the granularity git itself works at:
 * one per workspace folder (`lib/files/roots.ts`). It is asked for when the
 * roots change, when
 * Explorer's Refresh is pressed, and — debounced — whenever a watched directory
 * reports something, `.git` included: a commit made in the dock's shell is a
 * repaint of the whole tree, and nothing else would have told us about it.
 */

/**
 * How long a folder's status is left to settle before it is asked for.
 *
 * A `git status` is worth hundreds of milliseconds on a large repository, and
 * the events that trigger one arrive in bursts — a checkout, a build, an
 * `npm install` all rewrite many directories at once. One read at the end of
 * the burst is what somebody actually looks at.
 */
const SETTLE_MS = 400

/**
 * The colour each state is drawn in — the tree's rows, and the tabs above the
 * pane.
 *
 * These are the editors' own git colours rather than a set chosen here, and
 * deliberately: this is the one part of the studio somebody arrives at already
 * knowing, and a green that means "new" everywhere else must not mean something
 * else here. Hence the literal values instead of the palette's steps — Tailwind
 * has no step at this tan, and an `amber-400` beside it reads as a warning
 * rather than as an edit. Each is a light/dark pair for the same reason the
 * rest of the studio's colours are: the dark tan is illegible on white.
 *
 * Ignored is the exception and is deliberately not a hue: "this is not your
 * code" is said by receding, in the theme's own grey.
 */
export const GIT_TONES: Record<GitFileState, string> = {
  untracked: "text-[#007100] dark:text-[#73c991]",
  added: "text-[#007100] dark:text-[#73c991]",
  modified: "text-[#895503] dark:text-[#e2c08d]",
  deleted: "text-[#ad0707] dark:text-[#c74e39]",
  conflicted: "text-[#ad0707] dark:text-[#e4676b]",
  ignored: "text-muted-foreground/60",
}

/**
 * The letter at the end of a row — git's own, and the one every editor draws.
 *
 * Ignored has none on purpose. The letter is for a state somebody might act on,
 * and there are hundreds of ignored rows to one modified file: a column of `I`
 * down the whole of `node_modules` would be the loudest thing in the tree,
 * saying the least. Receding is the whole of what ignored has to say.
 */
export const GIT_LETTERS: Record<GitFileState, string | null> = {
  untracked: "U",
  added: "A",
  modified: "M",
  deleted: "D",
  conflicted: "C",
  ignored: null,
}

/** What the row's hover line says after the path, so the colours are readable
 * by somebody who has not learnt them — and by somebody who cannot see them. */
export const GIT_LABELS: Record<GitFileState, string> = {
  untracked: "new",
  added: "new",
  modified: "modified",
  deleted: "deleted",
  conflicted: "conflicted",
  ignored: "ignored",
}

/**
 * One root's answer, split by how it is looked up.
 *
 * `files` is the exact matches and is the common case — a `Record` because a
 * row asks about one path and there may be thousands. `dirs` are the entries
 * that stand for a subtree, and have to be tried as prefixes; there are a
 * handful of them (`node_modules/`, `dist/`, a new directory somebody just
 * made), which is what makes walking them per row affordable.
 */
type RootStatus = {
  files: Record<string, GitFileState>
  dirs: GitStatusEntry[]
}

type GitStatusState = {
  /** Keyed by `FileRoot.id`, which is the folder's id. */
  byRoot: Record<string, RootStatus>
  /** Reads one root now. */
  refresh: (root: FileRoot) => Promise<void>
  /** Reads every root now — the workspace loading, and Explorer's Refresh. */
  refreshAll: () => Promise<void>
  /** Reads one root once the changes stop arriving. */
  schedule: (rootId: string) => void
}

export const useGitStatus = create<GitStatusState>((set, get) => {
  /** A pending read per folder, so a burst of events is one `git status`. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  return {
    byRoot: {},

    async refresh(root) {
      const entries = await window.desktop
        .gitStatus(root.folderId)
        .catch(() => [] as GitStatusEntry[])

      // Dropped if the root left the workspace while this was in flight, the
      // same way the studio store drops a branch read against one.
      if (!fileRoots().some(({ id }) => id === root.id)) return

      const status: RootStatus = { files: {}, dirs: [] }
      for (const entry of entries) {
        if (entry.directory) status.dirs.push(entry)
        else status.files[entry.path] = entry.state
      }

      set((state) => ({ byRoot: { ...state.byRoot, [root.id]: status } }))
    },

    async refreshAll() {
      await Promise.all(fileRoots().map((root) => get().refresh(root)))
    },

    schedule(rootId) {
      const pending = timers.get(rootId)
      if (pending) clearTimeout(pending)
      timers.set(
        rootId,
        setTimeout(() => {
          timers.delete(rootId)
          const root = fileRoots().find((candidate) => candidate.id === rootId)
          if (root) void get().refresh(root)
        }, SETTLE_MS)
      )
    },
  }
})

/**
 * What git says about one path, or null for a path it says nothing about —
 * which is the ordinary case, a tracked file with no changes in it.
 *
 * The exact answer first, then the directories that stand for a subtree. The
 * longest of those wins, so a file explicitly reported inside a directory that
 * was reported wholesale is drawn as what it is.
 */
export function gitStateOf(
  state: GitStatusState,
  filePath: string
): GitFileState | null {
  for (const root of Object.values(state.byRoot)) {
    const exact = root.files[filePath]
    if (exact !== undefined) return exact

    let match: GitStatusEntry | null = null
    for (const dir of root.dirs) {
      if (!isInside(dir.path, filePath)) continue
      if (match === null || dir.path.length > match.path.length) match = dir
    }
    if (match) return match.state
  }
  return null
}

/**
 * Whether this file has uncommitted work in it — which is whether a diff of it
 * would say anything.
 *
 * `ignored` and a path git says nothing about are both "no", and for the same
 * reason: the committed side and the working side are the same text, so the two
 * columns would be one file drawn twice. Read by the pane header to decide
 * whether `Diff | Edit` is a question worth putting on screen; the tree's
 * right-click still offers `diff` for anything textual, on the argument in
 * `lib/files/viewers.ts` — a *menu* that changes with the working tree is one
 * nobody can learn, where a control over the pane is about what is on screen.
 */
export function hasGitChange(state: GitStatusState, filePath: string): boolean {
  const git = gitStateOf(state, filePath)
  return git !== null && git !== "ignored"
}

/** Which root a path belongs to, for the store that is keyed by one. */
export function rootIdOf(filePath: string): string | null {
  return rootOf(filePath)?.id ?? null
}

/**
 * A root arriving is what asks for its status, and one leaving is what forgets
 * it. This is also the launch read: `init` sets the folders once the manifest
 * is in.
 */
function follow() {
  const roots = fileRoots()
  const kept = new Set(roots.map((root) => root.id))
  const { byRoot } = useGitStatus.getState()

  if (Object.keys(byRoot).some((id) => !kept.has(id))) {
    useGitStatus.setState({
      byRoot: Object.fromEntries(
        Object.entries(byRoot).filter(([id]) => kept.has(id))
      ),
    })
  }

  for (const root of roots) {
    if (byRoot[root.id] === undefined)
      void useGitStatus.getState().refresh(root)
  }
}

useStudio.subscribe((studio, previous) => {
  if (studio.folders !== previous.folders) follow()
})
