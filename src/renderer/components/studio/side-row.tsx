import { useEffect, useRef, type MouseEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * One selectable row in a sidebar list: a file, or a table.
 *
 * Both sidebars had their own copy of this button — same height, same
 * active and hover treatment, but each written out by hand and neither
 * quite matching. `indent` is the tree depth; the base inset is built in so a
 * flat list and a nested one still align.
 *
 * A full-bleed row is the one place the shared `Button` has to be talked out of
 * its own shape — centred, rounded, inset — so that reshaping happens once,
 * here, rather than at each call site.
 *
 * Becoming the active row scrolls it into view. That belongs here rather than
 * in each sidebar for the same reason the rest of this does: every list has the
 * problem, since the thing on screen is often chosen from somewhere else — a
 * tab in the strip, the search palette, a definition jumped to — and a sidebar
 * that marks a row nobody can see has marked nothing. The tab strip has done
 * this since it was written; this is the same two lines for the other axis.
 */
/**
 * The shape of a row, apart from the button it usually is.
 *
 * Exported because a row is occasionally something else and still has to line up
 * with its neighbours to the pixel: the Explorer swaps a row for a text field
 * while it is being renamed, and an input inside a button is neither valid markup
 * nor a field that can be typed in. So the geometry is named here — one height,
 * one gap, one inset — rather than written out a second time where it would
 * quietly drift.
 */
// The height is the density setting's (`--density-row`, `lib/appearance.ts`)
// rather than `h-6`: this is the one row every list is built from, so it is
// the one place density has to be read for the whole sidebar to follow.
export const SIDE_ROW_SHAPE =
  "flex h-(--density-row) w-full items-center gap-1.5 pr-2 text-xs"

/** The inset for a row at `indent` levels deep. The base is built in, so a flat
 * list and a nested one align. */
export function sideRowIndent(indent: number): { paddingLeft: string } {
  return { paddingLeft: `${indent * 0.75 + 0.75}rem` }
}

export function SideRow({
  active = false,
  indent = 0,
  title,
  onClick,
  onDoubleClick,
  onContextMenu,
  className,
  children,
}: {
  active?: boolean
  indent?: number
  title?: string
  onClick?: () => void
  /** The second click, where the row has something more to mean by it — the
   * Explorer keeps a previewed file's tab. Both clicks still fire `onClick`,
   * which is what makes the pair "open it, then keep it". */
  onDoubleClick?: () => void
  /** For a row that carries its own right-click menu. */
  onContextMenu?: (event: MouseEvent) => void
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLButtonElement>(null)

  // `nearest`, so a row already on screen is left exactly where it is: the
  // alternative centres the list on every click, which reads as the sidebar
  // jumping away from the thing just clicked.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" })
  }, [active])

  return (
    <Button
      ref={ref}
      variant="ghost"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={title}
      aria-current={active ? "true" : undefined}
      style={sideRowIndent(indent)}
      className={cn(
        SIDE_ROW_SHAPE,
        "justify-start rounded-none font-normal",
        active
          ? // The bar is an *inset shadow* rather than a border: a full-bleed
            // row has no spare 2px to give a border, so one would shift every
            // label in the list sideways the moment its row was selected.
            "bg-accent text-accent-foreground shadow-[inset_2px_0_0_0_var(--primary)]"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        className
      )}
    >
      {children}
    </Button>
  )
}
