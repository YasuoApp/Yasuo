import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { AssistantMessage, SearchOptions } from "../src/shared/api"
import {
  chatMatchesIn,
  matcherOf,
  matchesIn,
  previewOf,
  searchFiles,
} from "../src/main/content-search"
import { hitAt, hitsIn } from "../src/renderer/lib/worktree-chat/search"
import { check, finish, section } from "./harness"

/**
 * The left column's Search: what the toggles mean, where a match is said to be,
 * and that a row in a chat lands the `⌘F` bar on the occurrence it showed.
 *
 * The files half runs against a real directory, the way `test/files.ts` does.
 */

const plain: SearchOptions = {
  matchCase: false,
  wholeWord: false,
  regex: false,
}
const regexOf = (query: string, options: Partial<SearchOptions> = {}) => {
  const built = matcherOf(query, { ...plain, ...options })
  if (!built || "error" in built) throw new Error(`no matcher for ${query}`)
  return built.matcher
}

section("the toggles")
{
  check("an empty query is no search", matcherOf("", plain) === null)
  check(
    "a literal is escaped",
    matchesIn("a.b axb", regexOf("a.b"), 10).length === 1
  )
  check(
    "case is ignored unless asked",
    matchesIn("Foo foo", regexOf("foo"), 10).length === 2 &&
      matchesIn("Foo foo", regexOf("foo", { matchCase: true }), 10).length === 1
  )
  check(
    "whole word",
    matchesIn("cat concat cat_", regexOf("cat", { wholeWord: true }), 10)
      .length === 1
  )
  check(
    "a pattern",
    matchesIn("a1 b22", regexOf("\\d+", { regex: true }), 10).length === 2
  )
  const broken = matcherOf("(", { ...plain, regex: true })
  check(
    "a broken pattern is an error, not a throw",
    !!broken && "error" in broken
  )
}

section("where a match is")
{
  const found = matchesIn("one\ntwo foo\r\nfoo three", regexOf("foo"), 10)
  check(
    "lines and columns are one-based",
    found.length === 2 &&
      found[0]?.line === 2 &&
      found[0]?.column === 5 &&
      found[1]?.line === 3 &&
      found[1]?.column === 1,
    found
  )
  check(
    "the preview carries the line without its CR",
    found[0]?.preview.text === "two foo",
    found[0]?.preview
  )
  check(
    "an empty match does not loop",
    matchesIn("abc", regexOf("x*", { regex: true }), 10).length === 0
  )
  check("the limit holds", matchesIn("a a a a", regexOf("a"), 2).length === 2)
}
{
  const indented = previewOf("    const x = 1", 10, 11)
  check(
    "indentation is dropped",
    indented.text === "const x = 1" &&
      indented.text.slice(indented.from, indented.to) === "x",
    indented
  )
  const long = previewOf(`${"y".repeat(500)}MATCH${"z".repeat(500)}`, 500, 505)
  check(
    "a long line starts near its match",
    long.text.startsWith("…") &&
      long.text.slice(long.from, long.to) === "MATCH" &&
      long.text.length < 260,
    long
  )
}

section("chats")
{
  const messages: AssistantMessage[] = [
    {
      id: "u",
      role: "user",
      text: "Fix the Migration, then the migration test",
    },
    { id: "t", role: "thinking", text: "migration" },
    { id: "a", role: "assistant", text: "Done: migration ran." },
  ]
  const found = chatMatchesIn(messages, regexOf("migration"), 10)
  check(
    "the two voices only",
    found.length === 3 && found.every((match) => match.messageId !== "t"),
    found
  )

  // The second occurrence in the first message, found case-sensitively by the
  // column, has to land the bar on that same occurrence.
  const second = chatMatchesIn(
    messages,
    regexOf("migration", { matchCase: true }),
    10
  )[0]
  const landed = second && hitAt(messages, "u", second.offset, second.length)
  check(
    "a chat row lands the find bar on the occurrence it showed",
    landed?.query === "migration" &&
      hitsIn(messages, landed.query)[landed.at]?.messageId === "u" &&
      hitsIn(messages, landed.query)[landed.at]?.nth === 1,
    landed
  )
}

section("files")
{
  const root = await mkdtemp(path.join(tmpdir(), "yasuo-search-"))
  try {
    await mkdir(path.join(root, "src"))
    await mkdir(path.join(root, "node_modules"))
    await writeFile(path.join(root, "src", "a.ts"), "export const needle = 1\n")
    await writeFile(path.join(root, "b.md"), "no\nneedle here\n")
    await writeFile(path.join(root, "node_modules", "c.js"), "needle")
    await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 110, 101, 101]))

    const found = await searchFiles(
      [{ path: root, folderId: "f" }],
      regexOf("needle"),
      { limit: 100, stale: () => false }
    )
    const relatives = found.files.map((file) => file.relative).sort()
    check(
      "text files found, ignored directories skipped",
      JSON.stringify(relatives) === JSON.stringify(["b.md", "src/a.ts"]),
      relatives
    )
    check(
      "the line is right",
      found.files.find((file) => file.relative === "b.md")?.matches[0]?.line ===
        2
    )

    const capped = await searchFiles(
      [{ path: root, folderId: "f" }],
      regexOf("needle"),
      { limit: 1, stale: () => false }
    )
    check("the cap stops the walk", capped.truncated && capped.matches === 1)

    const stopped = await searchFiles(
      [{ path: root, folderId: "f" }],
      regexOf("needle"),
      { limit: 100, stale: () => true }
    )
    check("a stale search stops", stopped.files.length === 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

section("a repository: what git ignores is not searched")
{
  const root = await mkdtemp(path.join(tmpdir(), "yasuo-search-git-"))
  try {
    execFileSync("git", ["init", "-q"], { cwd: root })
    await writeFile(path.join(root, ".gitignore"), ".output/\nnotes.log\n")
    await mkdir(path.join(root, ".output"))
    await mkdir(path.join(root, "src"))
    await mkdir(path.join(root, "vendor"))
    await writeFile(path.join(root, ".output", "server.mjs"), "needle")
    await writeFile(path.join(root, "notes.log"), "needle")
    await writeFile(path.join(root, "vendor", "lib.js"), "needle")
    await writeFile(path.join(root, "src", "kept.ts"), "needle")
    await writeFile(path.join(root, "untracked.md"), "needle")
    execFileSync("git", ["add", "src/kept.ts"], { cwd: root })

    const found = await searchFiles(
      [{ path: root, folderId: "f" }],
      regexOf("needle"),
      { limit: 100, stale: () => false }
    )
    const relatives = found.files.map((file) => file.relative).sort()
    check(
      "tracked and untracked-but-not-ignored only",
      JSON.stringify(relatives) ===
        JSON.stringify(["src/kept.ts", "untracked.md"]),
      relatives
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

finish()
