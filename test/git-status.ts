import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { parseStatus, workingTree } from "../src/main/git"
import { check, finish, section } from "./harness"

/**
 * What git says about a folder's files, against a real repository.
 *
 * Built rather than sampled, for the same reason the transcript test is: the
 * thing being relied on is git's own output, and a fixture would only
 * prove this file agrees with itself. So a repository is made in a temporary
 * directory, put into each of the states Explorer draws a colour for, and read
 * back through the function the IPC handler calls.
 *
 * `parseStatus` is exercised directly for the one shape that is awkward to
 * arrange and easy to get wrong — a rename, which is two records where every
 * other entry is one.
 */

const run = promisify(execFile)

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir })
  return stdout
}

/** The states, keyed by the file's own name — which is all these assert on:
 * a temporary directory on macOS is reached through a symlink, so the absolute
 * paths are the thing under test rather than something to compare against. */
async function statesIn(dir: string): Promise<Record<string, string>> {
  const entries = await workingTree(dir)
  return Object.fromEntries(
    entries.map((entry) => [path.basename(entry.path), entry.state])
  )
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "vsclaude-git-"))

  section("a folder that is not a repository")

  check("has nothing to say", (await workingTree(root)).length === 0)

  section("a working tree")

  await git(root, "init", "--initial-branch", "main")
  await git(root, "config", "user.email", "test@example.com")
  await git(root, "config", "user.name", "Test")

  await writeFile(path.join(root, ".gitignore"), "dist/\n*.log\n")
  await writeFile(path.join(root, "kept.ts"), "export const kept = 1\n")
  await writeFile(path.join(root, "edited.ts"), "export const edited = 1\n")
  await writeFile(path.join(root, "removed.ts"), "export const removed = 1\n")
  await writeFile(path.join(root, "renamed.ts"), "export const renamed = 1\n")
  await git(root, "add", ".")
  await git(root, "commit", "-m", "first")

  // One of each state the tree draws.
  await writeFile(path.join(root, "edited.ts"), "export const edited = 2\n")
  await rm(path.join(root, "removed.ts"))
  await writeFile(path.join(root, "fresh.ts"), "export const fresh = 1\n")
  await writeFile(path.join(root, "debug.log"), "noise\n")
  await mkdir(path.join(root, "dist"))
  await writeFile(path.join(root, "dist", "bundle.js"), "// built\n")
  await mkdir(path.join(root, "sketch"))
  await writeFile(path.join(root, "sketch", "one.ts"), "//\n")

  const states = await statesIn(root)

  check(
    "an edited file is modified",
    states["edited.ts"] === "modified",
    states
  )
  check("a deleted file is deleted", states["removed.ts"] === "deleted", states)
  check("a new file is untracked", states["fresh.ts"] === "untracked", states)
  check("an ignored file is ignored", states["debug.log"] === "ignored", states)
  check(
    "a committed file with no changes is not mentioned at all",
    states["kept.ts"] === undefined,
    states
  )

  section("directories stand for what is under them")

  const entries = await workingTree(root)
  const dist = entries.find((entry) => path.basename(entry.path) === "dist")
  check("an ignored directory is one entry", dist?.state === "ignored", dist)
  check("marked as a directory", dist?.directory === true, dist)
  check(
    "and its contents are not listed under it",
    !entries.some((entry) => path.basename(entry.path) === "bundle.js"),
    entries.map((entry) => entry.path)
  )

  const sketch = entries.find((entry) => path.basename(entry.path) === "sketch")
  check(
    "a new directory arrives the same way",
    sketch?.state === "untracked" && sketch.directory,
    sketch
  )

  section("paths are the folder's own")

  check(
    "absolute, and under the folder that was asked about",
    entries.every((entry) => entry.path.startsWith(root + path.sep)),
    entries.slice(0, 3).map((entry) => entry.path)
  )

  section("a folder inside a repository")

  // What pointing the workspace at `packages/web` of a monorepo looks like:
  // git answers relative to the repository, and the paths still have to line up
  // with the rows the tree drew from `readdir`.
  const inner = path.join(root, "sketch")
  const innerStates = await statesIn(inner)
  check(
    "is read from where it is",
    innerStates["one.ts"] === "untracked" ||
      innerStates["sketch"] === "untracked",
    innerStates
  )
  check(
    "with paths under that folder",
    (await workingTree(inner))
      .filter((entry) => entry.path.includes("sketch"))
      .every((entry) => entry.path.startsWith(root + path.sep)),
    await workingTree(inner)
  )

  section("a rename")

  await git(root, "mv", "renamed.ts", "moved.ts")
  const renamed = await statesIn(root)
  check("lands on the new name", renamed["moved.ts"] === "modified", renamed)
  check(
    "and does not leave the old one behind",
    renamed["renamed.ts"] === undefined,
    renamed
  )

  section("parseStatus")

  // The two-record shape, spelled out: without the skip, the source path is
  // read as a record of its own — `enamed.ts` with a status of `d.`.
  const parsed = parseStatus("R  new.ts\0old.ts\0 M other.ts\0")
  check(
    "a rename is one entry, for where the file now is",
    parsed.length === 2 && parsed[0]?.relative === "new.ts",
    parsed
  )
  check(
    "and the record after it is not read as a status",
    parsed[1]?.relative === "other.ts" && parsed[1]?.state === "modified",
    parsed
  )

  const conflicted = parseStatus("UU both.ts\0AA added.ts\0DD gone.ts\0")
  check(
    "every shape of conflict is one",
    conflicted.every((entry) => entry.state === "conflicted"),
    conflicted
  )

  await rm(root, { recursive: true, force: true })
  finish()
}

await main()
