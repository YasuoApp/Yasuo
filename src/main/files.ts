import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import type { FileContent, FileEntry, FileIndexEntry } from "../shared/api"
import { ignoredPaths } from "./git"

/**
 * The Explorer's side of the disk: the workspace's folders, read and written
 * where they are.
 *
 * Everything else the studio stores lives under `~/.vsclaude` and is addressed by
 * an id — a note, a request, a database. These are the user's own files at
 * their own absolute paths, which is the whole point of the panel and also the
 * one thing that makes it different: an id names a file this app created, while
 * a path names anything at all. So every call here is checked against the
 * folders the workspace is pointed at before it touches anything (`insideAny`),
 * and the renderer's path never reaches `fs` unchecked.
 *
 * Deliberately free of `electron`: the two operations that need it — moving to
 * the trash and revealing in the file manager — stay in `ipc.ts`, so this
 * module can be imported by `test/files.ts` under plain Bun.
 */

/**
 * Past this, a file is reported rather than opened.
 *
 * The editor is a code editor in a renderer, and a megabyte-per-line minified
 * bundle is what actually hangs it — but a size is the only cheap thing to check
 * before the read, and 2 MB is comfortably above any file somebody opens to
 * read.
 */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024

/**
 * Directories the search index walks straight past.
 *
 * The palette is for finding a file somebody wrote, and none of these hold one:
 * they are what a package manager, a build or a virtualenv left behind. A
 * single `node_modules` outnumbers the repository around it by an order of
 * magnitude, so this is also the difference between an index that takes a
 * moment and one that takes a minute.
 *
 * What a repository's `.gitignore` names is skipped as well, but that is asked
 * of git (`ignoredPaths`) rather than parsed here. This list is for the folder
 * that is not a repository, and for the one whose `.gitignore` forgot
 * `node_modules`. Both are wrong in only one direction: something skipped is
 * still reachable in the tree, which shows everything.
 */
export const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".svn",
  ".turbo",
  ".venv",
  "__pycache__",
  "bower_components",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
  "vendor",
])

/**
 * How many files the palette will hold.
 *
 * A ceiling rather than a promise: past this the index simply stops, and the
 * tree is still the way to whatever was not reached. It is here because the
 * renderer scores what it holds on every keystroke — the walk itself would
 * happily run to a million.
 *
 * Folders are counted against it too, since they are indexed alongside the
 * files: a cap on rows is what the renderer's cost actually follows.
 */
export const MAX_INDEXED_FILES = 20_000

/** How much of a file is sniffed for the NUL byte that means "not text". */
const SNIFF_BYTES = 8000

/**
 * Whether `target` is one of `roots` or sits under one of them.
 *
 * Lexical, on resolved paths: `..` is what this is written against — a renderer
 * bug or an injected path asking for `~/.ssh` by way of a folder it does have.
 * A symlink inside a folder pointing outside it still resolves, which is
 * deliberate: a repository's own symlinks are part of the repository, and the
 * user could follow them in the Terminal panel anyway.
 */
export function insideAny(roots: string[], target: string): boolean {
  const resolved = path.resolve(target)
  return roots.some((root) => {
    const base = path.resolve(root)
    return resolved === base || resolved.startsWith(base + path.sep)
  })
}

/**
 * A name that can be created inside a directory, or the reason it cannot.
 *
 * Rejecting a separator is what keeps "New file" from being a way to write
 * anywhere: the dialog asks for a name and the caller joins it to a directory
 * that has already been checked, so a `../` in the name would slip past a check
 * that has already happened.
 */
export function nameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "Give it a name."
  if (trimmed === "." || trimmed === "..") return `"${trimmed}" is not a name.`
  if (/[/\\]/.test(trimmed)) return "A name cannot contain a slash."
  if (trimmed.includes("\0")) return "A name cannot contain a null byte."
  return null
}

/** Directories first, then by name the way a person reads them: case-blind, and
 * `item2` before `item10`. */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  })
}

/**
 * One directory's entries, sorted.
 *
 * One level only — the tree opens a folder at a time, so a workspace pointed at
 * a repository with a `node_modules` in it costs nothing until somebody expands
 * it. Nothing is filtered out: a file explorer that hid dotfiles would be
 * hiding `.env.example` and `.github`, which are exactly what somebody opens
 * this panel to find.
 */
