import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import type {
  AssistantMessage,
  ChatSearchMatch,
  FileSearchResult,
  SearchOptions,
  SearchPreview,
} from "../shared/api"
import { IGNORED_DIRECTORIES, indexFiles, MAX_INDEXED_FILES } from "./files"

const run = promisify(execFile)

/**
 * The left column's Search: a query run over what is *inside* the workspace's
 * files and its chats, the way an editor's `Find in files` is.
 *
 * Free of `electron`, like `files.ts` beside it, so `test/content-search.ts`
 * can import it. `ipc.ts` holds the generation that makes an older search stop,
 * and `WorktreeChats.search` the transcripts.
 *
 * **A walk and a read per search, nothing indexed.** The walk is the palette's
 * own (`indexFiles`, with its ignored directories and its cap), and the files
 * are read where they are. An index of contents would be a second copy of every
 * repository in the workspace kept in step by watching all of it — the cost
 * `files.ts` was written to avoid for names alone.
 */

/**
 * How many matches a search collects before it stops, across files and chats
 * together. A ceiling on what is read, not only on what is drawn: a query of
 * `e` would otherwise read every file to build rows nobody scrolls to.
 */
export const MAX_SEARCH_MATCHES = 2_000

/**
 * Past this a file is not searched. The editor's own limit for opening one as
 * text is `MAX_TEXT_FILE_BYTES`; this is lower because it is paid for every
 * file on every search rather than once for the one somebody clicked.
 */
const MAX_SEARCHED_BYTES = 1024 * 1024

/** Files read at once. Enough to overlap the disk; few enough that a search
 * typed past stops within a batch. */
const READ_BATCH = 32

/** What a preview keeps ahead of the match, and how long it runs. */
const PREVIEW_LEAD = 30
const PREVIEW_WIDTH = 200

export type Matcher = { matcher: RegExp } | { error: string }

/**
 * The query and its toggles as one expression, or why it is not one.
 *
 * A literal is escaped into the same `RegExp` a pattern is, so there is one
 * matching loop rather than an `indexOf` beside a `exec` that disagree about
 * where a line ends. `m`, so `^` and `$` are a line's ends the way they are in
 * every editor's search.
 */
export function matcherOf(
  query: string,
  options: SearchOptions
): Matcher | null {
  if (!query) return null

  let source = options.regex
    ? query
    : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (options.wholeWord) source = `\\b(?:${source})\\b`

  try {
    return { matcher: new RegExp(source, options.matchCase ? "gm" : "gim") }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export type TextMatch = {
  line: number
  column: number
  /** Into `text` as a whole, for a chat's find bar to land on. */
  offset: number
  length: number
  preview: SearchPreview
}

/**
 * Every match of `matcher` in `text`, up to `limit`, with the line each is on.
 *
 * An empty match — `^`, `a*` — is stepped past rather than kept: it is a row
 * with nothing to highlight, and without the step `exec` finds it forever.
 */
export function matchesIn(
  text: string,
  matcher: RegExp,
  limit: number
): TextMatch[] {
  // A copy, so two searches sharing one expression cannot move each other's
  // `lastIndex`.
  const pattern = new RegExp(matcher.source, matcher.flags)
  const found: TextMatch[] = []
  let line = 1
  let lineStart = 0

  while (found.length < limit) {
    const match = pattern.exec(text)
    if (!match) break
    if (match[0].length === 0) {
      pattern.lastIndex += 1
      continue
    }

    // Forward from the last match rather than counting from the top, so a file
    // with a match on every line is one pass and not a square.
    for (;;) {
      const newline = text.indexOf("\n", lineStart)
      if (newline === -1 || newline >= match.index) break
      lineStart = newline + 1
      line += 1
    }
    let lineEnd = text.indexOf("\n", lineStart)
    if (lineEnd === -1) lineEnd = text.length
    const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, "")

    const from = match.index - lineStart
    found.push({
      line,
      column: from + 1,
      offset: match.index,
      length: match[0].length,
      // A pattern that spans lines is highlighted to the end of its first.
      preview: previewOf(
        lineText,
        from,
        Math.min(from + match[0].length, lineText.length)
      ),
    })
  }

  return found
}

/**
 * A line cut down around its match: leading indentation dropped, as the editors
 * do, and a long line started a little ahead of the match so the match is on
 * screen rather than two hundred characters off its right edge.
 */
export function previewOf(
  line: string,
  from: number,
  to: number
): SearchPreview {
  const indent = line.length - line.trimStart().length
  let start = Math.min(indent, from)
  if (from - start > PREVIEW_LEAD) start = from - PREVIEW_LEAD
  const end = Math.min(line.length, start + Math.max(PREVIEW_WIDTH, to - start))

  const prefix = start > indent ? "…" : ""
  return {
    text: prefix + line.slice(start, end),
    from: prefix.length + from - start,
    to: prefix.length + Math.min(to, end) - start,
  }
}

/**
 * Whether a file is text. The test git and the editors use: a NUL in its first
 * eight thousand bytes says it is not.
 */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}

