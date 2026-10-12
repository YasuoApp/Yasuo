import { BlockNoteEditor } from "@blocknote/core"

import { adoptDrawingFences, type NoteBlock } from "./blocks"

/**
 * Reading markdown as blocks.
 *
 * The parser is BlockNote's own, which means an editor: `tryParseMarkdownToBlocks`
 * is a method rather than a function, and there is no lighter way in. One is
 * built here on first use and kept — it is never mounted and never shown, and
 * the alternative is a second editor per note being converted.
 */
let parser: BlockNoteEditor | null = null

/**
 * The blocks a markdown document becomes.
 *
 * The default schema, not the editor's own: a fence is a code block to any
 * parser, and `adoptDrawingFences` is what turns the drawing ones back into
 * drawing blocks afterwards. Keeping the drawing block out of here is what
 * keeps this file clear of the component layer.
 *
 * `drawings: false` leaves the fences as the code blocks they parsed to. That
 * is for a `.md` in one of the workspace's folders, which the block editor
 * writes *back* to markdown: a drawing block has no markdown of its own, so a
 * fence promoted to one there would be a fence that does not survive the next
 * save. As a code block holding an id it round-trips exactly.
 */
export function blocksFromMarkdown(
  markdown: string,
  { drawings = true }: { drawings?: boolean } = {}
): NoteBlock[] {
  parser ??= BlockNoteEditor.create()
  const blocks = parser.tryParseMarkdownToBlocks(markdown) as NoteBlock[]
  return drawings ? adoptDrawingFences(blocks) : blocks
}
