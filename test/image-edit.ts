import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { writeImageFile } from "../src/main/files"
import { encodableTypeOf } from "../src/shared/image-files"
import {
  arrowHead,
  isCroppable,
  isValidSize,
  keepRatio,
  MAX_SIDE,
  rectBetween,
  toImagePoint,
  turnedSize,
} from "../src/renderer/lib/files/image-edit"
import { check, finish, section } from "./harness"

/**
 * The image editor's arithmetic, and the one write it makes.
 *
 * The geometry is tested because its failures are quiet: a crop taken in the
 * on-screen box's pixels instead of the picture's is still a crop, of the
 * wrong place. The write is tested against a real file because the refusal it
 * makes — bytes of one format under another's name — is the whole of its job.
 */

async function main() {
  section("encodableTypeOf")

  check("a png is written as png", encodableTypeOf("/a/b.png") === "image/png")
  check(
    "a JPG is written as jpeg",
    encodableTypeOf("C:\\a\\B.JPG") === "image/jpeg"
  )
  check("a webp is writable", encodableTypeOf("/a/b.webp") === "image/webp")
  check(
    "a gif is not: a canvas cannot encode one",
    encodableTypeOf("/a/b.gif") === null
  )
  check(
    "an svg is not: it has a text editor",
    encodableTypeOf("/a/b.svg") === null
  )
  check("a dotfile is not an extension", encodableTypeOf("/a/.png") === null)

  section("toImagePoint")

  const box = { left: 100, top: 50, width: 200, height: 100 }
  const image = { width: 800, height: 400 }
  const point = toImagePoint({ x: 150, y: 75 }, box, image)
  check(
    "a pointer is scaled into the picture's pixels",
    point.x === 200 && point.y === 100,
    point
  )

  section("rectBetween")

  const dragged = rectBetween({ x: 50.4, y: 30 }, { x: 10, y: 90.6 }, image)
  check(
    "a drag up and to the left is the same rectangle",
    dragged.x === 10 &&
      dragged.y === 30 &&
      dragged.width === 40 &&
      dragged.height === 61,
    dragged
  )
  const outside = rectBetween({ x: -20, y: -5 }, { x: 900, y: 500 }, image)
  check(
    "a drag past the edges is held to the picture",
    outside.x === 0 &&
      outside.y === 0 &&
      outside.width === 800 &&
      outside.height === 400,
    outside
  )
  check(
    "a click is not a crop",
    !isCroppable(rectBetween({ x: 5, y: 5 }, { x: 6, y: 6 }, image))
  )
  check("nothing is not a crop", !isCroppable(null))
  check("a real drag is", isCroppable(dragged))

  section("sizes")

  const turned = turnedSize({ width: 30, height: 10 })
  check(
    "a quarter turn swaps the sides",
    turned.width === 10 && turned.height === 30
  )

  const wider = keepRatio({ width: 800, height: 400 }, "width", 401)
  check(
    "the height follows the width, rounded",
    wider.width === 401 && wider.height === 201,
    wider
  )
  const taller = keepRatio({ width: 800, height: 400 }, "height", 100)
  check(
    "the width follows the height",
    taller.width === 200 && taller.height === 100,
    taller
  )
  const tiny = keepRatio({ width: 1000, height: 10 }, "width", 10)
  check("never below a pixel", tiny.height === 1, tiny)

  check("a whole size is valid", isValidSize({ width: 1, height: 1 }))
  check("zero is not", !isValidSize({ width: 0, height: 10 }))
  check("a fraction is not", !isValidSize({ width: 10.5, height: 10 }))
  check(
    "past the canvas ceiling is not",
    !isValidSize({ width: MAX_SIDE + 1, height: 10 })
  )

  section("arrowHead")

  const [left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 2)
  check("the head is drawn back from the tip", left.x < 100 && right.x < 100)
  check(
    "and either side of the shaft",
    Math.sign(left.y) === -Math.sign(right.y) && left.y !== 0
  )

  section("writeImageFile")

  const dir = await mkdtemp(path.join(tmpdir(), "vsclaude-image-edit-"))
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const png = path.join(dir, "a.png")
    await writeImageFile(
      png,
      `data:image/png;base64,${bytes.toString("base64")}`
    )
    check(
      "the decoded bytes are what is written",
      (await readFile(png)).equals(bytes)
    )

    let mismatched = false
    await writeImageFile(
      path.join(dir, "b.jpg"),
      `data:image/png;base64,${bytes.toString("base64")}`
    ).catch(() => {
      mismatched = true
    })
    check("png bytes under a .jpg name are refused", mismatched)

    let gif = false
    await writeImageFile(
      path.join(dir, "c.gif"),
      "data:image/gif;base64,AAAA"
    ).catch(() => {
      gif = true
    })
    check("a format the editor does not write is refused", gif)

    let garbage = false
    await writeImageFile(path.join(dir, "d.png"), "not a data url").catch(
      () => {
        garbage = true
      }
    )
    check("something that is not a data URL is refused", garbage)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  finish()
}

await main()
