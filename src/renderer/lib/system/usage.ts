import { useEffect, useState } from "react"

import type { SystemUsage } from "@shared/api"

/**
 * How often the machine is asked, and so also the window each percentage is
 * averaged over — the main process measures from one call to the next.
 *
 * Two seconds is the compromise between the two ways this bar can lie. Faster
 * and it flickers: a single core waking up for 200ms becomes a spike nobody
 * can read. Slower and a burst of work is averaged away to nothing. It also
 * costs something to ask — `getAppMetrics()` walks every process — so this is
 * not a number to lower for the sake of a smoother bar.
 */
const POLL_MS = 2000

/**
 * One poller for the whole window, and not only to avoid waste: the reading
 * *is* the interval between two calls, so a
 * second timer asking on its own schedule would shorten both of theirs and
 * both would report a fraction of the truth.
 */
let current: SystemUsage | null = null
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false
const listeners = new Set<(value: SystemUsage) => void>()

async function refresh() {
  // A poll that has not come back yet is not one to queue behind. The main
  // process is single-threaded and this runs forever in the background: on a
  // machine busy enough to make the answer interesting, backing up is exactly
  // when it would happen.
  if (inFlight) return
  inFlight = true
  try {
    const next = await window.desktop.systemUsage()
    current = next
    for (const listener of listeners) listener(next)
  } finally {
    inFlight = false
  }
}

/** The machine's CPU and memory headroom, and the app's share of it. Null
 * until the first reading lands. */
export function useSystemUsage(): SystemUsage | null {
  const [value, setValue] = useState(current)

  useEffect(() => {
    listeners.add(setValue)
    if (!timer) {
      void refresh()
      timer = setInterval(() => void refresh(), POLL_MS)
    }
    return () => {
      listeners.delete(setValue)
      if (listeners.size === 0 && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }, [])

  return value
}
