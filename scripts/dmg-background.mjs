// Draws the DMG window's background into build/background.png (+ @2x).
//
// It is generated rather than exported from a design tool for the same reason
// search.ts is not ripgrep: the artefact has to be reproducible on any machine
// that checks out the repo, and a committed PNG nobody can regenerate is a
// binary whose colours drift out of the app's.
//
// Two constraints come from electron-builder, both worth knowing before
// touching the numbers:
//
//   - dmg-builder sizes the DMG window from the background image, so WIDTH and
//     HEIGHT must stay equal to `dmg.window` in package.json or the icon
//     coordinates in `dmg.contents` land in the wrong place.
//   - background@2x.png is picked up on its own and folded into a multi-
//     representation TIFF with tiffutil. There is no config for it.
//
// Deliberately wordless. Finder already draws "Visual Studio Claude" and "Applications"
// under the two icons; an arrow between them is the whole instruction.
//
//   bun apps/desktop/scripts/dmg-background.mjs [--theme light|dark]

import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import process from "node:process"
import console from "node:console"
import { Buffer } from "node:buffer"
import { encodePng } from "./png.mjs"

const WIDTH = 540
const HEIGHT = 380

// Where dmg.contents puts the two icons. The glows sit under them.
const APP = { x: 150, y: 190 }
const APPLICATIONS = { x: 390, y: 190 }

const THEMES = {
  // Light is the default because Finder paints the icon labels in the system
  // label colour, which is near-black under a light appearance. A dark
  // background looks better in dark mode and costs the labels their contrast
  // in light mode, and light mode is the one we cannot detect or opt out of.
  light: {
    top: [0.988, 0.988, 0.996],
    bottom: [0.945, 0.945, 0.965],
    // Light tints toward the accent instead of adding to it — additive light
    // on an already bright base just clips to white.
    blend: "tint",
    glows: [
      { at: APP, color: [0.435, 0.322, 1.0], radius: 205, strength: 0.16 },
      {
        at: APPLICATIONS,
        color: [0.231, 0.51, 0.965],
        radius: 205,
        strength: 0.11,
      },
    ],
    arrow: { color: [0.36, 0.36, 0.45], alpha: 0.55 },
    vignette: 0.045,
  },
  dark: {
    top: [0.031, 0.031, 0.051],
    bottom: [0.02, 0.02, 0.031],
    blend: "add",
    glows: [
      { at: APP, color: [0.427, 0.231, 1.0], radius: 215, strength: 0.5 },
      {
        at: APPLICATIONS,
        color: [0.231, 0.51, 0.965],
        radius: 215,
        strength: 0.38,
      },
    ],
    arrow: { color: [0.91, 0.91, 0.96], alpha: 0.45 },
    vignette: 0.16,
  },
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

// Hermite ease used for every falloff here, so the glows and the arrow's
// antialiasing share one curve.
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

// Distance to a capsule: one segment, one thickness, round ends. Both the
// shaft and the two barbs of the arrowhead are drawn with it.
function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const lengthSquared = abx * abx + aby * aby
  const t =
    lengthSquared === 0
      ? 0
      : clamp((apx * abx + apy * aby) / lengthSquared, 0, 1)
  const dx = apx - abx * t
  const dy = apy - aby * t
  return Math.hypot(dx, dy)
}

// Starts clear of the app icon (80px, so ±40) and stops clear of the
// Applications alias, otherwise the shaft runs under both labels.
const SHAFT_FROM = APP.x + 62
const SHAFT_TO = APPLICATIONS.x - 62
const HEAD_LENGTH = 13
const HEAD_SPREAD = 11
const STROKE = 1.6

function arrowCoverage(x, y) {
  const shaft = segmentDistance(x, y, SHAFT_FROM, APP.y, SHAFT_TO, APP.y)
  const upper = segmentDistance(
    x,
    y,
    SHAFT_TO - HEAD_LENGTH,
    APP.y - HEAD_SPREAD,
    SHAFT_TO,
    APP.y
  )
  const lower = segmentDistance(
    x,
    y,
    SHAFT_TO - HEAD_LENGTH,
    APP.y + HEAD_SPREAD,
    SHAFT_TO,
    APP.y
  )
  const d = Math.min(shaft, upper, lower)
  return smoothstep(STROKE + 0.6, STROKE - 0.6, d)
}

function render(theme, scale) {
  const t = THEMES[theme]
  const width = WIDTH * scale
  const height = HEIGHT * scale
  const pixels = Buffer.allocUnsafe(width * height * 4)

  // Radius of the corner-to-centre diagonal, for the vignette.
  const maxRadius = Math.hypot(WIDTH / 2, HEIGHT / 2)

  let offset = 0
  for (let py = 0; py < height; py++) {
    // Sample at pixel centres in logical space so 1x and 2x agree.
    const y = (py + 0.5) / scale
    for (let px = 0; px < width; px++) {
      const x = (px + 0.5) / scale

      const v = y / HEIGHT
      let r = t.top[0] + (t.bottom[0] - t.top[0]) * v
      let g = t.top[1] + (t.bottom[1] - t.top[1]) * v
      let b = t.top[2] + (t.bottom[2] - t.top[2]) * v

      for (const glow of t.glows) {
        const d = Math.hypot(x - glow.at.x, y - glow.at.y)
        const falloff = smoothstep(1, 0, d / glow.radius) ** 1.6
        const a = falloff * glow.strength
        if (a <= 0) continue
        if (t.blend === "add") {
          r += glow.color[0] * a
          g += glow.color[1] * a
          b += glow.color[2] * a
        } else {
          r += (glow.color[0] - r) * a
          g += (glow.color[1] - g) * a
          b += (glow.color[2] - b) * a
        }
      }

      const d = Math.hypot(x - WIDTH / 2, y - HEIGHT / 2) / maxRadius
      const shade = 1 - t.vignette * d * d
      r *= shade
      g *= shade
      b *= shade

      const coverage = arrowCoverage(x, y) * t.arrow.alpha
      if (coverage > 0) {
        r += (t.arrow.color[0] - r) * coverage
        g += (t.arrow.color[1] - g) * coverage
        b += (t.arrow.color[2] - b) * coverage
      }

      // Ordered dither. A 540px-wide gradient crosses far fewer than 256
      // levels, and without this the flat areas band visibly on a good display.
      const noise = (((px * 7 + py * 13) % 16) / 16 - 0.5) / 255

      pixels[offset++] = clamp(Math.round((r + noise) * 255), 0, 255)
      pixels[offset++] = clamp(Math.round((g + noise) * 255), 0, 255)
      pixels[offset++] = clamp(Math.round((b + noise) * 255), 0, 255)
      pixels[offset++] = 255
    }
  }

  return { pixels, width, height }
}

const themeArg = process.argv.indexOf("--theme")
const theme = themeArg === -1 ? "light" : process.argv[themeArg + 1]
if (!THEMES[theme]) {
  console.error(
    `unknown theme "${theme}" — expected ${Object.keys(THEMES).join(" or ")}`
  )
  process.exit(1)
}

const outArg = process.argv.indexOf("--out")
const buildDir =
  outArg === -1
    ? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources")
    : process.argv[outArg + 1]

for (const scale of [1, 2]) {
  const file = path.join(
    buildDir,
    scale === 1 ? "background.png" : "background@2x.png"
  )
  // No alpha: the background is opaque, and the channel is a third of the file.
  writeFileSync(file, encodePng(render(theme, scale), { alpha: false }))
  console.log(`${file}  ${WIDTH * scale}×${HEIGHT * scale}  ${theme}`)
}
