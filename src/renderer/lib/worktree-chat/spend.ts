import type { ChatSpend } from "@shared/api"

/**
 * The cost dashboard's arithmetic: every turn's bill (`ChatSpend`, one row per
 * usage line across every chat) folded by day, by project, by model and by
 * chat.
 *
 * Pure and tested in `test/chat-spend.ts`, because the two ways this goes
 * wrong are both quiet. A turn at 23:40 filed under tomorrow because the day
 * was cut in UTC is a chart that is right everywhere except where the user
 * lives; and a turn that reported no estimate summed as `$0` is a dashboard
 * claiming a crashed turn was free. So days are **local calendar days**, and a
 * null cost is counted (`unpriced`) rather than added.
 */

/** The filter row's presets, in the order they are drawn. */
export type SpendRange = "today" | "7d" | "30d" | "all"

export const SPEND_RANGES: { id: SpendRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All" },
]

/** A turn with no model, or no project, is keyed by the empty string: a
 * folder id is never empty and the CLI never names a model that way, so the
 * key cannot collide with a real one and reads as "none" on the way out. */
export const NONE = ""

/** The last series of a stack past `limit` — everything folded together. */
export const OTHER = "\u0000other"

export type DaySpend = {
  /** Local `YYYY-MM-DD`. */
  day: string
  /** Midnight at the start of that day, local, for the axis label. */
  at: Date
  /** Priced turns' estimates added up. */
  total: number
  turns: number
  /** Cost by model id (`NONE` for a turn the CLI did not name one on). */
  models: Record<string, number>
  /** Cost by folder id (`NONE` for a chat with no project). */
  projects: Record<string, number>
}

export type SpendGroup = {
  key: string
  turns: number
  costUsd: number
  /** Of the priced total in the rows given, `0` when nothing was priced. */
  share: number
}

export type ChatSpendGroup = SpendGroup & {
  title: string
  folderId: string | null
}

export type SpendTotals = {
  costUsd: number
  turns: number
  chats: number
  /** Turns that reported no estimate — and so are in `turns` and not in
   * `costUsd`, which is why the dashboard says so beside the figure. */
  unpriced: number
}

/** Local `YYYY-MM-DD`, which is the one way a day is named in this module. */
export function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** `days` ago at local midnight. Through the date constructor rather than
 * `- days * 86_400_000`, which is an hour off across a DST change. */
function daysAgo(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days)
}

/** How many calendar days a range spans, counting today. */
export function daysIn(
  range: SpendRange,
  rows: ChatSpend[],
  now: Date
): number {
  if (range === "today") return 1
  if (range === "7d") return 7
  if (range === "30d") return 30
  // `All` runs from the earliest turn to today. Never fewer than a week, so a
  // workspace a day old does not get a chart of one bar standing alone.
  let earliest = startOfDay(now)
  for (const row of rows) {
    const at = startOfDay(new Date(row.at))
    if (!Number.isNaN(at.getTime()) && at < earliest) earliest = at
  }
  const span =
    Math.round((startOfDay(now).getTime() - earliest.getTime()) / 86_400_000) +
    1
  return Math.max(7, span)
}

/** The rows inside a range, by local day: `7d` is today and the six before
 * it, not the last 168 hours. */
export function rangeOf(
  rows: ChatSpend[],
  range: SpendRange,
  now: Date = new Date()
): ChatSpend[] {
  if (range === "all") return rows
  const since = daysAgo(now, daysIn(range, rows, now) - 1).getTime()
  return rows.filter((row) => {
    const at = new Date(row.at).getTime()
    return !Number.isNaN(at) && at >= since
  })
}

/**
 * The last `days` local days, oldest first, every one of them present.
 *
 * Zero-filled rather than sparse: a bar chart with the quiet days missing
 * would draw Monday beside Thursday and read as two busy days in a row.
 * Rows outside the window are left out, so this is also the range filter for
 * the chart.
 */
