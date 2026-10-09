import { StringStream } from "@codemirror/language"

import {
  languageForFile,
  languageNamed,
} from "../src/renderer/lib/editor-languages"
import { makefileParser } from "../src/renderer/lib/editor-makefile"
import { check, finish, section } from "./harness"

/**
 * A Makefile's highlighting — `lib/editor-makefile.ts`, and the name match in
 * `lib/editor-languages.ts` that hands a file to it.
 */

const parser = makefileParser

/** Every line's tokens as `style:text`, unstyled runs dropped. */
function tokens(text: string): string[] {
  const state = parser.startState!(4)
  const out: string[] = []
  for (const line of text.split("\n")) {
    if (line === "") {
      parser.blankLine?.(state, 4)
      continue
    }
    const stream = new StringStream(line, 4, 4)
    while (!stream.eol()) {
      const style = parser.token(stream, state)
      if (stream.pos === stream.start) throw new Error(`stuck on ${line}`)
      if (style) out.push(`${style}:${stream.current()}`)
      stream.start = stream.pos
    }
  }
  return out
}

section("which files are Makefiles")
check("Makefile", languageForFile("/r/Makefile")?.name === "Makefile")
check("makefile", languageForFile("/r/makefile")?.name === "Makefile")
check("GNUmakefile", languageForFile("/r/GNUmakefile")?.name === "Makefile")
check("rules.mk", languageForFile("/r/rules.mk")?.name === "Makefile")
check(
  "not CMakeLists.txt",
  languageForFile("/r/CMakeLists.txt")?.name !== "Makefile"
)
check("a ```make fence", languageNamed("make")?.name === "Makefile")

section("tokens")
const assign = tokens("CC := gcc")
check(
  "variable, operator",
  assign.join(" ") === "variableName.definition:CC operator::=",
  assign
)

const rule = tokens("build: main.o $(OBJS)")
check("target", rule[0] === "labelName:build", rule)
check("colon", rule[1] === "operator::", rule)
check(
  "$(VAR) prerequisite",
  rule.includes("variableName.special:$(OBJS)"),
  rule
)

const phony = tokens(".PHONY: all clean")
check(".PHONY is special", phony[0] === "keyword:.PHONY", phony)

const recipe = tokens('all:\n\t@echo "hi $$HOME" $@ # done')
check("recipe's @", recipe.includes("operator:@"), recipe)
check(
  "a string around its $$",
  recipe.includes('string:"hi ') && recipe.includes('string:HOME"'),
  recipe
)
check("and closed by its quote", !recipe.includes('string:" '), recipe)
check("automatic variable", recipe.includes("variableName.special:$@"), recipe)
check("shell comment", recipe.at(-1) === "comment:# done", recipe)

const call = tokens("SRC = $(wildcard src/*.c)")
check("function head", call.includes("keyword:$(wildcard"), call)
check("and its )", call.at(-1) === "keyword:)", call)

const directive = tokens("ifeq ($(OS),Darwin)\nendif")
check("ifeq", directive[0] === "keyword:ifeq", directive)
check("endif", directive.at(-1) === "keyword:endif", directive)

const defined = tokens("define BODY\n\tsome text\nendef\nX = 1")
check("define", defined[0] === "keyword:define", defined)
check("body is text", defined.includes("string:\tsome text"), defined)
check("endef", defined.includes("keyword:endef"), defined)
check(
  "and after it, make again",
  defined.includes("variableName.definition:X"),
  defined
)

const continued = tokens("LIST = a \\\n  b\nNEXT = 2")
check(
  "a continued line is the assignment's rest",
  !continued.includes("labelName:b") &&
    continued.includes("variableName.definition:NEXT"),
  continued
)

const comment = tokens("# top\nall: # why")
check("line comment", comment[0] === "comment:# top", comment)
check("comment after a rule", comment.at(-1) === "comment:# why", comment)

// None of these may leave the stream where it was — the parser throws on that.
tokens('all:\n\techo "a \\\n\tb"')
tokens("X = $\nY = $(")
tokens('all:\n\t@\n\t"$')
check("a trailing \\, a lone $ and an open quote advance", true)

finish()
