import type { ChatHit } from "./search"

/**
 * The matched text itself, painted where it is — what `⌘F` marks.
 *
 * **Through the CSS Custom Highlight API, which is the whole reason this can be
 * done at all.** A message is rendered markdown: headings, links, code blocks,
 * mentions. Marking a run of characters inside it the ordinary way means
 * splitting text nodes and wrapping them in `<mark>` — through React, that is
 * either re-rendering somebody's code block around a span or mutating a tree
 * React owns and will overwrite on the next line that arrives. `CSS.highlights`
 * takes `Range`s and paints them: **no DOM is touched**, nothing is re-rendered,
 * and a highlight over a node React replaces simply stops existing.
 *
 * Which also means a highlight cannot be styled per element — `::highlight()`
 * takes a colour and little else — and that is fine here: what is wanted is the
 * search-result amber every editor uses, and it is in `styles/globals.css`
 * beside `::selection`, which is the same kind of painted range.
 *
 * The registry is the **document's**, not a component's, so this module owns
 * both halves: whoever paints must clear, and the bar closing is what does.
 */

/** Every match, and the one the arrows are on — two registrations rather than
 * one, because they are two colours and a `Highlight` carries none. */
const ALL = "chat-find"
const CURRENT = "chat-find-current"

/**
 * A message's node in the transcript, by line id.
 *
 * Every message carries `data-line`, at the top level and inside an open fold
 * (`ChatMessage`), which is what makes this one selector rather than two paths:
 * the ranges have to be per **message**, since a hit's `nth` is counted within
 * one message's own text, and a fold's node holds several.
 */
const nodeOf = (root: HTMLElement, messageId: string) =>
  root.querySelector(`[data-line="${CSS.escape(messageId)}"]`)

/**
 * Paints every hit, and the current one in its own colour.
 *
 * The occurrences of a message are found in its rendered text and lined up with
 * the hits by position — the `nth` in the model is the `nth` here. The two can
 * only come apart where the markdown *syntax* is what matched (a query of `*` in
 * `**bold**`), which paints one mark short rather than the wrong one, and is the
 * same class of miss as the split-node case below.
 *
 * A hit with no node is **not an error**: it is a match inside a collapsed fold,
 * whose text is not on screen at all. It stays in the count, keeps its place in
 * the arrows' walk, and the pane rings the fold instead.
 */
export function paintFind(
  root: HTMLElement,
  hits: ChatHit[],
  current: ChatHit | null,
  query: string
): void {
  const registry = CSS.highlights
  // A Chromium too old to have the registry: the ring on the current fold is
  // still drawn, the scroll still lands, and nothing here throws.
  if (!registry) return

  /*
   * Added one at a time rather than spread into the constructor, which is not a
   * style choice: `new Highlight(...ranges)` is a call with one argument per
   * range, and a single-letter query in a long conversation is tens of thousands
   * of them — past the engine's argument limit, where it stops being a search
   * and becomes a `RangeError`.
   */
  const all = new Highlight()
  const marked = new Highlight()

  // One walk per message rather than per hit: a message with nine matches is
  // nine hits and one node to read.
  for (const [messageId, nths] of byMessage(hits)) {
    const node = nodeOf(root, messageId)
    if (!node) continue

    const ranges = rangesIn(node, query)
    for (const nth of nths) {
      const range = ranges[nth]
      if (!range) continue
      const isCurrent = current?.messageId === messageId && current.nth === nth
      ;(isCurrent ? marked : all).add(range)
    }
  }

  registry.set(ALL, all)
  registry.set(CURRENT, marked)
}

/**
 * Where the current match is on screen, so the pane can scroll to **it** rather
 * than to the top of the message holding it.
 *
 * Null when there is nothing to land on: the fold it is in is shut, or the
 * transcript has not rendered that far yet. The caller falls back to the block.
 */
export function rectOfHit(
  root: HTMLElement,
  hit: ChatHit,
  query: string
): DOMRect | null {
  const node = nodeOf(root, hit.messageId)
  if (!node) return null
  return rangesIn(node, query)[hit.nth]?.getBoundingClientRect() ?? null
}

/** Takes both registrations down — the bar closing, the pane unmounting, or a
 * query with nothing left in it. */
export function clearFind(): void {
  CSS.highlights?.delete(ALL)
  CSS.highlights?.delete(CURRENT)
}

/**
 * Where in one message's rendered text each occurrence is.
 *
 * A match split across two text nodes — a word with `*emphasis*` inside it — is
 * not found. The node walk is what makes this cheap and independent of how a
 * message is rendered, and reaching across nodes would mean rebuilding the
 * flattened text of every block on every keystroke for a case nobody writes.
 */
function rangesIn(element: Element, query: string): Range[] {
  if (!query) return []
  const wanted = query.toLowerCase()

  const ranges: Range[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue?.toLowerCase()
    if (!text) continue

    let at = text.indexOf(wanted)
    while (at !== -1) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + wanted.length)
      ranges.push(range)
      at = text.indexOf(wanted, at + wanted.length)
    }
  }

  return ranges
}

/** The hits gathered by the message they are in, in the order they arrived. */
function byMessage(hits: ChatHit[]): Map<string, number[]> {
  const held = new Map<string, number[]>()
  for (const hit of hits) {
    const entry = held.get(hit.messageId)
    if (entry) entry.push(hit.nth)
    else held.set(hit.messageId, [hit.nth])
  }
  return held
}
