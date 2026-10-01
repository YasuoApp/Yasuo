import path from "node:path"

import { BrowserWindow, app, shell } from "electron"

import { registerIpc } from "./ipc"
import { installMenu } from "./menu"
import {
  APP_ORIGIN,
  registerAppScheme,
  serveApp,
  serveNoteFiles,
} from "./protocol"

/** Set by scripts/dev.mjs; absent in a packaged app. */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/** Where `vite build` leaves the renderer, relative to `dist-electron/`. */
const RENDERER_DIST = path.join(__dirname, "..", "dist-renderer")

/**
 * The master icon electron-builder converts into the platform formats it needs
 * (`.icns`, `.ico`) when packaging. Only reachable in dev — `resources/` is not
 * in the packaged `files`, and a packaged app takes its icon from the bundle.
 */
const DEV_ICON = path.join(__dirname, "..", "resources", "icon.png")

/**
 * Packaging sets this from `build.productName`, but a dev run reads
 * `package.json` straight from disk, where the app is called `yasuo`. Naming
 * it here is what puts "Yasuo" in the macOS menu bar, the About panel and
 * the window title instead of Electron's own name. It has to happen before
 * `whenReady`: the default menu is built from `app.name`, and `userData` is
 * derived from it.
 */
app.setName("Yasuo")

/**
 * Where the studio itself lives — the one place navigation is allowed to go.
 *
 * Parsed rather than string-compared, and by scheme and host rather than by
 * `origin`: Node's URL parser reports `null` for the origin of any scheme it
 * does not know, so two unrelated `app://`-style URLs would compare equal.
 */
const HOME = new URL(DEV_SERVER_URL ?? APP_ORIGIN)

/**
 * The schemes worth handing to the OS.
 *
 * Not a blanket allow, because most of what can be clicked in this app was
 * written by a model or printed by a tool rather than typed by the user: a
 * `file:`, `smb:` or third-party-app URL reaching `shell.openExternal` asks the
 * OS to open something the user never chose. A web link and an email address
 * are what a link in a transcript is actually for.
 */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"])

/** The user's browser, for a URL that is safe to give it. */
function openExternal(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return
  void shell.openExternal(url)
}

function isHome(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === HOME.protocol && parsed.host === HOME.host
  } catch {
    return false
  }
}

let mainWindow: BrowserWindow | null = null

/** Where the renderer is. */
function rendererUrl(): string {
  return DEV_SERVER_URL ?? `${APP_ORIGIN}/index.html`
}

/**
 * The two ways a window can leave the studio, both handed to the browser.
 *
 * Shared by both windows rather than written twice: what a link in an agent's
 * answer or a docs link should do is the app's policy, not one window's.
 */
function keepInside(window: BrowserWindow): void {
  // The studio's previews and docs links belong in the user's browser, not in
  // a second app window with no chrome.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })

  /**
   * A link click, which is a different event from the `window.open` above.
   *
   * An `<a href>` with no `target` — which is every link the transcript's
   * markdown renderer produces, since ProseMirror's serializer emits a bare
   * anchor — is a *navigation*: left alone, the window itself leaves the studio
   * for that URL, and with no browser chrome and no history there is nothing to
   * come back with. The studio's own navigation is let through untouched (a
   * dev-server reload is one of these), and everything else is handed to the
   * browser, which is where a link in a chat log was always meant to open.
   */
  window.webContents.on("will-navigate", (details) => {
    if (isHome(details.url)) return
    details.preventDefault()
    openExternal(details.url)
  })
}

// Privileges have to be declared before the app is ready, so this runs at
// module scope rather than inside `whenReady`.
registerAppScheme()

const {
  terminals,
  worktreeChats,
  tsServers,
  watchers,
  tray,
  startTray,
  noteFilePath,
} = registerIpc(
  () => mainWindow,
  (chatId) => openChatWindow(chatId)
)

/** The window each popped-out chat is in, by chat id, so a second pop-out of
 * the same chat focuses the one it has rather than opening a twin. */
const chatWindows = new Map<string, BrowserWindow>()

/**
 * One chat in a window of its own.
 *
 * The same renderer, told which chat by `?chat=`, which `App` reads before it
 * draws anything. Smaller and narrower than the studio because it is meant for
 * the corner of another editor's screen; `alwaysOnTop` is the renderer's to set
 * through `setAlwaysOnTop`, from a button in the window's own bar.
 */
