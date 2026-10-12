/**
 * Absolute paths, as the renderer has to handle them.
 *
 * `lib/runtime/tree.ts` splits on `/` and is right to: the paths it is about are
 * the ones this app made up. These are the operating system's, handed over by
 * the main process exactly as `node:path` produced them — which on Windows
 * means `C:\project\src\main.ts`, backslashes and all. A renderer that assumed
 * one separator would put the whole tree under a single row named
 * `C:\project\src\main.ts` there, and quietly: nothing would throw.
 *
 * So everything here accepts both separators, and nothing here builds a path —
 * joining a directory to a name happens in the main process, which knows which
 * separator this machine uses. See `main/files.ts`.
 */

/** Where the last separator falls, whichever separator it is. */
function lastSeparator(target: string): number {
  return Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"))
}

/** The last segment: `src/main.ts` → `main.ts`. */
export function nameOf(target: string): string {
  const index = lastSeparator(target)
  return index === -1 ? target : target.slice(index + 1)
}

/**
 * How much of a file's name is the name rather than its extension:
 * `report.txt` → 8.
 *
 * A length rather than the stem itself, because the one caller is a text
 * selection — the rename field opens with `report` selected and `.txt` left
 * alone, since retyping the extension is not what renaming a file usually
 * means.
 *
 * `dot > 0`, the same rule the extension lookups elsewhere in `lib/files` use:
 * the leading dot of `.gitignore` is part of the name, so a dotfile has no
 * extension and the whole of it is selected. The *last* dot, so `archive.tar.gz`
 * offers `archive.tar` — the alternative is deciding which compound suffixes are
 * really one, and there is no end to that list.
 */
export function stemEnd(name: string): number {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? dot : name.length
}

/**
 * The directory holding it: `/a/b/c.ts` → `/a/b`.
 *
 * A path with no separator left in it is its own parent rather than `""` —
 * the callers are asking "where would a sibling of this go", and an empty
 * answer sends a new file to the process's working directory.
 */
export function parentOf(target: string): string {
  const index = lastSeparator(target)
  if (index === -1) return target
  // A path directly under the root keeps the root's own separator, so
  // `/a.txt` gives `/` rather than `""`.
  return index === 0 ? target.slice(0, 1) : target.slice(0, index)
}

/**
 * Whether `target` is `root` itself or sits under it.
 *
 * The renderer's own copy of the question `insideAny` answers in the main
 * process, and deliberately not a substitute for it: this one decides which
 * tabs a removed folder takes with it, that one decides what the app is allowed
 * to read. A check in the renderer is a convenience; the one that matters is
 * the one on the other side of the IPC boundary.
 */
export function isInside(root: string, target: string): boolean {
  if (target === root) return true
  const last = root.slice(-1)
  const prefix = last === "/" || last === "\\" ? root : root + separatorOf(root)
  return target.startsWith(prefix)
}

/**
 * `target` as it reads from inside `root`: `/a/b/c.ts` under `/a` → `b/c.ts`.
 *
 * Handed back whole when it is not under `root` at all, which is the honest
 * answer rather than a `../..` chain: a path from another checkout has to say
 * so, in a message being typed and in a row of a list alike.
 *
 * The root itself is `""`, which is the same rule taken to its end — there is
 * nothing left of the path once the root is off it. That is what a caller wants:
 * the Changes list writes this under a row's name and draws no line for a file
 * that sits in the checkout's own directory, where the name has already said
 * everything. Handing the absolute path back for that case put the whole of
 * `~/.vsclaude/workspace/worktrees/<id>/<branch>` under a file called
 * `test.txt`.
 */
export function relativeTo(root: string, target: string): string {
  // An empty root is not a root everything is under: `isInside` reads it as one
  // — its prefix comes out as `/`, which every absolute path starts with — and
  // that would hand back a path with its leading separator shaved off.
  if (!root) return target

  // A separator on the end of the root is not part of it. Normalised first so
  // that the three questions below — is it the root, is it under the root, how
  // much of it is the root — cannot answer as if it were written two ways.
  const last = root.slice(-1)
  const base = last === "/" || last === "\\" ? root.slice(0, -1) : root

  if (target === base) return ""
  if (!isInside(base, target)) return target
  return target.slice(base.length + 1)
}

/** The separator a path is already written with, defaulting to `/` for one
 * that has none. */
function separatorOf(target: string): string {
  return target.includes("\\") && !target.includes("/") ? "\\" : "/"
}

/**
 * `target` with the part of it that was `from` replaced by `to` — what a rename
 * does to every path filed under the thing renamed.
 *
 * Paths are identities in this panel, so renaming a directory is not an edit to
 * one record: it is a new name for the open tab, the expanded row and the
 * cached listing of everything inside it.
 */
export function movedPath(target: string, from: string, to: string): string {
  return isInside(from, target) ? to + target.slice(from.length) : target
}

/**
 * A path as a message should carry it: in double quotes where it holds a space,
 * bare otherwise.
 *
 * Not shell quoting — a chat message is a sentence, not a command line — but the
 * same problem. `Screenshot 2026-08-27 at 9.14.12 PM.png` is what macOS names
 * every screenshot, and dropped into a draft bare it reads as six words, one of
 * which happens to end in `.png`; two files dropped together make it worse,
 * since nothing says where the first path ends. A path that is already quoted is
 * left alone, or a second drop of the same file would double them.
 */
export function quotePath(target: string): string {
  if (!/\s/.test(target)) return target
  return target.startsWith('"') && target.endsWith('"') ? target : `"${target}"`
}
