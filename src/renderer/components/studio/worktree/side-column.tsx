import { useRef, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

const DEFAULT_WIDTH = 240
const MIN_WIDTH = 200
/** Past this the transcript, `max-w-2xl` and centred, starts losing its own
 * width rather than its margins. Also never more than half the pane. */
const MAX_WIDTH = 560

/**
 * The width last dragged to, for every chat and for both columns — they take
 * the same slot, so one that came back narrower than the other was left would
 * move the transcript on every switch. In memory and per run, like the pane's
 * `sideShown`; behind a function so a render never writes it.
 */
let remembered = DEFAULT_WIDTH
function remember(width: number): void {
  remembered = width
}

/**
 * The column beside the transcript — the table of contents or the shared media
 * — with a handle on its left edge to drag it wider. Double-clicking the handle
 * puts it back.
 *
 * A handle of its own rather than `react-resizable-panels`, which the studio's
 * cards use: that is a group of sized panels, and the transcript beside this is
 * a scroll whose position the pane measures and restores — a second layout
 * owner around it was more to get wrong than a pointer drag.
 */
export function SideColumn({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  const [width, setWidth] = useState(remembered)
  const [dragging, setDragging] = useState(false)
  const column = useRef<HTMLElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)

  const clamp = (value: number): number => {
    const pane = column.current?.parentElement?.clientWidth ?? Infinity
    return Math.round(Math.max(MIN_WIDTH, Math.min(value, MAX_WIDTH, pane / 2)))
  }

  return (
    <nav
      ref={column}
      aria-label={label}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label.toLowerCase()}`}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        title="Drag to resize, double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, width }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start) return
          // The handle is on the left edge, so dragging left widens it.
          setWidth(clamp(start.width + start.x - event.clientX))
        }}
        onPointerUp={() => {
          if (!drag.current) return
          drag.current = null
          setDragging(false)
          remember(width)
        }}
        onPointerCancel={() => {
          drag.current = null
          setDragging(false)
        }}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH)
          remember(DEFAULT_WIDTH)
        }}
        className={cn(
          "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize",
          "after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors hover:after:bg-ring/60",
          dragging && "after:bg-ring/60"
        )}
      />
      {children}
    </nav>
  )
}
