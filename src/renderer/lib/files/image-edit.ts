/**
 * The image editor's arithmetic, apart from the canvas it is drawn on.
 *
 * Everything here is in the picture's own pixels. The canvas on screen is
 * shrunk to fit the pane, so a pointer is in CSS pixels of a box that is not the
 * picture's size, and a crop taken in the wrong one is a crop of the wrong
 * place — which is exactly the mistake that is invisible on a small image and
 * obvious on a screenshot.
 */

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }
export type Size = { width: number; height: number }

/** A pointer in the picture's pixels, from where it is on the box drawing it. */
export function toImagePoint(
  client: Point,
  box: { left: number; top: number; width: number; height: number },
  image: Size
): Point {
  return {
    x: ((client.x - box.left) * image.width) / box.width,
    y: ((client.y - box.top) * image.height) / box.height,
  }
}

/**
 * The rectangle between two corners, whichever way it was dragged, held to the
 * picture and rounded to whole pixels — a crop is of pixels, and a fractional
 * edge is a column half-sampled into its neighbour.
 */
export function rectBetween(a: Point, b: Point, image: Size): Rect {
  const clampX = (v: number) =>
    Math.min(Math.max(Math.round(v), 0), image.width)
  const clampY = (v: number) =>
    Math.min(Math.max(Math.round(v), 0), image.height)
  const left = clampX(Math.min(a.x, b.x))
  const right = clampX(Math.max(a.x, b.x))
  const top = clampY(Math.min(a.y, b.y))
  const bottom = clampY(Math.max(a.y, b.y))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Below this a drag is a click, not a crop: a 1×1 picture is never what
 * somebody meant. */
export const MIN_CROP = 4

export function isCroppable(rect: Rect | null): rect is Rect {
  return rect !== null && rect.width >= MIN_CROP && rect.height >= MIN_CROP
}

/** The size after a quarter turn either way. */
export function turnedSize(size: Size): Size {
  return { width: size.height, height: size.width }
}

/**
 * The other side of a resize with the ratio kept, from the side typed into.
 * Never below one pixel: a canvas of width 0 throws on encode.
 */
export function keepRatio(
  original: Size,
  changed: "width" | "height",
  value: number
): Size {
  const clamp = (v: number) => Math.max(1, Math.round(v))
  if (changed === "width") {
    const width = clamp(value)
    return { width, height: clamp((width * original.height) / original.width) }
  }
  const height = clamp(value)
  return { width: clamp((height * original.width) / original.height), height }
}

/** The ceiling on a resize, in either dimension — past it Chromium's canvas
 * fails to allocate and answers with a blank one rather than an error. */
export const MAX_SIDE = 16384

export function isValidSize(size: Size): boolean {
  return (
    Number.isInteger(size.width) &&
    Number.isInteger(size.height) &&
    size.width >= 1 &&
    size.height >= 1 &&
    size.width <= MAX_SIDE &&
    size.height <= MAX_SIDE
  )
}

/**
 * The two ends of an arrow's head, drawn back from the tip at ±30°. Its length
 * follows the stroke so a thick arrow does not end in a pin.
 */
export function arrowHead(
  from: Point,
  to: Point,
  width: number
): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const length = Math.max(10, width * 4)
  const at = (offset: number) => ({
    x: to.x - length * Math.cos(angle + offset),
    y: to.y - length * Math.sin(angle + offset),
  })
  return [at(Math.PI / 6), at(-Math.PI / 6)]
}
