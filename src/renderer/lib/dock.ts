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
 * What it holds is shells, and one `Preview` tab: an ad-hoc terminal is most
 * of it, because the work an agent does happens in a project's chat, so a
 * shell is somewhere to run `git log` beside it. Its tabs are the shells
 * themselves (`lib/shell/store.ts`), and after them the page the dev server
 * in one of those shells is serving (`lib/preview.ts`). There was a `Run` tab
 * beside them — one command per folder, its output as a log — and it is gone
 * (`docs/design.md` § Run, removed); before that an `Assistant` tab, with the
 * workspace chat it opened.
 */

/**
 * Which of the dock's two faces is showing: the shells (one of them, by
 * `useShells.activeId`) or the preview. Held here rather than as a sentinel
 * in `activeId`, so the shell store's own invariants — the active id names a
 * shell or nothing — stay as they are, and `keep` moving onto a neighbour
 * cannot land on a tab that is not a shell.
 */
export type DockView = "shells" | "preview"

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
  view: DockView
  /** Opens the dock, on the face named — or on whichever it was showing. */
  show: (view?: DockView) => void
  close: () => void
  /** The chevron, the rail's Terminal button and `⌃\``. */
  toggle: () => void
}

export const useDock = create<DockState>((set, get) => ({
  open: false,
  view: "shells",

  show(view) {
    set(view ? { open: true, view } : { open: true })
  },

  close() {
    set({ open: false })
  },

  toggle() {
    set({ open: !get().open })
  },
}))
