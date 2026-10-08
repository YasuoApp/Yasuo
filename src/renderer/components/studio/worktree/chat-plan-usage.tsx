import { useEffect, useRef, useState } from "react"
import { Gauge, RefreshCw } from "lucide-react"

import type { PlanWindow } from "@shared/api"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  headlineWindow,
  percent,
  planName,
  resetLabel,
  usageTone,
  usePlanUsage,
  windowLabel,
  windowShort,
} from "@/lib/worktree-chat/plan-usage"
import { IconButton } from "../icon-button"

/**
 * How much of the claude.ai plan this chat's account has used, beside the
 * context meter in the composer's toolbar — the numbers `/usage` prints.
 *
 * In the toolbar rather than in a corner of the window because it is about the
 * message about to be sent: the account is the chat's (`profileId`), so two
 * chats on two profiles show two meters, and the one in front of somebody is
 * the one they are about to spend. See `main/plan-usage.ts` for the asking.
 *
 * Asked on mount (main holds a minute per account, so a switch between chats
 * is free), again **fresh** when a turn ends — the moment the number moved —
 * and on Refresh. Nothing is drawn for an account the plan limits do not apply
 * to (an API key, Bedrock, Vertex), or before the first answer: a meter at 0%
 * would be claiming an empty window nobody has measured.
 */
export function PlanUsageMeter({
  profileId,
  sending,
}: {
  profileId: string | null
  sending: boolean
}) {
  const key = profileId ?? ""
  const usage = usePlanUsage((state) => state.byProfile[key])
  const loading = usePlanUsage((state) => state.loading.includes(key))
  const load = usePlanUsage((state) => state.load)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void load(profileId)
  }, [load, profileId])

  // A turn ending is what spends the plan, so it is when to look again.
  const wasSending = useRef(sending)
  useEffect(() => {
    if (wasSending.current && !sending) void load(profileId, true)
    wasSending.current = sending
  }, [sending, load, profileId])

  if (!usage || (!usage.available && !usage.error)) return null

  const headline = headlineWindow(usage.windows)
  const tone = headline ? usageTone(headline.utilization) : "ok"
  const now = new Date()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={
              headline
                ? `${windowLabel(headline.id)} limit: ${percent(headline.utilization)} used${
                    resetLabel(headline.resetsAt, now)
                      ? `, ${resetLabel(headline.resetsAt, now)}`
                      : ""
                  }`
                : "Plan usage"
            }
            aria-label="Plan usage"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[0.7rem] tabular-nums",
              "transition-colors hover:bg-accent data-[popup-open]:bg-accent",
              toneClass(tone)
            )}
          >
            <Gauge className="size-3 shrink-0" />
            {headline ? (
              <>
                {windowShort(headline.id)}
                <Bar utilization={headline.utilization} />
                {percent(headline.utilization)}
              </>
            ) : (
              "Usage"
            )}
          </button>
        }
      />
      <PopoverContent align="start" className="w-64 gap-0 p-0">
        <div className="flex items-center gap-2 border-b py-1.5 pr-1.5 pl-3">
          <p className="flex-1 text-xs font-medium">
            Plan usage
            {planName(usage.subscription) && (
              <span className="ml-1.5 font-normal text-muted-foreground">
                {planName(usage.subscription)}
              </span>
            )}
          </p>
          <IconButton
            label="Refresh"
            side="bottom"
            disabled={loading}
            onClick={() => void load(profileId, true)}
            className="size-6 shrink-0"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </IconButton>
        </div>

        {usage.error ? (
          <p className="p-3 text-xs text-destructive">{usage.error}</p>
        ) : usage.windows.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            Claude reported no usage windows for this plan.
          </p>
        ) : (
          <div className="space-y-2.5 p-3">
            {usage.windows.map((window) => (
              <WindowRow key={window.id} window={window} now={now} />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function WindowRow({ window, now }: { window: PlanWindow; now: Date }) {
  const tone = usageTone(window.utilization)
  const reset = resetLabel(window.resetsAt, now)
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="flex-1">{windowLabel(window.id)}</span>
        <span className={cn("tabular-nums", toneClass(tone))}>
          {percent(window.utilization)}
        </span>
      </div>
      <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            tone === "high"
              ? "bg-destructive"
              : tone === "warn"
                ? "bg-amber-500"
                : "bg-foreground/60"
          )}
          style={{ width: `${window.utilization}%` }}
        />
      </div>
      {reset && <p className="text-[0.65rem] text-muted-foreground">{reset}</p>}
    </div>
  )
}

/** The button's own bar: it **fills**, since the label counts up — the
 * context meter beside it drains for the opposite reason. */
function Bar({ utilization }: { utilization: number }) {
  return (
    <span
      aria-hidden
      className="h-1 w-6 overflow-hidden rounded-full bg-border"
    >
      <span
        className="block h-full rounded-full bg-current transition-[width]"
        style={{ width: `${utilization}%` }}
      />
    </span>
  )
}

function toneClass(tone: "ok" | "warn" | "high"): string {
  return tone === "high"
    ? "text-destructive"
    : tone === "warn"
      ? "text-amber-600 dark:text-amber-500"
      : "text-muted-foreground"
}
