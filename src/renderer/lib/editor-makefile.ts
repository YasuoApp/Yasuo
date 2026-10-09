import { LanguageSupport, StreamLanguage } from "@codemirror/language"
import type { StreamParser, StringStream } from "@codemirror/language"

/**
 * A Makefile's grammar, which `@codemirror/language-data` does not have — its
 * one `make` is CMake.
 *
 * What a line is decides almost everything in make, and it is decided by the
 * line's first character and by whether a `:` or an `=` comes first: a tab
 * opens a recipe, `NAME = …` is a variable, `target: prereqs` is a rule. So the
 * line is classified once, at its start, and the tokens after that only have to
 * know the `$(…)` references, which mean the same thing everywhere.
 */

type Line = "rule" | "assign" | "directive" | "recipe" | "define"

interface State {
  line: Line
  /** Whether the rule's `:` has been passed — before it are targets. */
  afterColon: boolean
  /** Inside a `define … endef` body, which is text until the `endef`. */
  define: boolean
  /** Open `$(function …` calls, so their own `)` is coloured with them. */
  depth: number
  /** The previous line ended in a backslash, so this one is its rest. */
  continued: boolean
  /** Inside a recipe's double-quoted string, which a `$` interrupts. */
  quoted: boolean
}

const DIRECTIVES =
  /^(?:-include|sinclude|include|define|endef|ifeq|ifneq|ifdef|ifndef|else|endif|export|unexport|override|private|vpath|undefine)(?=\s|$)/

/** GNU make's functions, which are what tell `$(name args)` from a variable. */
const FUNCTIONS = new Set(
  (
    "subst patsubst strip findstring filter filter-out sort word wordlist " +
    "words firstword lastword dir notdir suffix basename addsuffix addprefix " +
    "join wildcard realpath abspath error warning info shell origin flavor " +
    "foreach if or and call eval file value let intcmp guile"
  ).split(" ")
)

const ASSIGN =
  /^\s*(?:(?:export|override|private)\s+)*[^\s:#=]+\s*(?::::?=|::?=|\?=|\+=|!=|=)/
const RULE = /^[^\s#=][^#=]*?:(?!=)/

function classify(text: string): Line {
  if (text.startsWith("\t")) return "recipe"
  if (ASSIGN.test(text)) return "assign"
  if (DIRECTIVES.test(text.trimStart())) return "directive"
  if (RULE.test(text)) return "rule"
  return "directive"
}

/** A `$` and what it refers to — or `null`, with nothing consumed. */
function reference(stream: StringStream, state: State): string | null {
  if (stream.match("$$")) return "escape"
  const call = stream.match(
    /^\$[({]([\w-]+)(?=[ \t])/,
    false
  ) as RegExpMatchArray | null
  if (call && FUNCTIONS.has(call[1]!)) {
    stream.match(/^\$[({][\w-]+/)
    state.depth += 1
    return "keyword"
  }
  if (stream.match(/^\$[({][^(){}$\s]*[)}]/)) return "variableName.special"
  if (stream.match(/^\$[({]/)) {
    // `$(VAR:$(EXT)=.o)` and its like: the head here, the rest as it comes.
    state.depth += 1
    return "variableName.special"
  }
  if (stream.match(/^\$[@<^?*+%|A-Za-z0-9_]/)) return "variableName.special"
  return null
}

function rest(stream: StringStream, state: State): string | null {
  if (stream.peek() === "$") {
    const style = reference(stream, state)
    if (style) return style
  }
  if (state.depth > 0 && (stream.peek() === ")" || stream.peek() === "}")) {
    stream.next()
    state.depth -= 1
    return "keyword"
  }
  if (stream.match(/^\\./)) return "escape"
  stream.next()
  return null
}

/** Exported for `test/makefile.ts`, which tokenizes lines without an editor. */
export const makefileParser: StreamParser<State> = {
  name: "makefile",
  startState: () => ({
    line: "directive",
    afterColon: false,
    define: false,
    depth: 0,
    continued: false,
    quoted: false,
  }),
  copyState: (state) => ({ ...state }),
  blankLine(state) {
    state.continued = false
    state.depth = 0
  },
  token(stream, state) {
    if (stream.sol()) {
      const continued = state.continued
      state.continued = /\\\s*$/.test(stream.string)
      if (state.define) {
        if (/^\s*endef\b/.test(stream.string)) {
          state.define = false
          state.line = "directive"
        } else {
          state.line = "define"
        }
      } else if (!continued) {
        state.line = classify(stream.string)
        state.afterColon = false
        state.depth = 0
        state.quoted = false
      }
    }

    // Still a string around the `$(…)` inside it, and closed by its own quote
    // rather than read as the opening of the next one.
    if (state.quoted) {
      if (stream.peek() === "$") return rest(stream, state)
      stream.match(/^(?:[^"\\$]|\\.)*/)
      if (stream.eat('"')) state.quoted = false
      // A backslash that ends the line is the continuation, and text.
      else if (stream.pos === stream.start) stream.next()
      return "string"
    }

    if (state.line === "define") {
      if (stream.peek() === "$") return rest(stream, state)
      stream.match(/^[^$]+/)
      return "string"
    }

    if (stream.eatSpace()) return null

    // A recipe's `#` is the shell's comment, at the start of a word; anywhere
    // else in make it is one unless escaped.
    if (stream.peek() === "#") {
      const before = stream.string[stream.pos - 1]
      if (state.line !== "recipe" || !before || /\s/.test(before)) {
        stream.skipToEnd()
        return "comment"
      }
    }

    switch (state.line) {
      case "recipe": {
        if (stream.string.slice(0, stream.pos).trim() === "") {
          if (stream.match(/^[@+-]+/)) return "operator"
        }
        if (stream.match(/^'[^']*'?/)) return "string"
        if (stream.eat('"')) {
          state.quoted = true
          stream.match(/^(?:[^"\\$]|\\.)*/)
          if (stream.eat('"')) state.quoted = false
          return "string"
        }
        return rest(stream, state)
      }
      case "assign": {
        if (stream.match(/^(?:export|override|private)(?=\s)/)) {
          return "keyword"
        }
        if (stream.match(/^(?::::?=|::?=|\?=|\+=|!=|=)/)) {
          state.line = "directive"
          return "operator"
        }
        if (stream.match(/^[^\s:#=?+!$]+/)) return "variableName.definition"
        return rest(stream, state)
      }
      case "rule": {
        if (!state.afterColon) {
          if (stream.match(/^::?/)) {
            state.afterColon = true
            return "operator"
          }
          if (stream.match(/^\.[A-Z_]+(?=[\s:])/)) return "keyword"
          if (stream.match(/^[^\s:$#]+/)) return "labelName"
          return rest(stream, state)
        }
        // An inline recipe: `target: prereqs ; command`.
        if (stream.eat(";")) {
          state.line = "recipe"
          return "operator"
        }
        if (stream.match(/^\|/)) return "operator"
        return rest(stream, state)
      }
      default: {
        if (stream.string.slice(0, stream.pos).trim() === "") {
          const directive = stream.match(DIRECTIVES) as RegExpMatchArray | null
          if (directive) {
            if (directive[0] === "define") state.define = true
            return "keyword"
          }
        }
        return rest(stream, state)
      }
    }
  },
  languageData: { commentTokens: { line: "#" } },
}

const makefileLanguage = StreamLanguage.define(makefileParser)

export function makefile(): LanguageSupport {
  return new LanguageSupport(makefileLanguage)
}
