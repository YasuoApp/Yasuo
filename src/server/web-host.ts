import { execFile } from "node:child_process"
import { mkdir, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type { Host } from "../main/host"
import { processShare } from "../main/system-usage"
import { WEB_NOTICE_CHANNEL } from "../shared/wire"

const run = promisify(execFile)

/** Set by `scripts/build-web.mjs` from `package.json`. */
declare const __YASUO_VERSION__: string

/** What a picker answers on a platform with no `osascript` — the add-folder
 * dialog shows it under its path field, which is the way round it. */
const NO_PICKER =
  "There is no native picker in the browser build here — type the path instead."

/**
 * An AppleScript `choose …`, run over whatever app is frontmost — the browser
 * the request came from — so the sheet lands in front of the person who
 * clicked rather than behind their window.
 *
 * That `tell` needs Automation permission for the browser, which macOS asks
 * for once; refused, the same script runs on its own and the picker opens
 * wherever osascript puts it. A cancel is error -128 and is an answer, not a
 * failure.
 */
async function chooseOnMac(script: string): Promise<string[] | null> {
  const wrapped = [
    "tell application (path to frontmost application as text)",
    "activate",
    script,
    "end tell",
  ].join("\n")

  for (const source of [wrapped, script]) {
    try {
      const { stdout } = await run("osascript", ["-e", source], {
        maxBuffer: 1024 * 1024,
      })
      return stdout.split("\n").filter(Boolean)
    } catch (error) {
      if (String((error as { stderr?: string }).stderr).includes("-128")) {
        return null
      }
    }
  }
  throw new Error("The file picker could not be opened.")
}

/** A string as an AppleScript literal. */
function appleString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** A name not already taken in `dir`, the way Finder suffixes one. */
async function freeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? name : `${stem} ${attempt}${ext}`
    try {
      await stat(path.join(dir, candidate))
    } catch {
      return candidate
    }
  }
}

/**
 * The OS trash, without Electron's `shell.trashItem`.
 *
 * A rename into the trash directory rather than Finder's own delete: Finder
 * would need Automation permission, and a prompt on the first discard is a
 * worse surprise than a file without Put Back. A rename cannot cross volumes,
 * so a file on another disk is refused rather than deleted — `unlink` is never
 * the fallback, for the reason `trashPath` in `ipc.ts` gives.
 */
async function trash(target: string): Promise<void> {
  if (process.platform === "darwin") {
    const dir = path.join(homedir(), ".Trash")
    await rename(
      target,
      path.join(dir, await freeName(dir, path.basename(target)))
    )
    return
  }

  if (process.platform === "linux") {
    // The freedesktop.org layout, which is what every Linux file manager's
    // Trash reads — a file without its `.trashinfo` would be invisible there.
    const base = path.join(
      process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
      "Trash"
    )
    const files = path.join(base, "files")
    const info = path.join(base, "info")
    await mkdir(files, { recursive: true })
    await mkdir(info, { recursive: true })
    const name = await freeName(files, path.basename(target))
    await writeFile(
      path.join(info, `${name}.trashinfo`),
      `[Trash Info]\nPath=${encodeURI(target)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`
    )
    await rename(target, path.join(files, name))
    return
  }

  throw new Error(
    "Moving to the trash is not supported by the browser build here."
  )
}

/**
 * The host the localhost server runs `ipc.ts` with.
 *
 * Several of its answers are deliberately inert, because the tab answers that
 * call itself and never sends it (`src/renderer/web/desktop.ts`): saving a file
 * is a download, a pop-out is `window.open`, the clipboard is the page's own.
 * They are here so that a call that does arrive is refused loudly rather than
 * answered with something plausible.
 */
export function webHost(send: Host["send"]): Host {
  return {
    send,

    async pickDirectory() {
      if (process.platform !== "darwin") throw new Error(NO_PICKER)
      const picked = await chooseOnMac(
        'POSIX path of (choose folder with prompt "Add a folder")'
      )
      return picked?.[0]?.replace(/\/$/, "") || null
    },

    async pickFiles({ title, images, directory }) {
      if (process.platform !== "darwin") throw new Error(NO_PICKER)
      const options = [
        `with prompt ${appleString(title)}`,
        "with multiple selections allowed",
        images ? 'of type {"public.image"}' : "",
        directory
          ? `default location (POSIX file ${appleString(directory)})`
          : "",
      ].join(" ")
      const picked = await chooseOnMac(
        [
          `set picked to (choose file ${options})`,
          'set out to ""',
          "repeat with entry in picked",
          "set out to out & POSIX path of entry & linefeed",
          "end repeat",
          "out",
        ].join("\n")
      )
      return picked ?? []
    },

    async saveTextFile() {
      throw new Error(
        "A browser tab saves by downloading — see web/desktop.ts."
      )
    },
    clipboardImage: async () => null,

    trash,
    async reveal(target) {
      if (process.platform === "darwin") {
        await run("open", ["-R", target])
      } else if (process.platform === "win32") {
        await run("explorer", [`/select,${target}`]).catch(() => undefined)
      } else {
        await run("xdg-open", [path.dirname(target)])
      }
    },

    // The server cannot see a window; each tab decides for itself whether it
    // is being looked at before it shows what this sends.
    focused: () => false,
    notify: (notice) => send(WEB_NOTICE_CHANNEL, notice),

    openChatWindow: () => undefined,
    setAlwaysOnTop: () => undefined,
    isAlwaysOnTop: () => false,

    tray: null,
    version: __YASUO_VERSION__,
    installerScript: null,
    appShare: processShare,
  }
}
