/**
 * The HTML in a markdown file, made safe to put on the page.
 *
 * A `.md` in one of the workspace's folders is a file from somebody's
 * repository — a dependency's README, a checked-out branch, a repo cloned to
 * look at — and rendering the HTML in it means rendering markup this app did not
 * write inside a renderer that has a preload bridge on it. So it goes through an
 * allowlist first: a tag not named below is unwrapped, an attribute not named
 * below is dropped, and a URL that is not plainly a document or a picture does
 * not survive. An allowlist rather than a list of things to strip, because a
 * denylist is a list of the attacks somebody thought of.
 *
 * This is the same shape of decision GitHub makes about the same files, and the
 * list is close to theirs on purpose: what a README actually uses. Three things
 * are deliberately not on it —
 *
 * - **`style`**, which a fair number of READMEs do use. A stylesheet is not
 *   markup: `position: fixed` and a z-index draw over the studio's own chrome
 *   from inside a pane, and there is no useful subset of CSS to allow. `align`
 *   and `width` cover what the layout HTML in a README is mostly doing.
 * - **`svg`**, whose `<script>` and `<foreignObject>` make it a document rather
 *   than a picture. An SVG *file* still opens in the image view, where it is a
 *   picture in an `<img>` and cannot run anything.
 * - **`class` and `id`**, which would reach the studio's own stylesheets and
 *   `document.getElementById`.
 *
 * The policy — the two predicates — is plain data and is tested under `bun`
 * (`test/sanitize-html.ts`). The walk needs a DOM and is the thin half.
 */

/**
 * What a README is made of.
 *
 * Everything here either has no behaviour at all or has behaviour this app
 * already gives markdown: `img` because `![]()` renders one, `a` because a link
 * does, `input` because a task list is a disabled checkbox. `details` and
 * `summary` are the reason people write HTML in a README in the first place.
 */
const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "audio",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "var",
  "video",
  "wbr",
])

/**
 * Tags whose *content* goes with them, rather than being kept.
 *
 * Everything else not on the allowlist is unwrapped — `<center>Hello</center>`
 * should still say Hello. These are the ones where the content is not prose but
 * the thing itself: a script's text is the script, and a `<style>` block
 * unwrapped is a page with CSS printed at the top of it.
 */
const DROPPED_TAGS = new Set([
  "base",
  "button",
  "canvas",
  "embed",
  "form",
  "iframe",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
])

/** Attributes any allowed tag may carry: presentation and language, no
 * behaviour. */
const GLOBAL_ATTRIBUTES = new Set(["align", "dir", "lang", "title"])

/** And the ones that only mean something on one tag. */
const TAG_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "rel", "target"],
  audio: ["controls", "loop", "muted", "src"],
  col: ["span", "width"],
  colgroup: ["span", "width"],
  details: ["open"],
  img: ["alt", "height", "loading", "src", "srcset", "width"],
  input: ["checked", "disabled", "type"],
  ol: ["reversed", "start", "type"],
  source: ["media", "sizes", "src", "srcset", "type"],
  td: ["colspan", "headers", "rowspan", "valign"],
  th: ["colspan", "headers", "rowspan", "scope", "valign"],
  video: ["controls", "height", "loop", "muted", "poster", "src", "width"],
}

/** Attributes holding a URL, which is a second question after the name. */
const URL_ATTRIBUTES = new Set(["href", "poster", "src", "srcset"])

export function isAllowedTag(tag: string): boolean {
  return ALLOWED_TAGS.has(tag.toLowerCase())
}

export function isDroppedTag(tag: string): boolean {
  return DROPPED_TAGS.has(tag.toLowerCase())
}

/**
 * Whether one attribute survives on one tag.
 *
 * The value is part of the question, and not only for URLs: `type` on an
 * `<input>` decides whether the thing is a task list's checkbox or a text field
 * somebody can be persuaded to type into.
 */
export function isAllowedAttribute(
  tag: string,
  name: string,
  value: string
): boolean {
  const attribute = name.toLowerCase()
  // Every event handler at once, ahead of the allowlist rather than after it,
  // so that a tag added above can never bring one in by accident.
  if (attribute.startsWith("on")) return false

  const element = tag.toLowerCase()
  const named =
    GLOBAL_ATTRIBUTES.has(attribute) ||
    (TAG_ATTRIBUTES[element]?.includes(attribute) ?? false)
  if (!named) return false

  if (element === "input" && attribute === "type") {
    return value.toLowerCase() === "checkbox"
  }
  // A README's `target="_blank"` is a new window; anything else names a frame,
  // and this app has none to name.
  if (element === "a" && attribute === "target") return value === "_blank"

  if (URL_ATTRIBUTES.has(attribute)) return isAllowedUrl(value)

  return true
}

/**
 * Whether a URL is one of the two things a document may point at: somewhere to
 * go, or a picture to show.
 *
 * A relative URL is allowed: the markdown preview resolves a local picture
 * against the document's own directory and reads it in (`baseDir` on
 * `MarkdownView`), and a relative `href` is opened in the Explorer by the
 * view's own click handler rather than followed (`lib/markdown/links.ts`).
 */
export function isAllowedUrl(value: string): boolean {
  // Control characters and whitespace go first, because `java\nscript:` is how a
  // scheme slips past a check that reads the string as written — the browser
  // takes them out before it resolves the URL.
  // eslint-disable-next-line no-control-regex
  const url = value.replace(/[\u0000-\u0020]/g, "").toLowerCase()

  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(url)
  if (!scheme) return true

  if (scheme[1] === "http" || scheme[1] === "https" || scheme[1] === "mailto") {
    return true
  }
  // A picture inlined in the file, which is how a badge or a small logo travels
  // in a README. Not `image/svg+xml`: an SVG is a document, and this is the one
  // place a document could arrive claiming to be a picture.
  if (scheme[1] === "data") {
    return /^data:image\/(png|jpeg|jpg|gif|webp|avif);/.test(url)
  }
  return false
}

/**
 * An HTML string as nodes, with everything the policy refuses taken out.
 *
 * Parsed with `DOMParser` rather than by assigning `innerHTML`, so the markup
 * is inert while it is being read: a document from `parseFromString` is not the
 * page, so an `<img onerror>` in it has nothing to fire against and a `<script>`
 * in it never runs. The fragment that comes back is built node by node from
 * that document, so nothing crosses over unexamined.
 */
export function sanitizeHtml(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  return childrenOf(parsed.body, document)
}

function childrenOf(parent: Node, target: Document): DocumentFragment {
  const fragment = target.createDocumentFragment()

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      fragment.append(target.createTextNode(node.textContent ?? ""))
      continue
    }
    // Comments and everything else that is not an element — a processing
    // instruction, a CDATA section — carry nothing worth showing.
    if (node.nodeType !== Node.ELEMENT_NODE) continue

    const source = node as Element
    const tag = source.tagName.toLowerCase()

    if (isDroppedTag(tag)) continue

    if (!isAllowedTag(tag)) {
      // Unwrapped: the tag goes and its words stay.
      fragment.append(childrenOf(source, target))
      continue
    }

    const element = target.createElement(tag)
    for (const attribute of Array.from(source.attributes)) {
      if (isAllowedAttribute(tag, attribute.name, attribute.value)) {
        element.setAttribute(attribute.name, attribute.value)
      }
    }
    // A link out of a document nobody here wrote opens in a new window and
    // cannot reach back into this one.
    if (tag === "a" && element.getAttribute("target") === "_blank") {
      element.setAttribute("rel", "noreferrer noopener")
    }

    element.append(childrenOf(source, target))
    fragment.append(element)
  }

  return fragment
}
