import { cn } from "@/lib/utils"

/**
 * A fraction of an allowance, at whatever width the row can spare it.
 *
 * One definition rather than a copy per caller: the context window, the
 * account's two limit windows, and the machine's CPU and memory are all the
 * same measurement — how much of something finite is gone — and they only
 * read as one control if they are literally the same drawing.
 */
export function Meter({
  percent,
  label,
  className,
}: {
  percent: number
  label: string
  className?: string
}) {
  const filled = Math.max(0, Math.min(100, percent))

  return (
    <div
      className={cn(
        "h-1.5 shrink-0 overflow-hidden rounded-full bg-border",
        className
      )}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(filled)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300",
          severity(filled)
        )}
        style={{ width: `${filled}%` }}
      />
    </div>
  )
}

/**
 * Amber from the point a ceiling is close enough to be worth knowing about
 * before it interrupts a train of thought, red when it is about to.
 *
 * The same thresholds everywhere a meter appears, so that a colour means one
 * thing wherever it is seen.
 */
function severity(percent: number): string {
  if (percent >= 90) return "bg-destructive"
  if (percent >= 70) return "bg-warning"
  return "bg-muted-foreground/60"
}
