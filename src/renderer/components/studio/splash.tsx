import { type CSSProperties } from "react"
import { cn } from "@/lib/utils"

/**
 * The screen the app opens on, and the only one shown before the workbench.
 *
 * There used to be two — the suspense fallback while the studio's chunk loaded
 * and a second one while the manifest was read — each a line of grey text, and
 * the handover between them was a flicker. They are one component now, timed
 * from `startedAt` below so that crossing from the first mount to the second
 * continues the same animation rather than starting it again.
 *
 * What it draws is the studio in miniature, in the order the eye reads it: the
 * left column with the four sections in their own hues, a strip of tabs, the
 * pane, and the Explorer on the right. A launch screen has to fill the time it takes to
 * open a manifest and a few settings either way, and a logo sitting still
 * fills it by looking like nothing is happening.
 */

/**
 * When the launch sequence started.
 *
 * At module scope because the splash is mounted twice on the way in and the
 * assembly is one animation across both. Not measured from page load: the
 * bundle's own evaluation is not something anybody watched, and delays counted
 * through it would already have elapsed by the time the first frame was drawn.
 */
let startedAt: number | null = null

/**
 * The `animation-delay` for a step that belongs at `ms` into the sequence.
 *
 * On the second mount the sequence is already running, so a step whose moment
 * has passed loses its delay and one whose moment is long past is dropped
 * entirely — replaying an animation that has already finished on screen is the
 * flicker this whole arrangement exists to avoid.
 */
function step(ms: number): CSSProperties {
  const elapsed = performance.now() - (startedAt ?? performance.now())
  const left = ms - elapsed
  if (left < -400) return { animation: "none" }
  return left > 16 ? { animationDelay: `${Math.round(left)}ms` } : {}
}

/** How long the sequence runs before the workbench is allowed to replace it. */
export const SPLASH_ASSEMBLE_MS = 900

/**
 * How long the launch screen has been on screen, in milliseconds.
 *
 * What the studio holds itself back against, so that the wait covers the
 * animation the user is actually watching rather than the time since whichever
 * component happened to ask.
 */
export function splashElapsed(): number {
  return startedAt === null ? 0 : performance.now() - startedAt
}
/** The crossfade out, during which both this and the workbench are on screen. */
export const SPLASH_FADE_MS = 420

/**
 * Four of the studio's own hues, in the sections' order.
 *
 * Not one dot per section — this is the studio in miniature, not a mirror of
 * it — so the sections losing their Terminal entry, and later their Mail one,
 * does not change how many are drawn here. `--section-terminal` is still the
 * colour a terminal is known by, now the dock's; `--section-mail` went with the
 * panel, and Explorer's own cyan took its place in the row.
 *
 * Written out rather than imported from `SECTION_ACCENT` in `section-marks.tsx`,
 * which is the one to change if a section's colour does: reaching for it here
 * would pull the icons that module names — and through them lucide — into the
 * chunk that has to be parsed before anything is on screen, which is a strange
 * price for a launch screen to charge. They are variables
 * from `globals.css` either way, so a re-hue there moves both.
 */
const HUES = [
  "var(--section-files)",
  "var(--section-database)",
  "var(--section-api)",
  "var(--section-terminal)",
]