export function byDay(
  rows: ChatSpend[],
  days: number,
  now: Date = new Date()
): DaySpend[] {
  const count = Math.max(1, Math.floor(days))
  const out: DaySpend[] = []
  const index = new Map<string, DaySpend>()
  for (let back = count - 1; back >= 0; back -= 1) {
    const at = daysAgo(now, back)
    const entry: DaySpend = {
      day: dayKey(at),
      at,
      total: 0,
      turns: 0,
      models: {},
      projects: {},
    }
    out.push(entry)
    index.set(entry.day, entry)
  }

  for (const row of rows) {
    const at = new Date(row.at)
    if (Number.isNaN(at.getTime())) continue
    const entry = index.get(dayKey(at))
    if (!entry) continue
    entry.turns += 1
    if (row.costUsd === null) continue
    entry.total += row.costUsd
    add(entry.models, row.model ?? NONE, row.costUsd)
    add(entry.projects, row.folderId ?? NONE, row.costUsd)
  }
  return out
}

/**
 * The series a stacked chart draws, and each day's values in that order.
 *
 * The top `limit` keys by total over the whole window, then everything else
 * as one `OTHER` series — never a sixth hue. The order is by the window's
 * totals rather than by the day's, so a model keeps its colour from bar to
 * bar; and it is fixed for the window, so hovering a quiet day does not
 * reshuffle the legend.
 */
export function stacksOf(
  days: DaySpend[],
  by: "models" | "projects",
  limit = 5
): { series: string[]; values: number[][] } {
  const totals: Record<string, number> = {}
  for (const day of days) {
    for (const [key, cost] of Object.entries(day[by])) add(totals, key, cost)
  }
  const ranked = Object.entries(totals)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key)
  const kept = ranked.slice(0, limit)
  const folded = ranked.slice(limit)
  const series = folded.length > 0 ? [...kept, OTHER] : kept

  const values = days.map((day) => {
    const row = kept.map((key) => day[by][key] ?? 0)
    if (folded.length > 0) {
      row.push(folded.reduce((sum, key) => sum + (day[by][key] ?? 0), 0))
    }
    return row
  })
  return { series, values }
}

export function byProject(rows: ChatSpend[]): SpendGroup[] {
  return grouped(rows, (row) => row.folderId ?? NONE)
}

export function byModel(rows: ChatSpend[]): SpendGroup[] {
  return grouped(rows, (row) => row.model ?? NONE)
}

/** Dearest first. The title is the one on the latest row for the chat, since
 * a chat renamed halfway should be listed under what it is called now. */
export function byChat(rows: ChatSpend[]): ChatSpendGroup[] {
  const latest = new Map<string, ChatSpend>()
  for (const row of rows) {
    const seen = latest.get(row.chatId)
    if (!seen || row.at > seen.at) latest.set(row.chatId, row)
  }
  return grouped(rows, (row) => row.chatId).map((group) => {
    const row = latest.get(group.key)!
    return { ...group, title: row.title, folderId: row.folderId }
  })
}

export function totals(rows: ChatSpend[]): SpendTotals {
  const chats = new Set<string>()
  let costUsd = 0
  let unpriced = 0
  for (const row of rows) {
    chats.add(row.chatId)
    if (row.costUsd === null) unpriced += 1
    else costUsd += row.costUsd
  }
  return { costUsd, turns: rows.length, chats: chats.size, unpriced }
}

function grouped(
  rows: ChatSpend[],
  keyOf: (row: ChatSpend) => string
): SpendGroup[] {
  const groups = new Map<string, SpendGroup>()
  let total = 0
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? { key, turns: 0, costUsd: 0, share: 0 }
    group.turns += 1
    if (row.costUsd !== null) {
      group.costUsd += row.costUsd
      total += row.costUsd
    }
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      share: total > 0 ? group.costUsd / total : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns)
}

function add(into: Record<string, number>, key: string, cost: number) {
  into[key] = (into[key] ?? 0) + cost
}
