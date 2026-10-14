import {
  splitFrontmatter,
  withFrontmatter,
} from "../src/renderer/lib/files/block-doc"
import { check, finish, section } from "./harness"

/**
 * The text handling behind the Explorer's block editor: what is held back from
 * the editor when the file is markdown.
 *
 * The answer is destructive when it is wrong, which is why it is the half of
 * that pane written to be tested without a DOM. Frontmatter missed is quiet: `---` is a thematic break to
 * every markdown parser there is, so a document whose metadata went through the
 * editor comes back as three horizontal rules with `title:` between them, and
 * the site that reads that file stops finding what it needs.
 */

section("frontmatter")

const yaml = "---\ntitle: Release notes\ntags: [a, b]\n---\n\n# Heading\n"
const split = splitFrontmatter(yaml)

check(
  "is taken off the front",
  split.frontmatter === "---\ntitle: Release notes\ntags: [a, b]\n---",
  split
)
check("and the prose is what is left", split.body === "\n# Heading\n", split)
check(
  "and goes back in front of what the editor wrote",
  withFrontmatter(split.frontmatter, "# Heading\n") ===
    "---\ntitle: Release notes\ntags: [a, b]\n---\n\n# Heading\n"
)

check(
  "a file without it is all body",
  splitFrontmatter("# Heading\n").frontmatter === "" &&
    splitFrontmatter("# Heading\n").body === "# Heading\n"
)

check(
  // Otherwise the editor opens empty on a file that is entirely there, which
  // reads as having eaten it.
  "an opening rule that never closes is not frontmatter",
  splitFrontmatter("---\njust prose, no closing fence\n").frontmatter === ""
)

check(
  "a rule further down the file is left alone",
  splitFrontmatter("# Heading\n\n---\n\nMore\n").frontmatter === ""
)

check(
  "an empty block is still a block",
  splitFrontmatter("---\n---\nbody\n").frontmatter === "---\n---"
)

const crlf = splitFrontmatter("---\r\ntitle: x\r\n---\r\n\r\nBody\r\n")
check(
  // A repository shared with Windows has these, and a frontmatter block missed
  // for the sake of one byte is the whole failure above.
  "CRLF line endings are frontmatter too",
  crlf.frontmatter === "---\r\ntitle: x\r\n---",
  crlf
)

check(
  "trailing spaces on the fences do not hide it",
  splitFrontmatter("--- \ntitle: x\n--- \n\nBody\n").frontmatter ===
    "--- \ntitle: x\n--- "
)

check(
  "nothing is added to a file that had none",
  withFrontmatter("", "# Heading\n") === "# Heading\n"
)

finish()
