import { useEffect, useRef, type KeyboardEvent } from "react"
import { ChevronDown, ChevronUp, X } from "lucide-react"

import { IconButton } from "../icon-button"

/**
 * `⌘F` over a transcript — the bar an editor puts in the top-right corner.
 *
 * **A bar in the pane rather than a dialog over the window**, which is the whole
 * point of the key: `⌘P` is *go to* and takes the screen because what it finds
 * may be anywhere; `⌘F` is *find in this*, and what it finds is on the page
 * behind it. A palette would cover the thing being searched, which is the one
 * thing that must stay readable — every match is drawn in place, and the arrows
 * walk them under the bar.
 *
 * It carries what the count and the arrows need and nothing else. There is no
 * `Aa`, no whole-word and no `.*`: the match is the query as typed, case
 * ignored (`hitsIn`) — and three toggles nobody presses would be three controls
 * in the way of the count that everybody reads.
 *
 * **`n of m` counts occurrences**, which is the same thing the highlights count:
 * a word said twice in one message is two of them. It counted *messages* for a
 * version, and that was a count arguing with what it had just painted — three
 * marks on screen under a bar saying `2`.
 *
 * The input is **controlled and autofocused**, so `⌘F` is one gesture: press,
 * type, read the count. Enter and `⇧`-Enter are next and previous, Escape
 * closes — the bindings the same bar has in every editor, and the reason they
 * are handled on the input rather than on the window is that they mean nothing
 * anywhere else.
 */
export function ChatFind({
  query,
  opened,
  at,
  total,
  onQuery,
  onStep,
  onClose,
}: {
  query: string
  /** How many times `⌘F` has been pressed for this bar — see `find` in the
   * pane. Every press puts the caret back in the field and selects what is
   * there. */
  opened: number
  /** Which match the pane is on, zero-based — drawn as `at + 1`. */
  at: number
  total: number
  onQuery: (query: string) => void
  onStep: (by: number) => void
  onClose: () => void
}) {
  const field = useRef<HTMLInputElement>(null)

  // Focused on the press rather than with `autoFocus`, which fires only on the
  // first mount: `⌘F` with the bar already up is somebody asking for the field
  // and for the last query to be replaceable by typing, not for a second bar.
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [opened])

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== "Enter") return
    event.preventDefault()
    onStep(event.shiftKey ? -1 : 1)
  }

  return (
    <div
      /*
       * Over the transcript, against its top-right corner, the way an editor
       * hangs it. `absolute` inside the pane rather than in flow: a bar that
       * took a row of height would push the conversation down every time it
       * opened, which is the reader losing their place to a search they have not
       * typed yet.
       */
      className="absolute top-2 right-4 z-30 flex items-center gap-1 rounded-md border bg-popover/95 py-1 pr-1 pl-2 shadow-md backdrop-blur-sm"
      role="search"
    >
      <input
        ref={field}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in this chat"
        aria-label="Find in this chat"
        spellCheck={false}
        className="h-6 w-44 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
      />

      {/* What the search has to say, in the one place the eye is already
          looking. `No results` rather than `0 of 0`, which reads as a counter
          that has not been filled in — and nothing at all before anything is
          typed, since there is no question to answer yet. */}
      <span className="w-20 shrink-0 text-right text-[0.7rem] text-muted-foreground tabular-nums">
        {total > 0 ? `${at + 1} of ${total}` : query ? "No results" : ""}
      </span>

      <IconButton
        label="Previous match"
        side="bottom"
        disabled={total === 0}
        onClick={() => onStep(-1)}
      >
        <ChevronUp />
      </IconButton>
      <IconButton
        label="Next match"
        side="bottom"
        disabled={total === 0}
        onClick={() => onStep(1)}
      >
        <ChevronDown />
      </IconButton>
      <IconButton label="Close" side="bottom" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  )
}
