/**
 * Which lines of a file are selected, and how a message names them — the pure
 * half of `editor-selection.ts`, so a test can reach it without a store.
 */

/** A run of whole lines, 1-based and inclusive. */
export type LineRun = { fromLine: number; toLine: number }

/**
 * The lines a selection covers, or null for an empty one.
 *
 * A selection ending at the very start of a line does not take that line: a
 * drag down the gutter, or `⇧↓` from a line's start, lands there, and counting
 * the line the caret merely touches would make every such selection one too long.
 */
export function selectedLines(
  lineAt: (pos: number) => { number: number; from: number },
  from: number,
  to: number
): LineRun | null {
  if (from === to) return null
  const start = lineAt(from)
  const end = lineAt(to)
  const toLine =
    end.from === to && end.number > start.number ? end.number - 1 : end.number
  return { fromLine: start.number, toLine }
}

export function lineCount(run: LineRun): number {
  return run.toLine - run.fromLine + 1
}

/** What the chip and the pill say: `10 lines selected`. */
export function selectionLabel(run: LineRun): string {
  const count = lineCount(run)
  return `${count} ${count === 1 ? "line" : "lines"} selected`
}

/**
 * The run as a message names it: `@src/main/git.ts#L12-21`.
 *
 * A reference rather than the text, for the reason every mention is a path
 * (`mention-text.ts`): the turn runs in the checkout with `Read`, and the
 * `#L` suffix is the form the CLI's own IDE integration writes a selection in.
 */
export function selectionMention(path: string, run: LineRun): string {
  const lines =
    run.fromLine === run.toLine
      ? `L${run.fromLine}`
      : `L${run.fromLine}-${run.toLine}`
  return `@${path}#${lines}`
}
