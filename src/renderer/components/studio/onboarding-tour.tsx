import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { IS_MAC } from "./title-bar"

/**
 * The first-launch tour: five cards, each pointing at one part of the window.
 *
 * Shown once, after the launch screen has gone and the settings have been read
 * (`Studio` decides; `onboarded` in `lib/settings.ts` remembers), and again from
 * Settings › Appearance › Replay the tour. Five is the cap on purpose: a tour
 * is read once, standing between the user and the app they just opened, and
 * every card past the fifth is one more thing to skip.
 *
 * Each step names an element by `data-tour` rather than holding a ref to it,
 * because the targets are spread across components that know nothing about
 * the tour — the rail, the title bar, the pane. The spotlight is a `fixed` box
 * over the target with a shadow the size of the viewport around it: one
 * element, one hole, and nothing to keep in step the way four dark panels
 * would be. A target that is not on screen — the Explorer dragged shut on
 * another run, say — leaves the card centred over a plain dim, which still
 * reads as "about this app" rather than as a card pointing at nothing.
 */
export function OnboardingTour({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0)
  // `index` only ever moves between 0 and the last step, so the lookup
  // cannot miss; the assertion is for `noUncheckedIndexedAccess`.
  const step = STEPS[index]!
  const last = index === STEPS.length - 1

  const [target, setTarget] = useState<Rect | null>(null)
  const [place, setPlace] = useState<Place | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Measured in a layout effect so the first paint of a step already has the
  // spotlight on its target, and again on resize — the only way the targets
  // move while the overlay is holding the pointer.
  useLayoutEffect(() => {
    const measure = () => setTarget(rectOf(step.target))
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [step.target])

  // The card's own size is only known once it is drawn, so it is placed in a
  // second pass — before paint, since this is a layout effect.
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const { width, height } = card.getBoundingClientRect()
    setPlace(
      placeCard(
        target,
        { width, height },
        {
          width: window.innerWidth,
          height: window.innerHeight,
        }
      )
    )
  }, [target, index])

  // Focus follows the step so the keys below land here rather than in whatever
  // the user was typing into when the tour opened.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true })
  }, [index])

  const next = () => (last ? onDone() : setIndex(index + 1))
  const back = () => setIndex(Math.max(0, index - 1))

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A button in the card with focus handles its own Enter; taking the key
      // here too would advance twice.
      if (
        event.key === "Enter" &&
        event.target instanceof HTMLButtonElement &&
        cardRef.current?.contains(event.target)
      ) {
        return
      }
      if (event.key === "Escape") onDone()
      else if (event.key === "Enter" || event.key === "ArrowRight") next()
      else if (event.key === "ArrowLeft") back()
      else return
      event.preventDefault()
      event.stopPropagation()
    }

    // Capture, like the studio's own shortcuts: an editor under the overlay
    // would otherwise take the arrow keys first.
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  })

  const spot = target ? pad(target, SPOT_PADDING) : null

  return (
    // Above the dialogs' `z-50`: Replay the tour is pressed inside one, and
    // the tour has to land over whatever is still closing.
    <div className="fixed inset-0 z-60">
      {/* Catches every click so the window under the tour is not driven by
          accident; dims the whole window itself when there is no target for
          the spotlight's shadow to do it. */}
      <div
        className={cn("absolute inset-0", !spot && "bg-black/55")}
        onClick={onDone}
      />

      {spot && (
        <div
          aria-hidden
          className="tour-spot pointer-events-none fixed rounded-lg shadow-[0_0_0_200vmax_rgba(0,0,0,0.55)] ring-2 ring-primary/70"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
          }}
        />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal
        aria-labelledby="tour-title"
        tabIndex={-1}
        // Re-keyed per step so the entrance plays again for each card rather
        // than once for the whole tour.
        key={index}
        className="fixed w-80 animate-rise rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none"
        style={
          place
            ? { top: place.top, left: place.left }
            : // Off screen until placed, so the first frame is not a card in
              // the corner sliding to where it belongs.
              { top: -9999, left: -9999 }
        }
      >
        <p className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
          {index + 1} of {STEPS.length}
        </p>
        <h2 id="tour-title" className="mt-1 text-sm font-medium">
          {step.title}
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {step.body}
        </p>

        <div className="mt-4 flex items-center gap-1">
          {STEPS.map((candidate, dot) => (
            <span
              key={candidate.target}
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                dot === index ? "bg-primary" : "bg-muted-foreground/30"
              )}
            />
          ))}
          <div className="flex-1" />
          {!last && (
            <Button size="xs" variant="ghost" onClick={onDone}>
              Skip tour
            </Button>
          )}
          {index > 0 && (
            <Button size="xs" variant="outline" onClick={back}>
              Back
            </Button>
          )}
          <Button size="xs" onClick={next}>
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  )
}

