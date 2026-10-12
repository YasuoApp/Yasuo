import { LanguageSupport, StreamLanguage } from "@codemirror/language"
import type { StreamParser, StringStream } from "@codemirror/language"

/**
 * A `.env` file's grammar, which `@codemirror/language-data` does not have.
 *
 * The nearest thing it has is `properties`, which colours `KEY=value` but not
 * an `export ` prefix, a quoted value's own quotes, or the `${VAR}` that
 * dotenv-expand and docker compose both substitute — the three things that make
 * a `.env` line read as something other than an INI file. A stream parser
 * rather than Lezer: the format is one line deep and has no nesting to recover.
 */

interface State {
  /** Where on the line the tokenizer is: before the key, between key and `=`,
   * or in the value. A line that ends resets it. */
  at: "key" | "equals" | "value"
  /** The quote a value opened that has not been closed — a double-quoted
   * value may run onto the next line, which dotenv reads as one value. */
  quote: string | null
}

function interpolation(stream: StringStream): string | null {
  if (stream.match(/^\$\{[^}\n]*\}?/) || stream.match(/^\$[A-Za-z_]\w*/)) {
    return "variableName.special"
  }
  return null
}

function quoted(stream: StringStream, state: State): string {
  const quote = state.quote!
  // An expansion and an escape are only read inside double quotes; a single-
  // quoted value is literal, and a backtick one is in every dialect that has it.
  if (quote === '"') {
    if (stream.match(/^\\./)) return "escape"
    const expanded = interpolation(stream)
    if (expanded) return expanded
  }
  // A lone `$` or a trailing `\` is text; taking it here is what keeps the loop
  // below, which stops on both, from returning without having advanced.
  if (stream.peek() !== quote) stream.next()
  while (!stream.eol()) {
    const next = stream.peek()
    if (next === quote) {
      stream.next()
      state.quote = null
      state.at = "value"
      return "string"
    }
    if (quote === '"' && (next === "\\" || next === "$")) break
    stream.next()
  }
  return "string"
}

/** Exported for `test/dotenv.ts`, which tokenizes lines without an editor. */
export const dotenvParser: StreamParser<State> = {
  name: "dotenv",
  startState: () => ({ at: "key", quote: null }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (stream.sol() && !state.quote) state.at = "key"
    if (state.quote) return quoted(stream, state)
    if (stream.eatSpace()) return null

    if (state.at === "key") {
      if (stream.peek() === "#") {
        stream.skipToEnd()
        return "comment"
      }
      if (stream.match(/^export(?=\s)/)) return "keyword"
      if (stream.match(/^[^\s=#:]+/)) {
        state.at = "equals"
        return "propertyName"
      }
      stream.skipToEnd()
      return "invalid"
    }

    if (state.at === "equals") {
      if (stream.eat("=") || stream.eat(":")) {
        state.at = "value"
        return "operator"
      }
      stream.skipToEnd()
      return "invalid"
    }

    // In the value: a `#` after whitespace starts a comment, one inside an
    // unquoted value (`URL=http://host/#frag`) does not.
    const next = stream.peek()
    if (next === "#") {
      stream.skipToEnd()
      return "comment"
    }
    if (next === '"' || next === "'" || next === "`") {
      stream.next()
      state.quote = next
      return quoted(stream, state)
    }
    const expanded = interpolation(stream)
    if (expanded) return expanded
    stream.match(/^(?:[^\s$]|\$(?![{A-Za-z_]))+/)
    return "string"
  },
  languageData: { commentTokens: { line: "#" } },
}

const dotenvLanguage = StreamLanguage.define(dotenvParser)

export function dotenv(): LanguageSupport {
  return new LanguageSupport(dotenvLanguage)
}
