// Just enough PNG to read and write the build resources, so that generating
// them needs nothing installed beyond what the repo already has. Same reasoning
// as search.ts not shelling out to ripgrep: a build artefact that only some
// machines can regenerate is one nobody regenerates.
//
// Scope is deliberately narrow — 8-bit, non-interlaced, truecolour with or
// without alpha. Everything else throws rather than guessing, because the only
// inputs here are files this repo produced or a designer exported.

import { deflateSync, inflateSync } from "node:zlib"
import { Buffer } from "node:buffer"

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i++)
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decode to { width, height, pixels } with pixels as straight (un-premultiplied) RGBA. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG")

  let width = 0
  let height = 0
  let channels = 0
  const idat = []

  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("ascii", offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colorType = data[9]
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`)
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`unsupported colour type ${colorType} (want 2 or 6)`)
      }
      if (data[12] !== 0) throw new Error("interlaced PNG is not supported")
      channels = colorType === 6 ? 4 : 3
    } else if (type === "IDAT") {
      idat.push(data)
    } else if (type === "IEND") {
      break
    }
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(
      raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    )

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      if (filter === 1) line[i] = (line[i] + a) & 0xff
      else if (filter === 2) line[i] = (line[i] + b) & 0xff
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) line[i] = (line[i] + paeth(a, b, c)) & 0xff
      else if (filter !== 0)
        throw new Error(`unknown filter ${filter} on row ${y}`)
    }

    for (let x = 0; x < width; x++) {
      const from = x * channels
      const to = (y * width + x) * 4
      out[to] = line[from]
      out[to + 1] = line[from + 1]
      out[to + 2] = line[from + 2]
      out[to + 3] = channels === 4 ? line[from + 3] : 255
    }

    previous = line
  }

  return { width, height, pixels: out }
}

/**
 * Encode straight RGBA. `alpha: false` drops the channel — worth it for the DMG
 * background, which is fully opaque and a third smaller without it.
 */
export function encodePng({ width, height, pixels }, { alpha = true } = {}) {
  const channels = alpha ? 4 : 3
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)

  for (let y = 0; y < height; y++) {
    // Filter 0 throughout: these images are smooth gradients, where per-row
    // filter selection buys almost nothing over what deflate already finds.
    const rowStart = y * (stride + 1) + 1
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      const to = rowStart + x * channels
      raw[to] = pixels[from]
      raw[to + 1] = pixels[from + 1]
      raw[to + 2] = pixels[from + 2]
      if (alpha) raw[to + 3] = pixels[from + 3]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = alpha ? 6 : 2

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** Tightest rectangle containing any pixel with alpha above `threshold`. */
export function alphaBounds({ width, height, pixels }, threshold = 0) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] <= threshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) throw new Error("image is fully transparent")
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

export function crop(image, { x, y, width, height }) {
  const pixels = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4
    image.pixels.copy(pixels, row * width * 4, from, from + width * 4)
  }
  return { width, height, pixels }
}

const LANCZOS_A = 3

function lanczos(x) {
  if (x === 0) return 1
  if (x <= -LANCZOS_A || x >= LANCZOS_A) return 0
  const px = Math.PI * x
  return (LANCZOS_A * Math.sin(px) * Math.sin(px / LANCZOS_A)) / (px * px)
}

// Weights for one output axis. Sampling is done in the source's coordinate
// space so the same routine handles up- and downscaling; the support widens
// when shrinking so downscales average rather than alias.
function weightsFor(sourceSize, targetSize) {
  const ratio = sourceSize / targetSize
  const support = Math.max(1, ratio) * LANCZOS_A
  const rows = []

  for (let i = 0; i < targetSize; i++) {
    const center = (i + 0.5) * ratio
    const from = Math.max(0, Math.floor(center - support))
    const to = Math.min(sourceSize - 1, Math.ceil(center + support))
    const weights = []
    let total = 0
    for (let j = from; j <= to; j++) {
      const w = lanczos((j + 0.5 - center) / Math.max(1, ratio))
      weights.push(w)
      total += w
    }
    rows.push({ from, weights, total })
  }

  return rows
}

/**
 * Lanczos resample. Colour is weighted by alpha (premultiplied) and divided
 * back out afterwards — resampling straight RGBA pulls the colour of fully
 * transparent pixels into the edge, which on this icon is a black halo, since
 * that is what its transparent region happens to hold.
 */
export function resize(image, targetWidth, targetHeight) {
  const horizontal = weightsFor(image.width, targetWidth)
  const vertical = weightsFor(image.height, targetHeight)

  const intermediate = new Float64Array(targetWidth * image.height * 4)
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const { from, weights, total } = horizontal[x]
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < weights.length; k++) {
        const w = weights[k]
        const p = (y * image.width + from + k) * 4
        const alpha = image.pixels[p + 3] / 255
        r += image.pixels[p] * alpha * w
        g += image.pixels[p + 1] * alpha * w
        b += image.pixels[p + 2] * alpha * w
        a += image.pixels[p + 3] * w
      }
      const to = (y * targetWidth + x) * 4
      intermediate[to] = r / total
      intermediate[to + 1] = g / total
      intermediate[to + 2] = b / total
      intermediate[to + 3] = a / total
    }
  }

  const pixels = Buffer.alloc(targetWidth * targetHeight * 4)
  for (let y = 0; y < targetHeight; y++) {
    const { from, weights, total } = vertical[y]
    for (let x = 0; x < targetWidth; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < weights.length; k++) {
        const w = weights[k]
        const p = ((from + k) * targetWidth + x) * 4
        r += intermediate[p] * w
        g += intermediate[p + 1] * w
        b += intermediate[p + 2] * w
        a += intermediate[p + 3] * w
      }
      r /= total
      g /= total
      b /= total
      a /= total

      const to = (y * targetWidth + x) * 4
      const alpha = Math.max(0, Math.min(255, a))
      pixels[to + 3] = Math.round(alpha)
      const scale = alpha > 0 ? 255 / alpha : 0
      pixels[to] = Math.max(0, Math.min(255, Math.round(r * scale)))
      pixels[to + 1] = Math.max(0, Math.min(255, Math.round(g * scale)))
      pixels[to + 2] = Math.max(0, Math.min(255, Math.round(b * scale)))
    }
  }

  return { width: targetWidth, height: targetHeight, pixels }
}
