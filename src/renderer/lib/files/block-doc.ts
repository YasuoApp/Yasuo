/**
 * A `.md` the Explorer opens in the block editor, as text on disk — a file the
 * editor is only one way of writing. Everything here is the part of that which
 * is pure text handling — the parsing and printing of blocks
 * themselves is BlockNote's, and lives in `lib/note/from-markdown.ts` where it
 * can reach an editor. Keeping the two apart is what lets this file be tested
 * under plain `bun`, with no DOM for ProseMirror to want.
 */

/**
 * A markdown file's frontmatter, split off from the prose.
 *
 * The block editor never sees it, and that is the point: to any markdown parser
 * a `---` fence is a thematic break, so a document with frontmatter parsed into
 * blocks and printed back out again returns as three horizontal rules with
 * `title: …` sitting between them as body text. That is not a lossy conversion,
 * it is a broken file — a static site, a docs build or anything else reading
 * that file for its metadata would stop finding it. So it travels around the
 * editor rather than through it, byte for byte.
 *
 * Only a block that opens on the file's very first line counts, which is where
 * every format that defines frontmatter puts it, and it must close: an
 * unterminated `---` is a document that happens to start with a rule, and
 * swallowing the whole file as metadata would leave the editor empty.
 *
 * A leading `---` followed by a later one is read as frontmatter even when it
 * was meant as a horizontal rule. That is deliberate: it is what Jekyll, Hugo
 * and `gray-matter` all do with the same bytes, and matching the tools that
 * read these files matters more than being clever about an opening rule, which
 * nobody writes.
 */
export function splitFrontmatter(text: string): {
  frontmatter: string
  body: string
} {
  // The inner group is optional so that an empty block — `---` twice, with
  // nothing between — is still a block rather than two rules. The character
  // class after each fence is spaces and tabs only: with a bare `\S` it eats
  // the `\r` of a CRLF file and hands back a frontmatter block ending in half
  // a line break.
  const match =
    /^(---[^\S\r\n]*\r?\n(?:[\s\S]*?\r?\n)?---[^\S\r\n]*)(\r?\n|$)/.exec(text)
  if (!match) return { frontmatter: "", body: text }

  return {
    frontmatter: match[1]!,
    body: text.slice(match[0].length),
  }
}

/** The other direction: what `splitFrontmatter` took off, back in front of what
 * the editor wrote. */
export function withFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter) return body
  return `${frontmatter}\n\n${body.replace(/^\s+/, "")}`
}
