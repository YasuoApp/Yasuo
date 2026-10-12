import { useState } from "react"
import { createReactBlockSpec } from "@blocknote/react"

import { MarkdownView } from "../markdown-view"

/**
 * A run of a markdown file the block editor cannot hold, kept exactly as it is.
 *
 * What lands here is anything with HTML in it — a `<details>` that folds, an
 * `<img align="right">`, a `<sub>` in a line of prose. The block document has a
 * fixed set of blocks and no tag among them, so markup parsed into it is
 * dropped on the way in and gone from the file on the way out; the run is taken
 * out before the parser sees it (`lib/markdown/raw-html.ts`) and put back
 * verbatim on the way out (`files/file-blocks.tsx`). Nothing in the file is
 * lost, which is the whole point — a README that loses half of itself the first
 * time it is saved is worse than one that cannot be edited here at all.
 *
 * The same division the drawing block makes, and for the same reason: a block
 * that carries a thing markdown has no shape for. What differs is which way
 * round it is. A drawing's markdown is a fence *this app invented*, so a `.md`
 * is given the fence and not the block; HTML is markdown the file already had,
 * so the file is given the block and the block prints the HTML.
 *
 * **Read-only, and rendered.** `content: "none"`, so there is nothing in it to
 * put a caret in — the source is one string and a caret halfway through a tag is
 * a way to write a document that no longer parses. It is drawn through the same
 * `MarkdownView` the Markdown preview uses, so the block shows what the preview
 * shows, and `Source` is there for the times what you need is the markup.
 */
export const RAW_HTML_BLOCK = "rawHtml"

export const rawHtmlBlockSpec = createReactBlockSpec(
  {
    type: RAW_HTML_BLOCK,
    content: "none",
    /** The run's own text, which for a run that is nothing but tags is the HTML
     * and for a paragraph with a `<br>` in it is the paragraph. Held whole
     * because a tag on its own is not something a document can be given back. */
    propSchema: { source: { default: "" } },
  },
  {
    render: ({ block, editor }) => (
      <RawHtml
        source={block.props.source}
        onRemove={() => editor.removeBlocks([block])}
      />
    ),
  }
)

function RawHtml({
  source,
  onRemove,
}: {
  source: string
  onRemove: () => void
}) {
  const [showSource, setShowSource] = useState(false)

  return (
    <div className="note-raw-html">
      {/* `contentEditable={false}` over the rendered markup as well as the
          buttons: the block is an atom to ProseMirror, but the elements inside
          it are real elements, and a browser will happily put a caret in one. */}
      <div className="note-raw-html-body" contentEditable={false}>
        {showSource ? (
          <pre className="note-raw-html-source">{source}</pre>
        ) : (
          <MarkdownView
            source={source}
            rawHtml
            className="markdown-document text-[0.9375rem]"
          />
        )}
      </div>

      <div className="note-raw-html-toolbar" contentEditable={false}>
        <span className="note-raw-html-label">HTML</span>
        <button type="button" onClick={() => setShowSource(!showSource)}>
          {showSource ? "Rendered" : "Source"}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onRemove()
          }}
        >
          Remove
        </button>
      </div>
    </div>
  )
}
