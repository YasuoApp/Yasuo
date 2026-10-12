import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
} from "electron"

import {
  activityLabel,
  activityTitle,
  isRunning,
  type ChatActivity,
} from "../shared/chat-activity"
import trayIcon from "../../resources/tray.png"
import trayIcon2x from "../../resources/tray@2x.png"

const IS_MAC = process.platform === "darwin"

/**
 * The menu bar's count of what the chats are doing, and the way back to one.
 *
 * The studio is a window somebody walks away from — several chats answering at
 * once is what it is for, and the cost of that is that the only two things
 * saying "one of them wants you" were a banner that has already gone and a
 * sidebar row inside the window that was walked away from. This is the third:
 * a standing count in the strip that is on screen whatever is in front of it,
 * and a menu naming the chats behind the number.
 *
 * It draws `activityLabel` — the sidebar row's own label, from
 * `@shared/chat-activity` — deliberately, and that is the whole reason those
 * two functions are shared: the count out here is checked against the count in
 * there, and two formats would read as two different facts.
 *
 * Nothing here polls. It is redrawn from `ChatNotices.pending()` on the same
 * events the notifications are read off, which is the only thing in this
 * process that knows a chat is busy.
 */
export class ChatTray {
  private tray: Tray | null = null

  constructor(
    private readonly actions: {
      /** Brings the studio up and scrolls a chat into view — the same thing
       * clicking a notification does. */
      reveal: (chatId: string) => void
      /** Brings the studio up with nothing selected. */
      show: () => void
    }
  ) {}

  /** Whether the icon is in the strip. The setting can switch it off, and
   * switching it off has to be the icon going away rather than an icon that
   * stops counting. */
  get shown(): boolean {
    return this.tray !== null
  }

  /**
   * Puts the icon in the strip, or takes it out.
   *
   * The `Tray` is held on this object rather than in a local, which is not
   * tidiness: an unreferenced Tray is collected and the icon disappears from
   * the menu bar some seconds after launch, with nothing in any log.
   */
  setShown(shown: boolean): void {
    if (shown === this.shown) return
    if (!shown) {
      this.tray?.destroy()
      this.tray = null
      return
    }

    this.tray = new Tray(image())
    // macOS opens this on either button once a menu is set, so there is no
    // separate left-click handler to write; elsewhere the click is the way in
    // and the menu is the right button's.
    if (!IS_MAC) this.tray.on("click", () => this.actions.show())
  }

  /**
   * Redraws the count and the menu behind it.
   *
   * `chats` is the listing, for the names — the ids are all this process keeps,
   * and a menu item saying `0b1f…` is a menu item nobody can use. A chat with
   * no row is one the `+` opened and nobody has spoken into, which is why an
   * id that is not in the listing is dropped rather than drawn under some
   * stand-in name.
   */
  update(
    pending: { working: string[]; waiting: string[] },
    chats: { id: string; title: string }[]
  ): void {
    const tray = this.tray
    if (!tray) return

    const activity: ChatActivity = {
      working: pending.working.length,
      waiting: pending.waiting.length,
    }
    const named = (ids: string[]) =>
      ids.flatMap((id) => {
        const chat = chats.find((entry) => entry.id === id)
        return chat ? [chat] : []
      })

    /*
     * The count beside the icon, macOS only — `setTitle` is that platform's,
     * and Windows and Linux draw a tooltip instead, which the line below sets
     * on every platform.
     *
     * Empty when nothing is running, rather than a `0`: this strip belongs to
     * the whole machine, and an app charging it three characters to say that
     * nothing is happening is an app that gets dragged out of it.
     */
    if (IS_MAC)
      tray.setTitle(isRunning(activity) ? activityLabel(activity) : "")
    tray.setToolTip(
      isRunning(activity)
        ? `Visual Studio Claude — ${activityTitle(activity)}`
        : "Visual Studio Claude"
    )

    const waiting = named(pending.waiting)
    const working = named(pending.working)

    const items: MenuItemConstructorOptions[] = []
    /*
     * Waiting first and working under it, each under a heading, because the two
     * are not the same errand: one is a question with a turn stopped behind it
     * and the other is something to leave alone. A single list ordered by
     * whatever the event stream happened to say would bury the one item this
     * menu is opened for.
     */
    if (waiting.length > 0) {
      items.push({ label: "Waiting for you", enabled: false })
      items.push(...waiting.map((chat) => this.item(chat)))
    }
    if (working.length > 0) {
      if (items.length > 0) items.push({ type: "separator" })
      items.push({ label: "Answering", enabled: false })
      items.push(...working.map((chat) => this.item(chat)))
    }
    if (items.length === 0) {
      items.push({ label: "No chats running", enabled: false })
    }

    items.push({ type: "separator" })
    items.push({
      label: "Open Visual Studio Claude",
      click: () => this.actions.show(),
    })
    // Quit is on here because on macOS this icon can be the only part of the
    // app on screen: an app with no window and no menu bar item of its own is
    // one somebody has to find in the dock to get rid of.
    items.push({ role: "quit" })

    tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  private item(chat: {
    id: string
    title: string
  }): MenuItemConstructorOptions {
    return { label: chat.title, click: () => this.actions.reveal(chat.id) }
  }

  destroy(): void {
    this.setShown(false)
  }
}

/**
 * The icon, at both the sizes a menu bar draws.
 *
 * Both representations rather than one image scaled, and a template image —
 * black, with the bubble in its alpha channel (`scripts/tray-icon.mjs`) — for
 * the reasons written on `settingsImage` in `menu.ts`: macOS tints it to the
 * bar's own appearance, light or dark, which a coloured icon would have to
 * fight. Elsewhere the same file is drawn as it is.
 */
function image(): Electron.NativeImage {
  const icon = nativeImage.createFromDataURL(trayIcon)
  icon.addRepresentation({ scaleFactor: 2, dataURL: trayIcon2x })
  icon.setTemplateImage(true)
  return icon
}
