import type {
  IBufferLine,
  IDecoration,
  ILink,
  IMarker,
  Terminal,
} from "@xterm/xterm"

import { revealAt } from "@/lib/files/typescript"
import {
  fileLinkCandidates,
  type FileLinkCandidate,
} from "@/lib/shell/file-links"
import { IS_MAC } from "./title-bar"

/*
 * File paths in a terminal's output: coloured as soon as they are printed,
 * underlined on hover, and opened in the editor by `⌘`-click (`Ctrl`
 * elsewhere) — at the line and column when the output names one, which is what
 * makes a tsc error or a failing test's stack frame one click from its source.
 *
 * A modifier, unlike the web links, because paths are most of what `git
 * status` and `ls` print: a plain click into that output to focus the shell
 * would open a tab every time. It is VS Code's gesture for the same thing, and
 * the hover says so in the host's tooltip.
 *
 * Each candidate is asked of main before it is coloured — through the same
 * gate every file read goes through, so a path outside the workspace's
 * folders is never a link, and neither is a directory or a word that only
 * looks like a path. A path broken across a wrapped row is not joined back up.
 */

type Resolved = FileLinkCandidate & { target: string }

/** A row that has been coloured, found again by its marker — a row's index
 * moves as the scrollback trims from the top, and a marker moves with it. */
type Painted = {
  marker: IMarker
  text: string
  decorations: IDecoration[]
}

/*
 * How long an answer from main is believed. A hit hardly ever goes stale; a
 * miss does, the moment a build writes the file it was about — so misses are
 * asked again sooner.
 */
const HIT_MS = 60_000
const MISS_MS = 3_000

/** How long output has to settle before the rows it touched are scanned, so a
 * stream of output is read in batches rather than a row per write. */
const SCAN_DELAY_MS = 120

/**
 * A buffer row as text, with the cell each character sits in.
 *
 * `translateToString` alone is a string whose indices drift from the grid at
 * the first wide character — a CJK name in `ls`, an emoji in a prompt — and a
 * link placed by string index then marks the wrong cells. A wide glyph is one
 * cell holding the character and one empty cell after it, which is what the
 * zero width skips.
 */
function rowText(line: IBufferLine, cols: number) {
  let text = ""
  const cellAt: number[] = []
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars() || " "
    for (let i = 0; i < chars.length; i++) cellAt.push(x)
    text += chars
  }
  return { text, cellAt }
}

