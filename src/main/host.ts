/**
 * Everything `ipc.ts` needs from Electron itself — a native dialog, a window to
 * pin, a badge on the dock icon — and nothing that reads or writes the
 * workspace. `electron-ipc.ts` implements it.
 *
 * Free of `electron`, like the rest of what `ipc.ts` imports, so the tests can
 * import the handlers without it.
 */
export type Host = {
  /** A push event, to every window at once — see
   * `send` in `ipc.ts` for why it is everyone rather than the caller. */
  send: (channel: string, payload: unknown) => void

  /** A native folder picker — titled for adding a project unless told
   * otherwise. */
  pickDirectory: (options?: {
    title: string
    buttonLabel: string
  }) => Promise<string | null>
  /** A native file picker. Empty when cancelled. */
  pickFiles: (options: {
    title: string
    directory?: string
    /** One file rather than several. */
    single?: boolean
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<string[]>
  /** Asks where to put a text file and writes it; null when cancelled.
   * `caller` is whatever the transport identifies a window by. */
  saveTextFile: (
    caller: unknown,
    input: {
      defaultName: string
      text: string
      filters?: { name: string; extensions: string[] }[]
    }
  ) => Promise<string | null>
  /** The system clipboard's picture as PNG bytes, or null for none. */
  clipboardImage: () => Promise<Uint8Array | null>

  /** The OS trash rather than `unlink` — see `trashPath` in `ipc.ts`. */
  trash: (target: string) => Promise<void>
  /** Shows a path in the OS file manager. */
  reveal: (target: string) => Promise<void>
  /** Hands a path to the OS as a drag out of the calling window, so it can be
   * dropped into Finder, Slack, a mail — anywhere that takes a file. */
  startDrag: (caller: unknown, target: string) => Promise<void>

  /** Whether somebody is looking at one of this app's windows right now — the
   * check a notification is skipped on. */
  focused: () => boolean
  /** Rings an OS notification whose click leads back to `chatId`. */
  notify: (notice: { title: string; body: string; chatId: string }) => void

  openChatWindow: (chatId: string) => void
  setAlwaysOnTop: (caller: unknown, on: boolean) => void
  isAlwaysOnTop: (caller: unknown) => boolean

  /** The number on the app's own icon — the dock's red badge on macOS, the
   * launcher's count on Linux. Zero clears it. */
  setBadgeCount: (count: number) => void

  /** This build's version, for the update check. */
  version: string
  /** `install.sh`, or null where this host cannot run it — see
   * `installUpdate` in `ipc.ts`. */
  installerScript: string | null
  /** The built-in plugins this build carries, or null for none — see
   * `main/plugins.ts`. */
  bundledPluginsDir: string | null

  /** This app's own share of the machine, for `systemUsage`: every process
   * Chromium runs, added up. */
  appShare: (cores: number) => {
    appCpuPercent: number
    appCoreCpuPercent: number
    appMemory: number
    appProcesses: number
  }
}
