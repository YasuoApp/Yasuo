import { useEffect } from "react"
import { ClipboardList } from "lucide-react"

import { unreadWatchCount, useClickup } from "@/lib/clickup/store"
import { cn } from "@/lib/utils"

/**
 * The whole of what the ClickUp watcher puts in the left column: one button.
 *
 * **It was a section, with the tasks listed under a header.** That is deleted.
 * A watched task is a name, a status and a history of sentences, and a column
 * two hundred pixels wide can hold the first of those honestly and the third
 * not at all — so the list took a third of the column's height to say less than
 * the pane says in a glance. What belongs in a column that narrow is the one
 * fact somebody needs from it without opening anything: **whether something has
 * happened**. That is this button and its count.
 *
 * It sits at the left end of the footer bar, which is the end that has stood
 * empty since the Database and API panels took their window buttons with them.
 * `docs/design.md` § Watching ClickUp tasks has the rest.
 */
export function ClickupButton() {
  const watches = useClickup((state) => state.watches)
  const unread = unreadWatchCount(watches)

  return (
    <button
      type="button"
      // `""` rather than an id: this button is about the list, so the tab
      // opens on whichever task was last read, or the first. A row inside the
      // pane opens it *at* something; nothing out here knows which task is
      // worth landing on.
      onClick={() => useClickup.getState().show("")}
      title={
        watches.length === 0
          ? "Watch a ClickUp task"
          : unread > 0
            ? `ClickUp — ${unread} of ${watches.length} with something new`
            : `ClickUp — watching ${watches.length}`
      }
      className={cn(
        "flex h-5 shrink-0 items-center gap-1.5 rounded px-1.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        unread > 0
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      <ClipboardList className="size-3.5 shrink-0" />
      {unread > 0 && (
        // The count, not a dot: "three tasks have moved" is worth crossing the
        // window for and "one has" often is not. The ClickUp tab carries the
        // same number when it is open, which is the point: once it is, this
        // button is behind whatever is being read.
        <span className="rounded-full bg-primary/15 px-1.5 text-[0.625rem] font-medium text-primary tabular-nums">
          {unread}
        </span>
      )}
    </button>
  )
}

/**
 * Reads the watch list once and takes what main pushes afterwards.
 *
 * Held by the **column** rather than by the pane, and that is the whole point:
 * a pane is mounted only once it has been shown and is unmounted with its tab,
 * and the count on the button has to be right when it has not — which is every
 * moment that matters, since the count is what makes somebody open it. The
 * column is never unmounted, only made `invisible` with its panel.
 */
export function useClickupWatches(): void {
  useEffect(() => {
    void useClickup.getState().refresh()
    return window.desktop.onClickupWatches((next) => {
      useClickup.getState().accept(next)
    })
  }, [])
}
