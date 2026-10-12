/**
 * Which parts of a markdown file have HTML of their own in them.
 *
 * A `.md` in somebody's repository is allowed to be part HTML — a `<details>`
 * that folds, an `<img align="right">`, a `<sub>` in a line of prose — and every
 * reader of that file renders it, GitHub included. The block editor cannot: its
 * document is a fixed set of blocks, so a tag it has no block for is dropped on
 * the way in and gone from the file on the way out. That is not a lossy
 * conversion, it is a file that lost half a README.
 *
 * So the parts with HTML in them are found here, before the parser sees them,
 * and held verbatim (`note/raw-html-block.tsx`). This file is only the finding —
 * text in, spans out, no DOM — so it is testable under `bun`:
 * `test/raw-html.ts`.
 *
 * **A whole run at a time, not a tag at a time.** The unit is the lines between
 * blank lines, and one tag anywhere in it holds the run. A tag on its own is not
 * something a block document can be given back — half a `<details>` is not a
 * block — and a list whose third item has a `<br>` in it has to stay one list.
 * A run that leaves a tag open takes what it opened over with it, which is what
 * makes a `<details>` with markdown folded inside it one block rather than
 * three: `closesAt` says why, and why it gives up rather than run to the end of
 * the file.
 */

export type MarkdownSegment = {
  /** `html` for a run to be held verbatim; `markdown` for one the block editor
   * can read and write back. */
  kind: "markdown" | "html"
  /** The source, exactly as it was in the file. */
  text: string
}

/**
 * A markdown body split into the runs the editor can hold and the runs it
 * cannot.
 *
 * Adjacent markdown runs come back as one segment with their blank lines
 * between them, deliberately: a loose list has a blank line inside it, so a
 * splitter that handed its items over one at a time would turn one list into
 * several.
 */
export function splitRawHtml(markdown: string): MarkdownSegment[] {
  const units = unitsOf(markdown.split("\n"))
  const segments: MarkdownSegment[] = []
  let buffer: string[] = []

  const flush = () => {
    // The blank lines at either end belong to neither segment: they are the gap
    // between them, and both callers put a gap back — the editor by parsing each
    // segment as its own document, the save by joining them with one.
    const text = buffer.join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
    buffer = []
    if (text.trim() !== "") segments.push({ kind: "markdown", text })
  }

  let index = 0
  while (index < units.length) {
    const unit = units[index]!

    if (unit.kind !== "chunk" || !hasRawHtml(unit.lines.join("\n"))) {
      buffer.push(...unit.lines)
      index += 1
      continue
    }

    const end = closesAt(units, index)
    flush()
    const held = units.slice(index, end).flatMap((held) => held.lines)
    segments.push({
      kind: "html",
      text: held.join("\n").replace(/\n+$/, ""),
    })
    index = end
  }

  flush()
  return segments
}

/** The document as fences, blank lines and runs of text — the three things the
 * split above is decided one of at a time. */
function unitsOf(lines: string[]): {
  kind: "fence" | "blank" | "chunk"
  lines: string[]
}[] {
  const units: { kind: "fence" | "blank" | "chunk"; lines: string[] }[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!

    // A fence is markdown whatever is inside it, and what is inside it is
    // routinely HTML — a README showing the markup it is talking about. Taken
    // whole so that the blank lines in a fenced block do not end a run.
    const fence = FENCE.exec(line)
    if (fence) {
      const held = [line]
      index += 1
      const closing = fence[1]![0]!
      const length = fence[1]!.length
      while (index < lines.length) {
        const inside = lines[index]!
        held.push(inside)
        index += 1
        const close = FENCE.exec(inside)
        if (close && close[1]![0] === closing && close[1]!.length >= length) {
          break
        }
      }
      units.push({ kind: "fence", lines: held })
      continue
    }

    if (line.trim() === "") {
      units.push({ kind: "blank", lines: [line] })
      index += 1
      continue
    }

    const held: string[] = []
    while (index < lines.length) {
      const inside = lines[index]!
      // A fence stops a run, because a fence may interrupt a paragraph.
      if (inside.trim() === "" || FENCE.test(inside)) break
      held.push(inside)
      index += 1
    }
    units.push({ kind: "chunk", lines: held })
  }

  return units
}

/**
 * Where a held run ends: past the unit that closes the tag it opened.
 *
 * The one shape this is for is the `<details>` a README folds its long parts
 * into, whose content is markdown with blank lines in it:
 *
 * ```
 * <details>
 * <summary>More</summary>
 *
 * Some prose.
 *
 * </details>
 * ```
 *
 * Blank lines end an HTML block in markdown, so that is three runs, and holding
 * them one at a time gives three blocks: a `<details>` a browser closes for
 * itself, a paragraph outside it, and a stray closing tag. Held together it is
 * the one thing the file says it is.
 *
 * Opportunistic, and that is the important part. A tag that never closes — a
 * stray `<div>` in a long README — would otherwise take the rest of the file
 * into one read-only block, so a run that does not balance before the end of the
 * document is left as the single run it was.
 */
function closesAt(
  units: { kind: "fence" | "blank" | "chunk"; lines: string[] }[],
  start: number
): number {
  let depth = openDepth(units[start]!.lines.join("\n"))
  if (depth <= 0) return start + 1

  for (let index = start + 1; index < units.length; index += 1) {
    const unit = units[index]!
    // A fence's contents are text, so the tags in it close nothing.
    if (unit.kind === "chunk") depth += openDepth(unit.lines.join("\n"))
    if (depth <= 0) return index + 1
  }

  return start + 1
}

/**
 * How many block elements a run leaves open — negative for one that closes more
 * than it opens, which is the `</details>` at the end of a folded section.
 *
 * Void elements count for nothing: an `<img>` or a `<br>` is closed by being
 * written, and counting them as open is what would make a run of badges swallow
 * the paragraph under it.
 */
function openDepth(text: string): number {
  let depth = 0
  for (const match of bare(text).matchAll(TAGS)) {
    const [, closing, name, attributes] = match
    if (closing) {
      depth -= 1
      continue
    }
    if (VOID_TAGS.has(name!.toLowerCase())) continue
    if (attributes?.trimEnd().endsWith("/")) continue
    depth += 1
  }
  return depth
}

/**
 * Whether a run of lines has markup in it that the block editor would lose.
 *
 * Four leading spaces is an indented code block, so the `<div>` in it is text
 * and the run is markdown like any other.
 */
export function hasRawHtml(text: string): boolean {
  if (/^(?: {4}|\t)/.test(text)) return false

  const stripped = bare(text)
  if (stripped.includes("<!--")) return true
  return TAG.test(stripped)
}

/**
 * A run with the two places a tag is text taken out of it.
 *
 * A backslash escape, because `\<div>` is the four characters and every reader
 * of that file shows them; and a code span, because `` `<br>` `` is markup being
 * talked about rather than markup.
 */
function bare(text: string): string {
  return text.replace(/\\[\s\S]/g, "").replace(/(`+)[^`]*?\1/g, "")
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * A tag, and deliberately not an autolink.
 *
 * The name has to be followed by whitespace, `/` or `>` — which is what a tag
 * looks like and what `<https://example.com>` and `<user@example.com>` do not,
 * since a `:` and an `@` come next in those. Both of them are markdown's own
 * syntax and neither survives being held as HTML.
 */
const TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)/

/** The same tag, with its parts, for counting what a run leaves open. */
const TAGS = /<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g

/** Closed by being written, so they open nothing. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])
