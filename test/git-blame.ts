import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { blame, webUrlOf } from "../src/main/git"
import {
  ago,
  annotationOf,
  commitAt,
  fileUrl,
  issueNumbers,
  messageParts,
} from "../src/renderer/lib/files/git-blame"
import { check, finish, section } from "./harness"

/**
 * The editor's current-line blame — `blame` in `main/git.ts` and the words in
 * `lib/files/git-blame.ts`.
 *
 * Against a real repository, like `test/git-diff.ts`: what is relied on is the
 * porcelain format, and above all that a buffer handed over on stdin is blamed
 * as it stands — a line typed above an old one has to move that one's commit
 * down with it, or every annotation under the caret is a line off.
 */

const run = promisify(execFile)

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir })
  return stdout
}

section("blame")

const root = await mkdtemp(path.join(tmpdir(), "yasuo-blame-"))
try {
  await git(root, "init", "-b", "main")
  await git(root, "config", "user.email", "ada@example.com")
  await git(root, "config", "user.name", "Ada")
  await git(root, "remote", "add", "origin", "git@github.com:acme/app.git")

  const file = path.join(root, "file.ts")
  await writeFile(file, "one\ntwo\n")
  await git(root, "add", "-A")
  await git(root, "commit", "-m", "first (#12)")
  await writeFile(file, "one\ntwo\nthree\n")
  await git(root, "commit", "-am", "second")
  const [first, second] = (await git(root, "log", "--format=%H", "--reverse"))
    .trim()
    .split("\n")

  // An unsaved line typed at the top, the way the editor would hand it over.
  const answer = await blame(root, file, "zero\none\ntwo\nthree\n")
  check("answers for a committed file", answer !== null)
  if (answer) {
    check(
      "lines follow the buffer, not the disk",
      JSON.stringify(answer.lines) ===
        JSON.stringify([null, first, first, second]),
      answer.lines
    )
    const commit = answer.commits[first!]
    check("names the author", commit?.author === "Ada", commit)
    check("without the angle brackets", commit?.email === "ada@example.com")
    check("keeps the summary", commit?.summary === "first (#12)")
    check("an ISO date", !Number.isNaN(Date.parse(commit?.date ?? "")))
    check("finds the forge", answer.webUrl === "https://github.com/acme/app")
    check("names the file from the root", answer.path === "file.ts")
    check("an uncommitted line is null", commitAt(answer, 1) === null)
    check("past the end is undefined", commitAt(answer, 9) === undefined)
  }

  const untracked = path.join(root, "new.ts")
  await writeFile(untracked, "x\n")
  check(
    "an untracked file is null",
    (await blame(root, untracked, "x\n")) === null
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

section("webUrlOf")

for (const [remote, expected] of [
  ["git@github.com:acme/app.git", "https://github.com/acme/app"],
  ["https://github.com/acme/app.git", "https://github.com/acme/app"],
  ["https://token@github.com/acme/app", "https://github.com/acme/app"],
  [
    "ssh://git@gitlab.com/group/sub/app.git",
    "https://gitlab.com/group/sub/app",
  ],
  ["git@github.com-personal:acme/app.git", "https://github.com/acme/app"],
  ["git@github-work:acme/app.git", "https://github.com/acme/app"],
  ["ssh://git@github.com:22/acme/app.git", "https://github.com/acme/app"],
  ["git@bitbucket.org:acme/app.git", "https://bitbucket.org/acme/app"],
  ["git@gitlab.example.com:acme/app.git", null],
  ["git@git.internal:acme/app.git", null],
  ["/srv/repos/app.git", null],
  ["", null],
] as const) {
  check(
    `${remote || "(none)"}`,
    webUrlOf(remote) === expected,
    webUrlOf(remote)
  )
}

section("words")

const now = Date.parse("2026-10-08T12:00:00Z")
check("months", ago("2026-07-10T13:15:00Z", now) === "2 months ago")
check("yesterday", ago("2026-10-07T10:00:00Z", now) === "yesterday")
check("seconds", ago("2026-10-08T11:59:50Z", now) === "just now")
check(
  "the annotation",
  annotationOf(
    {
      hash: "a",
      author: "Ada",
      email: "",
      date: "2026-07-10T13:15:00Z",
      summary: "feat: x",
    },
    now
  ) === "Ada, 2 months ago • feat: x"
)
check("an uncommitted line", annotationOf(null, now).includes("Not committed"))

const parts = messageParts("feat: add (#27) and #3", "https://github.com/a/b")
check(
  "issue numbers become links",
  JSON.stringify(parts) ===
    JSON.stringify([
      { text: "feat: add (" },
      { text: "#27", href: "https://github.com/a/b/issues/27" },
      { text: ") and " },
      { text: "#3", href: "https://github.com/a/b/issues/3" },
    ]),
  parts
)
check("not without a forge", messageParts("fix #3", null).length === 1)
check(
  "not inside a word",
  messageParts("color#3", "https://github.com/a/b").length === 1
)

section("links")

check(
  "a file at a commit, on GitHub",
  fileUrl("https://github.com/a/b", "abc", "src/x.ts", 12) ===
    "https://github.com/a/b/blob/abc/src/x.ts#L12"
)
check(
  "on GitLab",
  fileUrl("https://gitlab.com/a/b", "abc", "x.ts", 3) ===
    "https://gitlab.com/a/b/-/blob/abc/x.ts#L3"
)
check(
  "on Bitbucket",
  fileUrl("https://bitbucket.org/a/b", "abc", "x.ts", 3) ===
    "https://bitbucket.org/a/b/src/abc/x.ts#lines-3"
)
check(
  "a path with a space is escaped, its slashes are not",
  fileUrl("https://github.com/a/b", "abc", "my dir/x.ts", 1) ===
    "https://github.com/a/b/blob/abc/my%20dir/x.ts#L1"
)
check(
  "the issue numbers in a summary, once each",
  JSON.stringify(issueNumbers("fix (#27), see #3 and #27")) === "[27,3]"
)

finish()
