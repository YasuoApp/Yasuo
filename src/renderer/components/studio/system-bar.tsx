import { Cpu, MemoryStick } from "lucide-react"

import type { SystemUsage } from "@shared/api"
import { useSystemUsage } from "@/lib/system/usage"
import { useUpdateWatch } from "@/lib/updates"
import { Meter } from "./meter"
import { UpdatePill } from "./update-pill"

/**
 * What the machine has left, along the bottom of the window.
 *
 * The studio's work is the expensive kind — a `claude` turn, a Docker
 * database, a query returning more rows than expected — and the question this
 * answers is the one asked *while* that is happening: is the machine the thing
 * that is slow, and is it this app doing it. Which is why the app's own share
 * sits in the same row, on the same scale, rather than being a thing to go
 * and look up in Activity Monitor: the comparison is the whole point.
 *
 * At the bottom of the workbench rather than in the header, and never in the
 * way: this is a number to glance at, not one to act on, and the header is
 * already where the things you click live.
 */
export function SystemBar() {
  const usage = useSystemUsage()
  // Before the early return, and here rather than in `UpdatePill`: the pill
  // draws nothing until there is something to install, so it cannot be the
  // thing that keeps the check running.
  useUpdateWatch()

  // Nothing is drawn until the first reading lands — a row of empty meters
  // would be a claim that the machine is idle, which is not what "not yet
  // measured" means. It arrives within a frame or two of the app opening.
  if (!usage) return null

  const memoryPercent = memoryUsedPercent(usage)
  const freeText = `${bytes(usage.memoryAvailable)} free`

  return (
    // No edge or fill of its own: it sits on the canvas under the cards, which
    // is what separates it from them.
    <footer className="flex h-6 shrink-0 items-center gap-2 px-3 text-[11px] text-muted-foreground">
      <span
        className="flex shrink-0 items-center gap-1.5"
        title={cpuTitle(usage)}
      >
        <Cpu className="size-3 shrink-0" />
        <Meter percent={usage.cpuPercent} label="CPU in use" className="w-14" />
        <span className="tabular-nums">{Math.round(usage.cpuPercent)}%</span>
      </span>

      <span className="text-muted-foreground/40">·</span>

      <span
        className="flex min-w-0 shrink items-center gap-1.5"
        title={memoryTitle(usage)}
      >
        <MemoryStick className="size-3 shrink-0" />
        <Meter percent={memoryPercent} label="Memory in use" className="w-14" />
        {/* The free figure, not the used one: "how much is left" is the
            question, and the meter beside it already says how much is gone. */}
        <span className="truncate tabular-nums">{freeText}</span>
      </span>

      {/* Right-hand end, away from the machine's two: this app is a part of
          what those meters are already showing, not a third thing beside
          them, and a divider would suggest otherwise. The `ml-auto` is on the
          group rather than on the figures, so an update pill appearing beside
          them moves nothing else in the row. */}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <UpdatePill />
        <span
          className="flex shrink-0 items-center gap-1.5 tabular-nums"
          title={appTitle(usage)}
        >
          <span className="text-muted-foreground/70">This app</span>
          {formatPercent(usage.appCpuPercent)} CPU
          <span className="text-muted-foreground/40">·</span>
          {bytes(usage.appMemory)}
        </span>
      </span>
    </footer>
  )
}

function memoryUsedPercent(usage: SystemUsage): number {
  if (usage.memoryTotal <= 0) return 0
  const used = usage.memoryTotal - usage.memoryAvailable
  return Math.max(0, Math.min(100, (used / usage.memoryTotal) * 100))
}

function cpuTitle(usage: SystemUsage): string {
  return [
    `CPU ${Math.round(usage.cpuPercent)}% in use, ${Math.round(100 - usage.cpuPercent)}% idle`,
    `Across all ${usage.cores} cores, averaged over the last couple of seconds.`,
  ].join("\n")
}

function memoryTitle(usage: SystemUsage): string {
  const used = usage.memoryTotal - usage.memoryAvailable
  return [
    `Memory ${bytes(used)} in use of ${bytes(usage.memoryTotal)}`,
    `${bytes(usage.memoryAvailable)} available.`,
    "",
    // Worth saying, because it is why this figure is kinder than the one a
    // naive "free memory" reading would give — and than the one macOS itself
    // shows under "Memory Used".
    "Available counts cached memory the system would reclaim on demand,",
    "not only pages that are wholly free.",
  ].join("\n")
}

function appTitle(usage: SystemUsage): string {
  return [
    `Yasuo across ${usage.appProcesses} ${
      usage.appProcesses === 1 ? "process" : "processes"
    }`,
    `CPU ${formatPercent(usage.appCpuPercent)} of the machine — ${formatPercent(
      usage.appCoreCpuPercent
    )} of one core, which is the figure Activity Monitor shows.`,
    `Memory ${bytes(usage.appMemory)} resident.`,
    "",
    // The distinction that stops this reading as a bug: an agent chewing
    // through a turn is the user's own `claude`, and it costs what it costs
    // whether it was started from here or from a terminal.
    "Terminal panel sessions are separate processes and are not counted here.",
  ].join("\n")
}

/** One decimal below 10%, none above — the difference between 34% and 34.2%
 * is not something anybody reads a status bar for, but 0.4% and 0% are not
 * the same statement about an idle app. */
function formatPercent(percent: number): string {
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`
}

/** Bytes at the width a status bar has for them: GB once it is into them,
 * MB below, and never more than three significant figures. */
function bytes(value: number): string {
  const mb = value / 1024 ** 2
  if (mb >= 1024) {
    const gb = mb / 1024
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`
  }
  return `${Math.round(mb)} MB`
}
