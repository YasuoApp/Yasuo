import { create } from "zustand"

/**
 * Whether the search palette is up.
 *
 * On a store rather than inside the component because `⌘P` is no longer the
 * only way in: the left column has a **Search** row, the way Conductor's does,
 * and a row that worked by dispatching a synthetic keydown would be a second,
 * lying implementation of the shortcut. The palette still owns the key itself —
 * this only holds the answer both of them set.
 */
type PaletteState = {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const usePalette = create<PaletteState>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
}))
