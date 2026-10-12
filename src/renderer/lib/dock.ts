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
 * The height of the dock's tab strip, in px — `studio.tsx` gives it to the
 * panel as its `collapsedSize`, so that closing the dock leaves the strip on
 * screen instead of taking it away.
 *
 * That is the whole of what stops the chevron being a one-way door. There used
 * to be a button at the right of the title bar for the way back, from when the
 * dock collapsed to nothing; a strip that is always there answers it where the
 * question is asked, and the button is gone.
 *
 * One number rather than a Tailwind `h-9` in the strip and a `36` here: they
 * have to agree or the dock closes to a sliver of its own tabs, and nothing
 * would catch the drift.
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
