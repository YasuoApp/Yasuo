import type { AssistantMessage } from "@shared/api"

import { WRITES } from "./edit"

/**
 * What a chat has shared, Telegram's way: its pictures, the files it wrote and
 * the links said in it, each as a list beside the transcript rather than
 * somewhere in the middle of an afternoon's scrolling.
 *
 * **Newest first**, because what somebody reaches for is the screenshot from a
 * few minutes ago, not the first one of the day — and a grid that grew at the
 * bottom would put the newest picture where the column has to be scrolled to.
 *
 * Every item carries `lineId`, the **main loop's** line to land on: a subagent's
 * own lines are drawn inside its `Agent` row rather than as blocks of their own,
 * so a picture a subagent's tool came back with lands on the row that ran it.
 */
export type ChatMedia = {
  /** Note files — a sent message's pictures and a tool's. */
  images: { file: string; lineId: string; at?: string }[]
  /** Files the chat wrote, each once, at the last line that wrote it. */
  files: { path: string; lineId: string; at?: string }[]
  /** Web links said in it by either side, each once. */
  links: { url: string; lineId: string; at?: string }[]
}

export type MediaKind = keyof ChatMedia

/** A web link as it appears in prose or markdown. Stops at whitespace and at
 * the characters that close what it was written inside — `)` of a markdown
 * link, `>` of an autolink, a quote — and trailing punctuation is trimmed
 * after, since a sentence's full stop is not part of the URL. */
const LINK = /https?:\/\/[^\s<>"'`)\]]+/g
const TRAILING = /[.,;:!?*_~]+$/

export function linksIn(text: string): string[] {
  return [...text.matchAll(LINK)].map((match) => match[0].replace(TRAILING, ""))
}

export function mediaOf(lines: readonly AssistantMessage[]): ChatMedia {
  const callLine = new Map<string, string>()
  for (const line of lines) {
    if (line.role === "tool" && line.toolId && !line.parent) {
      callLine.set(line.toolId, line.id)
    }
  }
  const landing = (line: AssistantMessage): string =>
    (line.parent && callLine.get(line.parent)) || line.id

  const images: ChatMedia["images"] = []
  const files = new Map<string, ChatMedia["files"][number]>()
  const links = new Map<string, ChatMedia["links"][number]>()

  for (const line of lines) {
    const lineId = landing(line)
    if ((line.role === "user" || line.role === "tool") && line.images) {
      for (const file of line.images) images.push({ file, lineId, at: line.at })
    }
    if (
      line.role === "tool" &&
      line.path &&
      !line.failed &&
      (WRITES.has(line.name) || line.stat !== undefined)
    ) {
      // Deleted and set again so the map's order is the *last* write's.
      files.delete(line.path)
      files.set(line.path, { path: line.path, lineId, at: line.at })
    }
    if (line.role === "user" || line.role === "assistant") {
      for (const url of linksIn(line.text)) {
        links.delete(url)
        links.set(url, { url, lineId, at: line.at })
      }
    }
  }

  return {
    images: images.reverse(),
    files: [...files.values()].reverse(),
    links: [...links.values()].reverse(),
  }
}
