import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { RefreshCw } from "lucide-react"

import type { ChatSpend } from "@shared/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import {
  byChat,
  byDay,
  byModel,
  byProject,
  daysIn,
  NONE,
  OTHER,
  rangeOf,
  SPEND_RANGES,
  stacksOf,
  totals,
  type DaySpend,
  type SpendRange,
} from "@/lib/worktree-chat/spend"
import { modelLabel, money } from "@/lib/worktree-chat/usage"

/**
 * What the workspace's chats have cost — the rail's `Costs` button.
 *
 * A dialog rather than a pane, for the reason Settings is: it is about the
 * workbench as a whole rather than about any one project, and a figure read
 * once and closed does not want a tab beside the files. Everything in it is
 * drawn from one read of `chatSpend()` — a row per turn across every chat —
 * folded in `lib/worktree-chat/spend.ts`; nothing here is a second account of
 * what a chat cost, and the usage line under a chat's composer is the same
 * estimates added up one chat at a time.
 *
 * The chart is inline SVG by hand. No chart library is installed, and one
 * stacked bar chart is not a reason to install one: the whole of it is a
 * scale, five rects per bar and a hover rect per day. What it follows is the
 * dataviz skill's specs — bars capped at 24px with a rounded cap and a square
 * foot, a 2px gap of the surface between stacked segments rather than a stroke,
 * hairline solid gridlines, text in the text tokens and never in a series
 * colour, a legend for the series and the same numbers in a table under it, so
 * nothing is reachable only by hovering.
 *
 * The series colours are the app's `--chart-*` tokens in a **fixed order** that
 * is not 1-2-3-4-5: run through the skill's validator, 1-2 and 4-5 are adjacent
 * pairs a protan reader cannot tell apart in dark mode, and 1-4-2-5-3 is the
 * order of the same five that passes in both modes. Past five, everything
 * else is one `Other` series in the muted ink — a sixth hue is never
 * generated.
 */
