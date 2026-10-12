import { useEffect, useRef, useState, type RefObject } from "react"
import { Reply } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The `Reply` that appears beside a run of the transcript somebody selected.
 *
 * **Why a button on the selection and not a row action.** A reply is about a
 * *sentence* — "this part, why did you do it that way" — and a row's copy
 * button is about the whole message. The selection already says which part;
 * the button only has to be where the selection ended, which is where the
 * eye is.
 *
 * Shown once the mouse is up rather than as the selection grows, because a
 * button that follows the drag sits under the cursor the moment it stops and
 * takes the click that was meant to extend the selection. Keyboard selection
 * has no drag, so it shows as it changes. Hidden the moment the selection
 * leaves the transcript or collapses — a click anywhere does both — and it
 * keeps the selection alive through its own click (`preventDefault` on mouse
 * down), since a button that cleared the words it was about to quote would
 * quote nothing.
 *
 * Positioned fixed, off the selection's last client rect, so it sits under
 * the end of the run wherever in the scroll the run is; the pane's own scroll
 * moves it along (`scroll` on capture — the scroll container is not this
 * component's).
 */
export function ReplyToSelection({
  within,
  onReply,
}: {
  /** The transcript — a selection outside it is somebody else's. */
  within: RefObject<HTMLElement | null>
  onReply: (text: string) => void
}) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(
    null
  )
  const dragging = useRef(false)

  useEffect(() => {
    const read = () => {
      const root = within.current
      const selection = document.getSelection()
      if (
        !root ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        setAt(null)
        return
      }
      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) {
        setAt(null)
        return
      }
      const text = selection.toString()
      if (!text.trim()) {
        setAt(null)
        return
      }
      const rects = range.getClientRects()
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
      setAt({ x: last.right, y: last.bottom, text })
    }

    const onSelection = () => {
      if (dragging.current) setAt(null)
      else read()
    }
    const onDown = (event: MouseEvent) => {
      // The button's own press is not the start of a drag — and not a reason
      // to hide what the press is for.
      if ((event.target as HTMLElement | null)?.closest?.("[data-reply]"))
        return
      dragging.current = true
      setAt(null)
    }
    const onUp = () => {
      dragging.current = false
      read()
    }

    document.addEventListener("selectionchange", onSelection)
    document.addEventListener("mousedown", onDown)
    document.addEventListener("mouseup", onUp)
    document.addEventListener("scroll", read, true)
    return () => {
      document.removeEventListener("selectionchange", onSelection)
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("mouseup", onUp)
      document.removeEventListener("scroll", read, true)
    }
  }, [within])

  if (!at) return null

  return (
    <button
      type="button"
      data-reply
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onReply(at.text)
        document.getSelection()?.removeAllRanges()
        setAt(null)
      }}
      style={{
        // Right-aligned to where the run ended, and kept on screen when the
        // run ended against the left edge.
        left: Math.max(at.x, 72),
        top: at.y + 6,
      }}
      className={cn(
        "fixed z-20 flex -translate-x-full items-center gap-1 rounded-md border",
        "bg-popover px-2 py-1 text-[0.7rem] text-popover-foreground shadow-md",
        "outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      )}
    >
      <Reply className="size-3" />
      Reply
    </button>
  )
}