export function Splash({
  status = "Starting the studio…",
  closing = false,
}: {
  /** What is being waited on, in the app's own voice. */
  status?: string
  /** Fades the screen out over the workbench mounting behind it. */
  closing?: boolean
}) {
  startedAt ??= performance.now()

  return (
    <div
      // What `prefers-reduced-motion` in `motion.css` reaches for to cut the
      // crossfade below, without a blanket rule over the rest of the app.
      data-splash=""
      className={cn(
        "fixed inset-0 z-50 grid place-items-center bg-background transition-[opacity,transform] duration-400 ease-out",
        closing && "pointer-events-none scale-[1.04] opacity-0"
      )}
    >
      <div className="flex flex-col items-center gap-7">
        <StudioMark />

        <div className="flex flex-col items-center gap-1.5">
          {/* The gradient is barely there in either theme; it is what keeps
              the wordmark from reading as one more line of body text. */}
          <span
            style={step(300)}
            className="animate-rise bg-gradient-to-b from-foreground to-foreground/55 bg-clip-text font-heading text-lg font-medium tracking-tight text-transparent"
          >
            Visual Studio Claude
          </span>
          <p
            style={step(420)}
            className="animate-rise text-xs text-muted-foreground"
          >
            <span className="inline-block animate-breathe">{status}</span>
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * The studio in miniature, drawn at the size of a large app icon.
 *
 * Exported for the setup screen's welcome page, which comes after the splash
 * and so finds every `step` long past: there it is the finished picture, with
 * only the glow and the sweep still moving.
 */
export function StudioMark() {
  return (
    <div className="relative">
      {/*
        A wash of the brand hue behind the card, breathing on the same 2.6s as
        the status line. Blurred far past its own edges so what shows is light
        rather than a shape — a hard-edged glow would be a second object on a
        screen that is meant to hold one.
      */}
      <div
        aria-hidden
        className="absolute -inset-12 animate-breathe rounded-full bg-primary/25 blur-3xl"
      />

      {/*
        The chrome of the miniature is `bg-muted` against panels of `bg-card`,
        which is the contrast the workbench itself is built on. Borders alone
        were not enough: at this size, and against a light theme's near-white
        background, a one-pixel line between two whites is a card with nothing
        drawn on it.
      */}
      <div
        style={step(0)}
        className="relative flex h-32 w-52 animate-settle overflow-hidden rounded-xl border bg-muted shadow-2xl"
      >
        {/* The left column, and the hues that are the app's own colours: the
            projects, the databases and the saved requests — which is what the
            workspace holds. */}
        <div className="flex w-11 shrink-0 flex-col gap-1.5 border-r p-2">
          {HUES.map((hue, index) => (
            <span key={hue} className="flex items-center gap-1">
              <span
                style={{ backgroundColor: hue, ...step(180 + index * 50) }}
                className="size-1 shrink-0 animate-pop rounded-full"
              />
              <span
                style={{
                  width: `${[7, 5, 6, 4][index]! * 0.25}rem`,
                  ...step(180 + index * 50),
                }}
                className="h-1 animate-glide rounded-full bg-muted-foreground/35"
              />
            </span>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* The tab strip, with the leading tab marked the way the real one
              marks it: a bar across the top edge in the brand hue. */}
          <div className="flex h-4.5 shrink-0 items-stretch gap-px border-b px-1">
            <span
              style={step(320)}
              className="mt-px w-10 animate-fade rounded-t-[3px] border-t-2 border-t-primary bg-card"
            />
            <span
              style={step(380)}
              className="mt-px w-8 animate-fade rounded-t-[3px] bg-card/50"
            />
          </div>

          {/* The pane, and the one thing in the mark that never finishes: a
              sweep across it for as long as the app is still opening. */}
          <div className="relative min-h-0 flex-1 overflow-hidden bg-card p-2">
            <div className="flex flex-col gap-1.5">
              {[11, 8, 10, 6].map((width, index) => (
                <span
                  key={index}
                  style={{
                    width: `${width * 0.25}rem`,
                    ...step(440 + index * 60),
                  }}
                  className="block h-1 animate-rise rounded-full bg-muted-foreground/30"
                />
              ))}
            </div>
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-1/2 animate-sweep bg-gradient-to-r from-transparent via-primary/25 to-transparent"
            />
          </div>
        </div>

        {/* The right column: the Explorer, and the dock under it. One header
            rather than a row of tabs, because it holds one thing — the file
            tree of whichever checkout the left column has clicked. */}
        <div className="flex w-14 shrink-0 flex-col border-l bg-card">
          <div className="flex h-4.5 shrink-0 items-center gap-1 border-b px-2">
            <span
              style={{ backgroundColor: HUES[0], ...step(180) }}
              className="size-1.5 shrink-0 animate-pop rounded-full"
            />
            <span
              style={step(240)}
              className="h-1 w-4 animate-glide rounded-full bg-muted-foreground/35"
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2">
            {[9, 7, 8].map((width, index) => (
              <span
                key={index}
                style={{
                  width: `${width * 0.25}rem`,
                  ...step(360 + index * 70),
                }}
                className="h-1 animate-glide rounded-full bg-muted-foreground/35"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
