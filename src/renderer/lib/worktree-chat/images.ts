import type { ChatImage } from "@shared/api"
import { extensionForType } from "@shared/note-files"

/**
 * Pictures in a chat's message: `[Image #n]` in the text, the bytes beside it.
 *
 * The tag is the CLI's own — what `claude` writes into its prompt for a picture
 * pasted into the terminal — so a message reads the same whichever of the two it
 * was written in, and the tag is plain text somebody can move or delete like any
 * other word. Deleting it is how a picture is taken back out: what goes is
 * whatever the text still refers to when it is sent (`attachedIn`).
 */

/** The text standing in for the `n`th picture held by a draft. */
export const imageTag = (n: number): string => `[Image #${n}]`

const TAG = /\[Image #(\d+)\]/g

/**
 * The message as it goes out: the pictures the text still names, renumbered
 * `1…k` in the order they appear.
 *
 * Renumbered because a draft numbers in the order things were *added*, and
 * deleting the first of two leaves a message saying `[Image #2]` beside one
 * picture — which the model reads as a reference to a picture it was never
 * given. A tag naming nothing held is left as it is: it is somebody's text.
 *
 * `held[n - 1]` is `[Image #n]`'s picture.
 */
export function attachedIn(
  text: string,
  held: ChatImage[]
): { text: string; images: ChatImage[] } {
  const renumbered = new Map<number, number>()
  const images: ChatImage[] = []

  const out = text.replace(TAG, (tag, digits: string) => {
    const n = Number(digits)
    const image = held[n - 1]
    if (!image) return tag

    let next = renumbered.get(n)
    if (next === undefined) {
      images.push(image)
      next = images.length
      renumbered.set(n, next)
    }
    return imageTag(next)
  })

  return { text: out, images }
}

/**
 * The pictures a draft's text still names, with the number each is named by —
 * what the composer draws a thumbnail for. In the order they were added, which
 * is the order of the numbers, rather than the order of the text: a thumbnail
 * that jumped when a tag was moved would be a strip nobody can keep their place
 * in.
 */
export function namedIn(
  text: string,
  held: ChatImage[]
): { n: number; image: ChatImage }[] {
  const named = new Set<number>()
  for (const match of text.matchAll(TAG)) named.add(Number(match[1]))
  return held.flatMap((image, index) =>
    named.has(index + 1) ? [{ n: index + 1, image }] : []
  )
}

/** The draft without the `n`th picture's tag, and the space that led into it,
 * so taking a picture out does not leave a gap where it was. */
export function withoutTag(text: string, n: number): string {
  return text
    .split(` ${imageTag(n)}`)
    .join("")
    .split(imageTag(n))
    .join("")
}

/** A held picture as something an `img` can show — it is already in memory. */
export const dataUrlOf = (image: ChatImage): string =>
  `data:${image.mediaType};base64,${image.data}`

/**
 * Writes each picture into the workspace as a note file, so the line the
 * transcript keeps can name it — see `ChatImage.fileName`.
 *
 * Best effort, one by one: a write that fails costs that picture its preview
 * and nothing else, since the bytes still go to the CLI. Written at send rather
 * than at the drop, so a picture taken back out of a draft leaves no file.
 */
export function storeImages(images: ChatImage[]): Promise<ChatImage[]> {
  return Promise.all(
    images.map(async (image) => {
      const fileName = `${crypto.randomUUID()}.${extensionForType(image.mediaType) ?? "png"}`
      try {
        const bytes = Uint8Array.from(atob(image.data), (char) =>
          char.charCodeAt(0)
        )
        await window.desktop.writeNoteFile(fileName, bytes)
        return { ...image, fileName }
      } catch (error) {
        console.error("Could not keep that picture for the transcript", error)
        return image
      }
    })
  )
}

/** What the API takes as it is; anything else is redrawn as a PNG. */
const SENDABLE = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

/**
 * The API refuses a picture over 5 MB of base64, which is about 3.75 MB of
 * bytes, and one over 8000px on a side. A full-resolution Retina screenshot is
 * comfortably under both; a photo off a phone is often not.
 */
const MAX_BYTES = 3.75 * 1024 * 1024
const MAX_EDGE = 8000
/** Where a picture that has to be shrunk is shrunk to: the API scales anything
 * past about 1568px down before the model sees it, so detail beyond this was
 * never going to arrive anyway. */
const SHRUNK_EDGE = 2000

/**
 * A dropped or pasted file read as a picture to send, or null for anything that
 * is not one — a PDF, or a format Chromium cannot decode.
 *
 * Read **now**, at the drop: the whole reason this exists is that the file may
 * be gone by the time the message is sent.
 */
export async function readImage(file: File): Promise<ChatImage | null> {
  if (!file.type.startsWith("image/")) return null

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }

  try {
    const edge = Math.max(bitmap.width, bitmap.height)
    if (SENDABLE.has(file.type) && file.size <= MAX_BYTES && edge <= MAX_EDGE) {
      return {
        mediaType: file.type as ChatImage["mediaType"],
        data: await base64Of(file),
      }
    }

    const scale = Math.min(1, SHRUNK_EDGE / edge)
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas
      .getContext("2d")
      ?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    // A PNG first, since most of what lands here is a screenshot and a JPEG
    // smears text; a JPEG only when the PNG is still past the limit.
    const png = await blobOf(canvas, "image/png")
    if (png && png.size <= MAX_BYTES) {
      return { mediaType: "image/png", data: await base64Of(png) }
    }
    const jpeg = await blobOf(canvas, "image/jpeg", 0.85)
    if (jpeg && jpeg.size <= MAX_BYTES) {
      return { mediaType: "image/jpeg", data: await base64Of(jpeg) }
    }
    return null
  } finally {
    bitmap.close()
  }
}

function blobOf(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/** Through a data URL, which is the browser's own encoder and does not build a
 * string a byte at a time. */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error("Could not read"))
    reader.readAsDataURL(blob)
  })
}
