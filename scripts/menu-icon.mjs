// Draws the gear beside **Settings…** in the application menu, into
// resources/menu-settings.png (+ @2x).
//
// Generated rather than exported from a design tool, for the reason
// dmg-background.mjs is: an artefact only some machines can regenerate is one
// nobody regenerates. A gear is also a profile and a stroke width, which is
// less to describe in code than it is to keep in a binary nobody can diff.
//
// **Drawn as an outline, not a solid.** The items around it — Services, Hide,
// Show All — are SF Symbols at the menu's own weight, which are thin strokes
// with air inside them; a filled gear beside them reads as a heavier icon in a
// darker ink even though a template image has no ink of its own. So the shape
// here is the gear's outline at `STROKE`, sized to sit in the same box as
// theirs rather than to fill the 16pt one.
//
// It is a **template image**: black everywhere, and the alpha channel is the
// whole drawing. macOS tints template images itself, so one file follows the
// menu's own appearance — light, dark, and the highlight the row takes when the
// pointer is over it — where a coloured icon would be wrong in two of the three.
//
// The two sizes are the two representations `menu.ts` hands to Electron: menu
// icons are 16pt, and @2x is what a Retina display draws.
//
//   bun scripts/menu-icon.mjs [--preview]

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import path from "node:path"
import console from "node:console"
import { Buffer } from "node:buffer"

import { encodePng } from "./png.mjs"

const root = path.join(import.meta.dirname, "..")

/** Teeth, and how much of each tooth's slot the tooth itself takes. Eight is
 * as many as reads at 16px — twelve turns into a fuzzy circle. */
const TEETH = 8
const DUTY = 0.5

/*
 * The gear, as fractions of the image so one description draws every size.
 *
 * The tip plus half a stroke is the icon's real radius, and it stops short of
 * the edge: macOS gives a menu item's icon its 16pt box and draws the label
 * right against it, so an icon that fills its box sits closer to the text than
 * the system's own do.
 */
const TIP = 0.38
const ROOT = 0.245
const HOLE = 0.135
/** The pen. 0.07 of 16px is the ~1.1px stroke an SF Symbol is drawn with at
 * this size, which is what makes the gear weigh the same as its neighbours.
 * A tooth is twice that tall, or the stroke closes over it and the teeth come
 * back as the solid bumps this outline was drawn to get rid of. */
const STROKE = 0.07

/** Sub-samples per pixel, per axis. A 1.1px stroke is thinner than a pixel in
 * places, and how much of the pixel it covers is the whole of how it looks. */
const SAMPLES = 8

/** How far apart two points on the profile are sampled when it is turned into
 * a polyline. Fine enough that a tooth's side is one near-radial segment. */
const PROFILE_STEPS = 720

/** The toothed outline as a closed polyline, in fractions of the image. */
function profile() {
  const points = []
  for (let step = 0; step < PROFILE_STEPS; step++) {
    const turn = step / PROFILE_STEPS
    // Where this angle falls in its tooth's slot: the first `DUTY` of a slot is
    // the tooth, the rest is the gap between it and the next.
    const radius = (turn * TEETH) % 1 < DUTY ? TIP : ROOT
    const angle = turn * 2 * Math.PI
    points.push([radius * Math.cos(angle), radius * Math.sin(angle)])
  }
  return points
}

const OUTLINE = profile()

/** Distance from a point to a segment. */
function toSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const along = length === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / length
  const clamped = Math.max(0, Math.min(1, along))
  return Math.hypot(px - (ax + clamped * dx), py - (ay + clamped * dy))
}

/**
 * Distance from a point to the nearest line the gear is drawn along — the
 * toothed outline, or the circle at its centre.
 *
 * Only the segments around the point's own angle are measured. The outline is
 * a radius per angle, so the nearest piece of it is never more than a tooth
 * away round the circle; walking all 720 for every sub-sample of every pixel
 * is what made this take a minute for a 16px icon.
 */
function toOutline(px, py) {
  let nearest = Math.abs(Math.hypot(px, py) - HOLE)

  const turn = (Math.atan2(py, px) / (2 * Math.PI) + 1) % 1
  const at = Math.floor(turn * PROFILE_STEPS)
  const window = Math.ceil(PROFILE_STEPS / TEETH)

  for (let step = at - window; step <= at + window; step++) {
    const i = (step + PROFILE_STEPS) % PROFILE_STEPS
    const distance = toSegment(
      px,
      py,
      OUTLINE[i],
      OUTLINE[(i + 1) % PROFILE_STEPS]
    )
    if (distance < nearest) nearest = distance
  }
  return nearest
}

/** How much of the pixel at (x, y) the stroke covers, 0 to 1. */
function coverage(x, y, size) {
  const centre = size / 2
  const half = STROKE / 2

  let inside = 0
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      // In fractions of the image, which is what the profile is written in.
      const px = (x + (sx + 0.5) / SAMPLES - centre) / size
      const py = (y + (sy + 0.5) / SAMPLES - centre) / size
      if (toOutline(px, py) <= half) inside += 1
    }
  }

  return inside / (SAMPLES * SAMPLES)
}

/** The gear at one size, as an RGBA image: black, with the shape in alpha. */
function gear(size) {
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      pixels[(y * size + x) * 4 + 3] = Math.round(255 * coverage(x, y, size))
    }
  }
  return { width: size, height: size, pixels }
}

const { values } = parseArgs({
  options: { preview: { type: "boolean", default: false } },
})

const sizes = [
  ["menu-settings.png", 16],
  ["menu-settings@2x.png", 32],
  // Not shipped — a size worth looking at when the numbers above are changed.
  ...(values.preview ? [["menu-settings-preview.local.png", 256]] : []),
]

for (const [name, size] of sizes) {
  const file = path.join(root, "resources", name)
  writeFileSync(file, encodePng(gear(size)))
  console.log(`wrote ${path.relative(root, file)} (${size}×${size})`)
}