function openChatWindow(chatId: string): void {
  const existing = chatWindows.get(chatId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }

  const window = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 360,
    minHeight: 400,
    backgroundColor: "#111218",
    show: false,
    ...(DEV_SERVER_URL && process.platform !== "darwin"
      ? { icon: DEV_ICON }
      : {}),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 12 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  chatWindows.set(chatId, window)
  window.once("ready-to-show", () => window.show())
  window.on("closed", () => {
    if (chatWindows.get(chatId) === window) chatWindows.delete(chatId)
  })
  keepInside(window)

  const url = new URL(rendererUrl())
  url.searchParams.set("chat", chatId)
  void window.loadURL(url.toString())
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 600,
    // The studio defaults to its dark theme; matching it here keeps the first
    // paint from flashing white. `#111218` is the dark `--background` in
    // `styles/globals.css` — the one number in this file that has to follow it.
    backgroundColor: "#111218",
    show: false,
    // Windows and Linux draw the window/taskbar icon from here. macOS ignores
    // it — the dock is handled below — and a packaged build has the icon in
    // its own resources, so this is only worth setting while developing.
    ...(DEV_SERVER_URL && process.platform !== "darwin"
      ? { icon: DEV_ICON }
      : {}),
    // macOS only: drop the separate title bar and let the studio's own header
    // stand in for it, with the traffic lights inset into it (the header holds
    // nothing on that side, so there is nothing for them to overlap). Windows and
    // Linux keep their native frame, which is what their users expect.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          // Centres the lights in the header's 44px: 12px buttons, so 16px
          // above and below.
          trafficLightPosition: { x: 18, y: 16 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The dock's `Preview` tab is a `<webview>` of the project's dev server
      // (`dock-preview.tsx`): a separate renderer the studio can screenshot
      // into a chat, which an `<iframe>` of another origin cannot be.
      webviewTag: true,
    },
  })

  // Showing the window only once it has painted avoids a blank frame while the
  // studio's WASM payload loads.
  mainWindow.once("ready-to-show", () => mainWindow?.show())

  mainWindow.on("closed", () => {
    mainWindow = null
  })

  keepInside(mainWindow)

  // In dev, the renderer's own console — including an uncaught exception,
  // which Chromium logs as a `console.error` before the page goes blank —
  // is mirrored into this process' terminal. Packaged builds skip this:
  // nobody is watching that terminal, and it would just be noise.
  if (DEV_SERVER_URL) {
    mainWindow.webContents.on("console-message", (event) => {
      const { level, message, lineNumber, sourceId } = event
      const at = sourceId ? ` (${sourceId}:${lineNumber})` : ""
      console.log(`[renderer:${level}] ${message}${at}`)
    })

    // A crashed renderer shows the window's background color and nothing
    // else — the same "black screen" a JS exception can produce, but with a
    // different cause this app cannot recover from on its own.
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error("[renderer] process gone:", details.reason)
    })
  }

  void mainWindow.loadURL(rendererUrl())
}

void app.whenReady().then(() => {
  // In dev the app runs inside the stock Electron bundle, so the dock shows
  // Electron's atom until it is replaced at runtime. A packaged build already
  // has the right icon baked into its bundle.
  if (DEV_SERVER_URL && process.platform === "darwin") {
    app.dock?.setIcon(DEV_ICON)
  }

  if (!DEV_SERVER_URL) serveApp(RENDERER_DIST)
  // Both builds: a note's pictures are served the same way whether the renderer
  // came from Vite or from `app://`.
  serveNoteFiles(noteFilePath)
  // Before the window, so the menu bar is never Electron's default one.
  installMenu(() => mainWindow)
  createWindow()
  // After the window, and not awaited: the icon is a count of what the chats
  // are doing, and at this point they are not doing anything. A first paint
  // must not wait on a settings read.
  void startTray()

  app.on("activate", () => {
    // macOS: clicking the dock icon reopens the studio. The *studio* rather
    // than "any window", because a panel window can outlive it, and the dock
    // icon has to lead back to the app itself and not to a panel of it.
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

app.on("window-all-closed", () => {
  // macOS apps conventionally stay running with no windows; every other
  // platform quits.
  if (process.platform !== "darwin") app.quit()
})

/** Guards the second `before-quit`, the one this handler asks for itself. */
let cleanedUp = false

/** How long shutdown may take before the app stops waiting and exits anyway. */
const CLEANUP_TIMEOUT_MS = 5_000

app.on("before-quit", (event) => {
  if (cleanedUp) return

  // Quitting is deferred because the asynchronous half of this matters: Electron
  // does not wait for promises in `before-quit`, so simply starting them meant
  // database containers kept running after the app was gone, holding their
  // ports for the next launch.
  event.preventDefault()

  void (async () => {
    // Synchronous kills first, so the slow work below cannot delay them.
    // Child processes with nothing to flush: a TypeScript server holds a
    // project in memory and no state worth writing.
    tsServers.stopAll()
    // Same kind of thing, and free: file handles the OS would drop anyway, but
    // a watcher with a debounce pending is a callback into a window that is on
    // its way out.
    watchers.closeAll()
    // The menu bar's icon, before the slow half below: quitting can take the
    // five seconds that cleanup is given, and an icon still counting chats
    // during them is an app that looks stuck.
    tray.destroy()

    await Promise.race([
      // Containers are stopped, not removed: a database's data lives in its
      // volume, not the container itself. Closing every connection cleanly
      // means the next launch does not have to recover.
      // Terminal sessions go with the app. They live in the agent daemon
      // rather than this process, so this is what ends them — and it is
      // awaited, since an Electron that exits first would leave them running
      // with nobody to reattach them to.
      Promise.allSettled([
        terminals.killAll(),
        // A turn in flight is a `claude` this app spawned; it goes with the app
        // rather than being left talking to a window that has gone.
        worktreeChats.dispose(),
      ]),
      // A wedged daemon must not leave the app unquittable.
      new Promise((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
    ])

    cleanedUp = true
    app.quit()
  })()
})
