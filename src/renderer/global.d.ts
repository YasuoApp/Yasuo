import type { DesktopApi } from "@shared/api"

declare global {
  interface Window {
    /** Exposed by the Electron preload script; see apps/desktop/electron/preload.ts. */
    desktop: DesktopApi
    /**
     * Where Excalidraw looks for its own fonts. Set by the drawing editor
     * before the library loads — left unset it fetches them from
     * esm.sh, and this app ships them (see `vite.config.ts`).
     */
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}
