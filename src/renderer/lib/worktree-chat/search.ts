import type { AssistantMessage } from "@shared/api"

/**
 * Finding a run of text in the conversation on screen — what `⌘F` searches.
 *
 * **The chat that is open, and only that one.** A chat's title is its first
 * sentence, so the palette's `Chats` group finds a conversation by how it opened
 * and by nothing else; this is the other question, and it is asked with the
 * conversation already in front of you — where did it say that, where was the
 * sentence I wrote about the migration. Which is `⌘F` in every editor there has
 * ever been, and so it is a bar over the transcript rather than a dialog over
 * the window (`chat-find.tsx`).
 *
 * There is no channel behind it. The lines of the chat on screen are already in
 * the renderer's own store — `select` read them once — so this is a pass over an
 * array: nothing is read from disk, nothing is cached, and nothing has to be
 * kept in step. A search of *every* chat is the left column's, in main
 * (`main/content-search.ts`); `hitAt` below is where it lands in this bar.
 */

/**
 * One occurrence — not one message.
 *
 * **This is the whole unit of the feature**, and it was messages for a version:
 * `hitsIn` answered with the lines that carried the query, so a word said twice
 * in one message and once in the next counted as `2` while three words sat
 * highlighted on screen. A count that disagrees with what it has just painted is
 * a count nobody can use. So a match is an occurrence, `n of m` counts them all,
 * and the arrows walk them one at a time.
 *
 * `nth` is which occurrence *within that message*, counted over its own text,
 * which is what lets the painter find the same one in the rendered DOM — see
 * `find-marks.ts`.
 */
export type ChatHit = { messageId: string; nth: number }

/**
 * Every occurrence of `query` in what was said, oldest first.
 *
 * **A literal, case-insensitive substring**, which is what `⌘F` means everywhere
 * else — type `hi` and every `hi` lights up. An earlier version split the query
 * on spaces and asked for every word *somewhere* in the line, which is right for
 * a palette full of half-remembered names and wrong here twice: it cannot say
 * where a match *is*, so it cannot count or step, and a bar that highlights
 * `migration` for a query of `schema migration` is a bar disagreeing with itself.
 *
 * The query is taken **as typed**, spaces and all: a trailing space is part of
 * what somebody is looking for, and trimming it would be this deciding otherwise.
 *
 * **What was said, and nothing else** — the two voices, and not a tool's summary,
 * which is a path or a command the conversation is *about*, nor a thinking line,
 * which is the model talking to itself. The palette already finds files, so a
 * path typed here should not turn up the forty tool calls that read it.
 *
 * Read off the message's own text rather than off the rendered DOM, which is the
 * only way a match inside a collapsed fold can be counted at all — the fold has
 * no text on screen for the painter to find.
 */
/**
 * The left column's Search landing in this bar: which query and which `at`
 * stand for the match that starts at `offset` in one message's text.
 *
 * The column's match may have been a pattern or case-sensitive, and this bar
 * knows neither, so the query handed over is the **text that matched** — which
 * this bar's literal, case-ignoring rule finds again — and `at` is that
 * occurrence among all of them, counted the way `hitsIn` counts. Null for a
 * message this chat no longer has.
 */
export function hitAt(
  messages: AssistantMessage[],
  messageId: string,
  offset: number,
  length: number
): { query: string; at: number } | null {
  const message = messages.find((entry) => entry.id === messageId)
  if (!message || (message.role !== "user" && message.role !== "assistant"))
    return null

  const query = message.text.slice(offset, offset + length)
  if (!query) return null

  const wanted = query.toLowerCase()
  const haystack = message.text.toLowerCase()
  let nth = 0
  let at = haystack.indexOf(wanted)
  while (at !== -1 && at < offset) {
    nth += 1
    at = haystack.indexOf(wanted, at + wanted.length)
  }

  const index = hitsIn(messages, query).findIndex(
    (hit) => hit.messageId === messageId && hit.nth === nth
  )
  return { query, at: Math.max(index, 0) }
}

export function hitsIn(messages: AssistantMessage[], query: string): ChatHit[] {
  if (!query) return []
  const wanted = query.toLowerCase()

  const hits: ChatHit[] = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue

    const haystack = message.text.toLowerCase()
    let at = haystack.indexOf(wanted)
    let nth = 0
    while (at !== -1) {
      hits.push({ messageId: message.id, nth })
      nth += 1
      // Past the end of this one rather than one character on, so `aa` in
      // `aaaa` is two matches and not three overlapping ones — the same
      // counting the painter does, or the two would disagree.
      at = haystack.indexOf(wanted, at + wanted.length)
    }
  }

  return hits
}
