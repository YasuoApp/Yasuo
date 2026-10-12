import { useEffect, useRef, useState } from "react"
import { createReactBlockSpec } from "@blocknote/react"
import { useTheme } from "next-themes"

import {
  loadDrawing,
  onDrawingChanged,
  openDrawing,
  peekDrawing,
  type DrawingScene,
} from "@/lib/note/drawings"

/**
 * A drawing in a note: an Excalidraw scene, held in the document as one block
 * that knows only the scene's id.
 *
 * The scene itself is a file of its own (`lib/note/drawings.ts`) and this block
 * carries the id, which is the same division the markdown editor made — there
 * it was a ```drawing fence because a fence was all markdown could be asked to
 * hold, and here it is a prop because the note is a block document. What it is
 * not is the scene inlined: a note with five diagrams would be five copies of
 * Excalidraw's own JSON in the file the editor rewrites on every keystroke.
 *
 * The block draws the scene as an exported SVG rather than mounting a live
 * canvas per drawing: Excalidraw takes the wheel for zoom, so an editable
 * canvas inside a scrolling document is a scroll trap.
 */
export const DRAWING_BLOCK = "drawing"

export const drawingBlockSpec = createReactBlockSpec(
  {
    type: DRAWING_BLOCK,
    // The block is one thing, not a container: there is nothing in it to put a
    // caret in, and a selection must not reach inside.
    content: "none",
    propSchema: { drawingId: { default: "" } },
  },
  {
    render: ({ block, editor }) => (
      <DrawingPreview
        drawingId={block.props.drawingId}
        // Only the block. The scene file is left alone, because this has to be
        // undoable and a delete that had already removed the file would come
        // back as an empty drawing.
        onRemove={() => editor.removeBlocks([block])}
      />
    ),
  }
)

function DrawingPreview({
  drawingId,
  onRemove,
}: {
  drawingId: string
  onRemove: () => void
}) {
  const canvas = useRef<HTMLDivElement>(null)
  // A drawing is exported with its own light or dark rendering — Excalidraw
  // inverts the strokes rather than tinting them — so the toggle has to redraw
  // every preview in the document.
  const { resolvedTheme } = useTheme()

  // Seeded from the cache so a drawing already read this session draws on the
  // first frame rather than flashing a placeholder.
  const [scene, setScene] = useState<DrawingScene | null>(
    () => peekDrawing(drawingId) ?? null
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true

    const read = () => {
      const cached = peekDrawing(drawingId)
      if (cached) {
        setScene(cached)
        return
      }
      void loadDrawing(drawingId).then((loaded) => {
        if (live) setScene(loaded)
      })
    }

    read()
    // The scene is edited in a dialog over the note, so what is on the page has
    // to follow it — the drawing is saved before the dialog closes, and this is
    // what puts the new version under it.
    const stop = onDrawingChanged((id) => {
      if (id === drawingId) read()
    })

    return () => {
      live = false
      stop()
    }
  }, [drawingId])

  const empty = !scene || scene.elements.length === 0

  useEffect(() => {
    if (empty) return
    let live = true

    void (async () => {
      // Only ever reached for a drawing with something in it, which is what
      // keeps Excalidraw — a megabyte of editor — out of the initial bundle and
      // out of a session that never opens one.
      const { exportToSvg } = await import("@excalidraw/excalidraw")
      if (!live || !scene) return

      try {
        const svg = await exportToSvg({
          elements: scene.elements as Parameters<
            typeof exportToSvg
          >[0]["elements"],
          appState: {
            ...scene.appState,
            exportWithDarkMode: resolvedTheme === "dark",
          },
          files: scene.files as Parameters<typeof exportToSvg>[0]["files"],
          exportPadding: 8,
        })
        if (!live) return

        // Its own intrinsic size is the scene's bounding box in pixels; the
        // block is as wide as the note, so the drawing scales to it rather than
        // overflowing a narrow pane.
        //
        // The attributes go and the inline style is set, rather than leaving
        // the sizing to `note-editor.css`: Excalidraw writes its own `style` on
        // the root `<svg>`, and an inline width beats any stylesheet rule no
        // matter how specific — which is what left a diagram sitting small in
        // the middle of a block the full width of the note. The viewBox it was
        // exported with is what keeps the proportions.
        svg.removeAttribute("width")
        svg.removeAttribute("height")
        svg.style.width = "100%"
        svg.style.height = "auto"
        svg.style.maxWidth = "100%"

        // And the ratio spelled out, rather than left for `height: auto` to
        // work out from the viewBox.
        //
        // That inference is what a browser does with a replaced element that
        // has an aspect ratio and no intrinsic size, and when it does not
        // happen the element still takes the full width while its height comes
        // from somewhere else — leaving `preserveAspectRatio` to fit the scene
        // to the *height* and centre it, which is a diagram sitting small in
        // the middle of a block the full width of the note with empty margins
        // either side. Read off the export rather than the scene, because
        // `exportToSvg` adds its own padding to the bounds.
        const [, , vbWidth, vbHeight] = (svg.getAttribute("viewBox") ?? "")
          .split(/[\s,]+/)
          .map(Number)
        if (vbWidth > 0 && vbHeight > 0) {
          svg.style.aspectRatio = `${vbWidth} / ${vbHeight}`
        }
        canvas.current?.replaceChildren(svg)
        setFailed(false)
      } catch (error) {
        console.error("Could not draw the preview", error)
        if (live) setFailed(true)
      }
    })()

    return () => {
      live = false
    }
  }, [scene, empty, resolvedTheme])

  return (
    <div className="note-drawing" data-drawing-id={drawingId}>
      <div
        className="note-drawing-canvas"
        onClick={() => openDrawing(drawingId)}
      >
        {empty || failed ? (
          <p className="note-drawing-placeholder">
            {failed
              ? "This drawing could not be drawn"
              : "Empty drawing — click to start"}
          </p>
        ) : (
          <div ref={canvas} />
        )}
      </div>

      {/* The buttons are this block's own; `contentEditable={false}` is what
          keeps a click on one out of the document's selection. */}
      <div className="note-drawing-toolbar" contentEditable={false}>
        <button type="button" onClick={() => openDrawing(drawingId)}>
          Edit
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
