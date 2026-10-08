import { useEffect, useRef, useState } from "react"
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  filterSuggestionItems,
} from "@blocknote/core"
import {
  FilePanelController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react"
import { BlockNoteView } from "@blocknote/shadcn"
import { useTheme } from "next-themes"

import { newDrawingId, onDrawingOpened, openDrawing } from "@/lib/note/drawings"
import type { NoteBlock } from "@/lib/note/blocks"
import { uploadNoteFile } from "@/lib/note/uploads"
import { DrawingEditor } from "./drawing-editor"
import { NoteFilePanel } from "./file-panel"
import { DRAWING_BLOCK, drawingBlockSpec } from "./drawing-block"
import { RAW_HTML_BLOCK, rawHtmlBlockSpec } from "./raw-html-block"
import "@blocknote/core/fonts/inter.css"
import "@blocknote/shadcn/style.css"
import "./note-editor.css"

/**
 * The studio's one prose editor: a note, edited as blocks.
 *
 * BlockNote rather than a bare ProseMirror, for the same reason Crepe was
 * chosen before it — the slash menu, the drag handles, the formatting toolbar
 * and resizable tables come with it instead of being hand-built — and rather
 * than Crepe because those parts are what the panel is, and Crepe's tables
 * could not be resized without reaching into someone else's node view.
 *
 * The `shadcn` build of its view, not the Mantine one: this app already has
 * shadcn components and Tailwind v4, and the Mantine build would have brought a
 * second component library and a second set of tokens for the theme toggle to
 * miss.
 */
const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    [DRAWING_BLOCK]: drawingBlockSpec(),
    // In the schema for every document, and only ever put in one by the
    // Explorer reading a `.md` — nothing inserts it and it is not in the slash
    // menu. A note has no markdown behind it to have had HTML in.
    [RAW_HTML_BLOCK]: rawHtmlBlockSpec(),
  },
})

/** The `/drawing` item's mark in the slash menu — lucide's `shapes`, the same
 * one the block menu carried before. */
const DrawingIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <circle cx="17.5" cy="17.5" r="3.5" />
  </svg>
)

export type Editor = typeof schema.BlockNoteEditor

/**
 * Exported for the Explorer's `.note` and `.md` files, which are the same
 * editor over a file in one of the workspace's folders rather than over a note
 * in `~/.yasuo` — see `files/file-blocks.tsx`. It takes its blocks already
 * read, which is what that pane has: the files store holds the text.
 */
