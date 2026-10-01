import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight"

import { languageNamed } from "../editor-languages"

/**
 * Syntax colour for the code blocks in a rendered reply.
 *
 * Not a CodeMirror editor per block, which is the obvious way to reuse the
 * editor's own highlighting and the reason the tool rows do without it: a
 * reply with eight fences would mount eight editors to colour text nobody can
 * edit. This is the parser alone — the same `LanguageDescription` the editor
 * loads, through the same memoised `load()` — walked once by `highlightCode`
 * into plain spans. The tags are the editor's list (`lib/editor.ts`), so a
 * keyword is the same hue in a reply as in the file beside it; the colours are
 * in `markdown-view.css` under `.tok-*`, written for both themes.
 *
 * A language the registry does not know, or whose chunk will not load, leaves
 * the block as it was — monospace text — which is what it was a moment ago.
 */
const highlighter = tagHighlighter([
  { tag: [t.comment, t.lineComment, t.blockComment], class: "tok-comment" },
  { tag: [t.keyword, t.modifier, t.controlKeyword], class: "tok-keyword" },
  { tag: [t.operatorKeyword, t.definitionKeyword], class: "tok-keyword" },
  { tag: [t.string, t.special(t.string)], class: "tok-string" },
  { tag: [t.regexp, t.escape], class: "tok-regexp" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "tok-number" },
  { tag: [t.typeName, t.className, t.namespace], class: "tok-type" },
  { tag: [t.function(t.variableName), t.labelName], class: "tok-function" },
  { tag: [t.propertyName], class: "tok-property" },
  { tag: [t.variableName, t.attributeName], class: "tok-variable" },
  { tag: [t.tagName, t.meta, t.processingInstruction], class: "tok-tag" },
  { tag: [t.operator, t.punctuation, t.bracket], class: "tok-punctuation" },
  { tag: [t.heading], class: "tok-heading" },
  { tag: [t.link, t.url], class: "tok-link" },
  { tag: [t.emphasis], class: "tok-emphasis" },
  { tag: [t.strong], class: "tok-strong" },
  { tag: [t.invalid], class: "tok-invalid" },
])

/**
 * Colours every `<pre data-language>` under `root` that names a language.
 *
 * `alive` is asked before each block is written back: the parser loads over a
 * promise, and the message may have been re-rendered (a reply streaming in) or
 * unmounted meanwhile. Writing spans into a `<code>` that is no longer in the
 * document is harmless; writing them into one React has since replaced the
 * contents of is not, which is why the caller passes the guard rather than
 * this module guessing.
 */
export async function highlightCodeBlocks(
  root: ParentNode,
  alive: () => boolean = () => true
): Promise<void> {
  const blocks = Array.from(
    root.querySelectorAll<HTMLPreElement>("pre[data-language]")
  )
  await Promise.all(blocks.map((block) => highlightBlock(block, alive)))
}

async function highlightBlock(
  pre: HTMLPreElement,
  alive: () => boolean
): Promise<void> {
  const name = pre.dataset.language
  const code = pre.querySelector("code")
  if (!name || !code) return

  const description = languageNamed(name)
  if (!description) return

  let parser
  try {
    parser = (await description.load()).language.parser
  } catch {
    // A chunk that would not load is a block without colour, which is what an
    // unknown language already gets.
    return
  }
  if (!alive() || !code.isConnected) return

  const text = code.textContent ?? ""
  const tree = parser.parse(text)
  const built = document.createDocumentFragment()
  highlightCode(
    text,
    tree,
    highlighter,
    (piece, classes) => {
      if (!classes) {
        built.append(piece)
        return
      }
      const span = document.createElement("span")
      span.className = classes
      span.textContent = piece
      built.append(span)
    },
    () => built.append("\n")
  )
  code.replaceChildren(built)
}
