import { useStorage } from "nitro/storage"

import { dayKey } from "./usage.ts"

/**
 * Each user's spend for the day, in `usage.ts`'s input-token equivalents,
 * under the `quota` storage mount (`nitro.config.ts`) as `<day>:<uid>`.
 *
 * Read before a request and added to after it: a request already running when
 * the budget runs out is finished, and the next one is refused. Two requests
 * finishing at once can each read the old total, so the count can come out
 * short by one request — a budget is a ceiling on a free tier, not a bill, and
 * a lock per user would be a second store to run.
 */

function keyOf(uid: string, now: Date): string {
  return `${dayKey(now)}:${uid}`
}

export async function spentToday(uid: string, now = new Date()): Promise<number> {
  const value = await useStorage("quota").getItem<number>(keyOf(uid, now))
  return typeof value === "number" ? value : 0
}

export async function addSpend(
  uid: string,
  amount: number,
  now = new Date()
): Promise<void> {
  if (amount <= 0) return
  const storage = useStorage("quota")
  const key = keyOf(uid, now)
  const before = await storage.getItem<number>(key)
  await storage.setItem(key, (typeof before === "number" ? before : 0) + amount)
}

/** Seconds until the budget resets, for `retry-after`. */
export function secondsToReset(now = new Date()): number {
  const next = new Date(now)
  next.setUTCHours(24, 0, 0, 0)
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000))
}
