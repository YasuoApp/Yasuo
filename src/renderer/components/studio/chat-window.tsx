import { useEffect, useState } from "react"
import { Pin, PinOff } from "lucide-react"

import { applyAppearance } from "@/lib/appearance"
import { cn } from "@/lib/utils"
import { useProjects } from "@/lib/projects"
import { useSettings } from "@/lib/settings"
import { useStudio } from "@/lib/store"
import { useClaudeProfiles } from "@/lib/worktree-chat/claude-profiles"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
import { IconButton } from "./icon-button"
import { IS_MAC } from "./title-bar"
import { WorktreeChatPane } from "./worktree/chat-pane"

/**
 * One chat in a window of its own — what `?chat=<id>` on the renderer's URL
 * draws instead of the studio (see `App`).
 *
 * The same stores, read the same way, with nothing of the workbench around
 * them: no strip, no Explorer, no dock. The chat's lines arrive over the same
 * `worktree-chats:event` channel the studio listens on, because main sends
 * every window every event; a message sent from here goes to the same CLI
 * session the studio's tab is on, so the two windows are two views of one
 * conversation rather than two conversations.
 *
 * The bar at the top is the window's title bar (macOS insets its lights into
 * it) with the one control the studio's pane has no use for: a pin, which is
 * `setAlwaysOnTop` on this window alone — the reason somebody pops a chat out
 * is to keep it over whatever editor they are working in.
 */
export function ChatWindow({ chatId }: { chatId: string }) {
  const loaded = useStudio((state) => state.loaded)
  const chat = useWorktreeChats((state) =>
    state.chats.find((entry) => entry.id === chatId)
  )
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    void useStudio.getState().init()
    void useSettings.getState().restore()
    void useClaudeProfiles.getState().refresh()
    void Promise.all([
      useWorktreeChats.getState().refresh(),
      // Before `select`, which moves the column's active project and writes
      // the column down: with nothing restored first that write would be the
      // defaults — every project unfolded, the sidebar back — over whatever
      // the studio window had saved.
      useProjects.getState().restore(),
    ]).then(() =>
      // Selecting is what reads the lines and marks the chat read; the pane
      // and the sidebar it would move are not here, so the rest of what
      // `select` does lands on stores nothing in this window draws.
      useWorktreeChats.getState().select(chatId)
    )
    void window.desktop.isAlwaysOnTop().then(setPinned)
  }, [chatId])

  // Settings › Appearance, the same way the studio applies it: this window is
  // its own document, and the palette and fonts are on `<html>`.
  useEffect(() => {
    applyAppearance(useSettings.getState())
    return useSettings.subscribe(applyAppearance)
  }, [])

  useEffect(() => useWorktreeChats.getState().listen(), [])

  // The chat's name in the OS's own title too, for the window switcher.
  useEffect(() => {
    document.title = chat ? `${chat.title} — Yasuo` : "Yasuo"
  }, [chat])

  const togglePin = () => {
    const next = !pinned
    setPinned(next)
    void window.desktop.setAlwaysOnTop(next)
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background">
      <header
        className={cn(
          "drag-region flex h-10 shrink-0 items-center gap-2 border-b pr-2",
          // Clears the traffic lights at `x: 14` (`openChatWindow` in
          // `main/main.ts`); elsewhere the frame is the OS's own.
          IS_MAC ? "pl-[4.5rem]" : "pl-3"
        )}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {chat?.title ?? "Chat"}
        </span>
        <IconButton
          label={pinned ? "Unpin from the top" : "Keep over other windows"}
          side="bottom"
          pressed={pinned}
          onClick={togglePin}
          className={cn(
            "no-drag size-6",
            pinned && "bg-accent text-accent-foreground"
          )}
        >
          {pinned ? (
            <Pin className="size-3.5" />
          ) : (
            <PinOff className="size-3.5" />
          )}
        </IconButton>
      </header>

      <div className="min-h-0 flex-1">
        {loaded && chat ? (
          <WorktreeChatPane chatId={chatId} popped />
        ) : (
          <div className="grid h-full place-items-center p-6">
            <p className="max-w-xs text-center text-xs text-muted-foreground">
              {loaded
                ? "That chat is not in the workspace any more."
                : "Opening…"}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
