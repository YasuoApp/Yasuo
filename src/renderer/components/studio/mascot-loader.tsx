import { cn } from "@/lib/utils"

import gif from "./mascot-loader.gif"

/**
 * A swordsman drawing and cutting — the chat's "a turn is running" indicator.
 *
 * It is **the GIF itself**, animated by the browser, and that is the whole of
 * the mechanism: there is no CSS for this component and `styles/motion.css` has
 * nothing left under `yasuo`. It replaced first a hand-drawn SVG and then a
 * spritesheet cut from this GIF's predecessor, and `docs/design.md` § The chat's
 * loading indicator carries both reversals.
 *
 * Three things the GIF costs, none of them fixable from here:
 *
 *  - **`prefers-reduced-motion` cannot touch it.** A GIF's clock is the decoder's,
 *    not the compositor's, so there is no rule to write. The SVG dropped its
 *    choreography under that setting and the spritesheet could at least be slowed
 *    to a third; this plays at one speed for everyone. Stopping it would mean
 *    shipping a still frame as a second asset.
 *  - **It does not follow the theme.** The SVG's blade was `fill-foreground` and
 *    its body `fill-muted-foreground`, so it stayed legible whichever way round
 *    the theme put them. These frames are fixed colours — near-black hair, a dark
 *    brown topknot — so the figure is at its weakest on a dark background.
 *  - **The figure has no feet**, because the source is cropped at the shins. It
 *    stands on the bottom edge of its own box.
 *
 * **The dead space is cropped in CSS rather than out of the file.** The GIF's
 * canvas is 640x270 and its drawing occupies 433x230 of that, so 42% of the frame
 * is empty and most of it is a margin down the left-hand side. Left alone at 28px
 * the figure is 24px tall and sits 17px right of its own box, which in a flex row
 * reads as a broken gap. So the `<img>` is oversized inside a clipping box and
 * pulled back into place — every number below is a percentage of the *content*
 * box, which is what keeps the crop correct at any height the caller asks for.
 * Re-encoding the GIF would have been tidier and was not done: cropping it means
 * writing a GIF encoder, and this is four numbers.
 */

/** The GIF's own canvas. */
const CANVAS_W = 640
const CANVAS_H = 270

/**
 * The union of every frame's drawn pixels, measured off the file. It is the
 * *union* rather than any one frame's: the blade leaves the body's box in six of
 * the thirteen frames, and a crop that fits the figure clips the swing.
 */
const CONTENT_X = 166
const CONTENT_Y = 40
const CONTENT_W = 433
const CONTENT_H = 230

function MascotLoader({
  className,
  label = "Loading",
}: {
  className?: string
  label?: string
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("relative h-16 overflow-hidden", className)}
      style={{ aspectRatio: `${CONTENT_W} / ${CONTENT_H}` }}
    >
      {/* `aria-hidden` because the box above is already the status: without it a
          screen reader announces the name twice. `max-w-none` because the app's
          base stylesheet caps images at their container. */}
      <img
        src={gif}
        alt=""
        aria-hidden
        className="absolute max-w-none"
        style={{
          width: `${(CANVAS_W / CONTENT_W) * 100}%`,
          height: `${(CANVAS_H / CONTENT_H) * 100}%`,
          left: `${(-CONTENT_X / CONTENT_W) * 100}%`,
          top: `${(-CONTENT_Y / CONTENT_H) * 100}%`,
        }}
      />
    </div>
  )
}

export { MascotLoader }
