import type { NoteBlock } from "@shared/api"

/**
 * A markdown file's frontmatter as rows, and the table the block editor shows
 * them in.
 *
 * `block-doc.ts` takes the block off the front of the file byte for byte, which
 * is what keeps a document with metadata from coming back as three horizontal
 * rules — read that first. This file is the next question: having taken it off,
 * can it be shown as something other than a line saying it is not shown? A flat
 * block of `key: value` lines can, as the two-column table GitHub draws for the
 * same bytes, and that is nearly all frontmatter in practice. Anything with
 * shape to it — a nested map, a list over several lines, a block scalar — cannot,
 * and says so rather than being flattened into rows that would be printed back
 * as something else.
 *
 * Everything here is text and plain objects, so it is testable under `bun` with
 * no DOM: `test/frontmatter.ts`. Getting it wrong is quiet and destructive in
 * the same way `splitFrontmatter` is, and for the same reason — the file's
 * metadata is what a site build, a docs pipeline or a skill loader reads it for.
 */

/**
 * One row: a key, and its value **exactly as it was written**, quotes and all.
 *
 * The value is deliberately not unquoted. YAML's plain scalars are typed —
 * `true` is a boolean and `1.0` is a number — so a value read out of quotes and
 * printed back without them changes what the file means, and one read as a plain
 * `1.0` and printed back quoted changes it the other way. There is no way to
 * tell those apart from the text alone once the quotes are gone, so they never
 * come off: what the table shows is the source, and what is printed back is the
 * source unless the user typed something that would not survive as it stands.
 * `plainValue` is for the one place that only reads — the preview.
 */
export type FrontmatterEntry = { key: string; value: string }

/**
 * The id the frontmatter's table carries in the document.
 *
 * How the save finds it again among the blocks. A fixed string rather than a
 * position, because a document whose body opens with a table of its own would
 * otherwise have that table read as its metadata the moment the frontmatter one
 * was deleted.
 */
export const FRONTMATTER_BLOCK_ID = "vsclaude-frontmatter"

/**
 * Frontmatter as rows, or null for a block that has shape to it.
 *
 * Takes what `splitFrontmatter` hands back — fences included — and accepts only
 * a flat run of `key: value` lines. Null is the answer for everything else, and
 * sends the caller back to showing the block as text: a nested map has no second
 * column to sit in, a `|` block scalar spans lines a cell cannot, and a `# note`
 * comment is a line that would be printed back as nothing at all.
 */
export function parseFrontmatterEntries(
  frontmatter: string
): FrontmatterEntry[] | null {
  const inner = frontmatter
    .replace(/^---[^\S\r\n]*\r?\n?/, "")
    .replace(/\r?\n?---[^\S\r\n]*$/, "")

  const entries: FrontmatterEntry[] = []
  for (const line of inner.split(/\r?\n/)) {
    // A blank line carries nothing, so it is skipped rather than refused — and
    // it is the one thing a round trip through the table does not put back.
    if (line.trim() === "") continue

    const match = KEY_LINE.exec(line)
    if (!match) return null

    const value = (match[2] ?? "").trimEnd()
    if (!isSingleLineScalar(value)) return null

    entries.push({ key: match[1]!, value })
  }

  return entries
}

/**
 * Rows back to a frontmatter block, fences and all — `""` for no rows left,
 * which is a file that should not have the fences either.
 *
 * The shape `splitFrontmatter` returns and `withFrontmatter` expects: no
 * trailing newline, since that file puts the blank line between the block and
 * the prose back itself.
 */
export function printFrontmatter(entries: FrontmatterEntry[]): string {
  const rows = entries.filter((entry) => entry.key.trim() !== "")
  if (rows.length === 0) return ""

  const lines = rows.map(({ key, value }) => {
    const name = key.trim()
    if (value === "") return `${name}:`
    return `${name}: ${needsQuotes(value) ? JSON.stringify(value) : value}`
  })

  return `---\n${lines.join("\n")}\n---`
}

/**
 * A value with its quotes taken off, for something that will only read it.
 *
 * The preview, and nothing else: it draws the table and never prints one back,
 * so it is the one caller that can show `hello: world` where the file says
 * `"hello: world"` without the quotes having to mean something on the way out.
 */
