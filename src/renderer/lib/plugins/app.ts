import {
  chatRootId,
  type AssistantMessage,
  type ChatSpend,
  type WorktreeChat,
  type WorktreeChatEvent,
} from "@shared/api"
import type { PluginManifest } from "@shared/plugins"
import { useFiles } from "@/lib/files/store"
import { useStudio } from "@/lib/store"
import { useWorktreeChats } from "@/lib/worktree-chat/store"

import type { PluginIcon, PluginRegistry } from "./registry"

/** A chat as a plugin sees it. */
export type PluginChat = {
  id: string
  title: string
  /** ISO. */
  createdAt: string
  /** Null for a chat whose project has left the workspace. */
  folderId: string | null
  /** That project's name, for a heading. */
  project: string | null
}

/**
 * What a plugin's `onload` is handed — the whole of the API a plugin is
 * written against.
 *
 * Deliberately narrow, and **not a security boundary**: `main.js` runs in this
 * page, so it can reach `window.desktop` and everything on it whatever this
 * object leaves out. What this buys is a surface that can be kept stable while
 * the studio's own stores change underneath it, and registrations that undo
 * themselves — `docs/design.md` § Plugins.
 */
export type PluginApp = {
  manifest: PluginManifest

  /** An item in a chat row's context menu, handed that chat's id. */
  addChatMenuItem: (item: {
    id: string
    name: string
    icon?: PluginIcon
    run: (chatId: string) => void | Promise<void>
  }) => void
  /** A button on the window's rail, under Search. */
  addRailButton: (button: {
    id: string
    label: string
    icon?: PluginIcon
    run: () => void | Promise<void>
  }) => void
  /** A line in the corner of the window for a few seconds. */
  notice: (text: string) => void
  /** Anything to undo when the plugin is switched off. */
  register: (dispose: () => void) => void

  /** What `saveData` last wrote, or null. */
  loadData: <T = unknown>() => Promise<T | null>
  /** Kept in the plugin's own data file; JSON only, up to 1 MB. */
  saveData: (data: unknown) => Promise<void>

  /** Asks where with the OS's save dialog and writes it there. The path, or
   * null when cancelled. */
  saveTextFile: (input: {
    defaultName: string
    text: string
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<string | null>
  copyText: (text: string) => Promise<void>
  /**
   * Markdown as HTML, through the renderer the transcript itself uses — so a
   * table that renders in the pane renders the same way in whatever a plugin
   * writes, and no plugin has to bundle a second Markdown stack to get there.
   */
  renderMarkdown: (markdown: string) => Promise<string>

  folders: () => { id: string; name: string; path: string }[]
  /** Opens a file of the workspace in a tab. */
  openFile: (path: string) => Promise<void>

  chats: {
    list: () => PluginChat[]
    get: (chatId: string) => PluginChat | null
    /** A chat's lines, read off disk when it has not been opened this run. */
    read: (chatId: string) => Promise<AssistantMessage[]>
    /** One row per usage line across every chat — what the usage dashboard
     * folds. Read off disk each call; see `WorktreeChats.spend`. */
    spend: () => Promise<ChatSpend[]>
    /** The chat on screen, if any. */
    selected: () => string | null
    open: (chatId: string) => void
    /** Every chat's events as main sends them; undone on unload. */
    onEvent: (listener: (event: WorktreeChatEvent) => void) => void
  }
}

/** The `PluginApp` one plugin is handed, every registration on it recorded
 * against that plugin in `registry`. */
export function createPluginApp(
  manifest: PluginManifest,
  registry: PluginRegistry,
  notice: (pluginId: string, text: string) => void
): PluginApp {
  const id = manifest.id

  return {
    manifest,

    addChatMenuItem: (item) => registry.addChatMenuItem(id, item),
    addRailButton: (button) => registry.addRailButton(id, button),
    notice: (text) => notice(id, String(text)),
    register: (dispose) => registry.track(id, dispose),

    loadData: async <T>() =>
      (await window.desktop.readPluginData(id)) as T | null,
    saveData: (data) => window.desktop.writePluginData(id, data),

    saveTextFile: (input) => window.desktop.saveTextFile(input),
    copyText: (text) => navigator.clipboard.writeText(text),
    renderMarkdown,

    folders: () =>
      useStudio.getState().folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        path: folder.path,
      })),
    openFile: (path) => useFiles.getState().open(path),

    chats: {
      list: () => useWorktreeChats.getState().chats.map(pluginChatOf),
      get: (chatId) => {
        const chat = useWorktreeChats
          .getState()
          .chats.find((candidate) => candidate.id === chatId)
        return chat ? pluginChatOf(chat) : null
      },
      // The store holds the lines of a chat opened this run and nothing else,
      // so one exported straight from the column is read off disk — the same
      // call the pane makes when it is selected.
      read: async (chatId) =>
        useWorktreeChats.getState().messages[chatId] ??
        (await window.desktop.readWorktreeChat(chatId)),
      spend: () => window.desktop.chatSpend(),
      selected: () => useWorktreeChats.getState().selectedId,
      open: (chatId) => useWorktreeChats.getState().select(chatId),
      onEvent: (listener) => {
        const stop = window.desktop.onWorktreeChatEvent((event) => {
          // One plugin throwing must not stop the bridge's other listeners —
          // the studio's own among them.
          try {
            listener(event)
          } catch (error) {
            console.error(`[plugin ${id}]`, error)
          }
        })
        registry.track(id, stop)
      },
    },
  }
}

function pluginChatOf(chat: WorktreeChat): PluginChat {
  const folderId = chatRootId(chat)
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    folderId,
    project:
      useStudio.getState().folders.find((folder) => folder.id === folderId)
        ?.name ?? null,
  }
}

/**
 * One reply's HTML, through a detached container; the plain text, escaped, if
 * the renderer throws on it. Imported on first use, since Milkdown is not
 * something a plugin that never asks should cost the launch.
 */
async function renderMarkdown(markdown: string): Promise<string> {
  const { markdownRenderer } = await import("@/lib/markdown/renderer")
  const render = await markdownRenderer()
  try {
    const box = document.createElement("div")
    box.replaceChildren(render(markdown))
    return box.innerHTML
  } catch (error) {
    console.error("Could not render markdown", error)
    const box = document.createElement("p")
    box.textContent = markdown
    return box.outerHTML
  }
}
