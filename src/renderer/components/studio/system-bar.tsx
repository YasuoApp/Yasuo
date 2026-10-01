import { useEffect } from "react"
import { Coins, Cpu, MemoryStick } from "lucide-react"

import type { ChatDigest, SystemUsage, WorkspaceFolder } from "@shared/api"
import { useSystemUsage } from "@/lib/system/usage"
import { useStudio } from "@/lib/store"
import { useUpdateWatch } from "@/lib/updates"
import { spentIn, useDigests } from "@/lib/worktree-chat/digests"
import { money } from "@/lib/worktree-chat/usage"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
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
        <Spend />
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

/**
 * What the workspace's chats have cost, beside what the machine is spending.
 *
 * The one figure in this row that is not about this second. It is here because
 * it is the same question the meters answer — what is this costing — asked of
 * the other resource the studio spends, and because there was nowhere else for
 * it: a total belongs to the workspace rather than to a chat, and every panel
 * here is about one project.
 *
 * **Since the beginning, not today.** A turn's usage line carries what it cost
 * and not when it ran (see `TurnUsage`), so "today" would be a figure worked out
 * from a chat's `updatedAt` — the time of its *last* line, which for a
 * conversation resumed this morning would count last week's turns as today's. A
 * number that is honest and coarse beats one that is precise about the wrong
 * thing; the breakdown per project is on the tooltip, where the width is.
 *
 * Drawn only once there is something to say. A `$0.00` in the corner of a fresh
 * workspace is a claim, and what it would mean — nothing has been spent, or
 * nothing has been read yet — are two different states.
 */
function Spend() {
  const digests = useDigests((state) => state.digests)
  const folders = useStudio((state) => state.folders)
  /*
   * Re-read when the chat listing moves, which is what a turn ending does
   * (`done` re-reads it) — so the figure lands with the answer rather than on a
   * clock of its own. The `Changes` list's own watcher refreshes this too, for
   * the filter above it; both are the same call, and neither is a timer.
   */
  const chats = useWorktreeChats((state) => state.chats)
  useEffect(() => {
    void useDigests.getState().refresh()
  }, [chats])

  const total = spentIn(digests)
  if (total.turns === 0) return null

  return (
    <>
      <span className="text-muted-foreground/40">·</span>
      <span
        className="flex shrink-0 items-center gap-1.5 tabular-nums"
        title={spendTitle(digests, folders)}
      >
        <Coins className="size-3 shrink-0" />
        {money(total.costUsd)}
      </span>
    </>
  )
}

/** The same total said in full: per project, and what it is not counting. */
function spendTitle(digests: ChatDigest[], folders: WorkspaceFolder[]): string {
  const total = spentIn(digests)

  const perProject = folders
    .map((folder) => ({ folder, spent: spentIn(digests, folder.id) }))
    .filter(({ spent }) => spent.turns > 0)
    .sort((a, b) => b.spent.costUsd - a.spent.costUsd)
    .map(({ folder, spent }) => `${folder.name} — ${money(spent.costUsd)}`)

  return [
    `${money(total.costUsd)} across ${total.turns} ${
      total.turns === 1 ? "turn" : "turns"
    }, since this workspace's first chat.`,
    ...(perProject.length > 1 ? ["", ...perProject] : []),
    "",
    // The CLI's own estimate, said out loud: this is not read back from an
    // account, and a turn that crashed before it had a figure is not free.
    "The CLI's own estimate per turn, added up.",
    ...(total.unpriced > 0
      ? [
          `${total.unpriced} ${
            total.unpriced === 1 ? "turn is" : "turns are"
          } not in it: they reported no cost.`,
        ]
      : []),
  ].join("\n")
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
