import { headingSlug, linkOf } from "../src/renderer/lib/markdown/links"
import { check, finish, section } from "./harness"

/**
 * What a click on a link in a markdown preview means. The case this exists for
 * is the relative one: left to the browser it navigated the studio's own window
 * away.
 */

section("linkOf")
{
  check("https", linkOf("https://example.com").kind === "external")
  check("mailto", linkOf("mailto:a@b.c").kind === "external")
  check("an upper-case scheme", linkOf("HTTP://x.y").kind === "external")
  check("file: is not opened", linkOf("file:///etc/hosts").kind === "none")
  check("javascript: is not", linkOf("javascript:alert(1)").kind === "none")
  check("a root-anchored path", linkOf("/docs/a.md").kind === "none")
  check("nothing", linkOf("  ").kind === "none")
  check("a bare #", linkOf("#").kind === "none")

  const anchor = linkOf("#getting-started")
  check(
    "an anchor",
    anchor.kind === "anchor" && anchor.id === "getting-started",
    anchor
  )

  const sibling = linkOf("./CONTRIBUTING.md")
  check(
    "a sibling file",
    sibling.kind === "relative" &&
      sibling.paths.length === 1 &&
      sibling.paths[0] === "./CONTRIBUTING.md",
    sibling
  )

  const fragment = linkOf("../docs/guide.md#setup?x")
  check(
    "the fragment is not the file's",
    fragment.kind === "relative" && fragment.paths[0] === "../docs/guide.md",
    fragment
  )

  const spaced = linkOf("my%20notes.md")
  check(
    "as written, then decoded",
    spaced.kind === "relative" &&
      spaced.paths[0] === "my%20notes.md" &&
      spaced.paths[1] === "my notes.md",
    spaced
  )

  check("a query alone", linkOf("?x=1").kind === "none")
}

section("headingSlug")
{
  check("words", headingSlug("Getting Started") === "getting-started")
  check(
    "punctuation",
    headingSlug("What's new (v1.2)?") === "whats-new-v12",
    headingSlug("What's new (v1.2)?")
  )
  check("hyphens kept", headingSlug("pre-flight") === "pre-flight")
  check("non-ASCII kept", headingSlug("Cài đặt") === "cài-đặt")
}

finish()
