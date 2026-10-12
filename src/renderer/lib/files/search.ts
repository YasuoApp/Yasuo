import type { FileIndexEntry } from "@shared/api"

import { nameOf } from "./paths"

/**
 * Cutting the workspace's files down to the handful the palette will show.
 *
 * The palette scores its rows with cmdk, which is written for a menu of a few
 * dozen commands rather than for twenty thousand paths — running it over the
 * whole index on every keystroke is the one thing here that would be felt. So
 * this comes first: a cheap subsequence pass that throws out almost everything,
 * a rank over what is left, and a short list handed on to be scored properly
 * against the tables, requests and notes it has to sit beside.
 *
 * Two scorers, with different jobs: this one decides which rows are even
 * candidates, cmdk decides how they rank against the other panels' rows.
 */

/** How many files the palette will show for one query. */
export const SHORTLIST_SIZE = 40

/**
 * Whether every character of `query` appears in `text`, in order.
 *
 * The same shape of match a file palette has always had — `slfs` finds
 * `src/lib/files/store.ts` — and deliberately looser than what ranks it: this
 * only has to be cheap and never to miss.
 */
export function matchesLoosely(text: string, query: string): boolean {
  if (query === "") return true

  let at = 0
  for (const character of query) {
    at = text.indexOf(character, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

/**
 * How well a path answers a query, higher being better.
 *
 * Three things decide it, in the order somebody actually thinks about them: a
 * query that matches the file's own name beats one that only matches the
 * directories above it, a run of characters together beats the same characters
 * scattered, and a shorter path beats a longer one. The last is what keeps
 * `src/store.ts` above `src/renderer/lib/db/explorer-store.ts` for "store".
 */
export function rank(entry: FileIndexEntry, query: string): number {
  const relative = entry.relative.toLowerCase()
  const name = nameOf(relative)

  let score = 0
  if (name.startsWith(query)) score += 200
  else if (name.includes(query)) score += 120
  else if (relative.includes(query)) score += 60
  else if (matchesLoosely(name, query)) score += 30

  // Shorter is better, but never enough to outrank the kinds of match above:
  // the whole term is worth less than the gap between two of them.
  return score + Math.max(0, 40 - relative.length / 4)
}

/**
 * The files worth showing for `query`, best first.
 *
 * Empty for an empty query, which is not the same as "everything": a palette
 * that listed twenty thousand paths the moment it opened would bury the tables,
 * requests and notes that are the other reason it exists.
 *
 * Files only. The index holds the workspace's folders as well — a chat's `@`
 * menu offers them — and a palette row opens a tab, which a folder is not.
 */
export function shortlist(
  entries: FileIndexEntry[],
  query: string,
  limit = SHORTLIST_SIZE
): FileIndexEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === "") return []

  // Slashes are how a path is typed but not necessarily how it is stored on
  // the way to matching: dropping them lets "libfiles" find `lib/files`.
  const loose = needle.replace(/[/\\ ]/g, "")

  const matched: { entry: FileIndexEntry; score: number }[] = []
  for (const entry of entries) {
    if (entry.kind === "directory") continue
    const relative = entry.relative.toLowerCase()
    if (!matchesLoosely(relative.replace(/\//g, ""), loose)) continue
    matched.push({ entry, score: rank(entry, needle) })
  }

  return matched
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((match) => match.entry)
}
