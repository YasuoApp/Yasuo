import { create } from "zustand"

/**
 * The strip under the pane, and whether it is open.
 *
 * Conductor's right side is a file list over a `Setup / Run / Terminal` strip,
 * and that lower strip is the shape being copied here: a dock for the things
 * that are *about* what is on screen rather than things that were opened. It
 * sits under the pane rather than under the Explorer, which is where Conductor
 * puts it — see The dock in `docs/design.md`.
 *
 * What it holds is shells: the work an agent does happens in a project's
 * chat, so a shell is somewhere to run `git log` beside it. Its tabs are the
 * shells themselves (`lib/shell/store.ts`). There was a `Preview` tab after
 * them — the page a shell's dev server was serving — and it is gone
 * (`docs/design.md` § Preview, removed); before it a `Run` tab (§ Run,
 * removed) and an `Assistant` tab, with the workspace chat it opened.
 */

/**
 * The height of the dock's tab strip, in px.
 *
 * It was the panel's `collapsedSize` too, so that closing the dock left the
 * strip on screen as the way back. The dock collapses to nothing now: the
 * `NavRail`'s Terminal button and `⌃\`` are the way back, and are on screen
 * whatever the dock is doing.
 */
export const DOCK_STRIP_HEIGHT = 36

type DockState = {
  open: boolean
  show: () => void
  close: () => void
  /** The chevron, the rail's Terminal button and `⌃\``. */
  toggle: () => void
}

export const useDock = create<DockState>((set, get) => ({
  open: false,

  show() {
    set({ open: true })
  },

  close() {
    set({ open: false })
  },

  toggle() {
    set({ open: !get().open })
  },
}))
