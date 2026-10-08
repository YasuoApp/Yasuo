import type { ReactNode } from "react"
import {
  ChartColumn,
  MessageSquare,
  Search,
  Settings,
  SquareTerminal,
  Workflow,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { useDock } from "@/lib/dock"
import { useProjects } from "@/lib/projects"
import { useWorkspaceSearch } from "@/lib/workspace-search"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
import {
  activityOf,
  activityTitle,
  isRunning,
} from "@/lib/worktree-chat/running"
import { unreadIn } from "@/lib/worktree-chat/unread"
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
export function NavRail({
  onOpenSettings,
  onOpenCosts,
}: {
  onOpenSettings: () => void
  onOpenCosts: () => void
}) {
  // "Showing" is the column open *on that view*: Search open hides the
  // projects as surely as a shut column does.
  const column = useProjects((state) => state.sidebar)
  const view = useProjects((state) => state.view)
  const toggleView = useProjects((state) => state.toggleView)
  const sidebar = column && view === "projects"
  const searching = column && view === "search"
  const workflows = column && view === "workflows"
  const dockOpen = useDock((state) => state.open)
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
  const chats = useWorktreeChats((state) => state.chats)
  const sending = useWorktreeChats((state) => state.sending)
  const asks = useWorktreeChats((state) => state.asks)
  const unread = useWorktreeChats((state) => state.unread)
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
      {/* The workspace's workflows, drawn on a canvas — the column lists them
          and a row opens one in the pane. See `docs/design.md` § Workflows. */}
      <RailButton
        label={workflows ? "Hide workflows" : "Workflows"}
        pressed={workflows}
        onClick={() => toggleView("workflows")}
      >
        <Workflow />
      </RailButton>
      {/* What every chat has cost, as a dialog — see `CostDashboard`. */}
      <RailButton label="Costs" onClick={onOpenCosts}>
        <ChartColumn />
      </RailButton>

      <div className="flex-1" />

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
    </nav>
  )
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