export function BlockEditor({
  initial,
  onChange,
  className = "h-full overflow-y-auto",
  visible = true,
  workspaceFiles = true,
}: {
  initial: NoteBlock[]
  /** Handed the editor as well as the document, for the one caller that has to
   * ask it to print itself: a `.md` is saved as markdown, and only the editor
   * can serialise its own schema back to it. */
  onChange: (blocks: NoteBlock[], editor: Editor) => void
  className?: string
  /** Whether this editor is the one on screen. The note pane keeps an editor
   * mounted per open tab, and only the one being looked at may answer the
   * drawing event below. */
  visible?: boolean
  /**
   * Whether this document may point at files of the workspace's own — a
   * drawing's scene under `workspace/drawings/`, a picture under
   * `workspace/note-files/`.
   *
   * True for a note, and for a `.note`, whose whole document is this app's
   * format anyway. False for a `.md`, which is somebody's markdown: a
   * `note-file://` URL in it is a broken image in every other reader, and a
   * drawing has no markdown at all to be written as. Both are switched off at
   * the source rather than warned about — the slash menu is built from what the
   * document can hold, and the upload tab of the file panel exists only because
   * `uploadFile` does.
   */
  workspaceFiles?: boolean
}) {
  // The editor is built once and never rebuilt, so it reaches its caller
  // through a ref rather than closing over an `onChange` a later render would
  // have replaced.
  const write = useRef(onChange)
  useEffect(() => {
    write.current = onChange
  }, [onChange])

  const { resolvedTheme } = useTheme()

  const editor = useCreateBlockNote({
    schema,
    // BlockNote refuses an empty array, and a note nobody has typed into is
    // exactly that — left out, it starts on its own empty paragraph.
    //
    // Cast because `NoteBlock` is deliberately structural (see `lib/note/
    // blocks.ts`): what is on disk is what BlockNote itself wrote, and typing
    // the walk in that file against the schema's own generics would spread
    // three type parameters across everything that touches a note.
    initialContent:
      initial.length > 0
        ? (initial as unknown as (typeof schema.PartialBlock)[])
        : undefined,
    /*
     * What a paste keeps: the formatting the copied thing actually had.
     *
     * BlockNote's default is `prioritizeMarkdownOverHTML: true` — when the
     * clipboard's `text/plain` fallback *looks* like markdown it throws the
     * `text/html` away and re-parses that fallback instead. The heuristic it
     * decides with fires on a bullet, a `*`, a `#` line or a `|`, so pasting a
     * formatted document out of a browser, Notion or a mail client routinely
     * took the plain-text branch: a heading arrived as a paragraph, `*starred*`
     * arrived italic where the source was bold, and a table — which has no
     * plain-text form beyond tab-separated lines — arrived as one paragraph of
     * run-together cells.
     *
     * `plainTextAsMarkdown` is deliberately left on. It is the branch for a
     * clipboard with no HTML on it at all — a terminal, an editor, a `.md`
     * file — where markdown is the only structure there is to read, and it is
     * unaffected by this, so pasting markdown source still becomes blocks.
     */
    pasteHandler: ({ defaultPasteHandler }) =>
      defaultPasteHandler({ prioritizeMarkdownOverHTML: false }),
    // The Upload half of the image panel, and what makes dropping or pasting a
    // picture into a note work at all: the panel is built from what the editor
    // can do, so with no `uploadFile` it offers only a URL to embed. See
    // `lib/note/uploads.ts`.
    uploadFile: workspaceFiles ? uploadNoteFile : undefined,
    // What the block's `img` loads for the URL the document holds — the same
    // URL under Electron, an HTTP route in a browser tab (`resolveNoteFileUrl`).
    resolveFileUrl: (url) => window.desktop.resolveNoteFileUrl(url),
  })

  return (
    <>
      {/*
        The note's own scrolling box, and the `.note-prose` every sizing rule
        in `note-editor.css` is written against.

        Not decoration: without a scroll container here a long note has nowhere
        to scroll, so it overflows the pane — which is absolutely positioned and
        does not clip — and an ancestor scrolls instead, taking the tab strip
        off the top of the window with it.
      */}
      <div className={`note-prose ${className}`}>
        <BlockNoteView
          editor={editor}
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          // Replaced below, so that `/drawing` sits among the defaults rather
          // than in a menu of its own.
          slashMenu={false}
          // Replaced below too — see `file-panel.tsx` for what BlockNote's own
          // draws and why it is not this panel's.
          filePanel={false}
          onChange={() => write.current(editor.document as NoteBlock[], editor)}
        >
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems(
                [
                  ...getDefaultReactSlashMenuItems(editor),
                  ...(workspaceFiles ? [drawingItem(editor)] : []),
                ],
                query
              )
            }
          />
          <FilePanelController filePanel={NoteFilePanel} />
        </BlockNoteView>
      </div>

      {workspaceFiles && <DrawingHost listening={visible} />}
    </>
  )
}

/** Inserts a drawing and opens the canvas on it: picking "Drawing" from the
 * menu is a request to draw, not to place an empty box and then find the way
 * into it. */
function drawingItem(editor: Editor) {
  return {
    title: "Drawing",
    subtext: "Shapes, arrows and freehand, on a canvas",
    aliases: ["draw", "excalidraw", "diagram", "sketch"],
    group: "Advanced",
    icon: <DrawingIcon />,
    onItemClick: () => {
      const id = newDrawingId()
      const current = editor.getTextCursorPosition().block

      // The block the `/` was typed in is empty by the time an item is picked,
      // so the drawing takes its place rather than leaving a blank line above
      // itself.
      editor.replaceBlocks(
        [current],
        [{ type: DRAWING_BLOCK, props: { drawingId: id } }]
      )
      openDrawing(id)
    },
  }
}

/**
 * Opens the drawing editor when a block in the document asks for it.
 *
 * The asking is an event rather than a prop, because what raises it is a block
 * far below any component that could have been handed a callback — and because
 * the slash menu raises it too.
 *
 * It is a broadcast, so a host that is not on screen has to stay off it: with
 * an editor mounted per open note, every one of them would otherwise open a
 * dialog for a drawing clicked in one of them.
 */
function DrawingHost({ listening }: { listening: boolean }) {
  const [drawingId, setDrawingId] = useState<string | null>(null)

  useEffect(() => {
    if (!listening) return
    return onDrawingOpened(setDrawingId)
  }, [listening])

  if (drawingId === null) return null
  return (
    <DrawingEditor drawingId={drawingId} onClose={() => setDrawingId(null)} />
  )
}
