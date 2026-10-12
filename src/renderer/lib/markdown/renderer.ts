import { Editor, parserCtx, rootCtx, schemaCtx } from "@milkdown/kit/core"
import { commonmark } from "@milkdown/kit/preset/commonmark"
import { gfm } from "@milkdown/kit/preset/gfm"
import { DOMSerializer } from "@milkdown/kit/prose/model"

/**
 * Renders markdown to DOM, for reading rather than editing.
 *
 * Milkdown is already this app's markdown stack — the composer's Crepe editor
 * is built on it — so an agent's replies are formatted by the same parser that
 * reads what the user types, rather than by a second library with its own idea
 * of what a list is.
 *
 * Deliberately *not* one Crepe (or Milkdown) editor per message, which is the
 * obvious way to reuse it: the transcript is the pane's main reading surface
 * and can run to dozens of replies, and that approach would put a live
 * ProseMirror editor — contentEditable, plugins, transaction machinery — behind
 * every one of them. Instead a single editor is built once and never shown:
 * everything below wants only its parser and its schema, and ProseMirror's own
 * `DOMSerializer` turns the parsed document into static nodes from there.
 */

/**
 * Markdown in, DOM out.
 *
 * `Node` rather than `DocumentFragment` because the serializer returns either,
 * depending on what it was given — and the only caller passes the result
 * straight to `replaceChildren`, which takes both.
 */
export type Render = (markdown: string) => Node

let building: Promise<Render> | null = null

/**
 * The renderer, built on first use and shared after that.
 *
 * Callers get an already-resolved promise from the second message onwards, so
 * only the first one waits — and that wait is a microtask, not a frame.
 */
export function markdownRenderer(): Promise<Render> {
  building ??= build()
  return building
}

async function build(): Promise<Render> {
  // A root that is never attached to the document. Milkdown insists on having
  // one to mount its view in, and this editor exists only to be asked
  // questions — nothing is ever typed into it and nobody ever sees it.
  const root = document.createElement("div")

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
    })
    // `gfm` on top of `commonmark` for the syntax agents actually emit:
    // tables, strikethrough, task lists, autolinks.
    .use(commonmark)
    .use(gfm)
    .create()

  return (markdown: string): Node =>
    editor.action((ctx) => {
      const parsed = ctx.get(parserCtx)(markdown)
      // The parser returns null for input it cannot make a document out of.
      // An empty fragment is the honest result; the caller's fallback covers
      // the case where that is not good enough.
      if (!parsed) return document.createDocumentFragment()

      return DOMSerializer.fromSchema(ctx.get(schemaCtx)).serializeFragment(
        parsed.content
      )
    })
}
