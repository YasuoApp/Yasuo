// Renders resources/icon.png from the app's mark in resources/logo.svg.
//
// electron-builder does not letterbox: it resizes whatever PNG it is handed to
// a square 1024. And the mark is wider than it is tall and sits inside a
// square viewBox with margin of its own, so drawn as-is it would sit small and
// off-grid inside its own tile next to every other icon in the Dock.
//
// So: find what is actually drawn, render it again at the size that fits the
// macOS icon grid, and centre it. Rendered twice rather than rendered once and
// scaled, so every pixel of the icon is the vector's own rather than a resample.
//
//   bun scripts/app-icon.mjs

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import console from "node:console"
import { Buffer } from "node:buffer"
import { Resvg } from "@resvg/resvg-js"
import { decodePng, encodePng, alphaBounds, crop } from "./png.mjs"

const CANVAS = 1024

// Apple's macOS icon grid: the artwork lives in a 824×824 area centred in a
// 1024 tile, and the surrounding margin is what keeps icons optically the same
// size in the Dock whatever their silhouette. A freeform mark like this one
// fills the box rather than sitting in a rounded-rect plate.
const CONTENT = 824

const buildDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "resources"
)
const sourceFile = path.join(buildDir, "logo.svg")
const outFile = path.join(buildDir, "icon.png")

const svg = readFileSync(sourceFile)

function render(width) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } })
    .render()
    .asPng()
  return decodePng(png)
}

// A first pass only to measure the mark against its own viewBox.
const PROBE = 1000
const probe = alphaBounds(render(PROBE), 0)
const scale = CONTENT / Math.max(probe.width, probe.height)

const full = render(Math.round(PROBE * scale))
const mark = crop(full, alphaBounds(full, 0))

const pixels = Buffer.alloc(CANVAS * CANVAS * 4)
const width = Math.min(mark.width, CANVAS)
const height = Math.min(mark.height, CANVAS)
const left = Math.round((CANVAS - width) / 2)
const top = Math.round((CANVAS - height) / 2)
for (let y = 0; y < height; y++) {
  const from = y * mark.width * 4
  mark.pixels.copy(
    pixels,
    ((top + y) * CANVAS + left) * 4,
    from,
    from + width * 4
  )
}

writeFileSync(outFile, encodePng({ width: CANVAS, height: CANVAS, pixels }))

console.log(`${outFile}  ${CANVAS}×${CANVAS}  (mark ${width}×${height})`)
