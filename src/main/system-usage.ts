import os from "node:os"

import type { SystemUsage } from "../shared/api"

/** The part of `SystemUsage` that is this app's own rather than the machine's —
 * asked of the host, since what "this app" is differs between Electron's
 * family of processes and the server's one. */
export type AppShare = Pick<
  SystemUsage,
  "appCpuPercent" | "appCoreCpuPercent" | "appMemory" | "appProcesses"
>

/**
 * What the machine has left, and what this app is taking of it.
 *
 * Every figure here is a *delta*, measured from the last time this was called
 * rather than from boot: a CPU percentage is meaningless without a span of
 * time to average over, and the span this app cares about is "since the bar
 * last drew". That makes the function stateful — two calls a millisecond
 * apart leave the second one nothing to divide by — which is why the renderer
 * runs one poller for the whole window instead of one per component
 * (`lib/system/usage.ts`).
 *
 * Nothing is shelled out to. `top`/`vm_stat`/`ps` would each be a per-poll
 * process spawn to learn what `os.cpus()` and Chromium's own accounting
 * already have, and the app polls this every couple of seconds.
 */
export function systemUsage(
  appShare: (cores: number) => AppShare
): SystemUsage {
  const cores = os.cpus().length
  return {
    cpuPercent: machineCpuPercent(),
    cores,
    ...memory(),
    ...appShare(cores),
  }
}

/** Cumulative busy/total tick counts across every core, as `os.cpus()` reports
 * them since boot. Only the difference between two of these means anything. */
type CpuSample = { busy: number; total: number }

/**
 * Primed at import — which happens with `createIpc()`, at startup — so the
 * first reading the renderer asks for is measured against app launch rather
 * than against boot, where it would be an average over however many days the
 * machine has been up.
 */
let previous = cpuSample()

/** The last percentage actually measured, held so that a poll with no elapsed
 * ticks to divide repeats it rather than dropping the bar to zero. */
let lastCpuPercent = 0

function cpuSample(): CpuSample {
  let busy = 0
  let total = 0
  for (const core of os.cpus()) {
    for (const [mode, ticks] of Object.entries(core.times)) {
      total += ticks
      if (mode !== "idle") busy += ticks
    }
  }
  return { busy, total }
}

/**
 * How much of the machine's total capacity was busy since the last call, 0–100
 * — all cores together, so a single core pinned on a ten-core machine reads
 * 10% rather than 100%. That is the scale the question "how much is left" is
 * asked on.
 */
function machineCpuPercent(): number {
  const current = cpuSample()
  const busy = current.busy - previous.busy
  const total = current.total - previous.total
  previous = current

  if (total <= 0) return lastCpuPercent
  lastCpuPercent = clampPercent((busy / total) * 100)
  return lastCpuPercent
}

/**
 * Total and *available* physical memory, in bytes.
 *
 * `os.freemem()` is the wrong number to answer this with on macOS: it counts
 * only wholly free pages, so a healthy machine with gigabytes of reclaimable
 * file cache reports tens of megabytes free and the bar sits pinned at 100%
 * for the life of the app. Chromium already computes the honest figure —
 * free plus file-backed plus purgeable, all of which the kernel will hand back
 * on demand — and `process.getSystemMemoryInfo()` exposes the pieces, in
 * kilobytes.
 *
 * The extra fields are macOS-only and absent from Electron's typings, so they
 * are read defensively: a platform that does not report them falls back to
 * free pages alone, which is what "available" means there anyway.
 */
function memory(): { memoryTotal: number; memoryAvailable: number } {
  try {
    // Electron's addition to `process`, absent under plain Node — the server
    // build lands in the `catch` and reports free pages.
    const info = (
      process as unknown as { getSystemMemoryInfo: () => unknown }
    ).getSystemMemoryInfo() as Record<string, unknown>
    const total = kilobytes(info["total"])
    const free = kilobytes(info["free"])
    if (total > 0) {
      const available =
        free + kilobytes(info["fileBacked"]) + kilobytes(info["purgeable"])
      return {
        memoryTotal: total,
        memoryAvailable: Math.min(total, available),
      }
    }
  } catch {
    // Nothing to report from Chromium's side; `os` still knows the shape of
    // the machine, even if its idea of "free" is the pessimistic one.
  }

  return { memoryTotal: os.totalmem(), memoryAvailable: os.freemem() }
}

export function kilobytes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value * 1024
    : 0
}

/**
 * This process alone, for a host with no family of processes to add up — the
 * localhost server. `cpuUsage` is microseconds of CPU since the last call, so
 * it is divided by the wall-clock span the same way the machine figure is.
 */
let lastProcess = { at: Date.now(), cpu: process.cpuUsage() }

export function processShare(cores: number): AppShare {
  const at = Date.now()
  const cpu = process.cpuUsage()
  const spent =
    cpu.user - lastProcess.cpu.user + cpu.system - lastProcess.cpu.system
  const elapsed = (at - lastProcess.at) * 1000
  lastProcess = { at, cpu }

  const core = elapsed > 0 ? (spent / elapsed) * 100 : 0
  return {
    appCpuPercent: clampPercent(core / Math.max(1, cores)),
    appCoreCpuPercent: Math.max(0, core),
    appMemory: process.memoryUsage().rss,
    appProcesses: 1,
  }
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}
