import { useEffect, useRef } from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import type { OutlineEntry } from "@/lib/worktree-chat/outline"
import { IconButton } from "../icon-button"

/**
 * A chat's table of contents — what was asked, in order, as a column beside the
 * transcript. See `outlineOf` for why the entries are the user's lines alone.
 *
 * **A column rather than a popover**, because it is read *while* scrolling: a
 * list that closed on the first click would have to be reopened for every
 * entry, and the marked row following the reader down the conversation is half
 * of what it is for. Beside the transcript rather than over it, so it never
 * covers the text it indexes — the transcript is `max-w-2xl` and centred, so on
 * any pane wide enough to want this there is room.
 */
export function ChatOutline({
  entries,
  current,
  onPick,
  onClose,
}: {
  entries: OutlineEntry[]
  /** The entry the reader is in — see `currentEntry`. */
  current: number
  onPick: (id: string) => void
  onClose: () => void
}) {
  const list = useRef<HTMLOListElement>(null)

  // The marked row kept in view as the transcript scrolls under it: a long
  // chat's outline is taller than the column, and a marker that slid off the
  // bottom would stop saying anything.
  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${current}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [current])

  return (
    <nav
      aria-label="Table of contents"
      className="flex w-60 shrink-0 flex-col border-l"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 pr-1 pl-3">
        <span className="flex-1 text-[0.7rem] font-medium text-muted-foreground">
          Contents
          <span className="ml-1.5 tabular-nums opacity-70">
            {entries.length}
          </span>
        </span>
        <IconButton label="Close contents" side="bottom" onClick={onClose}>
          <X />
        </IconButton>
      </div>

      {entries.length === 0 ? (
        <p className="px-3 py-2 text-[0.7rem] text-muted-foreground">
          Nothing asked yet.
        </p>
      ) : (
        <ol ref={list} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {entries.map((entry, index) => (
            <li key={entry.id} data-index={index}>
              <button
                type="button"
                onClick={() => onPick(entry.id)}
                title={entry.label}
                aria-current={index === current ? "location" : undefined}
                className={cn(
                  "flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-xs",
                  "text-muted-foreground hover:bg-accent hover:text-foreground",
                  index === current && "bg-accent/60 text-foreground"
                )}
              >
                <span className="w-4 shrink-0 text-right text-[0.65rem] tabular-nums opacity-60">
                  {index + 1}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1">
                  {entry.label}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  )
}
