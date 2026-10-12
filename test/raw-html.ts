import { hasRawHtml, splitRawHtml } from "../src/renderer/lib/markdown/raw-html"
import { check, finish, section } from "./harness"

/**
 * Which runs of a markdown file have HTML in them, and so have to be held
 * verbatim rather than parsed into blocks.
 *
 * Both kinds of mistake are destructive and quiet. A run missed is a
 * `<details>` gone from a README the moment the block editor saves it. A run
 * claimed that has no HTML in it is a paragraph, a list or a table turned into
 * a read-only box the user cannot type in — and the two false positives worth
 * being sure about are markdown's own angle brackets: an autolink and a tag
 * inside a code span.
 */

section("a run with HTML in it")

check("a block-level tag", hasRawHtml("<details>"))
check("a closing tag on its own", hasRawHtml("</details>"))
check("a self-closing one", hasRawHtml('<img src="a.png" />'))
check("an attribute-heavy one", hasRawHtml('<img align="right" src="a.png">'))
check("a comment", hasRawHtml("<!-- a note to nobody -->"))
check("one inside a line of prose", hasRawHtml("H<sub>2</sub>O is water"))
check("one at the end of a list item", hasRawHtml("- first<br>second"))

section("and a run without")

check("plain prose", !hasRawHtml("Just some words about a < b"))
check("a comparison with spaces", !hasRawHtml("if a < b and c > d then"))
check(
  // Markdown's own autolinks, which do not survive being held as HTML: what
  // comes after the name is a `:` and an `@`, not a space or a `>`.
  "an autolinked URL",
  !hasRawHtml("<https://example.com>")
)
check("an autolinked address", !hasRawHtml("<user@example.com>"))
check("a tag inside a code span", !hasRawHtml("use `<br>` for a line break"))
check("a tag inside a double-backtick span", !hasRawHtml("``a <div> in code``"))
check("an escaped bracket", !hasRawHtml("a literal \\<div> in prose"))
check(
  // Four spaces is an indented code block, so the tag in it is text.
  "an indented code block",
  !hasRawHtml("    <div>this is code</div>")
)

section("splitting a document")

const document = `# Title

Some prose.

<details>
<summary>More</summary>
</details>

The end.
`

const segments = splitRawHtml(document)

check("the HTML run comes out on its own", segments.length === 3, segments)
check("in order", segments[1]?.kind === "html", segments)
check(
  "verbatim, including its line breaks",
  segments[1]?.text === "<details>\n<summary>More</summary>\n</details>",
  segments[1]
)
check(
  "and the markdown either side is markdown",
  segments[0]?.kind === "markdown" && segments[2]?.kind === "markdown",
  segments
)

check(
  "a document with no HTML is one segment",
  splitRawHtml("# Title\n\nProse.\n").length === 1
)
check(
  "and one that is nothing but HTML is one too",
  splitRawHtml("<div>\n<p>hi</p>\n</div>\n").length === 1 &&
    splitRawHtml("<div>\n</div>\n")[0]?.kind === "html"
)

section("a fence is markdown whatever is inside it")

const fenced = splitRawHtml(
  "Prose.\n\n```html\n<div>\n\n<span>still in the fence</span>\n```\n\nMore prose.\n"
)

check(
  "the fence and everything in it stays in one markdown segment",
  fenced.length === 1 && fenced[0]?.kind === "markdown",
  fenced
)

const interrupted = splitRawHtml("Prose.\n```\n<div>\n```\n")
check(
  "a fence opening straight after a paragraph is still a fence",
  interrupted.length === 1 && interrupted[0]?.kind === "markdown",
  interrupted
)

section("a tag that opens takes what it opened over")

// The shape a README folds its long parts into. Blank lines end an HTML block
// in markdown, so this is three runs — and held one at a time it comes out as a
// `<details>` the browser closes for itself, a paragraph outside it and a stray
// closing tag.
const folded = splitRawHtml(
  "Before.\n\n<details>\n<summary>More</summary>\n\nSome prose.\n\n</details>\n\nAfter.\n"
)

check("the whole folded section is one segment", folded.length === 3, folded)
check("held as HTML", folded[1]?.kind === "html", folded)
check(
  "with the markdown inside it kept where it was",
  folded[1]?.text ===
    "<details>\n<summary>More</summary>\n\nSome prose.\n\n</details>",
  folded[1]
)
check(
  "and the prose either side left alone",
  folded[0]?.text === "Before." && folded[2]?.text === "After.",
  folded
)

check(
  // Or a stray `<div>` in a long README would take the rest of the file into
  // one read-only block.
  "a tag that never closes holds only its own run",
  splitRawHtml("<div>\n\nProse.\n\nMore prose.\n").length === 2
)
check(
  // Closed by being written: a run of badges must not swallow the paragraph
  // under it.
  "a void element opens nothing",
  splitRawHtml('<img src="a.png">\n\nProse.\n').length === 2 &&
    splitRawHtml("<br/>\n\nProse.\n").length === 2
)
check(
  "and neither does a self-closing tag",
  splitRawHtml('<img src="a.png" />\n\nProse.\n').length === 2
)
check(
  "a fence inside a folded section closes nothing",
  splitRawHtml(
    "<details>\n<summary>x</summary>\n\n```html\n</details>\n```\n\n</details>\n"
  ).length === 1
)

section("adjacent markdown runs stay together")

// A loose list has a blank line between its items, so a splitter handing them
// over separately would turn one list into several.
const loose = splitRawHtml("- first\n\n- second\n\n<br>\n")

check("the list is one segment", loose.length === 2, loose)
check(
  "with its blank line kept",
  loose[0]?.text === "- first\n\n- second",
  loose[0]
)
check("and the tag is the other", loose[1]?.kind === "html", loose)

finish()
