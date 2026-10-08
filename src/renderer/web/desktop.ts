import { IPC, type DesktopApi, type MenuCommand } from "@shared/api"
import { noteFileNameOf } from "@shared/note-files"
import {
  decodeWire,
  encodeWire,
  TOKEN_HEADER,
  TOKEN_PARAM,
  WEB_NOTICE_CHANNEL,
  WIRE_PREFIX,
  type WireEvent,
} from "@shared/wire"
import { channelMethods } from "./channels"

/**
 * `window.desktop` for a browser tab: the preload's contract, carried over HTTP
 * to the localhost server (`src/server/main.ts`) instead of over Electron IPC.
 *
 * Built from the `IPC` map rather than written out a method at a time — see
 * `channels.ts`, and `test/web-desktop.ts`, which holds it to every key the
 * preload exposes.
 *
 * What a tab does differently is the `overrides` at the bottom, and each says
 * why. None of them reaches the workspace: every read and write still goes to
 * the same handler the app's own window calls.
 */

const TOKEN_KEY = "yasuo.webToken"

/**
 * The token the server printed, taken off the URL it was opened with and kept
 * for the next load.
 *
 * Out of the address bar once read — `history.replaceState` — so it is not in
 * the next screenshot or the next link somebody copies. `localStorage` rather
 * than `sessionStorage` because a popped-out chat and a reload both need it,
 * and both are this same origin on this same machine.
 */
function takeToken(): string {
  const url = new URL(window.location.href)
  const fresh = url.searchParams.get(TOKEN_PARAM)
  if (fresh) {
    try {
      localStorage.setItem(TOKEN_KEY, fresh)
    } catch {
      // Storage refused: this load still has it, a reload will ask again.
    }
    url.searchParams.delete(TOKEN_PARAM)
    window.history.replaceState(null, "", url.toString())
    return fresh
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ""
  } catch {
    return ""
  }
}

/** The platform the server is on — it is this machine, so the browser's own
 * answer is the server's. */
function platformOf(): DesktopApi["platform"] {
  const agent = navigator.userAgent
  if (/Mac/i.test(agent)) return "darwin"
  if (/Win/i.test(agent)) return "win32"
  return "linux"
}

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"])

/**
 * A link out of the studio opens beside it rather than replacing it.
 *
 * The app does this in `main.ts` (`will-navigate`): a bare `<a href>` from a
 * transcript is a navigation, and here that would take the whole studio — every
 * open tab, every running terminal — away to the link.
 */
function keepLinksOutside(): void {
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return
      const anchor = (event.target as Element | null)?.closest?.("a[href]")
      if (!(anchor instanceof HTMLAnchorElement)) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin === window.location.origin) return
      event.preventDefault()
      if (EXTERNAL_SCHEMES.has(url.protocol)) {
        window.open(url.toString(), "_blank", "noopener,noreferrer")
      }
    },
    { capture: true }
  )
}

/**
 * The two menu items whose key is claimed by the app's menu rather than by the
 * page (`main/menu.ts`). The rest of the menu's keys the renderer already
 * listens for itself. A browser may keep these for its own — ⌘, is Chrome's
 * settings — in which case the rail's buttons are the way in.
 */
function menuCommandOf(event: KeyboardEvent): MenuCommand | null {
  const mod = platformOf() === "darwin" ? event.metaKey : event.ctrlKey
  if (!mod || event.altKey) return null
  if (event.key === "," && !event.shiftKey) return "open-settings"
  if (event.key.toLowerCase() === "o" && event.shiftKey) return "add-folder"
  return null
}

