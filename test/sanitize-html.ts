import {
  isAllowedAttribute,
  isAllowedTag,
  isAllowedUrl,
  isDroppedTag,
} from "../src/renderer/lib/markdown/sanitize"
import { check, finish, section } from "./harness"

/**
 * The allowlist the HTML in a markdown file goes through before it is drawn.
 *
 * The file is somebody's — a dependency's README, a branch somebody checked out,
 * a repository cloned to have a look at — and the pane drawing it is a renderer
 * with a preload bridge on it. So this is the one part of the markdown work
 * where a mistake is not a formatting mistake, and it is the part written to be
 * checked without a DOM: the walk in `sanitize.ts` is a dozen lines over these
 * three predicates.
 */

section("what a README is made of")

check("the folding block people write HTML for", isAllowedTag("details"))
check("and its summary", isAllowedTag("summary"))
check("a picture", isAllowedTag("img"))
check("a subscript", isAllowedTag("sub"))
check("a task list's checkbox", isAllowedTag("input"))
check("a centred div", isAllowedTag("div"))
check("case does not matter", isAllowedTag("DETAILS") && isAllowedTag("Img"))

section("and what is not")

check("a script", !isAllowedTag("script") && isDroppedTag("script"))
check("a stylesheet", !isAllowedTag("style") && isDroppedTag("style"))
check("a frame", !isAllowedTag("iframe") && isDroppedTag("iframe"))
check("a form", !isAllowedTag("form") && isDroppedTag("form"))
check(
  // An SVG is a document — it can hold a script and a foreignObject — where an
  // `.svg` file opened in the image view is a picture in an `<img>`.
  "inline SVG",
  !isAllowedTag("svg") && isDroppedTag("svg")
)
check(
  // Not on either list: the tag goes and the words stay, because
  // `<center>Hello</center>` should still say Hello.
  "an old tag is unwrapped rather than dropped",
  !isAllowedTag("center") && !isDroppedTag("center")
)

section("attributes")

check("a picture's source", isAllowedAttribute("img", "src", "logo.png"))
check("its alt text", isAllowedAttribute("img", "alt", "The logo"))
check(
  "the align a README lays itself out with",
  isAllowedAttribute("div", "align", "center")
)
check("a cell's span", isAllowedAttribute("td", "colspan", "2"))
check("a link's href", isAllowedAttribute("a", "href", "https://example.com"))

check(
  "every event handler, whatever the tag",
  !isAllowedAttribute("img", "onerror", "alert(1)") &&
    !isAllowedAttribute("div", "onclick", "alert(1)") &&
    !isAllowedAttribute("p", "ONMOUSEOVER", "alert(1)")
)
check(
  // Both would reach the studio's own stylesheets and its own lookups.
  "class and id",
  !isAllowedAttribute("div", "class", "fixed inset-0") &&
    !isAllowedAttribute("div", "id", "root")
)
check(
  "a style attribute, which is a stylesheet in an attribute",
  !isAllowedAttribute("div", "style", "position:fixed;inset:0")
)
check(
  "an attribute on a tag it means nothing on",
  !isAllowedAttribute("p", "src", "a.png")
)
check(
  // A task list's checkbox and nothing else: a text field is something a user
  // can be persuaded to type into.
  "an input that is not a checkbox",
  isAllowedAttribute("input", "type", "checkbox") &&
    !isAllowedAttribute("input", "type", "password")
)
check(
  "a target naming a frame rather than a new window",
  isAllowedAttribute("a", "target", "_blank") &&
    !isAllowedAttribute("a", "target", "_top")
)

section("URLs")

check("somewhere to go", isAllowedUrl("https://example.com/a"))
check("plain http", isAllowedUrl("http://example.com"))
check("an address", isAllowedUrl("mailto:someone@example.com"))
check(
  // No base to resolve one against, so it is a broken image rather than a file
  // read — which is the right answer for markup out of a repository.
  "a relative path",
  isAllowedUrl("./docs/logo.png") && isAllowedUrl("/logo.png")
)
check("a fragment", isAllowedUrl("#section"))

check("a script URL", !isAllowedUrl("javascript:alert(1)"))
check(
  // The characters a browser strips before it resolves the scheme, which is how
  // this gets past a check that reads the string as written.
  "a script URL with a newline in the scheme",
  !isAllowedUrl("java\nscript:alert(1)") &&
    !isAllowedUrl("  JAVASCRIPT:alert(1)")
)
check("a document inlined as data", !isAllowedUrl("data:text/html,<script>"))
check(
  "an SVG inlined as data, which is a document claiming to be a picture",
  !isAllowedUrl("data:image/svg+xml;base64,PHN2Zz4=")
)
check(
  "a badge inlined as data, which is not",
  isAllowedUrl("data:image/png;base64,iVBORw0KGgo=")
)
check("a file URL", !isAllowedUrl("file:///etc/passwd"))

finish()
