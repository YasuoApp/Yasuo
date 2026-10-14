/**
 * The file paths in a line of terminal output, for ⌘-click to open them.
 *
 * Pure and tested (`test/terminal-links.ts`). Whether a path names a real file
 * is not this module's question: what it finds are *candidates*, and the
 * terminal asks main about each before underlining it — a word that only looks
 * like a path (`v1.2`, `e.g`) is then simply not a link.
 *
 * The shapes are the ones a shell in this studio prints most:
 *
 * - `src/app.ts:42:7` and `src/app.ts:42` — eslint, vite, grep -n, node's
 *   stack frames (`at f (/abs/app.js:10:5)`, the parenthesis excluded)
 * - `src/app.ts(42,7)` — tsc
 * - `File "/abs/app.py", line 12` — a Python traceback
 * - a bare `src/app.ts` or `./README.md` — git status, ls, find
 */
export type FileLinkCandidate = {
  /** Where the link starts and ends in the line, end exclusive — the path and
   * its line suffix, which is what gets underlined. */
  start: number
  end: number
  path: string
  line?: number
  column?: number
}

// Everything that can sit in a path, which is everything but the characters
// that end one in practice: whitespace, quotes, brackets, and the separators
// a tool puts between a path and what it says about it.
const TOKEN = /[^\s'"`()[\]{}<>,;|]+/g

// Punctuation a sentence leaves on a path — `see src/app.ts.` — that is never
// the last character of one worth opening.
const TRAILING = /[.:!?]+$/

const LINE_SUFFIX = /^(.*?):(\d+)(?::(\d+))?$/
const TSC_SUFFIX = /^\((\d+),(\d+)\)/
const PYTHON_SUFFIX = /^["'],\s*line\s+(\d+)/

/**
 * A token is worth asking about when it has a directory separator or a file
 * extension that starts with a letter. The second half is what keeps every
 * version number and decimal out: `1.2.3` has no extension by that rule.
 */
function looksLikePath(path: string): boolean {
  if (path.includes("/")) return /[\w]/.test(path)
  return /^[\w@+-][\w.@+-]*\.[A-Za-z][\w]*$/.test(path)
}

export function fileLinkCandidates(text: string): FileLinkCandidate[] {
  const found: FileLinkCandidate[] = []

  for (const match of text.matchAll(TOKEN)) {
    const start = match.index
    let token = match[0]
    // A URL is the web-links addon's, and `file://` is rare enough here not to
    // be worth a second reading of the same token.
    if (token.includes("://")) continue

    token = token.replace(TRAILING, "")
    let path = token
    let line: number | undefined
    let column: number | undefined

    const suffix = LINE_SUFFIX.exec(token)
    if (suffix?.[1]) {
      path = suffix[1]
      line = Number(suffix[2])
      if (suffix[3]) column = Number(suffix[3])
    }

    let end = start + token.length
    const after = text.slice(start + match[0].length)
    if (line === undefined && token === match[0]) {
      const tsc = TSC_SUFFIX.exec(after)
      if (tsc) {
        line = Number(tsc[1])
        column = Number(tsc[2])
        end += tsc[0].length
      }
    }
    if (line === undefined) {
      const python = PYTHON_SUFFIX.exec(after)
      if (python && text[start - 1] === after[0]) line = Number(python[1])
    }

    if (!looksLikePath(path)) continue
    found.push({ start, end, path, line, column })
  }

  return found
}
