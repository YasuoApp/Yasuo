import {
  app,
  Menu,
  nativeImage,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron"

import { IPC, type MenuCommand } from "../shared/api"
import settingsIcon from "../../resources/menu-settings.png"
import settingsIcon2x from "../../resources/menu-settings@2x.png"

const IS_MAC = process.platform === "darwin"

/**
 * The gear beside **Settings…**.
 *
 * Both representations rather than one image scaled: a menu icon is 16pt, and
 * handing Electron only the 32px file would draw it at 32pt. It is a template
 * image — black, with the gear in its alpha channel (`scripts/menu-icon.mjs`) —
 * so macOS tints it to whatever the row is drawn in, including the highlight it
 * takes under the pointer, which a coloured icon would have to fight.
 *
 * macOS only. `setTemplateImage` is macOS's, and elsewhere the same file is
 * drawn as it is: black on a menu that may itself be dark. The standard items
 * around it carry no icons off macOS either.
 */
function settingsImage(): Electron.NativeImage {
  const image = nativeImage.createFromDataURL(settingsIcon)
  image.addRepresentation({ scaleFactor: 2, dataURL: settingsIcon2x })
  image.setTemplateImage(true)
  return image
}

/**
 * The application menu.
 *
 * There was none until adding a folder outgrew the header: on macOS the menu
 * bar is there whether the app uses it or not, and a window whose only chrome
 * is a row of unlabelled icons hides "add a folder" from anyone who has not
 * hovered one. Everything here also exists as a dialog in the renderer — the
 * menu sends the intent and the renderer opens it, so there is one
 * implementation rather than two.
 *
 * Replacing Electron's default menu means the editing and window roles it
 * provided have to be restated: without them ⌘C and ⌘V stop working in the
 * renderer, since those shortcuts are the menu's, not the page's.
 */
export function installMenu(getWindow: () => BrowserWindow | null): void {
  function send(command: MenuCommand): void {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(IPC.menuCommand, command)
  }

  function build(): void {
    /*
     * Settings, which is a dialog the renderer owns like every other item
     * here. ⌘, is the shortcut every macOS app has for it, and unlike Close
     * tab and Sidebar it is claimed rather than merely shown: nothing on
     * screen wants the comma — not a terminal, where Ctrl+, is unbound, and
     * not an editor — so there is no case where the page has to answer first.
     */
    const settingsItem: MenuItemConstructorOptions = {
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      ...(IS_MAC ? { icon: settingsImage() } : {}),
      click: () => send("open-settings"),
    }

    const fileItems: MenuItemConstructorOptions[] = [
      {
        label: "Add folder…",
        accelerator: "Shift+CmdOrCtrl+O",
        click: () => send("add-folder"),
      },
      {
        label: "Close tab",
        accelerator: "CmdOrCtrl+W",
        /*
         * Shown but not claimed. A registered accelerator is handled here,
         * before the page sees the key at all, and this one has to reach the
         * renderer: which tab is "the current tab" is the strip's answer, and
         * off macOS a terminal has first call on Ctrl+W, where it deletes the
         * word behind the cursor. So the renderer listens for the key and this
         * item is the menu saying so — and the way to it with no keyboard.
         */
        registerAccelerator: false,
        click: () => send("close-tab"),
      },
    ]

    const template: MenuItemConstructorOptions[] = [
      ...(IS_MAC
        ? ([
            {
              label: app.name,
              submenu: [
                { role: "about" },
                { type: "separator" },
                settingsItem,
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      {
        label: "File",
        submenu: [
          ...fileItems,
          // Off macOS there is no application menu to hold it, and File is
          // where the editors put it.
          ...(IS_MAC
            ? []
            : ([
                { type: "separator" },
                settingsItem,
              ] satisfies MenuItemConstructorOptions[])),
          { type: "separator" },
          // ⇧⌘W rather than the role's own ⌘W, which now closes a tab — the
          // same move an editor makes, and for the same reason: a window holds
          // every panel's tabs, and losing it to a keystroke aimed at one of
          // them takes everything running in it too.
          IS_MAC
            ? { role: "close", accelerator: "Shift+CmdOrCtrl+W" }
            : { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          // The way out of a paste that keeps too much: the block editor
          // pastes with the source's own formatting (see `block-editor.tsx`),
          // and copying out
          // of a rendered page is sometimes a request for its words rather than
          // its headings and tables.
          { role: "pasteAndMatchStyle" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Sidebar",
            accelerator: "CmdOrCtrl+B",
            // Shown but not claimed, for the reason Close tab is not: which
            // sidebar is showing — and whether the caret is somewhere ⌘B means
            // bold — is the renderer's answer, so it listens for the key and
            // this item is the menu saying the key exists.
            registerAccelerator: false,
            click: () => send("toggle-sidebar"),
          },
          {
            label: "Terminal",
            // `Ctrl` on macOS too, not `Cmd`: the editors' key for this panel,
            // and `Cmd+\`` is already the system's "next window" there. Hence
            // the literal rather than `CmdOrCtrl`.
            accelerator: "Ctrl+`",
            // Shown but not claimed, like the two above. Whether the key shows
            // the tab or hides the dock depends on which tab the dock is on,
            // which only the renderer knows — and this one is meant to work
            // while the focus is inside the terminal, so the page has to be
            // what answers it.
            registerAccelerator: false,
            click: () => send("toggle-terminal"),
          },
          { type: "separator" },
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: IS_MAC
          ? [
              { role: "minimize" },
              { role: "zoom" },
              { type: "separator" },
              { role: "front" },
            ]
          : [{ role: "minimize" }, { role: "close" }],
      },
    ]

    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  build()
}
