import { writeFile } from "node:fs/promises"
import path from "node:path"

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron"

import { IPC } from "../shared/api"
import type { Host } from "./host"
import { createIpc } from "./ipc"
import { clampPercent, kilobytes } from "./system-usage"
import { ChatTray } from "./tray"

/** What `pickImages`'s dialog offers — the extensions `readImageDataUrl`
 * recognises. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]

/** The installer, shipped in the bundle (`extraResources`) rather than fetched:
 * a button that runs a script downloaded at the moment it is pressed is a
 * different thing to agree to than one that runs the app's own. */
function installerScript(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "install.sh")
    : path.join(app.getAppPath(), "install.sh")
}

/** The window an IPC call came from, if it is still there. */
function ownerOf(caller: unknown): BrowserWindow | null {
  const sender = (caller as IpcMainInvokeEvent | undefined)?.sender
  const owner = sender ? BrowserWindow.fromWebContents(sender) : null
  return owner && !owner.isDestroyed() ? owner : null
}

/**
 * This app's own share: every process Electron runs, added up.
 *
 * `getAppMetrics()` reports one row per process — the main process, each
 * renderer, the GPU and utility processes — and none of them alone is "the
 * app". The ptys are not in here: a `claude` or a shell is a child of the
 * daemon, not of this app, and counting it would make the studio look
 * responsible for work the user started deliberately.
 *
 * `percentCPUUsage` is Chromium's own since-the-last-call delta, on the same
 * clock as the machine figure, and — measured, not assumed — it is already a
 * share of *all* cores rather than of one: a process burning 1.09 CPU-seconds
 * over two seconds on a ten-core machine reports 5%, not 54%. So it goes
 * straight into `appCpuPercent`, and it is the *Activity Monitor* figure that
 * has to be derived, by multiplying back up by the core count. Both are carried
 * because a bar disagreeing with Activity Monitor by a factor of ten, with no
 * way to see why, would just look broken.
 */
function electronShare(cores: number): ReturnType<Host["appShare"]> {
  const metrics = app.getAppMetrics()

  let machine = 0
  let memory = 0
  for (const entry of metrics) {
    machine += entry.cpu.percentCPUUsage
    memory += kilobytes(entry.memory.workingSetSize)
  }

  return {
    appCpuPercent: clampPercent(machine),
    appCoreCpuPercent: Math.max(0, machine * Math.max(1, cores)),
    appMemory: memory,
    appProcesses: metrics.length,
  }
}

/**
 * Puts every handler in `ipc.ts` on `ipcMain`, with Electron as its host.
 *
 * Every push event goes to every window — see `send` in `ipc.ts` — and the
 * dialogs are parented to the studio when there is one, so a picker is modal
 * to it rather than a sheet the user can lose behind it.
 */
export function registerIpc(
  getWindow: () => BrowserWindow | null,
  /** Opens or focuses the window one chat is popped out into — `main.ts`
   * owns window creation, so this is handed in rather than done here. */
  openChatWindow: (chatId: string) => void
) {
  /** Brings the studio up: from the dock, from behind another app, or from
   * minimised, which are three different states and only the last has a name. */
  const showWindow = (): BrowserWindow | null => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return null
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return window
  }

  /** The studio, scrolled to one chat. Shared by the notification's click and
   * the tray's menu, which are the same errand arriving two ways. */
  const revealChat = (chatId: string): void => {
    showWindow()?.webContents.send(IPC.revealWorktreeChat, chatId)
  }

  const showOpenDialog = (options: OpenDialogOptions) => {
    const window = getWindow()
    return window
      ? dialog.showOpenDialog(window, options)
      : dialog.showOpenDialog(options)
  }

  /*
   * Created here but not shown: a `Tray` before `whenReady` throws, and this
   * runs at module scope — `startTray` is what puts it in the strip.
   */
  const tray = new ChatTray({
    reveal: (chatId) => revealChat(chatId),
    show: () => showWindow(),
  })

  const host: Host = {
    send(channel, payload) {
      for (const window of BrowserWindow.getAllWindows()) {
        // Gone during shutdown; its last output has nowhere to go.
        if (window.isDestroyed()) continue
        window.webContents.send(channel, payload)
      }
    },

    async pickDirectory() {
      const result = await showOpenDialog({
        title: "Add a folder",
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "Add",
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },

    async pickFiles({ title, images, directory }) {
      const result = await showOpenDialog({
        title,
        properties: ["openFile", "multiSelections"],
        ...(images
          ? { filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] }
          : {}),
        ...(directory ? { defaultPath: directory } : {}),
      })
      return result.canceled ? [] : result.filePaths
    },

    async saveTextFile(caller, input) {
      const owner = ownerOf(caller)
      const options = {
        defaultPath: path.join(app.getPath("documents"), input.defaultName),
        filters: input.filters,
      }
      const result = await (owner
        ? dialog.showSaveDialog(owner, options)
        : dialog.showSaveDialog(options))
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, input.text, "utf8")
      return result.filePath
    },

    async clipboardImage() {
      const image = clipboard.readImage()
      return image.isEmpty() ? null : image.toPNG()
    },

    trash: (target) => shell.trashItem(target),
    async reveal(target) {
      shell.showItemInFolder(target)
    },

    // Any window of this app's, not only the studio's: a chat popped out into
    // its own window and being read there is one nobody needs calling back to.
    focused: () => BrowserWindow.getFocusedWindow() !== null,

    notify({ title, body, chatId }) {
      if (!Notification.isSupported()) return
      const banner = new Notification({ title, body })
      banner.on("click", () => revealChat(chatId))
      banner.show()
    },

    openChatWindow,
    // On the *calling* window: the studio has no reason to pin itself, and a
    // popped-out chat is the one that wants to stay over another editor.
    setAlwaysOnTop(caller, on) {
      ownerOf(caller)?.setAlwaysOnTop(on, "floating")
    },
    isAlwaysOnTop: (caller) => ownerOf(caller)?.isAlwaysOnTop() ?? false,

    tray,
    version: app.getVersion(),
    installerScript: installerScript(),
    appShare: electronShare,
  }

  const ipc = createIpc(host)
  for (const [channel, handler] of ipc.handlers) {
    ipcMain.handle(channel, (event, ...args: unknown[]) =>
      handler(event, ...args)
    )
  }

  return { ...ipc, tray }
}
