import { StringStream } from "@codemirror/language"

import { dotenvParser } from "../src/renderer/lib/editor-dotenv"
import { languageForFile } from "../src/renderer/lib/editor-languages"
import { check, finish, section } from "./harness"

/**
 * A `.env` file's highlighting — `lib/editor-dotenv.ts`, and the name match in
 * `lib/editor-languages.ts` that hands a file to it.
 */

const parser = dotenvParser

/** Each line's tokens as `style:text`, unstyled runs dropped. */
function tokens(text: string): string[] {
  const state = parser.startState!(2)
  const out: string[] = []
  for (const line of text.split("\n")) {
    const stream = new StringStream(line, 2, 2)
    while (!stream.eol()) {
      const style = parser.token(stream, state)
      if (stream.pos === stream.start) throw new Error(`stuck on ${line}`)
      if (style) out.push(`${style}:${stream.current()}`)
      stream.start = stream.pos
    }
  }
  return out
}

section("which files are dotenv")
check(".env", languageForFile("/r/.env")?.name === "dotenv")
check(".env.local", languageForFile("/r/.env.local")?.name === "dotenv")
check(".env.example", languageForFile("/r/.env.example")?.name === "dotenv")
check("not env.ts", languageForFile("/r/env.ts")?.name !== "dotenv")
check("not .envrc", languageForFile("/r/.envrc")?.name !== "dotenv")

section("tokens")
const plain = tokens("API_KEY=abc123")
check(
  "key, =, value",
  plain.join(" ") === "propertyName:API_KEY operator:= string:abc123",
  plain
)

const exported = tokens("export PORT=8080")
check("export is a keyword", exported[0] === "keyword:export", exported)

const comment = tokens("# a note\nA=b # trailing")
check("line comment", comment[0] === "comment:# a note", comment)
check("trailing comment", comment.at(-1) === "comment:# trailing", comment)

const hash = tokens("URL=http://host/#frag")
check(
  "# inside a value is the value",
  hash.join(" ") === "propertyName:URL operator:= string:http://host/#frag",
  hash
)

const expanded = tokens('DB="postgres://${USER}@host"')
check(
  "${VAR} inside double quotes",
  expanded.includes("variableName.special:${USER}"),
  expanded
)

const literal = tokens("RAW='${USER}'")
check(
  "single quotes are literal",
  !literal.some((t) => t.startsWith("variableName")),
  literal
)

const bare = tokens("HOME_DIR=$HOME/x")
check("$VAR unquoted", bare.includes("variableName.special:$HOME"), bare)

const multiline = tokens('KEY="line one\nline two"\nNEXT=1')
check(
  "a quoted value runs onto the next line",
  multiline.includes('string:line two"'),
  multiline
)
check(
  "and the line after is a key again",
  multiline.includes("propertyName:NEXT"),
  multiline
)

// Neither may leave the stream where it was — the parser throws on that.
tokens('A="cost $"')
tokens('A="trailing \\')
check("a lone $ and a trailing \\ advance", true)

finish()
