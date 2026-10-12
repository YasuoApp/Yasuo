import type { NoteBlock } from "@shared/api"

/**
 * The two files the Explorer opens in the block editor, as text on disk.
 *
 * A `.note` holds the editor's own block document; a `.md` holds markdown and
 * is a file the editor is only one way of writing. Everything here is the part
 * of that which is pure text handling — the parsing and printing of blocks
 * themselves is BlockNote's, and lives in `lib/note/from-markdown.ts` where it
 * can reach an editor. Keeping the two apart is what lets this file be tested
 * under plain `bun`, with no DOM for ProseMirror to want.
 */

/** Written back indented, and with the trailing newline every other file in a
 * repository has. A note kept in a working tree gets reviewed, and a note whose
 * diff is one 40 KB line is a note nobody can review. */
export function serializeBlockFile(blocks: NoteBlock[]): string {
  return `${JSON.stringify(blocks, null, 2)}\n`
}

/**
 * The blocks a `.note` holds, or null for a body that is not them.
 *
 * Null is not an error: it is what sends the caller to the markdown parser
 * instead. A `.note` can reach the pane having been written by hand or by
 * something else, and an unreadable one drawn as an empty document is an empty
 * document about to be saved over the top of it.
 */
export function blocksJsonOf(text: string): NoteBlock[] | null {
  // Checked before parsing so that markdown starting with a bracketed link is
  // not reported as broken JSON on the console every time it is opened.
  if (!text.trimStart().startsWith("[")) return null

  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as NoteBlock[]) : null
  } catch {
    return null
  }
}

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
