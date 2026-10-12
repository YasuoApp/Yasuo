import { quoteOf } from "../src/renderer/lib/worktree-chat/reply"
import { check, finish, section } from "./harness"

/** A selected run of the transcript, as the composer receives it. */

section("a selection as a quote")

check(
  "every line is quoted and the caret lands under it",
  quoteOf("first line\nsecond line") === "> first line\n> second line\n\n"
)

check(
  "a blank line inside the run stays inside the quote",
  quoteOf("one\n\ntwo") === "> one\n>\n> two\n\n"
)

check(
  "whitespace either side of the run is dropped",
  quoteOf("\n\n  said this  \n\n") === ">   said this\n\n"
)

check("nothing selected is nothing to type", quoteOf("  \n ") === "")

finish()