type Step = {
  /** The `data-tour` value of the element the card points at. */
  target: string
  title: string
  body: string
}

const STEPS: Step[] = [
  {
    target: "projects",
    title: "Your projects",
    body: "The folders this workspace points at, with the chats in each one underneath. This button opens and shuts the column; a dot on it means a chat is working while it is shut.",
  },
  {
    target: "palette",
    title: "Run a command",
    body: `${IS_MAC ? "⌘P" : "Ctrl+P"} opens the palette: go to a file or a chat by name, or run anything the studio can do.`,
  },
  {
    target: "composer",
    title: "Chats, side by side",
    body: "Each chat is a claude conversation in one project's directory. Several can run at once, and the row in the column says which are answering and which are waiting on you.",
  },
  {
    target: "explorer",
    title: "The Explorer",
    body: "Every file in the checkout, and under Git, what has changed since the last commit and the commits before it.",
  },
  {
    target: "terminal",
    title: "A shell underneath",
    body: `The dock under the pane holds a terminal per tab, in the project's own directory. ${IS_MAC ? "⌃`" : "Ctrl+`"} toggles it.`,
  },
]

type Rect = { top: number; left: number; width: number; height: number }
type Place = { top: number; left: number }

/** Room around the target inside the spotlight, so the ring is not on it. */
const SPOT_PADDING = 6
/** Space between the spotlight and the card, and between the card and the
 * window's edge. */
const MARGIN = 12

function rectOf(target: string): Rect | null {
  const element = document.querySelector(`[data-tour="${target}"]`)
  if (!(element instanceof HTMLElement)) return null
  const { top, left, width, height } = element.getBoundingClientRect()
  // A target with no box is one that is hidden, and a spotlight on a point
  // is worse than none.
  if (width === 0 || height === 0) return null
  return { top, left, width, height }
}

function pad(rect: Rect, by: number): Rect {
  return {
    top: rect.top - by,
    left: rect.left - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2,
  }
}

/**
 * Where the card goes: beside the target where there is room for it, under
 * or over it otherwise, and centred when there is no target at all. Each
 * answer is clamped into the window, so a target against an edge gets a card
 * that is still whole.
 */
function placeCard(
  target: Rect | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number }
): Place {
  if (!target) {
    return {
      top: (viewport.height - card.height) / 2,
      left: (viewport.width - card.width) / 2,
    }
  }

  const spot = pad(target, SPOT_PADDING)
  const right = spot.left + spot.width
  const bottom = spot.top + spot.height
  const gap = MARGIN

  let place: Place
  if (right + gap + card.width + MARGIN <= viewport.width) {
    place = { top: spot.top, left: right + gap }
  } else if (spot.left - gap - card.width >= MARGIN) {
    place = { top: spot.top, left: spot.left - gap - card.width }
  } else if (bottom + gap + card.height + MARGIN <= viewport.height) {
    place = { top: bottom + gap, left: spot.left }
  } else {
    place = { top: spot.top - gap - card.height, left: spot.left }
  }

  return {
    top: clamp(place.top, MARGIN, viewport.height - card.height - MARGIN),
    left: clamp(place.left, MARGIN, viewport.width - card.width - MARGIN),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
