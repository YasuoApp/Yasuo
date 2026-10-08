/**
 * Merge-conflict blocks in a file's text, and what resolving one writes.
 *
 * The editor's half is `lib/editor-conflicts.ts`; this is the half worth a
 * test (`test/conflicts.ts`), because the failure is quiet — a block read one
 * line off keeps a marker in the file, or drops a line of somebody's code.
 *
 * **Read off the text, not off git.** What a `UU` row in `Changes` says is
 * that git stopped; what is left to resolve is whatever markers are still in
 * the buffer, including ones half the way through being resolved by hand. So
 * the blocks are re-read on every edit, the way VS Code does it, and a file git
 * has never heard of with a pasted `<<<<<<<` in it gets the same buttons.
 *
 * Both styles git writes are read: plain (`<<<<<<<` / `=======` / `>>>>>>>`)
 * and `diff3` / `zdiff3`, which add a `|||||||` section holding the common
 * ancestor. That section is never kept by a resolution — it is what *both*
 * sides changed away from.
 */

/** One `<<<<<<<` … `>>>>>>>` block, as offsets into the text. */
export type Conflict = {
  /** Start of the `<<<<<<<` line. */
  from: number
  /** End of the `>>>>>>>` line, including its newline when it has one, so
   * replacing `from`–`to` leaves no blank line where the block was. */
  to: number
  /** What follows the marker — `HEAD`, a branch, a commit — or empty. */
  currentLabel: string
  incomingLabel: string
  /** The two sides' own text, each `from`–`to` covering whole lines with their
   * newlines, so either can be written back as it stood. */
  current: Range
  incoming: Range
  /** The `|||||||` section's text, for `diff3` conflicts only. */
  base: Range | null
  /** Where each marker line starts, for the editor to dim them. */
  markers: number[]
}

export type Range = { from: number; to: number }

export type Resolution = "current" | "incoming" | "both"

/**
 * Exactly seven, then a space or the end of the line. Git writes seven, and a
 * line of eight `=` is a Markdown rule or an underline somebody typed.
 */
const START = /^<{7}(?: (.*))?$/
const BASE = /^\|{7}(?: .*)?$/
const SPLIT = /^={7}$/
const END = /^>{7}(?: (.*))?$/

export function conflictsIn(text: string): Conflict[] {
  // The cheap answer for the file that has none, which is every file but one.
  if (!text.includes("<<<<<<<")) return []

  const lines = linesOf(text)
  const found: Conflict[] = []

  let index = 0
  while (index < lines.length) {
    const start = lines[index]!
    const opened = START.exec(start.text)
    if (!opened) {
      index += 1
      continue
    }

    const block = blockFrom(lines, index)
    if (!block) {
      // An opener with no well-formed block after it: not a conflict, and the
      // lines after it are still worth reading for one that is.
      index += 1
      continue
    }
    found.push(block.conflict)
    index = block.next
  }

  return found
}

/** The text with one block resolved. */
export function resolve(
  text: string,
  conflict: Conflict,
  choice: Resolution
): string {
  const { from, to, insert } = resolution(text, conflict, choice)
  return text.slice(0, from) + insert + text.slice(to)
}

/** The edit that resolves one block — the shape a CodeMirror change takes. */
export function resolution(
  text: string,
  conflict: Conflict,
  choice: Resolution
): { from: number; to: number; insert: string } {
  const current = text.slice(conflict.current.from, conflict.current.to)
  const incoming = text.slice(conflict.incoming.from, conflict.incoming.to)
  const kept =
    choice === "current"
      ? current
      : choice === "incoming"
        ? incoming
        : joined(current, incoming)

  // A block at the very end of a file with no trailing newline: the sides were
  // read with the newlines between them, so the last one kept would leave a
  // newline the file did not have.
  const insert =
    conflict.to === text.length && !text.endsWith("\n")
      ? kept.replace(/\r?\n$/, "")
      : kept

  return { from: conflict.from, to: conflict.to, insert }
}

/** Both sides, one after the other — with a newline between them if the first
 * one has none to end on, which only happens when it is empty. */
function joined(first: string, second: string): string {
  if (first === "" || first.endsWith("\n")) return first + second
  return `${first}\n${second}`
}

type Line = { text: string; from: number; to: number }

/** Every line with where it starts and where the next one does, so a range
 * built from them carries its own newlines — `\r\n` included. */
function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let from = 0
  while (from <= text.length) {
    const newline = text.indexOf("\n", from)
    const end = newline === -1 ? text.length : newline + 1
    const body = text.slice(from, newline === -1 ? text.length : newline)
    lines.push({ text: body.replace(/\r$/, ""), from, to: end })
    if (newline === -1) break
    from = end
  }
  return lines
}

function blockFrom(
  lines: Line[],
  startIndex: number
): { conflict: Conflict; next: number } | null {
  const start = lines[startIndex]!
  const markers = [start.from]
  let baseIndex = -1
  let splitIndex = -1

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!

    // A second opener before this block closed: the first was not a block.
    if (START.test(line.text)) return null

    if (splitIndex === -1 && baseIndex === -1 && BASE.test(line.text)) {
      baseIndex = index
      markers.push(line.from)
      continue
    }
    if (splitIndex === -1 && SPLIT.test(line.text)) {
      splitIndex = index
      markers.push(line.from)
      continue
    }

    const closed = END.exec(line.text)
    if (!closed) continue
    if (splitIndex === -1) return null
    markers.push(line.from)

    const currentEnd = baseIndex === -1 ? splitIndex : baseIndex
    return {
      conflict: {
        from: start.from,
        to: line.to,
        currentLabel: START.exec(start.text)?.[1]?.trim() ?? "",
        incomingLabel: closed[1]?.trim() ?? "",
        current: span(lines, startIndex + 1, currentEnd),
        incoming: span(lines, splitIndex + 1, index),
        base: baseIndex === -1 ? null : span(lines, baseIndex + 1, splitIndex),
        markers,
      },
      next: index + 1,
    }
  }

  return null
}

/** The lines `[first, end)` as one range; empty, at `first`'s start, if none. */
function span(lines: Line[], first: number, end: number): Range {
  const from = lines[first]!.from
  return first >= end ? { from, to: from } : { from, to: lines[end - 1]!.to }
}
