import { PanelRightClose, PanelRightOpen } from "lucide-react"

import { RAIL_WIDTH, useStudio } from "@/lib/store"
import { IconButton } from "../icon-button"

/**
 * The button against the window's right edge, and the whole of what stops the
 * Explorer's handle being a one-way door.
 *
 * The column is `collapsible`, so dragging its handle past the minimum shuts
 * it — and while it collapsed to nothing, the only way back was `⌘B` or the
 * View menu, neither of which is where somebody who has just dragged a column
 * shut is looking. The dock answered the same failure by collapsing to its own
 * tab row (`DOCK_STRIP_HEIGHT`); this is that turned on its side.
 *
 * Always on screen rather than only while collapsed: a button that appeared
 * when the column went would be somewhere different depending on the state it
 * is there to change.
 *
 * **It is positioned rather than laid out**, and that is the difference worth
 * knowing. It was a 36px flex column beside the tree first, which is the
 * honest way to build it and the wrong one: the tree paid that width on every
 * row for a button used at the top, and the column's own min/max had to be
 * written as "the tree's width plus the rail". Out of flow it costs the panel
 * nothing, and what is left to arrange is the one row it lands on — the tree's
 * header, which keeps its right padding clear for it.
 *
 * `RAIL_WIDTH` is the panel's `collapsedSize`, so a shut column is exactly this
 * button.
 */
export function ExplorerRail() {
  const sidebar = useStudio((state) => state.sidebar)
  const toggleSidebar = useStudio((state) => state.toggleSidebar)

  return (
    <div
      style={{ width: RAIL_WIDTH }}
      // `top-0`: the tree's header is the row it sits in, and the header keeps
      // its own bottom border across the full width now that this is out of
      // flow — so there is no line here for the button to be continuing.
      className="absolute top-0 right-0 flex h-9 items-center justify-center"
    >
      <IconButton
        label={sidebar ? "Hide Explorer" : "Show Explorer"}
        // Into the window rather than above: this is the last 36px before the
        // window's edge, and the default puts the tooltip over the title bar.
        side="left"
        onClick={toggleSidebar}
        className="size-6"
      >
        {sidebar ? (
          <PanelRightClose className="size-3.5" />
        ) : (
          <PanelRightOpen className="size-3.5" />
        )}
      </IconButton>
    </div>
  )
}
