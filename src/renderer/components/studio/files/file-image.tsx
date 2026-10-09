import { useState } from "react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ImageOff } from "lucide-react"

import type { ImageDoc } from "@/lib/files/store"
import { SECTION_ACCENT } from "../section-marks"

/**
 * A file shown as a picture.
 *
 * Contained rather than scaled up: a 16×16 favicon is drawn at 16×16, because
 * a smoothed, quadrupled icon says nothing true about the file. Anything larger
 * than the pane shrinks to fit, which is the one case where a picture and its
 * container disagree and the container has to win.
 *
 * The checkerboard is not decoration. Transparency is the thing somebody opens
 * an icon to check, and against a flat panel background a transparent PNG and a
 * white one look identical.
 */
export function FileImage({ image, alt }: { image: ImageDoc; alt: string }) {
  /** Natural dimensions, once the browser has decoded it — the one fact about
   * a picture worth a line of chrome, and not known until it loads. */
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null
  )

  if (image.kind === "loading") {
    return <Notice title="Reading…" />
  }

  if (image.kind === "error") {
    return <Notice title="Could not open this image" detail={image.message} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Pinned to the pane's box rather than a grid cell that grows with its
          content: `max-h-full` needs a height to be a percentage of, and an SVG
          with a `viewBox` but no `width` has no size of its own — it took the
          pane's whole width and ran off the bottom. */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <img
            src={image.src}
            alt={alt}
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            style={{
              backgroundImage:
                "linear-gradient(45deg, var(--muted) 25%, transparent 25%), linear-gradient(-45deg, var(--muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--muted) 75%), linear-gradient(-45deg, transparent 75%, var(--muted) 75%)",
              backgroundSize: "16px 16px",
              backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
            }}
            className="max-h-full max-w-full rounded-sm object-contain shadow-sm"
          />
        </div>
      </div>

      {size && (
        <p className="shrink-0 border-t px-3 py-1.5 text-center font-mono text-[0.65rem] text-muted-foreground">
          {/* An SVG reports the size its own attributes ask for, which is what
              it will be drawn at rather than what it is made of — there is no
              pixel grid behind it to report. */}
          {size.width} × {size.height}
        </p>
      )}
    </div>
  )
}

function Notice({ title, detail }: { title: string; detail?: string }) {
  return (
    <Empty className="size-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon" style={{ color: SECTION_ACCENT.files }}>
          <ImageOff />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {detail && <EmptyDescription>{detail}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  )
}
