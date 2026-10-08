import type { GitBlame, GitBlameCommit } from "@shared/api"

/**
 * The words the editor's blame annotation and its hover are drawn from — the
 * pure half of `lib/editor-git-blame.ts` (`test/git-blame.ts`).
 */

/** The commit that last changed line `line` (1-based), null for one nobody has
 * committed, undefined for a line the answer does not reach. */
export function commitAt(
  blame: GitBlame,
  line: number
): GitBlameCommit | null | undefined {
  const hash = blame.lines[line - 1]
  if (hash === undefined) return undefined
  if (hash === null) return null
  return blame.commits[hash]
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
]

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

/**
 * `2 months ago` — the long form, unlike the sidebar's `since`: the annotation
 * has the width of the rest of the line to spend, and it is read as a sentence.
 */
export function ago(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ""
  const ms = Math.max(0, now - at)
  for (const [unit, size] of UNITS) {
    if (ms >= size) return relative.format(-Math.floor(ms / size), unit)
  }
  return "just now"
}

/** What sits at the end of the caret's line: `Ada, 2 months ago • fix: …`. */
export function annotationOf(
  commit: GitBlameCommit | null,
  now: number = Date.now()
): string {
  if (!commit) return "You • Not committed yet"
  return `${commit.author}, ${ago(commit.date, now)} • ${commit.summary}`
}

/** A run of a commit message: plain text, or a `#27` the forge can open. */
export type MessagePart = { text: string } | { text: string; href: string }

/**
 * The summary with its `#27`s made links, when there is a forge to link them
 * to. `/issues/` rather than `/pull/`: GitHub redirects an issue number that is
 * a pull request, and not the other way round.
 */
export function messageParts(
  summary: string,
  webUrl: string | null
): MessagePart[] {
  if (!webUrl) return [{ text: summary }]
  const parts: MessagePart[] = []
  let last = 0
  for (const match of summary.matchAll(/(^|[\s(])#(\d+)\b/g)) {
    const start = match.index + match[1]!.length
    if (start > last) parts.push({ text: summary.slice(last, start) })
    parts.push({
      text: `#${match[2]}`,
      href: `${webUrl}/issues/${match[2]}`,
    })
    last = start + match[2]!.length + 1
  }
  if (last < summary.length) parts.push({ text: summary.slice(last) })
  return parts
}

export function commitUrl(webUrl: string, hash: string): string {
  return `${webUrl}/commit/${hash}`
}

/**
 * The file as that commit left it, scrolled to the line — the one address the
 * three forges spell differently.
 */
export function fileUrl(
  webUrl: string,
  hash: string,
  path: string,
  line: number
): string {
  const file = path.split("/").map(encodeURIComponent).join("/")
  const host = new URL(webUrl).hostname
  if (host === "gitlab.com") return `${webUrl}/-/blob/${hash}/${file}#L${line}`
  if (host === "bitbucket.org")
    return `${webUrl}/src/${hash}/${file}#lines-${line}`
  return `${webUrl}/blob/${hash}/${file}#L${line}`
}

/** The `#27`s a summary names, in order and once each — the card's
 * `Open #27` buttons. */
export function issueNumbers(summary: string): number[] {
  const seen = new Set<number>()
  for (const match of summary.matchAll(/(?:^|[\s(])#(\d+)\b/g))
    seen.add(Number(match[1]))
  return [...seen]
}

/** What `Ask in chat` types into the composer: the commit and the line, for a
 * question the user still writes. */
export function askAboutCommit(
  commit: GitBlameCommit,
  path: string,
  line: number
): string {
  return `About commit ${commit.hash.slice(0, 7)} ("${commit.summary}") by ${commit.author}, which last changed @${path}#L${line}: `
}
