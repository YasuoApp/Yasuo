// Draws the menu bar's icon, into resources/tray.png (+ @2x).
//
// Generated rather than exported from a design tool, for the reason
// menu-icon.mjs is: an artefact only some machines can regenerate is one nobody
// regenerates. A bubble is a rounded box and a tail, which is less to describe
// in code than it is to keep in a binary nobody can diff.
//
// **Filled, where the menu's gear is an outline.** They sit in different places
// and are read differently: the gear sits in a list beside SF Symbols at the
// menu's own weight, and this sits alone in a strip shared with every other app
// on the machine, glanced at from across the room. A 1.1px outline is what that
// glance loses first.
//
// It is a **template image**: black everywhere, and the alpha channel is the
// whole drawing. macOS tints template images itself, so one file follows the
// menu bar's own appearance — light, dark, and the highlight the item takes
// while its menu is open — where a coloured icon would be wrong in two of the
// three.
//
//   bun scripts/tray-icon.mjs [--preview]

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import path from "node:path"
import console from "node:console"
import { Buffer } from "node:buffer"

import { encodePng } from "./png.mjs"

const root = path.join(import.meta.dirname, "..")

/*
 * The bubble, as fractions of the image so one description draws every size.
 *
 * It stops well short of the edge on every side. A status item's icon is given
 * the menu bar's full height and the bar is ~22pt tall for a ~16pt drawing:
 * filling the box would make this the tallest thing in the strip, which is what
 * an icon that looks wrong beside the system's own actually is.
 */
const HALF_WIDTH = 0.38
const HALF_HEIGHT = 0.27
const RADIUS = 0.1
/** How far the box sits above centre, leaving the tail its room below. */
const RISE = 0.05

/** The tail, in the same fractions: where it leaves the box and where it points.
 * Left of centre, which is the direction a speech bubble's tail conventionally
 * goes and the side the count is not drawn on. */
const TAIL = [
  [-0.24, 0.1],
  [-0.04, 0.1],
  [-0.22, 0.4],
]

/** Sub-samples per pixel, per axis. At 16px a corner's radius is under two
 * pixels, and how much of each one it covers is the whole of how it looks. */
const SAMPLES = 8

/**
 * Whether a point is inside the rounded box.
 *
 * The usual rounded-rect distance, measured from the corner circles' own
 * centres: outside the box on both axes it is the distance to the nearest of
 * those, and inside on either axis it is how far in — which is what the
 * `min(…, 0)` term restores, and what a `max(x, y) <= 0` on its own gets wrong
 * for exactly the four points beyond one edge and between the other two.
 */
function inBox(px, py) {
  const x = Math.abs(px) - (HALF_WIDTH - RADIUS)
  const y = Math.abs(py + RISE) - (HALF_HEIGHT - RADIUS)
  const outside = Math.hypot(Math.max(x, 0), Math.max(y, 0))
  return outside + Math.min(Math.max(x, y), 0) <= RADIUS
}

/** Whether a point is inside the tail, by the sign of its three edge cross
 * products — one triangle, so there is nothing to be gained by an SDF. */
function inTail(px, py) {
  let side = 0
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = TAIL[i]
    const [bx, by] = TAIL[(i + 1) % 3]
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    if (cross === 0) continue
    const sign = cross > 0 ? 1 : -1
    if (side === 0) side = sign
    else if (side !== sign) return false
  }
  return true
}

/** How much of the pixel at (x, y) the bubble covers, 0 to 1. */
function coverage(x, y, size) {
  const centre = size / 2
  let inside = 0
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      // In fractions of the image, which is what the shape is written in.
      const px = (x + (sx + 0.5) / SAMPLES - centre) / size
      const py = (y + (sy + 0.5) / SAMPLES - centre) / size
      if (inBox(px, py) || inTail(px, py)) inside += 1
    }
  }
  return inside / (SAMPLES * SAMPLES)
}

/** The bubble at one size, as an RGBA image: black, with the shape in alpha. */
function bubble(size) {
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
  ["tray.png", 16],
  ["tray@2x.png", 32],
  // Not shipped — a size worth looking at when the numbers above are changed.
  ...(values.preview ? [["tray-preview.local.png", 256]] : []),
]

for (const [name, size] of sizes) {
  const file = path.join(root, "resources", name)
  writeFileSync(file, encodePng(bubble(size)))
  console.log(`wrote ${path.relative(root, file)} (${size}×${size})`)
}
