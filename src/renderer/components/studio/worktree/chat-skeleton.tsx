import { Bot } from "lucide-react"
import { useEffect, useState } from "react"

import type { ChatAgent } from "@shared/api"
import { cn } from "@/lib/utils"
import { elapsed } from "@/lib/worktree-chat/since"

/**
 * What the chat pane shows while a turn is being sent: the loader, and how long
 * it has been going. Placeholder bars mimicking a turn's shape were tried here
 * and read as content arriving that never did — the rows a turn actually draws
 * land within a second of the spinner anyway.
 *
 * The loader is three dots hopping in turn and a light passing over `Working…`
 * (`styles/motion.css`). It was a GIF swordsman for a while, then a stock
 * spinner — `docs/design.md` § The chat's loading indicator has why.
 *
 * The dots sit in a `LOADER_H` box, and that box's height is on the label's
 * row too: the column is top-aligned so the agent rows hang under the label,
 * and the dots centre on that first row rather than on the whole column.
 */
export function ChatSkeleton({
  startedAt,
  agents = [],
}: {
  startedAt?: number
  /** The subagents running under this turn, if any — see `ChatAgent`. */
  agents?: ChatAgent[]
}) {
  return (
    <div className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
      <WorkingDots />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className={cn(LOADER_H, "flex items-center gap-2")}>
          <span className="text-shimmer">
            {/* The count on the loader's own line, because it is the answer to
                the question somebody is staring at it with: nothing is being
                written, and this says who is out there working. */}
            {agents.length > 0
              ? `Working · ${agents.length} ${agents.length === 1 ? "agent" : "agents"}…`
              : "Working…"}
          </span>
          {startedAt !== undefined && <Elapsed startedAt={startedAt} />}
        </div>

        {/* One line each, capped: a turn that fanned out to seven agents is the
            case this was written for, and seven full descriptions push the answer
            it is waiting for off the screen. The last tool is what shows movement
            — a name on its own for five minutes reads as something stuck. */}
        {agents.slice(0, AGENTS_SHOWN).map((agent) => (
          <div key={agent.id} className="text-[0.7rem]">
            <div className="flex items-baseline gap-1.5">
              <Bot className="size-3 shrink-0 translate-y-0.5 text-muted-foreground/50" />
              <span className="min-w-0 truncate text-muted-foreground/70">
                {agent.description}
              </span>
              {agent.lastTool && (
                <span className="shrink-0 font-mono text-muted-foreground/40">
                  {agent.lastTool}
                </span>
              )}
            </div>
            {/* Where it has got to, under what it was asked: the description
                is the same for the agent's whole life, and this is the line
                that moves. One line, so seven agents still fit. */}
            {agent.summary && (
              <div className="truncate pl-4.5 text-muted-foreground/50">
                {agent.summary}
              </div>
            )}
          </div>
        ))}
        {agents.length > AGENTS_SHOWN && (
          <div className="text-[0.7rem] text-muted-foreground/40">
            and {agents.length - AGENTS_SHOWN} more
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The spinner's row height, and the label row's, which have to be the same
 * number — see the alignment note above. One constant rather than `h-7` written twice,
 * because the two being equal is not a coincidence anyone reading them would
 * infer.
 */
const LOADER_H = "h-5"

/**
 * Three dots hopping in turn, in the theme's accent. The stagger is a third of
 * the hop's rise, so one dot is always on its way up — a wave rather than three
 * dots blinking together.
 */
function WorkingDots() {
  return (
    <div
      role="status"
      aria-label="Working"
      className={cn(LOADER_H, "flex shrink-0 items-center gap-1 px-0.5")}
    >
      {[0, 140, 280].map((delay) => (
        <span
          key={delay}
          aria-hidden
          className="size-1.25 animate-dot rounded-full bg-primary"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  )
}

/** How many agents are named before the rest become a count. Four is what fits
 * above the composer without the turn's own last line leaving the screen. */
const AGENTS_SHOWN = 4

/**
 * The running clock beside `Working…`.
 *
 * Its own component so the tick re-renders this line and not the transcript
 * above it — a pane of rendered markdown redrawn once a second is the whole
 * chat's worth of work for two changing characters.
 *
 * A second is also the resolution the label has, so a faster interval would
 * only produce renders that draw the same string. `tabular-nums` keeps a digit
 * changing from nudging the ones beside it.
 */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())

  // `now` is an absolute time rather than a duration, so it does not need
  // resetting when `startedAt` changes — the next tick is at most a second away
  // and the label's resolution is a second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <span className="text-muted-foreground/50 tabular-nums">
      {elapsed(startedAt, now)}
    </span>
  )
}

/**
 * Skeleton for a chat whose lines are still being read off disk — opening a
 * conversation for the first time this run.
 *
 * A different shape from `ChatSkeleton`, which is one turn being worked on at
 * the end of a transcript: this stands in for a whole conversation, so it is
 * alternating bubbles down the pane and says nothing about "working". Without
 * it the pane drew the welcome — "this chat is empty, ask it something" — for
 * the moment before the lines landed, which is the wrong thing to say about a
 * chat that has a hundred of them.
 */
export function ChatTranscriptSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-6" aria-hidden>
      {[0, 1, 2].map((turn) => (
        <div key={turn} className="flex flex-col gap-3">
          {/* The user's message: short, and to the right, as a real one is. */}
          <div className="flex justify-end">
            <SkeletonBlock
              lines={1}
              className="w-2/5"
              barClassName="h-8 rounded-lg"
            />
          </div>
          <SkeletonBlock
            lines={turn === 1 ? 4 : 3}
            className="ml-4"
            barClassName="h-3 rounded last:w-2/3"
          />
        </div>
      ))}
    </div>
  )
}

/**
 * A vertical stack of placeholder bars, each pulsing at the same rate.
 */
function SkeletonBlock({
  lines,
  className,
  barClassName,
}: {
  lines: number
  className?: string
  barClassName?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={cn("w-full bg-muted/50", barClassName ?? "h-3 rounded")}
        />
      ))}
    </div>
  )
}