export function createWebDesktop(): DesktopApi {
  const token = takeToken()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  const emit = (channel: string, payload: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload)
  }

  const subscribe = (channel: string, listener: (payload: never) => void) => {
    const set = listeners.get(channel) ?? new Set()
    listeners.set(channel, set)
    const entry = listener as (payload: unknown) => void
    set.add(entry)
    return () => {
      set.delete(entry)
    }
  }

  const invoke = async (channel: string, ...args: unknown[]) => {
    const response = await fetch(`${WIRE_PREFIX}/invoke`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      body: encodeWire({ channel, args }),
    })
    if (response.status === 401) {
      throw new Error(
        "The server refused this tab's token — open the URL it printed when it started."
      )
    }
    if (!response.ok) throw new Error(await response.text())
    const answer = decodeWire<{ value?: unknown; error?: string }>(
      await response.text()
    )
    if (answer.error !== undefined) throw new Error(answer.error)
    return answer.value
  }

  // One stream for every push channel. `EventSource` reconnects on its own
  // after a dropped connection; a server restarted with a new token answers
  // 401, and the stream stays shut until the tab is opened with the new URL.
  const stream = new EventSource(
    `${WIRE_PREFIX}/events?${TOKEN_PARAM}=${encodeURIComponent(token)}`
  )
  stream.onmessage = (message: MessageEvent<string>) => {
    const event = decodeWire<WireEvent>(message.data)
    emit(event.channel, event.payload)
  }

  /*
   * A chat finishing while nobody is looking at the tab. The server cannot see
   * focus (`focused` in `server/web-host.ts`), so the tab decides — and the tag
   * is the chat, so two tabs open on the studio raise one banner between them
   * rather than one each.
   */
  subscribe(
    WEB_NOTICE_CHANNEL,
    (notice: { title: string; body: string; chatId: string }) => {
      if (document.hasFocus() || !("Notification" in window)) return
      if (Notification.permission !== "granted") return
      const banner = new Notification(notice.title, {
        body: notice.body,
        tag: `yasuo-${notice.chatId}`,
      })
      banner.onclick = () => {
        window.focus()
        emit(IPC.revealWorktreeChat, notice.chatId)
        banner.close()
      }
    }
  )
  // Permission is asked on a click, which is the only time a browser lets a
  // page ask — and only once, whatever the answer.
  if ("Notification" in window && Notification.permission === "default") {
    const ask = () => void Notification.requestPermission()
    document.addEventListener("pointerdown", ask, { once: true })
  }

  window.addEventListener(
    "keydown",
    (event) => {
      const command = menuCommandOf(event)
      if (!command) return
      event.preventDefault()
      emit(IPC.menuCommand, command)
    },
    { capture: true }
  )
  keepLinksOutside()

  const overrides: Partial<DesktopApi> = {
    platform: platformOf(),
    runtime: "web",

    resolveNoteFileUrl: async (url) => {
      const name = noteFileNameOf(url)
      return name
        ? `${WIRE_PREFIX}/note-file/${encodeURIComponent(name)}?${TOKEN_PARAM}=${encodeURIComponent(token)}`
        : url
    },

    // A page is never told where a dropped file lives — that is the browser
    // keeping a promise to the user. Every caller already treats "" as a file
    // with no path (a picture from a web page) and reads its bytes instead.
    getPathForFile: () => "",

    /*
     * The clipboard the tab can read, spilled by the server the same way the
     * app spills its own. Asks for permission the first time; refused, it is
     * the same "nothing to paste" the app answers for an empty clipboard.
     */
    clipboardImagePath: async () => {
      try {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((entry) => entry.startsWith("image/"))
          if (!type) continue
          const blob = await item.getType(type)
          const png = type === "image/png" ? blob : await reencodeAsPng(blob)
          return (await invoke(
            IPC.clipboardImagePath,
            new Uint8Array(await png.arrayBuffer())
          )) as string | null
        }
      } catch {
        // No permission, or nothing that is a picture.
      }
      return null
    },

    // A download: the browser's own save, to the browser's own folder. The
    // name is all there is to report, since a page never learns the path.
    saveTextFile: async ({ defaultName, text }) => {
      const link = document.createElement("a")
      link.href = URL.createObjectURL(
        new Blob([text], { type: "text/plain;charset=utf-8" })
      )
      link.download = defaultName
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 0)
      return defaultName
    },

    // A popup of this same page, which `App` reads `?chat=` off exactly as it
    // does in the app's own pop-out window. Named per chat, so a second click
    // focuses the window it already has.
    openChatWindow: async (chatId) => {
      const url = new URL("/", window.location.href)
      url.searchParams.set("chat", chatId)
      window.open(
        url.toString(),
        `yasuo-chat-${chatId}`,
        "popup,width=520,height=720"
      )
    },
    // A tab cannot be pinned over other windows; the button is not drawn
    // (`chat-window.tsx`), and these answer as a window that never was.
    setAlwaysOnTop: async () => undefined,
    isAlwaysOnTop: async () => false,
  }

  return { ...channelMethods(invoke, subscribe), ...overrides } as DesktopApi
}

/** A picture the clipboard holds in some other format, as PNG — the one
 * format the server writes. */
async function reencodeAsPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error("Not an image"))),
      "image/png"
    )
  )
}
