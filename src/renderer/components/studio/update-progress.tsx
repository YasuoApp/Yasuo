import type { UpdateProgress } from "@shared/api"

import { downloadPercent } from "@/lib/updates"
import { cn } from "@/lib/utils"

/**
 * How far an install has got, as a bar.
 *
 * Drawn in two places — the pill's sheet and Settings › Updates — from the one
 * store, so the two cannot disagree about a number that is only on screen for
 * half a minute and would never be seen side by side.
 *
 * A known total is a width; anything else is `animate-sweep`, the launch
 * screen's own loop, rather than a bar sitting at zero or ramping to 100 on a
 * timer. The stage that cannot be measured is the real one: `install.sh` mounts
 * a disk image, quits this app and copies a bundle, and the honest end of the
 * bar is the window closing.
 */
export function UpdateProgressBar({
  progress,
  className,
}: {
  progress: UpdateProgress | null
  className?: string
}) {
  const percent = downloadPercent(progress)

  return (
    <div
      className={cn(
        "h-1 w-full overflow-hidden rounded-full bg-primary/15",
        className
      )}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      // Absent rather than zero when there is no total: that is what tells a
      // screen reader this is indeterminate.
      aria-valuenow={percent ?? undefined}
    >
      {percent === null ? (
        <div className="h-full w-2/5 animate-sweep rounded-full bg-primary" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  )
}