export async function listDirectory(dir: string): Promise<FileEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true })

  const entries = await Promise.all(
    dirents.map(async (dirent): Promise<FileEntry> => {
      const target = path.join(dir, dirent.name)

      // A symlink is shown as whatever it points at, so a linked package
      // directory expands like the directory it is. One that dangles is listed
      // as a file rather than dropped — it is on disk, and saying so is more
      // use than silence.
      let directory = dirent.isDirectory()
      if (dirent.isSymbolicLink()) {
        directory = await stat(target)
          .then((stats) => stats.isDirectory())
          .catch(() => false)
      }

      return {
        path: target,
        name: dirent.name,
        kind: directory ? "directory" : "file",
      }
    })
  )

  return entries.sort(compareEntries)
}

/**
 * A file as text, or why it is not being shown as text.
 *
 * Three answers rather than an error for two of them: "this is a PNG" and "this
 * is a 40 MB log" are things the pane can say plainly, and a rejected promise
 * would put them in the same place as "the disk is gone".
 */
export async function readTextFile(filePath: string): Promise<FileContent> {
  const stats = await stat(filePath)
  if (stats.isDirectory()) throw new Error("That is a folder, not a file.")
  if (stats.size > MAX_TEXT_FILE_BYTES) {
    return { kind: "too-large", size: stats.size }
  }

  const data = await readFile(filePath)
  if (data.subarray(0, SNIFF_BYTES).includes(0)) return { kind: "binary" }

  return { kind: "text", text: data.toString("utf8") }
}

/** Writes a file back. The Explorer only ever saves a file it opened, so the
 * directory is known to exist. */
export async function writeTextFile(
  filePath: string,
  text: string
): Promise<void> {
  await writeFile(filePath, text, "utf8")
}

/**
 * An empty file, at the path it now has.
 *
 * `wx` rather than a check first: two calls would leave a window in which the
 * file appeared between them, and the flag makes "it is already there" the
 * failure rather than silently emptying somebody's file.
 */
export async function createFile(dir: string, name: string): Promise<string> {
  const target = joinChecked(dir, name)
  await writeFile(target, "", { encoding: "utf8", flag: "wx" })
  return target
}

export async function createDirectory(
  dir: string,
  name: string
): Promise<string> {
  const target = joinChecked(dir, name)
  // No `recursive`: it succeeds on a directory that already exists, and the
  // caller has just asked for a new one.
  await mkdir(target)
  return target
}

/**
 * Renames a file or directory in place, and hands back its new path.
 *
 * Refuses to land on something that exists — `rename` would otherwise replace a
 * file, and there is no undo for that here.
 */
export async function renamePath(
  target: string,
  name: string
): Promise<string> {
  const next = joinChecked(path.dirname(target), name)
  if (next === target) return target

  const taken = await stat(next).then(
    () => true,
    () => false
  )
  if (taken) throw new Error(`There is already a "${name}" here.`)

  await rename(target, next)
  return next
}

/**
 * Copies files and folders into `dir`, and hands back where each one landed.
 *
 * What a drop from Finder onto the tree does. The sources are the one set of
 * paths a `files:*` call takes from **outside** the workspace — that is the
 * point of the gesture — so only `dir` is gated, by the caller; the sources are
 * what `webUtils.getPathForFile` said the OS dragged in.
 *
 * Never over something: a name that is taken gets ` 2`, ` 3` before the
 * extension, the way Finder numbers a duplicate, because a drop has no dialog
 * to ask in and a silent overwrite has no undo. `errorOnExist` is what still
 * holds if the name is taken between the check and the copy.
 */
export async function copyInto(
  dir: string,
  sources: string[]
): Promise<string[]> {
  const copied: string[] = []
  for (const source of sources) {
    const from = path.resolve(source)
    // `cp` would recurse into its own output until the disk filled.
    if (insideAny([from], dir)) {
      throw new Error(`Cannot copy "${path.basename(from)}" into itself.`)
    }
    const directory = (await stat(from)).isDirectory()
    const target = await freeName(dir, path.basename(from), directory)
    await cp(from, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      // A relative link inside a copied folder stays relative, rather than
      // being rewritten to point back at the original.
      verbatimSymlinks: true,
    })
    copied.push(target)
  }
  return copied
}

/**
 * Moves `source` into `dir` — the tree's Cut and Paste — and hands back where it
 * landed. Numbered like `copyInto` rather than over something, for the same
 * reason. Two workspace folders can be on two volumes, where `rename` fails with
 * `EXDEV`; that is a copy and then a delete, and the delete only runs once the
 * copy is whole.
 */
