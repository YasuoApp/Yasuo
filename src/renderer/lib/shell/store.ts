import { create } from "zustand"

import { useDock } from "../dock"
import { nameOf } from "../files/paths"
import { useStudio } from "../store"

/**
 * One shell in the dock: a pty, in a project's directory, and one of the
 * dock's tabs.
 *
 * **Any number per project.** It was one shell per place, identified by the
 * place, so that clicking a project pointed the dock at *its* shell — but a dev
 * server left running in a shell is a shell nobody can type `git log` into, and
 * the answer was a second dock tab. Clicking a project still follows it: the
 * dock switches to one of that project's shells, or starts one. A pty's cwd is
 * fixed when it starts, so following can only mean another pty and not a `cd`
 * sent into the first — which would land in whatever is half-typed at the
 * prompt and do nothing while a command is running.
 *
 * Not remembered across a launch. A shell here is ad-hoc — something opened
 * beside the work for one command — and replaying five of them on every launch
 * would be a surprise rather than a convenience. The ptys are killed on quit
 * either way.
 */
export type Shell = {
  id: string
  /** An **id**, never a path: main resolves the directory from its own
   * record. */
  folderId: string
  /** Bumped to remount the pane, which is what starting a shell over is. */
  attempt: number
  exited: boolean
  /** The directory the shell is in now, as main last read it — what its tab
   * is named after. Null until it has been asked. */
  cwd: string | null
}

type ShellState = {
  shells: Shell[]
  /** The tab the dock is showing, or null when there is none. */
  activeId: string | null
  /**
   * The project last clicked: where the dock looks when it is shown, and where
   * the `+` opens a shell.
   *
   * Recorded rather than acted on, because acting on it would mean spawning a
   * process. A pty started because a row in a list was clicked, running unread
   * behind a collapsed dock, is exactly the kind of thing that has to be asked
   * for. Showing the dock is the asking; see `ensure`.
   */
  target: string | null

  /** Points the dock at a project. Switches to one of its shells when it has
   * one, and otherwise only records where the next one goes. */
  showFor: (folderId: string) => void
  /**
   * Makes sure the dock is showing a shell in the target project, starting one
   * there if it has none.
   *
   * Called by the panel while it is on screen, which is what keeps a pty from
   * being started for a dock nobody opened. With nothing clicked yet it falls
   * back to the first folder rather than to a picker: a tab that opens onto a
   * question is a tab that has to be answered before it is any use.
   */
  ensure: () => void
  /** The `+`: another shell, in the target project, beside the ones open. */
  add: () => void
  select: (id: string) => void
  /** Ends the shell's pty and drops its tab. The last one closing shuts the
   * dock, as an editor's panel does — a dock left open onto nothing would start
   * a shell the moment anything nudged it. */
  close: (id: string) => void
  /** Starts a shell's pty over, in the same place. */
  restart: (id: string) => void
  setExited: (id: string, exited: boolean) => void
  setCwd: (id: string, cwd: string) => void
}

/**
 * What each tab is called: the directory its shell is in now — so a `cd`
 * renames it, as a terminal app's own tab does — or its project's name before
 * that is known. Numbered from the second tab of the same name on, so two tabs
 * are never one word.
 */
export function shellLabels(
  shells: Shell[],
  projectOf: (folderId: string) => string
): Map<string, string> {
  const seen = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const shell of shells) {
    const name = shell.cwd ? dirName(shell.cwd) : projectOf(shell.folderId)
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    labels.set(shell.id, count === 1 ? name : `${name} ${count}`)
  }
  return labels
}

/** The last segment of a directory, with `/` itself left as `/`. */
function dirName(cwd: string): string {
  return nameOf(cwd.replace(/[\\/]+$/, "")) || cwd
}

export const useShells = create<ShellState>((set, get) => {
  /** Keeps only the shells `alive` accepts, and moves the dock onto a
   * neighbour when the one it was showing went. The pty is not killed here: the
   * pane unmounts with the shell and its own teardown is what ends it. */
  function keep(alive: (shell: Shell) => boolean) {
    const before = get().shells
    const shells = before.filter(alive)
    if (shells.length === before.length) return

    const { activeId } = get()
    let next = activeId
    if (!shells.some((shell) => shell.id === activeId)) {
      // The tab to its left, as a browser does, or the new first one.
      const at = before.findIndex((shell) => shell.id === activeId)
      const left = before
        .slice(0, Math.max(at, 0))
        .reverse()
        .find((shell) => shells.includes(shell))
      next = (left ?? shells[0])?.id ?? null
    }
    set({ shells, activeId: next })
  }

  /** Where a shell opens with no project said: the one last clicked, the one
   * on screen, the first. */
  function place(): string | null {
    const { target, shells, activeId } = get()
    return (
      target ??
      shells.find((shell) => shell.id === activeId)?.folderId ??
      useStudio.getState().folders[0]?.id ??
      null
    )
  }

  function start(folderId: string) {
    const shell: Shell = {
      id: crypto.randomUUID(),
      folderId,
      attempt: 0,
      exited: false,
      cwd: null,
    }
    set({ shells: [...get().shells, shell], activeId: shell.id })
  }

  // A folder dropped from the workspace takes its shells with it: they run in a
  // directory the studio no longer points at.
  useStudio.subscribe((studio) => {
    const kept = new Set(studio.folders.map((folder) => folder.id))
    keep((shell) => kept.has(shell.folderId))
    const target = get().target
    if (target && !kept.has(target)) set({ target: null })
  })

  return {
    shells: [],
    activeId: null,
    target: null,

    showFor(folderId) {
      const { shells, activeId } = get()
      const showing = shells.find((shell) => shell.id === activeId)
      // Already on one of its shells: stay on the one somebody picked.
      if (showing?.folderId === folderId) {
        set({ target: folderId })
        return
      }
      const own = shells.find((shell) => shell.folderId === folderId)
      set({ target: folderId, activeId: own?.id ?? activeId })
    },

    ensure() {
      const folderId = place()
      if (!folderId) return

      const { shells, activeId } = get()
      if (shells.find((shell) => shell.id === activeId)?.folderId === folderId)
        return

      const own = shells.find((shell) => shell.folderId === folderId)
      if (own) set({ activeId: own.id })
      else start(folderId)
    },

    add() {
      const folderId = place()
      if (!folderId) return
      start(folderId)
      useDock.getState().show("shells")
    },

    select(id) {
      set({ activeId: id })
      // A shell's tab clicked while the preview is up means the shell: the
      // dock has two faces, and the id alone only says which shell.
      useDock.getState().show("shells")
    },

    close(id) {
      keep((shell) => shell.id !== id)
      if (get().shells.length === 0) useDock.getState().close()
    },

    restart(id) {
      set({
        shells: get().shells.map((shell) =>
          shell.id === id
            ? { ...shell, attempt: shell.attempt + 1, exited: false }
            : shell
        ),
        activeId: id,
      })
    },

    setCwd(id, cwd) {
      const shell = get().shells.find((candidate) => candidate.id === id)
      if (!shell || shell.cwd === cwd) return
      set({
        shells: get().shells.map((candidate) =>
          candidate.id === id ? { ...candidate, cwd } : candidate
        ),
      })
    },

    setExited(id, exited) {
      set({
        shells: get().shells.map((shell) =>
          shell.id === id ? { ...shell, exited } : shell
        ),
      })
    },
  }
})
