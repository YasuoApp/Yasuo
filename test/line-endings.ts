import {
  lineEndingOf,
  toLf,
  withLineEnding,
} from "../src/renderer/lib/files/line-endings"
import { check, finish, section } from "./harness"

/**
 * A file's line endings — `lib/files/line-endings.ts`. The round trip is the
 * one that matters: a CRLF file opened and saved untouched must come back byte
 * for byte, or every save on a Windows checkout rewrites every line.
 */

section("which ending a file uses")
check("LF", lineEndingOf("a\nb\n") === "\n")
check("CRLF", lineEndingOf("a\r\nb\r\n") === "\r\n")
check("no line break reads as LF", lineEndingOf("a") === "\n")
check("mixed goes to the majority", lineEndingOf("a\r\nb\r\nc\n") === "\r\n")
check("a tie stays LF", lineEndingOf("a\r\nb\n") === "\n")

section("normalising")
check("CRLF to LF", toLf("a\r\nb\r\n") === "a\nb\n")
check("a lone CR to LF", toLf("a\rb") === "a\nb")
check("LF untouched", toLf("a\nb") === "a\nb")

section("the round trip")
for (const text of ["a\r\nb\r\n", "a\nb\n", "", "one line"]) {
  const back = withLineEnding(toLf(text), lineEndingOf(text))
  check(`${JSON.stringify(text)} comes back as it was`, back === text, back)
}
check(
  "a line typed into a CRLF file is saved as CRLF",
  withLineEnding("a\nnew\nb\n", "\r\n") === "a\r\nnew\r\nb\r\n"
)

finish()