export function CostDashboard({ onClose }: { onClose: () => void }) {
  // The rows and the moment they were read, together: every day in the chart
  // is cut against that `at`, so a dialog left open across midnight keeps the
  // days it was drawn with until Refresh rather than shifting under a hover.
  const [loaded, setLoaded] = useState<{ rows: ChatSpend[]; at: Date } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  /** Bumped by Refresh; the read below runs once per value. */
  const [asked, setAsked] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [range, setRange] = useState<SpendRange>("7d")
  const [stackBy, setStackBy] = useState<"models" | "projects">("models")

  useEffect(() => {
    let live = true
    window.desktop.chatSpend().then(
      (rows) => {
        if (!live) return
        setLoaded({ rows, at: new Date() })
        setError(null)
        setRefreshing(false)
      },
      (failure: unknown) => {
        if (!live) return
        setError(failure instanceof Error ? failure.message : String(failure))
        setRefreshing(false)
      }
    )
    return () => {
      live = false
    }
  }, [asked])

  const rows = loaded?.rows ?? null
  const loading = refreshing || (rows === null && error === null)

  const folders = useStudio((state) => state.folders)
  const projectName = useCallback(
    (id: string | null) => {
      if (id === null || id === NONE) return "No project"
      return (
        folders.find((folder) => folder.id === id)?.name ?? "Removed project"
      )
    },
    [folders]
  )

  const scoped = useMemo(
    () => (loaded ? rangeOf(loaded.rows, range, loaded.at) : []),
    [loaded, range]
  )
  const days = useMemo(
    () =>
      loaded
        ? byDay(loaded.rows, daysIn(range, loaded.rows, loaded.at), loaded.at)
        : [],
    [loaded, range]
  )
  const stack = useMemo(() => stacksOf(days, stackBy), [days, stackBy])
  const sum = useMemo(() => totals(scoped), [scoped])
  const projects = useMemo(() => byProject(scoped), [scoped])
  const models = useMemo(() => byModel(scoped), [scoped])
  const chats = useMemo(() => byChat(scoped).slice(0, 10), [scoped])

  const seriesLabel = (key: string) =>
    key === OTHER
      ? "Other"
      : stackBy === "models"
        ? (modelLabel(key) ?? (key === NONE ? "Unknown model" : key))
        : projectName(key)

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="flex h-[34rem] max-h-[85vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {/* `pr-12` clears the close button the dialog draws in the corner. */}
        <header className="flex shrink-0 items-start justify-between gap-4 border-b px-5 py-4 pr-12">
          <div>
            <DialogTitle>Costs</DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              What the chats in this workspace have cost, from the CLI&apos;s
              own estimate on each turn.
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setRefreshing(true)
              setAsked((count) => count + 1)
            }}
            disabled={loading}
            className="mt-0.5 shrink-0"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </header>

        {/* One filter row above everything it scopes: every tile, the chart
            and every table below are the same slice. */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-2.5">
          <Segmented
            label="Range"
            value={range}
            onChange={setRange}
            options={SPEND_RANGES.map((entry) => ({
              value: entry.id,
              label: entry.label,
            }))}
          />
          <Segmented
            label="Stack by"
            value={stackBy}
            onChange={setStackBy}
            options={[
              { value: "models", label: "Model" },
              { value: "projects", label: "Project" },
            ]}
          />
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-5 transition-opacity",
            // A refetch holds the last render at reduced opacity rather than
            // swapping in a skeleton: the frame stays put.
            loading && rows !== null && "opacity-60"
          )}
        >
          {error ? (
            <p className="text-sm text-destructive">
              Could not read the chats&apos; usage: {error}
            </p>
          ) : rows === null ? (
            <p className="text-sm text-muted-foreground">Reading the chats…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has been spent yet — a turn&apos;s estimate lands here
              once it ends.
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-4 gap-3">
                <Tile label="Spend" value={money(sum.costUsd)} hero />
                <Tile label="Turns" value={count(sum.turns)} />
                <Tile label="Chats" value={count(sum.chats)} />
                <Tile
                  label="Unpriced turns"
                  value={count(sum.unpriced)}
                  note={
                    sum.unpriced > 0
                      ? "Turns that reported no estimate — counted, not added."
                      : "Every turn reported an estimate."
                  }
                />
              </div>

              <section className="rounded-lg border p-4">
                <h3 className="mb-3 text-xs font-medium text-muted-foreground">
                  Spend by day
                  {scoped.length === 0 && (
                    <span className="font-normal">
                      {" "}
                      · nothing in this range
                    </span>
                  )}
                </h3>
                <SpendChart
                  days={days}
                  series={stack.series}
                  values={stack.values}
                  labelOf={seriesLabel}
                />
              </section>

              <div className="grid grid-cols-2 gap-4">
                <GroupTable
                  title="By project"
                  rows={projects.map((group) => ({
                    key: group.key,
                    name: projectName(group.key),
                    turns: group.turns,
                    costUsd: group.costUsd,
                    share: group.share,
                    color:
                      stackBy === "projects"
                        ? colorOf(stack.series, group.key)
                        : null,
                  }))}
                />
                <GroupTable
                  title="By model"
                  rows={models.map((group) => ({
                    key: group.key,
                    name:
                      modelLabel(group.key) ??
                      (group.key === NONE ? "Unknown model" : group.key),
                    turns: group.turns,
                    costUsd: group.costUsd,
                    share: group.share,
                    color:
                      stackBy === "models"
                        ? colorOf(stack.series, group.key)
                        : null,
                  }))}
                />
              </div>

              <section>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                  Top chats
                </h3>
                {chats.length === 0 ? (
                  <Empty />
                ) : (
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-1.5 pr-2 text-left font-medium">
                          Chat
                        </th>
                        <th className="py-1.5 pr-2 text-left font-medium">
                          Project
                        </th>
                        <th className="py-1.5 pr-2 text-right font-medium">
                          Turns
                        </th>
                        <th className="py-1.5 text-right font-medium">Spend</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {chats.map((chat) => (
                        <tr key={chat.key} className="border-b last:border-0">
                          <td className="max-w-0 truncate py-1.5 pr-2">
                            {chat.title}
                          </td>
                          <td className="max-w-0 truncate py-1.5 pr-2 text-muted-foreground">
                            {projectName(chat.folderId)}
                          </td>
                          <td className="py-1.5 pr-2 text-right text-muted-foreground">
                            {count(chat.turns)}
                          </td>
                          <td className="py-1.5 text-right">
                            {money(chat.costUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------------------------------------------------------------- */

/** The five tokens in the order that passes the validator — see the module
 * comment — then the muted ink for whatever was folded into `Other`. */
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-4)",
  "var(--chart-2)",
  "var(--chart-5)",
  "var(--chart-3)",
]
const OTHER_COLOR = "var(--muted-foreground)"

/** The colour a key wears in the chart, or null when it is not a series of
 * its own — then the table beside the chart draws no swatch for it. */
function colorOf(series: string[], key: string): string | null {
  const at = series.indexOf(key)
  if (at === -1) return null
  return series[at] === OTHER ? OTHER_COLOR : (SERIES_COLORS[at] ?? OTHER_COLOR)
}

const PLOT = { top: 8, right: 8, bottom: 22, left: 44, height: 180 }
const BAR_MAX = 24
const GAP = 2

/**
 * The stacked bars, one per day.
 *
 * The width is read off the container rather than fixed, because the dialog
 * is `max-w-4xl` and shrinks under it on a narrow window; a `viewBox` scaled
 * to fit would scale the tick labels with it. Each day has a transparent hit
 * rect the full band wide and the full plot tall — the mark is the hit target,
 * and a 6px bar is not something a pointer lands on reliably.
 */
function SpendChart({
  days,
  series,
  values,
  labelOf,
}: {
  days: DaySpend[]
  series: string[]
  values: number[][]
  labelOf: (key: string) => string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const plotW = width - PLOT.left - PLOT.right
  const plotH = PLOT.height
  const height = PLOT.top + plotH + PLOT.bottom
  const band = plotW / Math.max(1, days.length)
  const barW = Math.min(BAR_MAX, Math.max(3, band * 0.7))

  const max = days.reduce((top, day) => Math.max(top, day.total), 0)
  const ticks = ticksFor(max)
  const scale = ticks[ticks.length - 1] || 1
  const yOf = (value: number) => PLOT.top + plotH - (value / scale) * plotH

  // Every n-th label when the bands are too narrow to carry one each.
  const every = Math.max(1, Math.ceil(days.length / Math.floor(plotW / 56)))
  const dateLabel = (at: Date, index: number) => {
    if (days.length <= 1)
      return at.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    if (days.length <= 7)
      return at.toLocaleDateString(undefined, { weekday: "short" })
    if (index % every !== 0) return null
    return at.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }

  const hovered = hover !== null ? days[hover] : undefined
  const hoverX = hover !== null ? PLOT.left + band * hover + band / 2 : 0

  return (
    <div ref={box} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Spend by day"
        className="block select-none"
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PLOT.left}
              x2={PLOT.left + plotW}
              y1={yOf(tick)}
              y2={yOf(tick)}
              stroke="var(--border)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={PLOT.left - 8}
              y={yOf(tick)}
              dy="0.35em"
              textAnchor="end"
              fontSize={10}
              fill="var(--muted-foreground)"
              className="tabular-nums"
            >
              {tickLabel(tick)}
            </text>
          </g>
        ))}

        {days.map((day, index) => {
          const x = PLOT.left + band * index + (band - barW) / 2
          const label = dateLabel(day.at, index)
          const stacked = values[index] ?? []
          let top = -1
          stacked.forEach((value, at) => {
            if (value > 0) top = at
          })
          let floor = PLOT.top + plotH
          return (
            <g key={day.day}>
              {stacked.map((value, at) => {
                if (value <= 0) return null
                const full = (value / scale) * plotH
                const y = floor - full
                floor = y
                // The 2px gap is cut from the segment's own top, so the stack
                // still sums to the right height. The topmost gets the cap.
                const h = Math.max(0, full - (at === top ? 0 : GAP))
                const color =
                  series[at] === OTHER
                    ? OTHER_COLOR
                    : (SERIES_COLORS[at] ?? OTHER_COLOR)
                return (
                  <path
                    key={series[at]}
                    d={
                      at === top
                        ? capped(x, y, barW, h, 4)
                        : `M${x} ${y}h${barW}v${h}h${-barW}z`
                    }
                    fill={color}
                    opacity={hover === null || hover === index ? 1 : 0.55}
                  />
                )
              })}
              {label && (
                <text
                  x={PLOT.left + band * index + band / 2}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--muted-foreground)"
                >
                  {label}
                </text>
              )}
              <rect
                x={PLOT.left + band * index}
                y={PLOT.top}
                width={band}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(index)}
                onFocus={() => setHover(index)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                className="outline-none"
              />
            </g>
          )
        })}
        {/* The baseline, over the bars so a square foot reads as sitting on it. */}
        <line
          x1={PLOT.left}
          x2={PLOT.left + plotW}
          y1={PLOT.top + plotH}
          y2={PLOT.top + plotH}
          stroke="var(--border)"
          strokeWidth={1}
          shapeRendering="crispEdges"
        />
      </svg>

      {hovered && (
        <div
          role="status"
          className="pointer-events-none absolute top-2 z-10 w-52 rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md"
          style={
            // Flipped to the left of the band in the right half, so the box
            // never leaves the chart.
            hoverX > width / 2
              ? { right: width - hoverX + band / 2 }
              : { left: hoverX + band / 2 }
          }
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">{money(hovered.total)}</span>
            <span className="text-muted-foreground">
              {hovered.at.toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </span>
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {count(hovered.turns)} {hovered.turns === 1 ? "turn" : "turns"}
          </div>
          {series.length > 0 && hovered.total > 0 && (
            <ul className="mt-1.5 flex flex-col gap-0.5 border-t pt-1.5">
              {series.map((key, at) => {
                const value = values[hover!]?.[at] ?? 0
                if (value <= 0) return null
                return (
                  <li key={key} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-0.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: colorOf(series, key) ?? undefined }}
                    />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {labelOf(key)}
                    </span>
                    <span className="tabular-nums">{money(value)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {/* The legend, always, for two or more series; one series is named by
          the stack-by control and a box with one swatch would restate it. */}
      {series.length > 1 && (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground">
          {series.map((key) => (
            <li key={key} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: colorOf(series, key) ?? undefined }}
              />
              {labelOf(key)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A bar's top segment: rounded at the cap, square at its foot. */
function capped(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, h, w / 2)
  return [
    `M${x} ${y + h}`,
    `v${-(h - radius)}`,
    `a${radius} ${radius} 0 0 1 ${radius} ${-radius}`,
    `h${w - radius * 2}`,
    `a${radius} ${radius} 0 0 1 ${radius} ${radius}`,
    `v${h - radius}`,
    "z",
  ].join("")
}

/** Four clean steps up to just past the maximum, so the top tick is the
 * scale and never a bar poking out above the last gridline. */
function ticksFor(max: number): number[] {
  if (max <= 0) return [0, 0.25, 0.5, 0.75, 1]
  const rough = max / 4
  const power = 10 ** Math.floor(Math.log10(rough))
  const unit = rough / power
  const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power
  const steps = Math.ceil(max / step)
  return Array.from({ length: steps + 1 }, (_, at) => at * step)
}

function tickLabel(value: number): string {
  if (value === 0) return "$0"
  if (value >= 1)
    return `$${Number.isInteger(value) ? value : value.toFixed(2)}`
  return `$${value.toFixed(value >= 0.1 ? 2 : 3)}`
}

/* ---------------------------------------------------------------------- */

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex rounded-md bg-muted p-0.5"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-[5px] px-2 py-0.5 transition-colors",
              option.value === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  note,
  hero,
}: {
  label: string
  value: string
  note?: string
  hero?: boolean
}) {
  return (
    <div className="rounded-lg border px-3.5 py-3">
      <div className="text-[0.7rem] text-muted-foreground">{label}</div>
      {/* Proportional figures on a standalone number; `tabular-nums` is for
          the columns below, where digits have to line up. */}
      <div
        className={cn(
          "mt-0.5 font-semibold",
          hero ? "text-2xl leading-tight" : "text-lg leading-snug"
        )}
      >
        {value}
      </div>
      {note && (
        <div className="mt-1 text-[0.7rem] leading-snug text-muted-foreground">
          {note}
        </div>
      )}
    </div>
  )
}

function GroupTable({
  title,
  rows,
}: {
  title: string
  rows: {
    key: string
    name: string
    turns: number
    costUsd: number
    share: number
    color: string | null
  }[]
}) {
  return (
    <section className="min-w-0">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="py-1.5 pr-2 text-left font-medium">Name</th>
              <th className="py-1.5 pr-2 text-right font-medium">Turns</th>
              <th className="py-1.5 pr-2 text-right font-medium">Spend</th>
              <th className="w-14 py-1.5 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((row) => (
              <tr key={row.key} className="border-b last:border-0">
                <td className="max-w-0 py-1.5 pr-2">
                  <span className="flex items-center gap-1.5">
                    {row.color && (
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{ background: row.color }}
                      />
                    )}
                    <span className="truncate">{row.name}</span>
                  </span>
                </td>
                <td className="py-1.5 pr-2 text-right text-muted-foreground">
                  {count(row.turns)}
                </td>
                <td className="py-1.5 pr-2 text-right">{money(row.costUsd)}</td>
                <td className="py-1.5 text-right text-muted-foreground">
                  {Math.round(row.share * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function Empty(): ReactNode {
  return <p className="text-xs text-muted-foreground">Nothing in this range.</p>
}

function count(value: number): string {
  return value.toLocaleString()
}