export function attachFileLinks(
  terminal: Terminal,
  host: HTMLElement,
  options: {
    /** The directory a relative path is read from — the shell's cwd. */
    base: () => string | null
    /** The colour a link is painted, `#RRGGBB`, read at paint time. */
    color: () => string
  }
): { repaint: () => void; dispose: () => void } {
  let disposed = false
  const answers = new Map<
    string,
    {
      at: number
      /** Null while main has not answered yet. */
      hit: boolean | null
      answer: Promise<{ path: string; directory: boolean } | null>
    }
  >()

  function resolve(base: string | null, path: string) {
    if (!path.startsWith("/") && !base) return Promise.resolve(null)
    const key = `${base ?? ""}\0${path}`
    const now = Date.now()
    const known = answers.get(key)
    const fresh =
      known &&
      (known.hit === null || now - known.at < (known.hit ? HIT_MS : MISS_MS))
    if (known && fresh) return known.answer

    // A shell left open all day prints a lot of paths; the cache is a
    // convenience, not a record.
    if (answers.size > 2_000) answers.clear()
    const answer = window.desktop
      .resolveRelativePath(base ?? "/", path)
      .catch(() => null)
    const entry = { at: now, hit: null as boolean | null, answer }
    void answer.then((target) => (entry.hit = target !== null))
    answers.set(key, entry)
    return answer
  }

  async function linksIn(text: string, base: string | null) {
    const found = await Promise.all(
      fileLinkCandidates(text).map(async (candidate) => {
        const target = await resolve(base, candidate.path)
        if (!target || target.directory) return null
        return { ...candidate, target: target.path }
      })
    )
    return found.filter((link): link is Resolved => link !== null)
  }

  const open = (link: Resolved) =>
    revealAt(link.target, link.line ?? 1, link.column ?? 1)

  // ---- Hover: underline, tooltip, and the click itself.

  const openKey = (event: MouseEvent) =>
    IS_MAC ? event.metaKey : event.ctrlKey
  const hint = `${IS_MAC ? "⌘" : "Ctrl"}-click to open`

  const provider = terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const line = terminal.buffer.active.getLine(y - 1)
      if (!line) return callback(undefined)
      const { text, cellAt } = rowText(line, terminal.cols)

      void linksIn(text, options.base()).then((links) => {
        if (disposed) return
        const shaped = links.flatMap((link): ILink[] => {
          const first = cellAt[link.start]
          const last = cellAt[link.end - 1]
          if (first === undefined || last === undefined) return []
          return [
            {
              range: { start: { x: first + 1, y }, end: { x: last + 1, y } },
              text: text.slice(link.start, link.end),
              decorations: { underline: true, pointerCursor: false },
              activate(event) {
                if (openKey(event)) open(link)
              },
              hover() {
                host.title = hint
              },
              leave() {
                host.title = ""
              },
            },
          ]
        })
        callback(shaped.length > 0 ? shaped : undefined)
      })
    },
  })

  // ---- Colour: every link on screen painted as it arrives.

  /*
   * Rows are scanned when xterm redraws them, which is exactly when they are
   * new or changed — output, a scroll bringing rows into view, a TUI redrawing
   * a line. A row is only re-asked when its text differs from what was
   * painted, so a prompt redrawn in place costs a string comparison.
   *
   * The alternate screen — vim, less, Claude Code's own TUI — is left alone:
   * it is redrawn wholesale and markers do not live on it.
   */
  const painted: Painted[] = []
  const dirty = new Set<number>()
  const scanning = new Map<number, string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  function forget(entry: Painted) {
    for (const decoration of entry.decorations) decoration.dispose()
    entry.marker.dispose()
    const at = painted.indexOf(entry)
    if (at !== -1) painted.splice(at, 1)
  }

  async function scan(row: number, byLine: Map<number, Painted>) {
    const buffer = terminal.buffer.active
    const line = buffer.getLine(row)
    if (!line) return
    const { text, cellAt } = rowText(line, terminal.cols)
    const previous = byLine.get(row)
    if (previous?.text === text) return
    if (previous) forget(previous)
    if (fileLinkCandidates(text).length === 0) return
    // Redrawn again while main was still being asked about this very text.
    if (scanning.get(row) === text) return

    scanning.set(row, text)
    const links = await linksIn(text, options.base())
    if (scanning.get(row) === text) scanning.delete(row)
    if (disposed || links.length === 0) return
    // The row may have been rewritten or scrolled off while main answered.
    const now = terminal.buffer.active.getLine(row)
    if (terminal.buffer.active.type !== "normal" || !now) return
    if (rowText(now, terminal.cols).text !== text) return

    const marker = terminal.registerMarker(
      row - (buffer.baseY + buffer.cursorY)
    )
    const color = options.color()
    const decorations = links.flatMap((link) => {
      const first = cellAt[link.start]
      const last = cellAt[link.end - 1]
      if (first === undefined || last === undefined) return []
      const decoration = terminal.registerDecoration({
        marker,
        x: first,
        width: last - first + 1,
        foregroundColor: color,
        layer: "top",
      })
      return decoration ? [decoration] : []
    })
    const entry: Painted = { marker, text, decorations }
    painted.push(entry)
    // A row trimmed off the top of the scrollback takes its marker with it.
    marker.onDispose(() => {
      const at = painted.indexOf(entry)
      if (at !== -1) painted.splice(at, 1)
    })
  }

  function flush() {
    timer = undefined
    if (disposed || terminal.buffer.active.type !== "normal") {
      dirty.clear()
      return
    }
    const byLine = new Map(painted.map((entry) => [entry.marker.line, entry]))
    for (const row of dirty) void scan(row, byLine)
    dirty.clear()
  }

  const render = terminal.onRender(({ start, end }) => {
    if (terminal.buffer.active.type !== "normal") return
    const top = terminal.buffer.active.viewportY
    for (let row = start; row <= end; row++) dirty.add(top + row)
    timer ??= setTimeout(flush, SCAN_DELAY_MS)
  })

  /** Paints everything again — for a new link colour, after a theme change. */
  function repaint() {
    for (const entry of [...painted]) forget(entry)
    terminal.refresh(0, terminal.rows - 1)
  }

  return {
    repaint,
    dispose() {
      disposed = true
      clearTimeout(timer)
      render.dispose()
      provider.dispose()
      for (const entry of [...painted]) forget(entry)
    },
  }
}
