import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { DirectoryWatchers, RootWatchers } from "../src/main/watch"
import { check, finish, section } from "./harness"

/**
 * The Explorer's directory watchers, against a real directory.
 *
 * `fs.watch` is the thing being tested — a fake of it would only check that
 * this file's own idea of the API matches this file's own idea of the API — so
 * these create files in a temporary directory and wait for the events they
 * produce. What matters is the set arithmetic around it: a collapsed folder
 * must go quiet, or the panel is back to a handle per directory anybody has
 * ever opened.
 */

/** Long enough for a debounce (120ms) plus whatever the platform's watcher
 * takes, short enough that a hang is a failed test rather than a stuck run. */
const SETTLE_MS = 1500

/** Waits for `want` to be reported, or gives up. Polled rather than awaited on
 * a promise so that "nothing arrived" is answerable too. */
async function waitFor(
  seen: string[],
  want: string,
  timeout = SETTLE_MS
): Promise<boolean> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (seen.includes(want)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "yasuo-watch-"))
  const src = path.join(root, "src")
  const docs = path.join(root, "docs")
  await mkdir(src)
  await mkdir(docs)

  const seen: string[] = []
  const watchers = new DirectoryWatchers((dir) => seen.push(dir))

  section("a watched directory")

  watchers.set([src, docs])
  await writeFile(path.join(src, "new-file.ts"), "")
  check("reports a file created in it", await waitFor(seen, src), seen)
  check("and says nothing about the one beside it", !seen.includes(docs), seen)

  section("one event per burst")

  seen.length = 0
  // Three writes inside the debounce window: one save from an editor that
  // truncates and rewrites looks much the same.
  await writeFile(path.join(src, "a.ts"), "1")
  await writeFile(path.join(src, "b.ts"), "2")
  await writeFile(path.join(src, "c.ts"), "3")
  await waitFor(seen, src)
  await new Promise((resolve) => setTimeout(resolve, 300))
  check(
    "three writes in a row are one report",
    seen.filter((dir) => dir === src).length === 1,
    seen
  )

  section("a collapsed directory")

  seen.length = 0
  // What the renderer sends when a folder is folded: the set it still has open.
  watchers.set([docs])
  await writeFile(path.join(src, "after.ts"), "")
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS / 3))
  check("stops being reported", !seen.includes(src), seen)

  await writeFile(path.join(docs, "still-here.md"), "")
  check("and the one still open does not", await waitFor(seen, docs), seen)

  section("a directory that cannot be watched")

  seen.length = 0
  const gone = path.join(root, "never-existed")
  // The row is already drawing its own read error; this must not throw on top
  // of it, and must not take the rest of the set with it.
  watchers.set([docs, gone])
  await writeFile(path.join(docs, "again.md"), "")
  check(
    "leaves the directories beside it watched",
    await waitFor(seen, docs),
    seen
  )

  section("closeAll")

  seen.length = 0
  watchers.closeAll()
  await writeFile(path.join(docs, "last.md"), "")
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS / 3))
  check("leaves nothing reporting", seen.length === 0, seen)

  // The `Changes` list's watcher: one per root, recursive, and only where that
  // is one native handle — elsewhere it is deliberately inert.
  if (process.platform === "darwin" || process.platform === "win32") {
    section("a root, watched whole")

    const deep = path.join(root, "folded", "deeper")
    await mkdir(deep, { recursive: true })
    await mkdir(path.join(root, ".git"))

    const reported: string[] = []
    const roots = new RootWatchers((_root, paths) => reported.push(...paths))
    roots.set([root])
    // Give FSEvents a moment to start before the writes it should see.
    await new Promise((resolve) => setTimeout(resolve, 100))

    const written = path.join(deep, "made-by-a-chat.ts")
    await writeFile(written, "")
    check(
      "reports a file written in a folder nobody expanded",
      await waitFor(reported, written),
      reported
    )

    reported.length = 0
    await writeFile(path.join(root, ".git", "index"), "")
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS / 3))
    check(
      "and says nothing about `.git`, which has its own watcher",
      reported.every((entry) => !entry.includes(`${path.sep}.git`)),
      reported
    )

    roots.closeAll()
  }

  await rm(root, { recursive: true, force: true })
  finish()
}

await main()
