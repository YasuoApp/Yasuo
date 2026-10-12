import {
  adoptDrawingFences,
  type NoteBlock,
} from "../src/renderer/lib/note/blocks"
import { check, finish, section } from "./harness"

/**
 * What happens to the drawings a markdown document carried in a fence.
 *
 * This used to be a regular expression over ```drawing fences, and the fence
 * shapes it had to survive — four backticks, CRLF, an indented block — are now
 * BlockNote's parser's business rather than ours. What is left is the walk, and
 * the one hand-off that is still this app's own: a code block that says
 * `drawing` is a drawing, and nothing else is.
 *
 * Worth a test because both ways of being wrong are silent. Miss a fence and a
 * drawing reads as a code block full of a UUID; adopt one too eagerly and a
 * code block somebody wrote about drawings disappears into a canvas.
 *
 * The reads over the same document — which scenes a note owned, for deleting
 * and duplicating — went with the Notes panel; see `docs/design.md` § Notes,
 * removed.
 */

const ID = "7c3f1a2e-5b6d-4a8f-9e21-1f0b3c4d5e6f"

const text = (words: string): NoteBlock => ({
  type: "paragraph",
  content: [{ type: "text", text: words }],
})

const fence = (language: string, id: string): NoteBlock => ({
  type: "codeBlock",
  props: { language },
  content: [{ type: "text", text: id }],
})

/** Every drawing the document holds, in the order they appear — the assertion
 * the checks below are all really making. */
function drawingIds(blocks: NoteBlock[]): string[] {
  return blocks.flatMap((block) => [
    ...(block.type === "drawing" && typeof block.props?.drawingId === "string"
      ? [block.props.drawingId]
      : []),
    ...(block.children ? drawingIds(block.children) : []),
  ])
}

section("adoptDrawingFences")
{
  const adopted = adoptDrawingFences([text("before"), fence("drawing", ID)])
  check(
    "a drawing fence becomes a drawing block",
    adopted[1]?.type === "drawing" &&
      adopted[1]?.props?.drawingId === ID &&
      drawingIds(adopted).join() === ID,
    adopted[1]
  )

  check(
    "everything else survives",
    adopted[0]?.type === "paragraph" && adopted.length === 2
  )

  const other = adoptDrawingFences([fence("json", ID)])
  check(
    "a code block in another language is left alone",
    other[0]?.type === "codeBlock" && drawingIds(other).length === 0
  )

  check(
    "a language that merely starts the same is not a drawing",
    adoptDrawingFences([fence("drawings", ID)])[0]?.type === "codeBlock"
  )

  // Without this the id would be "", and a block pointing at no scene reads as
  // an empty drawing the user never made.
  check(
    "an empty fence stays a code block",
    adoptDrawingFences([fence("drawing", "  ")])[0]?.type === "codeBlock"
  )

  const deep = adoptDrawingFences([
    { type: "bulletListItem", content: [], children: [fence("drawing", ID)] },
  ])
  check(
    "a fence nested under another block is adopted too",
    drawingIds(deep).join() === ID
  )
}

finish()
