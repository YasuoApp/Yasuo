import { createWebDesktop } from "./desktop"

/*
 * Imported first by `main.tsx`, before anything that reads `window.desktop` at
 * module load (`IS_MAC` in `title-bar.tsx` does): ES modules evaluate in import
 * order, so this has run by the time they do.
 *
 * Under Electron the preload has already put `desktop` on the window and this
 * does nothing; in a browser tab there is no preload, and this is it.
 */
// Typed as always present (`global.d.ts`), which is true everywhere but here.
if (!(window as Partial<Window>).desktop) {
  window.desktop = createWebDesktop()
}
