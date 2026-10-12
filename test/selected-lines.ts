import { Text } from "@codemirror/state"

import {
  selectedLines,
  selectionLabel,
  selectionMention,
} from "../src/renderer/lib/files/selected-lines"
import { check, finish, section } from "./harness"

/**
 * Which lines a file's selection covers and how a message names them —
 * `lib/files/selected-lines.ts`, the chip's and the pill's arithmetic.
 */

const doc = Text.of(["one", "two", "three", "four", "five"])
const lineAt = (pos: number) => doc.lineAt(pos)
const start = (line: number) => doc.line(line).from

section("selectedLines")

check("an empty selection is none", selectedLines(lineAt, 5, 5) === null)

const within = selectedLines(lineAt, start(2) + 1, start(2) + 2)
check(
  "inside one line is that line",
  within?.fromLine === 2 && within.toLine === 2,
  within
)

const across = selectedLines(lineAt, start(2), start(4) + 2)
check(
  "across lines takes both ends",
  across?.fromLine === 2 && across.toLine === 4,
  across
)

const toNextStart = selectedLines(lineAt, start(2), start(4))
check(
  "ending at a line's start leaves that line out",
  toNextStart?.fromLine === 2 && toNextStart.toLine === 3,
  toNextStart
)

const emptyLineEnd = selectedLines(lineAt, start(2) + 1, start(3))
check(
  "but never leaves the run with no lines",
  emptyLineEnd?.fromLine === 2 && emptyLineEnd.toLine === 2,
  emptyLineEnd
)

section("words")

check(
  "one line is singular",
  selectionLabel({ fromLine: 3, toLine: 3 }) === "1 line selected"
)
check(
  "ten lines",
  selectionLabel({ fromLine: 12, toLine: 21 }) === "10 lines selected"
)
check(
  "a run is a range",
  selectionMention("src/main/git.ts", { fromLine: 12, toLine: 21 }) ===
    "@src/main/git.ts#L12-21"
)
check(
  "a line is a line",
  selectionMention("a.ts", { fromLine: 7, toLine: 7 }) === "@a.ts#L7"
)

finish()
