import {
  fileLinkCandidates,
  type FileLinkCandidate,
} from "../src/renderer/lib/shell/file-links"
import { check, finish, section } from "./harness"

/**
 * The dock's ⌘-click on a path: which runs of a line of output are offered to
 * main as files, and which line and column each one points at.
 */

const one = (text: string): FileLinkCandidate | undefined =>
  fileLinkCandidates(text)[0]

const span = (text: string, link: FileLinkCandidate | undefined) =>
  link ? text.slice(link.start, link.end) : null

section("line suffixes")
{
  const eslint = "src/app.ts:42:7  error  'x' is unused"
  const link = one(eslint)
  check(
    "reads path, line and column",
    link?.path === "src/app.ts" && link.line === 42 && link.column === 7,
    link
  )
  check("underlines the suffix too", span(eslint, link) === "src/app.ts:42:7")

  const grep = "lib/store.ts:118:  const x = 1"
  const grepped = one(grep)
  check(
    "a line without a column, and the colon after it left off",
    grepped?.path === "lib/store.ts" &&
      grepped.line === 118 &&
      grepped.column === undefined &&
      span(grep, grepped) === "lib/store.ts:118",
    grepped
  )

  const node = "    at run (/Users/me/app/index.js:10:5)"
  const frame = one(node.replace("at run ", ""))
  check(
    "a stack frame, without its parenthesis",
    fileLinkCandidates(node).some(
      (candidate) =>
        candidate.path === "/Users/me/app/index.js" && candidate.line === 10
    ) && frame?.path === "/Users/me/app/index.js"
  )
}

section("tsc and Python")
{
  const tsc = "src/app.ts(42,7): error TS2304: Cannot find name 'x'."
  const link = one(tsc)
  check(
    "tsc's (line,col)",
    link?.path === "src/app.ts" && link.line === 42 && link.column === 7,
    link
  )
  check("underlines it with the path", span(tsc, link) === "src/app.ts(42,7)")

  const py = '  File "/srv/app/main.py", line 12, in <module>'
  const traced = fileLinkCandidates(py).find((c) => c.path.endsWith(".py"))
  check(
    "a traceback's line",
    traced?.path === "/srv/app/main.py" && traced.line === 12,
    traced
  )
}

section("bare paths")
{
  const status = "\tmodified:   src/renderer/lib/dock.ts"
  check(
    "git status",
    fileLinkCandidates(status).some(
      (c) => c.path === "src/renderer/lib/dock.ts" && c.line === undefined
    )
  )
  check("a file name with an extension", one("README.md")?.path === "README.md")
  check(
    "a sentence's full stop is not part of the path",
    one("see ./docs/design.md.")?.path === "./docs/design.md"
  )
}

section("what is not a path")
{
  check("a URL", fileLinkCandidates("http://localhost:5173/").length === 0)
  check("a version", fileLinkCandidates("v1.2.3 1.2.3").length === 0)
  check("plain words", fileLinkCandidates("done in 1.2s, ok").length === 0)
}

finish()
