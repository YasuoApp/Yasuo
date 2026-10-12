import type { AssistantMessage } from "@shared/api"

/**
 * A chat's table of contents: one entry per thing the user asked.
 *
 * **The user's lines and nothing else**, because they are the only headings a
 * conversation has. A turn's answer is long and its working longer, but what
 * somebody scrolling back through an afternoon's chat is looking for is *the
 * point where they asked for X* — and that is a sentence they wrote. Listing
 * the answers too would be a second transcript beside the first.
 *
 * The entry's id is the line's, which is also its block's: a user line is
 * always a block of its own (`blocksOf`), so the pane finds it by
 * `data-block` the same way the find bar's landing does.
 */
export type OutlineEntry = {
  id: string
  /** The message's first line with something on it, trimmed to a row. */
  label: string
  at?: string
}

/** Long enough to tell two asks apart, short enough that a row never wraps
 * into a paragraph — the column is a list to scan, not to read. */
const LABEL_MAX = 80

/** A picture's placeholder says nothing about what was asked, and a message
 * that was a screenshot and one sentence should be listed as that sentence. */
const IMAGE_TAG = /\[Image #\d+\]/g

export function outlineOf(lines: readonly AssistantMessage[]): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  for (const line of lines) {
    if (line.role !== "user") continue
    entries.push({ id: line.id, label: labelOf(line.text), at: line.at })
  }
  return entries
}

export function labelOf(text: string): string {
  const first =
    text
      .replace(IMAGE_TAG, "")
      .split("\n")
      .map((row) => row.replace(/\s+/g, " ").trim())
      .find((row) => row.length > 0) ?? ""
  // A message that was only pictures still needs a row somebody can click.
  if (!first) return text.includes("[Image #") ? "Image" : "(empty message)"
  return first.length > LABEL_MAX
    ? `${first.slice(0, LABEL_MAX - 1).trimEnd()}…`
    : first
}

/**
 * Which entry the reader is in: the last one whose top has scrolled to or past
 * `line` — the top of the view, plus a margin so an entry counts as reached a
 * little before it touches the edge.
 *
 * Tops rather than DOM nodes so this stays on the testable side. A null top is
 * an entry with nothing on screen yet, which is skipped rather than read as 0.
 * Before the first entry is reached, the first one is still the answer: what is
 * above it is the start of the conversation it opened.
 */
export function currentEntry(
  tops: readonly (number | null)[],
  line: number
): number {
  let current = -1
  tops.forEach((top, index) => {
    if (top !== null && top <= line) current = index
  })
  if (current === -1) return tops.length > 0 ? 0 : -1
  return current
}