export async function moveInto(source: string, dir: string): Promise<string> {
  const from = path.resolve(source)
  if (insideAny([from], dir)) {
    throw new Error(`Cannot move "${path.basename(from)}" into itself.`)
  }
  // Pasted back where it was cut from: already there, and a ` 2` would be a
  // rename nobody asked for.
  if (path.dirname(from) === path.resolve(dir)) return from
  const directory = (await stat(from)).isDirectory()
  const target = await freeName(dir, path.basename(from), directory)
  try {
    await rename(from, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    await cp(from, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
    await rm(from, { recursive: true })
  }
  return target
}

/** `name`, or the first of `name 2`, `name 3`… not already in `dir`. A folder's
 * dot is part of its name; a file's is its extension. */
async function freeName(
  dir: string,
  name: string,
  directory: boolean
): Promise<string> {
  const ext = directory ? "" : path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} ${n}${ext}`)
    const taken = await stat(candidate).then(
      () => true,
      () => false
    )
    if (!taken) return candidate
  }
}

/**
 * Every file and folder under `root`, for the search palette and a chat's `@`.
 *
 * The one thing in this module that walks rather than reads a level: the
 * palette answers "which file is called something like this" across the whole
 * workspace, and there is no way to answer that from the directories the tree
 * happens to have open. Built on demand and held by the renderer for the run —
 * see `loadIndex` — rather than maintained: the panel's watchers follow the
 * directories somebody expanded (`watch.ts`), and keeping this in step would
 * mean watching everything under the workspace instead, which is the cost the
 * tree was written to avoid. Refresh rebuilds it.
 *
 * Breadth-first over an explicit queue rather than recursion: the depth of a
 * repository is not this function's to trust, and a queue also makes the
 * budget a single check.
 *
 * Symlinked directories are not descended into. A link back up its own tree is
 * an infinite walk, and the files it points at are already indexed under their
 * real path — the tree still expands them, where the user asked for that one
 * directory rather than for everything under it.
 *
 * A file's size comes from a `stat`, one directory's worth at a time: the `@`
 * menu shows what mentioning a path would cost a turn, and a size is the only
 * thing cheap enough to have for every path in the workspace. A stat that fails
 * is a 0 rather than a missing row — the path is still mentionable.
 */
export async function indexFiles(
  root: string,
  folderId: string,
  limit = MAX_INDEXED_FILES
): Promise<FileIndexEntry[]> {
  const found: FileIndexEntry[] = []
  const queue: string[] = [root]
  // Once per walk, up front: an ignored directory is then never read at all,
  // which for a repository's build output is most of what the walk would cost.
  const ignored = await ignoredPaths(root)

  while (queue.length > 0 && found.length < limit) {
    const dir = queue.shift()!

    // A directory that cannot be read is skipped rather than fatal: one
    // unreadable folder must not cost the palette every other file in the
    // workspace.
    const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [])

    // Always with forward slashes, even where the path has backslashes: this is
    // the string the user reads and types at, and nobody searching a repository
    // types `src\lib`.
    const relative = (target: string) =>
      path.relative(root, target).split(path.sep).join("/")

    /** The rows this level pushed for files, so the sizes below land on them
     * without a search back through everything already found. */
    const pending: FileIndexEntry[] = []
    for (const dirent of dirents) {
      if (found.length >= limit) break

      const target = path.join(dir, dirent.name)
      if (ignored.has(relative(target))) continue
      if (dirent.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(dirent.name)) continue
        queue.push(target)
        found.push({
          path: target,
          folderId,
          relative: relative(target),
          kind: "directory",
          bytes: 0,
        })
        continue
      }
      if (dirent.isSymbolicLink()) continue

      // Counted against the budget as it is found rather than after the stats,
      // so the cap still holds for a directory of a hundred thousand files.
      const entry: FileIndexEntry = {
        path: target,
        folderId,
        relative: relative(target),
        kind: "file",
        bytes: 0,
      }
      found.push(entry)
      pending.push(entry)
    }

    // One directory's stats at once: sequentially this is a syscall per file
    // with nothing overlapped, which on a twenty-thousand-file repository is
    // the difference between the palette opening and the palette waiting.
    const sizes = await Promise.all(
      pending.map((entry) =>
        stat(entry.path)
          .then((info) => info.size)
          .catch(() => 0)
      )
    )
    for (const [at, entry] of pending.entries()) entry.bytes = sizes[at] ?? 0
  }

  return found
}

/** A validated name joined to a directory — the one way a path is built from
 * something the user typed. */
function joinChecked(dir: string, name: string): string {
  const failure = nameError(name)
  if (failure) throw new Error(failure)
  return path.join(dir, name.trim())
}