export function plainValue(value: string): string {
  if (DOUBLE_QUOTED.test(value)) {
    try {
      return JSON.parse(value) as string
    } catch {
      // A double-quoted YAML scalar JSON will not take — `\x41`, say. The
      // source is still the honest thing to show.
      return value
    }
  }
  if (SINGLE_QUOTED.test(value)) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** The frontmatter as the block editor's own two-column table: keys down the
 * left as a header column, which is the shape of the thing rather than a
 * heading row that would have to be called something. */
export function frontmatterTableBlock(entries: FrontmatterEntry[]): NoteBlock {
  return {
    id: FRONTMATTER_BLOCK_ID,
    type: "table",
    content: {
      type: "tableContent",
      headerCols: 1,
      rows: entries.map(({ key, value }) => ({ cells: [key, value] })),
    },
  }
}

export function isFrontmatterBlock(block: NoteBlock): boolean {
  return block.id === FRONTMATTER_BLOCK_ID && block.type === "table"
}

/**
 * The rows out of that table again, after it has been typed into.
 *
 * Tolerant about the cells, because the two ends of the round trip are not the
 * same shape: a table is written with a string per cell and read back with
 * BlockNote's own `tableCell` objects around styled inline content. A cell's
 * text is all that is wanted either way — a bold key is still that key — so
 * every kind of inline content is flattened to its text and anything else in
 * there is dropped.
 */
export function frontmatterEntriesOf(block: NoteBlock): FrontmatterEntry[] {
  const content = block.content as
    { rows?: { cells?: unknown[] }[] } | undefined

  return (content?.rows ?? []).map((row) => ({
    key: cellText(row.cells?.[0]),
    value: cellText(row.cells?.[1]),
  }))
}

/** A key, and enough of a value for one line. Deliberately narrow: `/` and `.`
 * are in there for the `a.b` and `path/to` keys frontmatter really carries,
 * and nothing else is, so that a line this does not recognise is refused rather
 * than half-read. */
const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_./-]*):(?:[^\S\r\n]+(.*))?$/

const DOUBLE_QUOTED = /^"(?:[^"\\]|\\.)*"$/
const SINGLE_QUOTED = /^'(?:[^']|'')*'$/

/**
 * Whether a value is the whole of itself on this line.
 *
 * What is refused is what a cell would misrepresent. `|` and `>` open a scalar
 * that continues on the lines below, so the value on this line is not the value.
 * `[`, `{` are collections, `&`, `*` are anchors and `!` is a tag — all of them
 * structure that reads back as a string once it has been through a text cell.
 * A leading `#` is not a value at all, it is a comment.
 */
function isSingleLineScalar(value: string): boolean {
  if (value === "") return true
  if (DOUBLE_QUOTED.test(value) || SINGLE_QUOTED.test(value)) return true
  // A lone quote at the front that did not close is a scalar spanning lines.
  if (/^["']/.test(value)) return false
  if (/^[|>&*!%@`[\]{},#?]/.test(value)) return false
  // `- ` and `? ` and `: ` open a sequence entry or a complex key; `-1` is just
  // a number, so the space is what makes the difference.
  if (/^[-?:]\s/.test(value)) return false
  return true
}

/**
 * Whether a value has to go back out in quotes.
 *
 * Only for text that would not survive being read again as it stands. A value
 * already in quotes is left in them — see `FrontmatterEntry` for why quoting is
 * never taken off — and a plain one is left plain, so a frontmatter nobody
 * edited prints back the bytes it came in as.
 */
function needsQuotes(value: string): boolean {
  if (DOUBLE_QUOTED.test(value) || SINGLE_QUOTED.test(value)) return false
  if (/^\s|\s$/.test(value)) return true
  // ` #` starts a comment mid-line, and `: ` makes the rest of the line look
  // like a second key.
  if (/\s#/.test(value) || /:\s/.test(value) || value.endsWith(":")) return true
  if (/^[|>&*!%@`[\]{},#?"']/.test(value)) return true
  if (/^[-?:]\s/.test(value)) return true
  return false
}

/** One cell as text, whichever of the two shapes it arrived in. */
function cellText(cell: unknown): string {
  if (typeof cell === "string") return cell
  if (Array.isArray(cell)) return cell.map(inlineText).join("")

  const object = cell as { content?: unknown } | null
  if (object && Array.isArray(object.content)) {
    return object.content.map(inlineText).join("")
  }
  return ""
}

function inlineText(item: unknown): string {
  if (typeof item === "string") return item

  const node = item as { text?: unknown; content?: unknown } | null
  if (!node) return ""
  if (typeof node.text === "string") return node.text
  // A link, whose text is one level further in.
  if (Array.isArray(node.content)) return node.content.map(inlineText).join("")
  return ""
}
