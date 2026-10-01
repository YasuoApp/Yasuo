/**
 * A `.env` file as rows somebody can edit without typing its syntax.
 *
 * The same bargain the frontmatter table makes (`frontmatter.ts`): **a line
 * nobody touched prints back as the bytes it arrived as.** Quoting in a `.env`
 * is not decoration — `"a\nb"` is two lines to dotenv and `'a\nb'` is four
 * characters — so reprinting a value from its parsed form is a way to change
 * what a process reads without anybody having edited it. Only a row whose key
 * or value was changed goes through `printEntry`.
 *
 * Comments, blank lines and anything this does not recognise as `KEY=value`
 * are kept as lines of their own, in place, so the file's sections and its
 * commented-out alternatives survive the editor.
 */

export type EnvLine =
  | {
      kind: "entry"
      key: string
      /** The value as a process would read it: unquoted, escapes expanded. */
      value: string
      /** Whether the line was written `export KEY=…`, which shells source. */
      exported: boolean
      /** How the value was quoted, so an edited one keeps its style. */
      quote: EnvQuote
      /** A `# …` after an unquoted or closed value, without the `#`. */
      comment: string | null
      /** The line(s) as read, or null for a row that has been edited. */
      raw: string | null
    }
  | { kind: "comment"; text: string; raw: string | null }
  | { kind: "blank" }
  /** A line that is not an assignment — kept verbatim, never reprinted. */
  | { kind: "other"; raw: string }

export type EnvQuote = "none" | "single" | "double" | "backtick"

export interface EnvDoc {
  lines: EnvLine[]
  /** `\r\n` for a file written on Windows, so an edit does not convert it. */
  eol: string
  /** Whether the file ended with a newline. */
  finalNewline: boolean
}

const ASSIGNMENT = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/

export function parseEnv(text: string): EnvDoc {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const finalNewline = text === "" || /\r?\n$/.test(text)
  const rows = text.split(/\r?\n/)
  if (finalNewline) rows.pop()

  const lines: EnvLine[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!

    if (row.trim() === "") {
      lines.push({ kind: "blank" })
      continue
    }

    const trimmed = row.trimStart()
    if (trimmed.startsWith("#")) {
      lines.push({ kind: "comment", text: commentText(trimmed), raw: row })
      continue
    }

    const match = ASSIGNMENT.exec(row)
    if (!match) {
      lines.push({ kind: "other", raw: row })
      continue
    }

    const [, , exportWord, key, rest] = match
    const opener = rest![0]
    const quote = quoteOf(opener)

    if (quote === "none") {
      const { value, comment } = splitComment(rest!)
      lines.push({
        kind: "entry",
        key: key!,
        value,
        exported: exportWord !== undefined,
        quote,
        comment,
        raw: row,
      })
      continue
    }

    // A quoted value may run over several lines, as dotenv allows: read on
    // until the line holding the closing quote.
    let source = rest!.slice(1)
    const consumed = [row]
    let close = closingIndex(source, opener!)
    while (close < 0 && index + 1 < rows.length) {
      index += 1
      consumed.push(rows[index]!)
      source += `\n${rows[index]!}`
      close = closingIndex(source, opener!)
    }

    if (close < 0) {
      // Never closed: not something a reprint could get right, so it is kept
      // as the lines it was.
      for (const line of consumed) lines.push({ kind: "other", raw: line })
      continue
    }

    const inner = source.slice(0, close)
    const after = source.slice(close + 1).trim()
    lines.push({
      kind: "entry",
      key: key!,
      value: quote === "double" ? unescapeDouble(inner) : inner,
      exported: exportWord !== undefined,
      quote,
      comment: after.startsWith("#") ? commentText(after) : null,
      raw: consumed.join("\n"),
    })
  }

  return { lines, eol, finalNewline }
}

export function printEnv(doc: EnvDoc): string {
  const out = doc.lines.map((line) => {
    switch (line.kind) {
      case "blank":
        return ""
      case "other":
        return line.raw
      case "comment":
        return line.raw ?? (line.text === "" ? "#" : `# ${line.text}`)
      case "entry":
        return line.raw ?? printEntry(line)
    }
  })
  // A multi-line value's raw was joined with `\n`; the file's own ending wins.
  const text = out.join("\n").split("\n").join(doc.eol)
  return doc.finalNewline && out.length > 0 ? `${text}${doc.eol}` : text
}

export function printEntry(line: Extract<EnvLine, { kind: "entry" }>): string {
  const head = `${line.exported ? "export " : ""}${line.key}=`
  const tail = line.comment === null ? "" : ` # ${line.comment}`
  return `${head}${quoteValue(line.value, line.quote)}${tail}`
}

/**
 * The value written so dotenv reads it back as `value`.
 *
 * The row's own quoting where that still says the same thing, and the least
 * quoting that does otherwise — a value nobody needed to quote stays bare.
 */
export function quoteValue(value: string, preferred: EnvQuote): string {
  const single = !value.includes("'") && !value.includes("\n")
  if (preferred === "single" && single) return `'${value}'`
  if (preferred === "backtick" && !value.includes("`")) return `\`${value}\``
  if (preferred === "double") return `"${escapeDouble(value)}"`

  const bare =
    value === value.trim() && !/[\s#"'`\\]/.test(value) && value !== ""
  if (bare || value === "") return value
  return `"${escapeDouble(value)}"`
}

/** A key dotenv and a shell will both take. */
export function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)
}

/** The `.env` family: `.env` itself and `.env.local`, `.env.example`, … */
export function isEnvFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === ".env" || lower.startsWith(".env.")
}

function quoteOf(char: string | undefined): EnvQuote {
  if (char === '"') return "double"
  if (char === "'") return "single"
  if (char === "`") return "backtick"
  return "none"
}

/** Where `source` closes on `quote`, skipping a backslash-escaped one inside
 * double quotes. */
function closingIndex(source: string, quote: string): number {
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote === '"' && char === "\\") {
      index += 1
      continue
    }
    if (char === quote) return index
  }
  return -1
}

/** An unquoted value ends at ` #`, as dotenv reads it — a `#` with no space in
 * front of it is part of the value (`URL=http://x/#a`). */
function splitComment(rest: string): { value: string; comment: string | null } {
  const at = rest.search(/\s#/)
  if (at < 0) return { value: rest.trim(), comment: null }
  return {
    value: rest.slice(0, at).trim(),
    comment: commentText(rest.slice(at).trim()),
  }
}

function commentText(text: string): string {
  return text.replace(/^#\s?/, "")
}

function unescapeDouble(inner: string): string {
  return inner.replace(/\\([nrt"\\])/g, (_, char: string) =>
    char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char
  )
}

function escapeDouble(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}
