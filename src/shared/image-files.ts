/**
 * The pictures the image editor will write back, by extension.
 *
 * Shared because both sides ask the same question: the renderer whether to
 * offer `Edit` at all, and main whether the bytes it was handed are the format
 * the file's name promises. Only what a canvas can **encode** — `toDataURL`
 * answers a GIF or a BMP with a PNG, and writing PNG bytes under `.gif` is a
 * file every other tool then misreads. An SVG is not here either: it has a
 * text editor, and flattening one to pixels is not an edit of it.
 */
const ENCODABLE_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
}

/** The type a canvas has to be encoded as for this path, or null for a file
 * the editor does not write. */
export function encodableTypeOf(filePath: string): string | null {
  const name = filePath.split(/[/\\]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return null
  return ENCODABLE_IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null
}
