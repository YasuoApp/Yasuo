import type { ClickupWatch } from "@shared/api"

/**
 * How a moment is written in the ClickUp list and the dialog.
 *
 * Its own module because the dialog draws the same answer in two places — the
 * foot of its list and the head of each task — and two roundings of one instant
 * a few inches apart is two clocks in one window.
 */

/**
 * How long ago, in the shortest phrase that is still true.
 *
 * Not `Intl.RelativeTimeFormat`: what a row this narrow wants is `3m`, not
 * "3 minutes ago" — and a change from last Tuesday should say the day, which a
 * relative format goes on counting in hours forever.
 */
export function ago(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ""
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}

/** The moment in full, for a `title` — the thing `ago` rounded away, in the
 * reader's own locale since this one is read rather than compared. */
export function exactly(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ""
  return new Date(then).toLocaleString()
}

/**
 * When ClickUp was last read, for the foot of the dialog's list.
 *
 * The **newest** of them, since every task is polled in one pass: a task whose
 * own stamp is older is one that has been failing, and its row says so itself.
 * ISO strings sort as their instants do, so this never goes near a `Date`.
 */
export function lastPolled(watches: ClickupWatch[]): string | null {
  const stamps = watches
    .map((watch) => watch.polledAt)
    .filter((at): at is string => Boolean(at))
  if (stamps.length === 0) return null
  return stamps.sort().at(-1) ?? null
}