/**
 * Every file under `roots` with a match in it, in the walk's order.
 *
 * `stale` is asked between batches: a search somebody has typed past stops
 * where it is rather than reading the rest of the workspace for an answer the
 * renderer has already decided to drop.
 */
export async function searchFiles(
  roots: { path: string; folderId: string }[],
  matcher: RegExp,
  { limit, stale }: { limit: number; stale: () => boolean }
): Promise<{ files: FileSearchResult[]; matches: number; truncated: boolean }> {
  const files: FileSearchResult[] = []
  let matches = 0
  // The chats already spent the budget: walking for nothing would still read
  // every file.
  if (limit <= 0) return { files, matches, truncated: true }

  for (const root of roots) {
    const entries = await searchedFiles(root.path, root.folderId)

    for (let at = 0; at < entries.length; at += READ_BATCH) {
      if (stale()) return { files, matches, truncated: false }

      const batch = entries.slice(at, at + READ_BATCH)
      const read = await Promise.all(batch.map((entry) => readSearched(entry)))

      for (const [index, entry] of batch.entries()) {
        const buffer = read[index]
        if (!buffer || isBinary(buffer)) continue
        const found = matchesIn(
          buffer.toString("utf8"),
          matcher,
          limit - matches
        )
        if (found.length === 0) continue

        files.push({
          path: entry.path,
          folderId: entry.folderId,
          relative: entry.relative,
          matches: found.map(({ line, column, length, preview }) => ({
            line,
            column,
            length,
            preview,
          })),
        })
        matches += found.length
        if (matches >= limit) return { files, matches, truncated: true }
      }
    }
  }

  return { files, matches, truncated: false }
}

type Searched = { path: string; folderId: string; relative: string }

/**
 * The files of one folder a search reads.
 *
 * **What git does not ignore, where the folder is a repository** — tracked
 * files and untracked ones `.gitignore` lets through, asked of git itself
 * (`ls-files --exclude-standard`) rather than parsed here. A fixed list of
 * build directories is always one short — `.output`, `out`, `.svelte-kit`, a
 * generated `src/gen` — and a search full of minified bundles is the first
 * thing an editor's own `Find in files` is set up not to do. The palette keeps
 * the fixed list (`files.ts` says why); a result in an ignored file is noise
 * in a way a file *name* in the palette is not.
 *
 * `IGNORED_DIRECTORIES` still applies on top, for a `vendor` or `dist`
 * somebody committed. A folder that is not a repository, or a machine with no
 * `git`, falls back to the palette's walk.
 */
export async function searchedFiles(
  root: string,
  folderId: string
): Promise<Searched[]> {
  const listed = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  ).catch(() => null)

  if (!listed) {
    return (await indexFiles(root, folderId))
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({
        path: entry.path,
        folderId,
        relative: entry.relative,
      }))
  }

  const files: Searched[] = []
  // A file in a merge conflict is listed once per stage. A tracked file
  // deleted from disk is listed too, and is simply unreadable — `readSearched`
  // skips it.
  const seen = new Set<string>()
  for (const relative of listed.stdout.split("\0")) {
    if (files.length >= MAX_INDEXED_FILES) break
    if (!relative || seen.has(relative)) continue
    seen.add(relative)
    if (relative.split("/").some((part) => IGNORED_DIRECTORIES.has(part)))
      continue
    files.push({ path: path.join(root, relative), folderId, relative })
  }
  return files
}

/** A file's bytes, or null for one too large, gone, or a directory (a
 * submodule is listed as a path). */
async function readSearched(entry: Searched): Promise<Buffer | null> {
  const info = await stat(entry.path).catch(() => null)
  if (!info?.isFile() || info.size > MAX_SEARCHED_BYTES) return null
  return readFile(entry.path).catch(() => null)
}

/**
 * The matches in what a chat said — the two voices, as `⌘F` searches, and not a
 * tool's summary or a thinking line: a path typed here is already answered by
 * the files above it, and should not also turn up every tool call that read it.
 */
export function chatMatchesIn(
  messages: AssistantMessage[],
  matcher: RegExp,
  limit: number
): ChatSearchMatch[] {
  const found: ChatSearchMatch[] = []
  for (const message of messages) {
    if (found.length >= limit) break
    if (message.role !== "user" && message.role !== "assistant") continue

    for (const match of matchesIn(
      message.text,
      matcher,
      limit - found.length
    )) {
      found.push({
        messageId: message.id,
        offset: match.offset,
        length: match.length,
        preview: match.preview,
      })
    }
  }
  return found
}
