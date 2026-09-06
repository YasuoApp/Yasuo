import { PanelLeftClose, PanelLeftOpen } from "lucide-react"

import { cn } from "@/lib/utils"
import { useProjects } from "@/lib/projects"
import { RAIL_WIDTH } from "@/lib/store"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
import {
  activityOf,
  activityTitle,
  isRunning,
} from "@/lib/worktree-chat/running"
import { unreadIn } from "@/lib/worktree-chat/unread"
import { IconButton } from "../icon-button"

/**
 * The left column's toggle, and the mirror of Explorer's — same width, same
 * argument, same failure it was written against: a column that collapses to
 * nothing leaves nowhere to hold the way back.
 *
 * It used to be in the column's own top row beside the traffic lights, and that
 * row had to be drawn twice — once in the column, once in the crumb bar — so
 * that the button could survive the column it collapsed. See `WindowLeftEdge`,
 * which is now the clearance and nothing else.
 *
 * **On the column's inner edge, not the window's.** Explorer's is against the
 * window because that is the side its column is collapsible from, and this one
 * is for the same reason: the handle it undoes is on the right of this column,
 * so the button belongs at the end the column moves from. It also keeps the
 * window's left edge to the traffic lights alone.
 *
 * Out of flow (`absolute`) for the reason Explorer's is: in flow it charged the
 * project list 36px of width on every row for a button used at the top.
 */
export function ProjectRail() {
  const sidebar = useProjects((state) => state.sidebar)
  const toggleSidebar = useProjects((state) => state.toggleSidebar)

  /*
   * Whether anything is running behind the shut column.
   *
   * The column collapsed is the case the whole activity story is weakest in:
   * the rows are gone, the counts on them are gone, and a focused window rings
   * no notification. What is left is 36px, so what it can carry is a dot — the
   * one thing this rail can say is "there is something in there", and the way
   * to the rest is the button it sits on.
   *
   * Every chat rather than the active project's: a shut column is not showing
   * which project is which, so a dot that counted only one of them would go
   * dark while another project was answering.
   */
  const chats = useWorktreeChats((state) => state.chats)
  const sending = useWorktreeChats((state) => state.sending)
  const asks = useWorktreeChats((state) => state.asks)
  const unread = useWorktreeChats((state) => state.unread)
  const activity = activityOf(chats, sending, asks)
  // Drawn only while the column is shut. Open, the rows themselves say it, and
  // a dot beside a list that is already spinning is a second thing to read.
  const running = !sidebar && isRunning(activity)
  /*
   * And the case the shut column loses hardest: a chat that has already
   * finished. Nothing is running, so the dot above goes dark, and the news that
   * a turn landed is behind 36px of nothing. Second to `running`, because a
   * project still working is the more immediate of the two.
   */
  const news = !sidebar && !running && unreadIn(chats, unread) > 0

  return (
    <div
      style={{ width: RAIL_WIDTH }}
      // `h-9` to put this button on the same line as the Explorer rail's, which
      // is the height of the tree's header over there. `top-0` is the top of
      // the column *under* its window strip, so the traffic lights are never
      // over it.
      className="absolute top-0 right-0 flex h-9 items-center justify-center"
    >
      <IconButton
        label={
          sidebar
            ? "Hide projects"
            : running
              ? `Show projects — ${activityTitle(activity)}`
              : news
                ? "Show projects — a chat has answered"
                : "Show projects"
        }
        // Into the window rather than above: the crumb bar is directly over
        // this, and the default would put the tooltip on it.
        side="bottom"
        onClick={toggleSidebar}
        className="size-6"
      >
        {sidebar ? (
          <PanelLeftClose className="size-3.5" />
        ) : (
          <PanelLeftOpen className="size-3.5" />
        )}
      </IconButton>

      {/*
        Over the button's corner rather than beside it: there is no width here
        for a second thing in flow, and the dot is a mark *on* the way back
        rather than an item of its own. `pointer-events-none` so it never
        swallows the click meant for the button under it.
      */}
      {(running || news) && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-1.5 right-1.5 size-1.5 rounded-full ring-2 ring-background",
            // The same split the rows make: waiting is somebody's to act on and
            // takes the hue, working is furniture. An answer nobody has read is
            // the first of those and takes the hue too — but still, since it has
            // already happened.
            running
              ? activity.waiting > 0
                ? "animate-pulse bg-primary"
                : "bg-muted-foreground"
              : "bg-primary"
          )}
        />
      )}
    </div>
  )
}
