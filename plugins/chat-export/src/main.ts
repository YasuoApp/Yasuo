import type { PluginApp, PluginChat } from "@/lib/plugins/app"

import { chatToHtml } from "./html"
import { chatToMarkdown, fileNameOf } from "./markdown"

/**
 * A chat as a document: the three items that were on a chat row's menu before
 * they were a plugin, and the same three in the palette for the chat on
 * screen.
 *
 * Three items rather than one dialog with a format picker: the clipboard and a
 * `.md` are the same bytes, and a save dialog already asks the one question
 * left.
 */

type Format = {
  id: string
  name: string
  icon: "copy" | "download" | "code"
  run: (app: PluginApp, chat: PluginChat) => Promise<void>
}

const FORMATS: Format[] = [
  {
    id: "copy-markdown",
    name: "Copy as Markdown",
    icon: "copy",
    async run(app, chat) {
      const lines = await app.chats.read(chat.id)
      await app.copyText(chatToMarkdown(chat, lines, optionsOf(chat)))
    },
  },
  {
    id: "export-markdown",
    name: "Export as Markdown…",
    icon: "download",
    async run(app, chat) {
      const lines = await app.chats.read(chat.id)
      await app.saveTextFile({
        defaultName: fileNameOf(chat.title, "md"),
        text: chatToMarkdown(chat, lines, optionsOf(chat)),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      })
    },
  },
  {
    id: "export-html",
    name: "Export as HTML…",
    icon: "code",
    async run(app, chat) {
      const lines = await app.chats.read(chat.id)
      await app.saveTextFile({
        defaultName: fileNameOf(chat.title, "html"),
        text: await chatToHtml(
          chat,
          lines,
          optionsOf(chat),
          app.renderMarkdown
        ),
        filters: [{ name: "HTML", extensions: ["html"] }],
      })
    },
  },
]

function optionsOf(chat: PluginChat) {
  return chat.project ? { project: chat.project } : {}
}

export default {
  onload(app: PluginApp) {
    const exporting = async (format: Format, chatId: string | null) => {
      const chat = chatId ? app.chats.get(chatId) : null
      if (!chat) {
        app.notice("Open a chat first.")
        return
      }
      try {
        await format.run(app, chat)
        if (format.id === "copy-markdown") app.notice("Copied.")
      } catch (error) {
        console.error("Could not export chat", error)
        app.notice(
          `Could not export the chat: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    for (const format of FORMATS) {
      app.addChatMenuItem({
        id: format.id,
        name: format.name,
        icon: format.icon,
        run: (chatId) => exporting(format, chatId),
      })
    }
  },
}
