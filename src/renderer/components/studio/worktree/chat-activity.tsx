import { useState, type ReactNode } from "react"
import { CircleAlert } from "lucide-react"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import {
  dayDividerBetween,
  isPending,
  summaryOf,
  type ActivityCounts,
  type ChatBlock,
} from "@/lib/worktree-chat/activity"
import {
  distinctFiles,
  groupOutcome,
  rowsOf,
  type ToolLine,
} from "@/lib/worktree-chat/tool-row"
import type { AssistantMessage } from "@shared/api"
import {
  ChatMessage,
  Chevron,
  OPENED,
  ObjectChip,
  Outcome,
  TOOL_ROW,
  TOOL_VERB,
} from "./chat-message"
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
 * **What is inside it is rows, not a second fold.** An open fold draws the
 * turn's narration as itself and each run of like calls as one row — see
 * `rowsOf`, which is where the argument for that lives.
 */
export function ChatActivity({
  of,
  live = false,
}: {
  of: Extract<ChatBlock, { kind: "activity" }>
  /** Whether this fold is the running turn's, which is the only time a call
   * with no result is still going rather than cut off. */
  live?: boolean
}) {
  return (
    <Fold counts={of.counts} lines={of.lines} live={live}>
      {rowsOf(of.lines).map((row) =>
        row.kind === "line" ? (
          <ChatMessage key={row.id} of={row.line} live={live} />
        ) : (
          <ToolGroup
            key={row.id}
            verb={row.verb}
            lines={row.lines}
            live={live}
          />
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

/**
 * A run of like calls as one row: `Read` and five file chips, `3 files` at
 * the end. The same grammar as a single call's row — verb, objects, outcome —
 * so the two read as one kind of line, and it opens onto the calls themselves
 * for the one that is wanted.
 *
 * The spinner where the mark goes while one of them is still out, which is
 * the same place a single row says it.
 */
function ToolGroup({
  verb,
  lines,
  live,
}: {
  verb: string
  lines: ToolLine[]
  live: boolean
}) {
  const [open, setOpen] = useState(false)
  const running = live && lines.some(isPending)

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(TOOL_ROW, "hover:bg-muted/60 hover:text-foreground")}
      >
        <Chevron open={open} />
        {running ? (
          <Spinner
            aria-label="Running"
            className="size-3 shrink-0 translate-y-0.5 text-foreground/70"
          />
        ) : (
          toolMark(lines[0]!.name, "size-3 shrink-0 translate-y-0.5")
        )}
        <span className={TOOL_VERB}>{verb}</span>
        {/* Shrinks as one: a row of chips that each gave way would show the
            first file whole and the last as a sliver. */}
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
          {distinctFiles(lines).map((line) => (
            <ObjectChip key={line.id} of={line} />
          ))}
        </span>
        <Outcome text={groupOutcome(lines)} />
      </button>
      {open && (
        <div className={OPENED}>
          {lines.map((line) => (
            <ChatMessage key={line.id} of={line} live={live} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The fold itself: a summary that opens onto its rows.
 *
 * `children` is built by the caller whether or not the fold is open, which costs
 * an array of elements and no render: an element is not a mounted component, and
 * it is the mounting that `chat-message.tsx` is careful about.
 */
function Fold({
  counts,
  lines,
  live,
  children,
}: {
  counts: ActivityCounts
  lines: AssistantMessage[]
  live: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const marks = marksOf(lines)
  const running = live && Boolean(counts.pending)

  return (
    <div className={cn(open && "space-y-3")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left",
          "text-[0.7rem] text-muted-foreground outline-none",
          "hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        )}
      >
        <Chevron open={open} />
        {/* Said on the closed line because closed is how a turn is watched:
            what is running now, and that something failed, are the two
            things that cannot wait for somebody to think of opening it. */}
        {running && (
          <Spinner
            aria-hidden
            className="size-3 shrink-0 translate-y-0.5 text-foreground/70"
          />
        )}
        {!running && (counts.failed ?? 0) > 0 && (
          <CircleAlert
            aria-hidden
            className="size-3 shrink-0 translate-y-0.5 text-destructive/80"
          />
        )}
        <span className="truncate">{summaryOf(counts, live)}</span>
        {/* Hidden once it is open: the rows below say the same thing in full,
            and a summary beside them is the same fact twice. */}
        {!open && marks.length > 0 && (
          <span
            aria-hidden
            className="flex shrink-0 items-center gap-1 self-center"
          >
            {marks.map((name) => (
              <span key={name} className="contents">
                {toolMark(name, "size-3 opacity-70")}
              </span>
            ))}
          </span>
        )}
      </button>

      {open && <div className={cn(OPENED, "space-y-3")}>{children}</div>}
    </div>
  )
}
