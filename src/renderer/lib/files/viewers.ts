import { nameOf } from "./paths"

/**
 * How a file can be shown, and which way it is shown by default.
 *
 * Most files have one honest answer — a `.ts` is text, a `.png` is a picture —
 * and for those this decides nothing the extension had not already decided.
 * Two are genuinely more than one thing. An SVG is a picture, and also a text
 * file people open to change a `fill` or a `viewBox`. A `.md` is three: the
 * source somebody edits, the document somebody reads, and — since the studio
 * has a block editor anyway — prose somebody writes without typing the syntax.
 * A `.note` is the block editor first and its own document second. Every one of
 * them is reached from the tree's right-click menu.
 *
 * `blocks` is that block editor, and it is one viewer rather than two: what
 * changes between a `.note` and a `.md` is the file it writes, not the pane.
 *
 * `diff` is the odd one: every other viewer here is a way of reading the file,
 * and that one is a way of reading what has happened to it — the committed side
 * beside the working one. Offered for anything textual rather than only for a
 * file git has something to say about, because "what has changed in this" is a
 * fair question to ask of a file that turns out to have changed in nothing, and
 * a menu entry that appears and disappears with the working tree is one nobody
 * can learn. It is never the default: a diff is what somebody asks for.
 */
export type Viewer = "image" | "text" | "markdown" | "blocks" | "diff"

/**
 * What the studio will draw as a picture.
 *
 * The same list the main process will hand back bytes for (`IMAGE_MIME_TYPES`
 * in `main/ipc.ts`), because a viewer offered for a type that comes back as
 * `application/octet-stream` is an empty box with no explanation. Deliberately
 * not every format a browser can decode: `.ico` and `.avif` render, but nobody
 * opens a workspace to look at one, and each entry here is a row in a menu.
 */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
])

/** The extension, lowercased, without its dot — `""` for a name that has none,
 * and for a dotfile, whose leading dot is part of the name. */
function extensionOf(filePath: string): string {
  const name = nameOf(filePath).toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1) : ""
}

export function isImage(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(filePath))
}

/**
 * What the studio will render as a document.
 *
 * Just the two spellings of markdown, and deliberately not `.mdx`: that is
 * markdown with JSX in it, and a commonmark parser reads a component tag as
 * either nothing or a stray paragraph — a preview that quietly drops half the
 * file is worse than no preview offered.
 */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"])

export function isMarkdown(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(filePath))
}

/**
 * What the studio will open in the note editor.
 *
 * An extension of this app's own, unlike everything else in this file: the
 * Explorer's other viewers are chosen for formats that already existed, and
 * this one is a file the studio writes so that a note can live in the
 * repository it is about rather than only in the workspace's own directory.
 */
export const NOTE_EXTENSION = "note"

export function isNote(filePath: string): boolean {
  return extensionOf(filePath) === NOTE_EXTENSION
}

/** What a name typed into `New note…` becomes. The extension is what makes the
 * file a note, so it is added rather than asked for — and not added twice for
 * somebody who typed it. */
export function noteFileName(name: string): string {
  return isNote(name) ? name : `${name}.${NOTE_EXTENSION}`
}

/**
 * Every way this file can be shown, best first.
 *
 * The order is the menu's order and the first entry is the default, so there is
 * one list rather than a list and a separate rule about it. A length of one
 * means the tree draws no "open with" group at all: a menu whose only choice is
 * the thing already on screen is a menu that teaches nothing.
 */
export function viewersFor(filePath: string): Viewer[] {
  if (isImage(filePath)) {
    // An SVG is a picture first — that is what somebody double-clicking one
    // wants to see — and text when they say so, which is what earns it a diff
    // too. A PNG has neither: two versions of it as text is nothing anybody
    // reads, and comparing the pictures is a different feature.
    return extensionOf(filePath) === "svg"
      ? ["image", "text", "diff"]
      : ["image"]
  }

  // A `.md` opens as the document, not the source. The Explorer is where a
  // project's files are worked on, and a README reached from a tree of source
  // is more often being read than changed — so the rendered view is the one
  // arrived at, and the editor is the one asked for.
  if (isMarkdown(filePath)) return ["markdown", "text", "blocks", "diff"]

  // A `.note` is the other way round from a `.md`: the editor is the point of
  // the file, and the block document underneath it is JSON nobody writes by
  // hand — offered second all the same, since a note that will not open is a
  // note whose text somebody needs to see.
  if (isNote(filePath)) return ["blocks", "text", "diff"]

  return ["text", "diff"]
}

export function defaultViewer(filePath: string): Viewer {
  return viewersFor(filePath)[0]!
}

/**
 * What a viewer is called, in the menu of the file it would open.
 *
 * A function rather than a table because one of the four has two honest names:
 * the block editor is the **note** editor on a `.note`, whose whole point it
 * is, and the **markdown** editor on a `.md`, where it is the alternative to
 * typing the syntax. Naming it once for both would mean naming it after neither.
 */
export function viewerLabel(viewer: Viewer, filePath: string): string {
  if (viewer === "blocks") {
    return isNote(filePath) ? "Note editor" : "Markdown editor"
  }
  return FIXED_LABELS[viewer]
}

const FIXED_LABELS: Record<Exclude<Viewer, "blocks">, string> = {
  image: "Image preview",
  text: "Text editor",
  markdown: "Markdown preview",
  diff: "Diff",
}
