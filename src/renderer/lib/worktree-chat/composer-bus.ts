import { create } from "zustand"

import type { ChatImage } from "@shared/api"
import { useProjects } from "../projects"
import { useWorktreeChats } from "./store"

/**
 * The way something outside the chat pane puts words into its composer.
 *
 * The dock's shell and its `Preview` tab both want to: a run of error output
 * selected in the terminal, a screenshot of the page. Neither can reach the
 * composer's handle — it is a ref inside the pane, and the pane is keyed by
 * the chat it is drawing — so they leave a delivery here, addressed to a chat,
 * and the pane drawing that chat picks it up and types it in. A delivery is
 * kept until the pane takes it, which is what lets a chat opened *for* the
 * delivery (no chat was selected) receive it once it has mounted.
 *
 * Into the **draft**, never sent: what was selected is the material for a
 * question, and the question is the user's to write.
 */
export type Delivery = {
  chatId: string
  text?: string
  images?: ChatImage[]
}

type BusState = {
  pending: Delivery | null
  /**
   * Addresses the delivery to the selected chat, or to a new chat in the
   * project the workbench is on when none is selected, and shows it.
   */
  deliver: (input: { text?: string; images?: ChatImage[] }) => void
  /** The delivery for this chat, taken — the pane calls it once it has typed
   * the contents in. Null when there is nothing for this chat. */
  take: (chatId: string) => Delivery | null
}

export const useComposerBus = create<BusState>((set, get) => ({
  pending: null,

  deliver({ text, images }) {
    if (!text && !(images && images.length > 0)) return

    const chats = useWorktreeChats.getState()
    const selected =
      chats.selectedId && chats.openIds.includes(chats.selectedId)
        ? chats.selectedId
        : null

    if (selected) {
      // `select` again rather than trusting the id: the chat may be open in a
      // tab behind a file, and a delivery into a composer nobody can see is a
      // delivery nobody finds.
      chats.select(selected)
      set({ pending: { chatId: selected, text, images } })
      return
    }

    const folderId = useProjects.getState().activeFolderId
    if (!folderId) return
    void chats.create({ folderId }).then((chatId) => {
      if (chatId) set({ pending: { chatId, text, images } })
    })
  },

  take(chatId) {
    const { pending } = get()
    if (!pending || pending.chatId !== chatId) return null
    set({ pending: null })
    return pending
  },
}))

/**
 * A run of terminal output as the composer should receive it: fenced, so the
 * model reads it as output rather than as prose, and trimmed of the blank rows
 * a selection across a prompt picks up.
 */
export function fencedOutput(text: string): string {
  const body = text.replace(/\s+$/, "").replace(/^\n+/, "")
  return `\`\`\`\n${body}\n\`\`\`\n`
}
