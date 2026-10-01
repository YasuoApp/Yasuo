import { useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  dayDividerBetween,
  rowsOf,
  summaryOf,
  type ActivityCounts,
  type ChatBlock,
} from "@/lib/worktree-chat/activity"
import type { AssistantMessage } from "@shared/api"
import { ChatMessage } from "./chat-message"
import { marksOf, toolMark } from "./chat-marks"

/**
 * A turn's working, as one line that opens.
 *
 * **Closed by default, and that is the whole point.** A finished turn is read
 * for its answer; the seven tool calls under it are read when something looks
 * wrong, which is a different visit. Neither is served by a switch in Settings
 * that has to be found and flipped between the two — so the rows are always
 * there and always one click away.
 *
 * Open state is this component's own rather than the store's. A fold somebody
 * opened is a thing they are doing right now, not a preference; it belongs to
 * the mounted row the way a text selection does, and putting it in the store
 * would be a chat's file growing a field about how somebody was reading it.
 *
 * The marks after the summary are which *kinds* of tool ran, deduplicated —
 * scanning a closed transcript for "did this turn touch the shell" is the
 * question a fold would otherwise have to be opened to answer.
 *
 * **What is inside it folds again.** An open fold draws the turn's narration as
 * itself and each run of tool calls behind a fold of its own — see `rowsOf`,
 * which is where the argument for that lives.
 */
export function ChatActivity({
  of,
}: {
  of: Extract<ChatBlock, { kind: "activity" }>
}) {
  return (
    <Fold summary={summaryOf(of.counts)} lines={of.lines}>
      {rowsOf(of.lines).map((row) =>
        row.kind === "line" ? (
          <ChatMessage key={row.id} of={row.line} />
        ) : (
          <ToolRun key={row.id} counts={row.counts} lines={row.lines} />
        )
      )}
    </Fold>
  )
}

/**
 * The rule between two top-level blocks that fall on different days, with the
 * day's name on it: `Today`, `Yesterday`, `Mon 29 Sep`.
 *
 * Drawn by the pane between consecutive blocks — it is given the pair rather
 * than the list, so the decision (`dayDividerBetween`, pure and tested) and
 * the drawing stay apart. Null when no divider belongs there, which is most
 * pairs: a chat is usually an afternoon, and the rule earns its place on the
 * one that was picked up again the next morning. The same shape as the
 * compaction boundary in `chat-message.tsx`, since both are a line with a side.
 */
export function DayDivider({
  before,
  after,
}: {
  before: ChatBlock
  after: ChatBlock
}) {
  const label = dayDividerBetween(before, after)
  if (!label) return null
  return (
    <div
      role="separator"
      className="flex items-center gap-2 px-1 py-0.5 text-[0.7rem] text-muted-foreground/80"
    >
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

/** A run of tool calls inside an open fold. */
function ToolRun({
  counts,
  lines,
}: {
  counts: ActivityCounts
  lines: AssistantMessage[]
}) {
  return (
    <Fold summary={summaryOf(counts)} lines={lines}>
      {lines.map((line) => (
        <ChatMessage key={line.id} of={line} />
      ))}
    </Fold>
  )
}

/**
 * The fold itself: a summary that opens onto its rows.
 *
 * Shared by both levels rather than written twice, because the inner one is the
 * outer one applied again — a chevron that behaved differently one level down
 * would read as a different control.
 *
 * `children` is built by the caller whether or not the fold is open, which costs
 * an array of elements and no render: an element is not a mounted component, and
 * it is the mounting that `chat-message.tsx` is careful about.
 */
function Fold({
  summary,
  lines,
  children,
}: {
  summary: string
  lines: AssistantMessage[]
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const marks = marksOf(lines)

  return (
    <div className={cn(open && "space-y-3")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left",
          "text-[0.7rem] text-muted-foreground outline-none",
          "hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        )}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="truncate">{summary}</span>
        {/* Hidden once it is open: the rows below say the same thing in full,
            and a summary beside them is the same fact twice. */}
        {!open && marks.length > 0 && (
          <span aria-hidden className="flex shrink-0 items-center gap-1">
            {marks.map((name) => (
              <span key={name} className="contents">
                {toolMark(name, "size-3 opacity-70")}
              </span>
            ))}
          </span>
        )}
      </button>

      {/* A rule dropping from the chevron, with the turn's rows pushed off it.
          `ml-2.5` puts it under the glyph's centre (the button's `px-1` plus
          half of `size-3`), so an open fold reads as the working *belonging to*
          that line — which is the only thing saying where a long turn's rows
          end and the next block begins. */}
      {open && (
        <div className="ml-2.5 space-y-3 border-l pl-2.5">{children}</div>
      )}
    </div>
  )
}
