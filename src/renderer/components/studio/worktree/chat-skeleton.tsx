import { Bot } from "lucide-react"
import { useEffect, useState } from "react"

import type { ChatAgent } from "@shared/api"
import { cn } from "@/lib/utils"
import { YasuoLoader } from "@/components/studio/yasuo-loader"
import { elapsed } from "@/lib/worktree-chat/since"

/**
 * What the chat pane shows while a turn is being sent: the loader, and how long
 * it has been going. Placeholder bars mimicking a turn's shape were tried here
 * and read as content arriving that never did — the rows a turn actually draws
 * land within a second of the spinner anyway.
 *
 * This was a 12px `Spinner` on the same line as the label. It is the one of the
 * app's four busy indicators with room for a drawing: the other three
 * (`tab-items.tsx`, `board-card.tsx`, `projects-section.tsx`) are 12–14px icon
 * slots in a row of text, and a 433x230 drawing scaled into one of those is a
 * smudge. They keep their `Loader2`.
 *
 * The loader is 28px, so the label and the agent rows are a **column beside it**
 * rather than lines indented past it. The old layout hung the agent rows off a
 * `pl-5` that had to equal the icon's width plus the gap; a flex column cannot
 * drift out of alignment with the thing above it.
 *
 * `LOADER_H` is on the loader *and* on the label's row, and that pairing is the
 * whole of the vertical alignment: the column is top-aligned, so without a first
 * row as tall as the drawing the label sits against the top of a 28px box and
 * reads as floating above it. Centring the column instead would put the loader
 * halfway down once a few agent rows appear.
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
      {/* `label` stays plain English: it is the accessible name, and a screen
          reader announcing a pun is a screen reader announcing nothing. */}
      <YasuoLoader className={cn(LOADER_H, "shrink-0")} label="Working" />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className={cn(LOADER_H, "flex items-center gap-2")}>
          <span className="text-muted-foreground/60">
            {/* The count on the loader's own line, because it is the answer to
                the question somebody is staring at it with: nothing is being
                written, and this says who is out there working. */}
            {agents.length > 0
              ? `Hasaging · ${agents.length} ${agents.length === 1 ? "agent" : "agents"}…`
              : "Hasaging…"}
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
 * The loader's height, and the label row's, which have to be the same number —
 * see the alignment note above. One constant rather than `h-7` written twice,
 * because the two being equal is not a coincidence anyone reading them would
 * infer.
 */
const LOADER_H = "h-7"

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
