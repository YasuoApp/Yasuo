import { DRAWING_LANGUAGE, type NoteBlock } from "@shared/api"

/**
 * A block document, as the block editor holds it.
 *
 * What is left of the Notes panel's own document module. The panel is gone —
 * see `docs/design.md` § Notes, removed — and what still reads this is the
 * Explorer's block editor over a `.note` or a `.md` file: `blocksFromMarkdown`
 * in `from-markdown.ts` parses one and hands the result here to have its
 * drawing fences adopted.
 *
 * `NoteBlock` itself lives in `shared/api.ts`, from when the preview server
 * rendered the same document in the main process. It stayed there: it is the
 * shape of a file on disk rather than this side's own idea, and the file is
 * still on disk. Re-exported here because the walk below is here, and its
 * callers ask this file for the type.
 */
export type { NoteBlock }

/** The block a drawing lives in. Here rather than beside its React component,
 * so that the walk below does not have to reach into the component layer for a
 * string. */
export const DRAWING_BLOCK = "drawing"

/**
 * Turns the fences a markdown document carried its drawings in into drawing
 * blocks.
 *
 * The one thing the parse cannot leave to BlockNote: it knows nothing of this
 * app's blocks, so a ```drawing fence arrives as a code block whose text is an
 * id — which would read as a code block full of a UUID rather than as the
 * drawing it names.
 */
export function adoptDrawingFences(blocks: NoteBlock[]): NoteBlock[] {
  return blocks.map((block) => {
    const children = block.children
      ? adoptDrawingFences(block.children)
      : block.children

    const id = fencedDrawingId(block)
    if (id) {
      return {
        ...(block.id ? { id: block.id } : {}),
        type: DRAWING_BLOCK,
        props: { drawingId: id },
      }
    }

    return children === block.children ? block : { ...block, children }
  })
}

/**
 * The id inside a code block that used to be a drawing fence.
 *
 * BlockNote parses a fence into a `codeBlock` whose `language` is what followed
 * the backticks and whose text is the one line between them — so this is those
 * two things, read out of the block.
 */
function fencedDrawingId(block: NoteBlock): string | null {
  if (block.type !== "codeBlock") return null
  if (block.props?.language !== DRAWING_LANGUAGE) return null

  const text = textOf(block.content).trim()
  return text || null
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((item: unknown) => {
      if (typeof item === "string") return item
      const text = (item as { text?: unknown } | null)?.text
      return typeof text === "string" ? text : ""
    })
    .join("")
}
