import type { SearchOptions } from "./api"

/**
 * The left column's Search as pure functions both sides need: main runs the
 * query and the replace, and the renderer draws what a replace *would* write
 * on each row before anybody presses it. One copy, so the preview and the write
 * cannot disagree about what `$1` means.
 */

export type Matcher = { matcher: RegExp } | { error: string }

/**
 * The query and its toggles as one expression, or why it is not one.
 *
 * A literal is escaped into the same `RegExp` a pattern is, so there is one
 * matching loop rather than an `indexOf` beside a `exec` that disagree about
 * where a line ends. `m`, so `^` and `$` are a line's ends the way they are in
 * every editor's search.
 */
export function matcherOf(
  query: string,
  options: SearchOptions
): Matcher | null {
  if (!query) return null

  let source = options.regex
    ? query
    : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (options.wholeWord) source = `\\b(?:${source})\\b`

  try {
    return { matcher: new RegExp(source, options.matchCase ? "gm" : "gim") }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A replacement template filled in for one match — `$&`, `$1`–`$99`, `$<name>`
 * and `$$`, the subset of `String.prototype.replace`'s own every editor's
 * replace field offers. Anything else after a `$` is kept as typed.
 *
 * Written out rather than handed to `replace` as a string, because the replace
 * below needs a function (to step over empty matches) and a function gets no
 * expansion for free.
 */
export function expandReplacement(
  template: string,
  whole: string,
  groups: (string | undefined)[],
  named?: Record<string, string | undefined>
): string {
  let out = ""
  for (let at = 0; at < template.length; at += 1) {
    const char = template[at]
    if (char !== "$" || at === template.length - 1) {
      out += char
      continue
    }

    const next = template[at + 1]
    if (next === "$") {
      out += "$"
      at += 1
    } else if (next === "&") {
      out += whole
      at += 1
    } else if (next === "<" && named) {
      const close = template.indexOf(">", at + 2)
      if (close === -1) {
        out += char
        continue
      }
      out += named[template.slice(at + 2, close)] ?? ""
      at = close
    } else if (next !== undefined && next >= "0" && next <= "9") {
      // Two digits when there are that many groups, as `replace` reads them:
      // `$10` is the tenth group, or the first followed by a `0`.
      const two = template.slice(at + 1, at + 3)
      const wide =
        /^\d\d$/.test(two) && Number(two) > 0 && Number(two) <= groups.length
      const index = wide ? Number(two) : Number(next)
      if (index === 0 || index > groups.length) {
        out += char
        continue
      }
      out += groups[index - 1] ?? ""
      at += wide ? 2 : 1
    } else {
      out += char
    }
  }
  return out
}

/** What one match becomes: the template verbatim for a literal search, filled
 * in for a pattern. */
function replacementFor(
  match: RegExpExecArray | string[],
  replacement: string,
  regex: boolean,
  named?: Record<string, string | undefined>
): string {
  if (!regex) return replacement
  return expandReplacement(
    replacement,
    match[0] ?? "",
    Array.from(match).slice(1),
    named
  )
}

/**
 * Every match in `text` replaced, and how many there were.
 *
 * An empty match is left alone, as the search steps past it: it was never a
 * row, so replacing it would write somewhere nobody was shown.
 */
export function replaceIn(
  text: string,
  matcher: RegExp,
  replacement: string,
  regex: boolean
): { text: string; count: number } {
  const pattern = new RegExp(matcher.source, matcher.flags)
  let count = 0
  const replaced = text.replace(pattern, (...args: unknown[]) => {
    const whole = args[0] as string
    if (whole === "") return ""
    count += 1
    const last = args[args.length - 1]
    const named =
      typeof last === "object" && last !== null
        ? (last as Record<string, string | undefined>)
        : undefined
    // `(match, ...groups, offset, string, groups?)`.
    const groups = args.slice(1, named ? -3 : -2) as string[]
    return replacementFor([whole, ...groups], replacement, regex, named)
  })
  return { text: replaced, count }
}

/**
 * What the match at `from` in a preview line would be replaced with, for the
 * row to draw before anything is written.
 *
 * Matched again in the preview rather than sent from main, so typing in the
 * replace field redraws without a search. The line is all the context there is,
 * so a lookbehind reaching past its start may read differently than it will on
 * disk; the template unfilled is what is shown when the match is not found.
 */
export function previewReplacement(
  line: string,
  from: number,
  matcher: RegExp,
  replacement: string,
  regex: boolean
): string {
  if (!regex) return replacement
  const sticky = new RegExp(
    matcher.source,
    matcher.flags.replace("g", "") + "y"
  )
  sticky.lastIndex = from
  const match = sticky.exec(line)
  if (!match) return replacement
  return replacementFor(match, replacement, regex, match.groups)
}

/**
 * `files to include` / `files to exclude` as a test of a path relative to its
 * folder.
 *
 * VS Code's reading of a pattern, which is the one people type: a list split on
 * commas (not inside braces), `**`, `*`, `?`, `{a,b}` and `[…]`. A pattern
 * with no `/` matches at any depth (`*.ts`, `node_modules`), and a pattern that
 * names a directory matches everything under it.
 */
export function pathFilterOf(
  include: string,
  exclude: string
): (relative: string) => boolean {
  const included = globsOf(include)
  const excluded = globsOf(exclude)
  return (relative) =>
    (included.length === 0 || included.some((glob) => glob.test(relative))) &&
    !excluded.some((glob) => glob.test(relative))
}

export function globsOf(patterns: string): RegExp[] {
  const list: string[] = []
  let depth = 0
  let current = ""
  for (const char of patterns) {
    if (char === "{") depth += 1
    if (char === "}") depth = Math.max(0, depth - 1)
    if (char === "," && depth === 0) {
      list.push(current)
      current = ""
    } else current += char
  }
  list.push(current)

  return list
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map(globToRegExp)
}

function globToRegExp(glob: string): RegExp {
  let pattern = glob.replace(/\\/g, "/").replace(/^\.\//, "")
  pattern = pattern.replace(/\/+$/, "")
  if (pattern.startsWith("/")) pattern = pattern.slice(1)
  else if (!pattern.includes("/")) pattern = `**/${pattern}`

  let out = ""
  let braces = 0
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at] ?? ""
    if (char === "*") {
      if (pattern[at + 1] === "*") {
        at += 1
        if (pattern[at + 1] === "/") {
          at += 1
          out += "(?:.*/)?"
        } else out += ".*"
      } else out += "[^/]*"
    } else if (char === "?") out += "[^/]"
    else if (char === "{") {
      braces += 1
      out += "(?:"
    } else if (char === "}" && braces > 0) {
      braces -= 1
      out += ")"
    } else if (char === "," && braces > 0) out += "|"
    else if (char === "[") {
      const close = pattern.indexOf("]", at + 1)
      if (close === -1) out += "\\["
      else {
        out += `[${pattern.slice(at + 1, close).replace(/^!/, "^")}]`
        at = close
      }
    } else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  out += ")".repeat(braces)

  try {
    return new RegExp(`^${out}(?:/.*)?$`, "i")
  } catch {
    // A class like `[z-a]` does not compile; such a pattern matches nothing
    // rather than failing the whole search.
    return /(?!)/
  }
}
