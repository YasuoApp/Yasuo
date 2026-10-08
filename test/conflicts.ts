import { conflictsIn, resolve } from "../src/renderer/lib/files/conflicts"
import { check, finish, section } from "./harness"

/**
 * Merge-conflict blocks, read off a file's text and resolved one at a time.
 *
 * The failure this is written against is the quiet one: a block read a line
 * off leaves a marker in the file, or takes a line of somebody's code with it,
 * and the file still saves.
 */

const plain = [
  "before",
  "<<<<<<< HEAD",
  "ours 1",
  "ours 2",
  "=======",
  "theirs",
  ">>>>>>> feature/x",
  "after",
  "",
].join("\n")

section("reading a block")
{
  const [block] = conflictsIn(plain)
  check("one block", conflictsIn(plain).length === 1)
  check(
    "labels",
    block?.currentLabel === "HEAD" && block.incomingLabel === "feature/x"
  )
  check(
    "current side is its lines, newlines included",
    plain.slice(block!.current.from, block!.current.to) === "ours 1\nours 2\n"
  )
  check(
    "incoming side",
    plain.slice(block!.incoming.from, block!.incoming.to) === "theirs\n"
  )
  check("three markers", block?.markers.length === 3)
  check("no base", block?.base === null)
  check("a file with none", conflictsIn("a\nb\n").length === 0)
}

section("resolving")
{
  const [block] = conflictsIn(plain)
  check(
    "current",
    resolve(plain, block!, "current") === "before\nours 1\nours 2\nafter\n"
  )
  check(
    "incoming",
    resolve(plain, block!, "incoming") === "before\ntheirs\nafter\n"
  )
  check(
    "both, current first",
    resolve(plain, block!, "both") === "before\nours 1\nours 2\ntheirs\nafter\n"
  )
}

section("diff3: the base is read and never kept")
{
  const text = [
    "<<<<<<< ours",
    "a",
    "||||||| base",
    "original",
    "=======",
    "b",
    ">>>>>>> theirs",
    "",
  ].join("\n")
  const [block] = conflictsIn(text)
  check(
    "base read",
    text.slice(block!.base!.from, block!.base!.to) === "original\n"
  )
  check("current stops at the base", resolve(text, block!, "current") === "a\n")
  check("both leaves the base out", resolve(text, block!, "both") === "a\nb\n")
  check("four markers", block?.markers.length === 4)
}

section("edges")
{
  const empty = "<<<<<<< HEAD\n=======\nnew\n>>>>>>> x\n"
  const [block] = conflictsIn(empty)
  check("an empty side", resolve(empty, block!, "current") === "")
  check("both with an empty side", resolve(empty, block!, "both") === "new\n")

  const last = "x\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> y"
  const [atEnd] = conflictsIn(last)
  check(
    "a block ending the file adds no newline the file did not have",
    resolve(last, atEnd!, "incoming") === "x\nb"
  )

  const crlf = "<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> y\r\nz\r\n"
  const [windows] = conflictsIn(crlf)
  check("CRLF", resolve(crlf, windows!, "incoming") === "b\r\nz\r\n")

  const two = `${plain}${plain}`
  check("two blocks", conflictsIn(two).length === 2)

  check(
    "eight `=` is not a separator",
    conflictsIn("<<<<<<< a\nx\n========\ny\n>>>>>>> b\n").length === 0
  )
  check(
    "an opener with no close is not a block",
    conflictsIn("<<<<<<< a\nx\n=======\ny\n").length === 0
  )
  check(
    "a stray opener does not swallow the real block after it",
    conflictsIn(`<<<<<<< stray\n${plain}`).length === 1
  )
}

finish()
