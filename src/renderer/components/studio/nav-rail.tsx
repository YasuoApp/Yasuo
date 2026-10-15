import type { ReactNode } from "react"
import { MessageSquare, Search, Settings, SquareTerminal } from "lucide-react"

import { cn } from "@/lib/utils"
import { useDock } from "@/lib/dock"
import { useProjects } from "@/lib/projects"
import { useWorkspaceSearch } from "@/lib/workspace-search"
import { useChats } from "@/lib/chat/store"
import { activityOf, activityTitle, isRunning } from "@/lib/chat/running"
import { unreadIn } from "@/lib/chat/unread"
import { PLUGIN_ICON_COMPONENTS } from "@/lib/plugins/icons"
import type { PluginRailButton } from "@/lib/plugins/registry"
import { usePlugins } from "@/lib/plugins/store"
import { AccountMenu } from "./account-menu"
import { IconButton } from "./icon-button"

/**
 * The window's leftmost strip: the ways into the rest of the window, one icon
 * each, and Settings at the foot.
 *
 * It took over from the project column's own 36px rail (`ProjectRail`, deleted).
 * That rail existed so a column collapsed to nothing still left its way back on
 * screen; this strip is on screen whatever the column is doing, so the column
 * can collapse to nothing and the button that reopens it is the first one here.
 *
 * Its own card rather than part of the column's, because it is not about the
 * workspace's projects — Search, the dock and Settings are the window's.
 */
export function NavRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  // "Showing" is the column open *on that view*: Search open hides the
  // projects as surely as a shut column does.
  const column = useProjects((state) => state.sidebar)
  const view = useProjects((state) => state.view)
  const toggleView = useProjects((state) => state.toggleView)
  const sidebar = column && view === "projects"
  const searching = column && view === "search"
  const dockOpen = useDock((state) => state.open)
  const pluginButtons = usePlugins((state) => state.railButtons)
  const toggleDock = useDock((state) => state.toggle)

  /*
   * Whether anything is running behind the shut column — the rows are gone, the
   * counts on them are gone, and a focused window rings no notification, so a
   * dot on the button that reopens it is what is left to say it.
   *
   * Every chat rather than the active project's: a shut column is not showing
   * which project is which, so a dot that counted one of them would go dark
   * while another was answering. Drawn only while the column is shut; open, the
   * rows say it themselves.
   */
  const chats = useChats((state) => state.chats)
  const sending = useChats((state) => state.sending)
  const asks = useChats((state) => state.asks)
  const unread = useChats((state) => state.unread)
  const activity = activityOf(chats, sending, asks)
  const running = !sidebar && isRunning(activity)
  // Second to `running`: a chat that has already answered, which leaves nothing
  // spinning and so is the case a shut column loses hardest.
  const news = !sidebar && !running && unreadIn(chats, unread) > 0

  return (
    <nav
      aria-label="Window"
      className="flex w-12 shrink-0 flex-col items-center gap-1 rounded-xl bg-background py-2 outline -outline-offset-1 outline-border"
    >
      <RailButton
        label={
          sidebar
            ? "Hide projects"
            : running
              ? `Show projects — ${activityTitle(activity)}`
              : news
                ? "Show projects — a chat has answered"
                : "Show projects"
        }
        pressed={sidebar}
        onClick={() => toggleView("projects")}
        tour="projects"
        dot={
          running
            ? activity.waiting > 0
              ? "animate-pulse bg-primary"
              : "bg-muted-foreground"
            : news
              ? "bg-primary"
              : undefined
        }
      >
        <MessageSquare />
      </RailButton>
      {/* The workspace's `Find in files`, in the left column — `⌘P` (the title
          bar's field) is still the way to go to a file or a chat by name. */}
      <RailButton
        label={searching ? "Hide search" : "Search files and chats"}
        pressed={searching}
        onClick={() => {
          toggleView("search")
          if (!searching) useWorkspaceSearch.getState().focus()
        }}
      >
        <Search />
      </RailButton>

      <div className="flex-1" />

      {/* What plugins add, at the foot beside Settings rather than under
          Search: a plugin's button runs something — the built-in `usage`
          plugin's dashboard (`plugins/usage/`) is a dialog — and has no pressed
          state, so beside the column's two views it read as a third. Above
          Terminal, so the foot's two stay put however many plugins there are. */}
      {pluginButtons.map((button) => {
        const Icon = PLUGIN_ICON_COMPONENTS[button.icon]
        return (
          <RailButton
            key={button.id}
            label={button.label}
            onClick={() => void runRailButton(button)}
          >
            <Icon />
          </RailButton>
        )
      })}
      <RailButton
        label="Terminal"
        pressed={dockOpen}
        onClick={toggleDock}
        tour="terminal"
      >
        <SquareTerminal />
      </RailButton>
      <RailButton label="Settings" onClick={onOpenSettings}>
        <Settings />
      </RailButton>
      {/* Last, so it is the corner of the window whatever the rail holds above
          it. Who is signed in is the window's, not a setting's. */}
      <AccountMenu />
    </nav>
  )
}

/** One plugin's rail button, a throw reported in the plugin's name — the
 * button has nothing of its own on screen to show it in. */
async function runRailButton(button: PluginRailButton): Promise<void> {
  try {
    await button.run()
  } catch (error) {
    console.error(`[plugin ${button.pluginId}]`, error)
    usePlugins
      .getState()
      .notify(
        button.pluginId,
        `${button.label} failed: ${error instanceof Error ? error.message : String(error)}`
      )
  }
}

function RailButton({
  label,
  pressed,
  onClick,
  dot,
  tour,
  children,
}: {
  label: string
  pressed?: boolean
  onClick: () => void
  /** The classes of a mark over the button's corner, or nothing. */
  dot?: string
  /** The name the onboarding tour finds this button by (`data-tour`). */
  tour?: string
  children: ReactNode
}) {
  return (
    <div className="relative" data-tour={tour}>
      <IconButton
        label={label}
        side="right"
        pressed={pressed}
        onClick={onClick}
        className={cn(
          "size-8 [&_svg]:size-4",
          pressed && "bg-accent text-accent-foreground"
        )}
      >
        {children}
      </IconButton>
      {/* `pointer-events-none` so it never swallows the click meant for the
          button under it. */}
      {dot && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-background",
            dot
          )}
        />
      )}
    </div>
  )
}
