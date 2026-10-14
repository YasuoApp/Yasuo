/**
 * How many chats are working, how many have stopped to ask, and how that reads.
 *
 * Drawn by the sidebar's project row and the rail
 * (`lib/chat/running.ts`, which re-exports all of this). It is under
 * `shared/` because the menu bar's tray used to draw it from main too; that is
 * deleted — `docs/design.md` § The menu bar, removed.
 */

/**
 * **Waiting wins over working**, which is the rule.
 *
 * Both are true while a question is up — the turn has not ended, so the chat is
 * still `busy` — and only one of them is something for the user to do. A chat
 * counted in both columns would make a project of three chats read as five
 * things happening, and worse, it would draw a "1 waiting" beside a "1 working"
 * that are the same conversation.
 */
export type ChatActivity = {
  /** Answering, and nothing is wanted from anybody. */
  working: number
  /** Stopped on a question. Nothing moves in these until they are answered, and
   * nothing times them out — see `Chats.ask` in main. */
  waiting: number
}

/** Whether there is anything to draw at all. A row that says `0 running` is a
 * row saying nothing, and this list is mostly idle. */
export function isRunning(activity: ChatActivity): boolean {
  return activity.working > 0 || activity.waiting > 0
}

/**
 * The count as a row draws it: `2` working, `1!` waiting, `2 · 1!` for both.
 *
 * Deliberately not words. This sits at the right-hand end of a sidebar row
 * whose left-hand end is a project name that has to keep its width — "2 chats
 * running, 1 waiting" is a sentence, and a sentence here is a truncated project
 * name. The `!` is what separates the two without a second colour to read, so
 * the label survives being drawn in the muted hue everything else on the row
 * uses.
 *
 * The menu bar wants exactly the same compression for the same reason: that
 * strip is shared with every other app on the machine, and a title there is
 * charged by the pixel.
 */
export function activityLabel(activity: ChatActivity): string {
  const parts: string[] = []
  if (activity.working > 0) parts.push(String(activity.working))
  if (activity.waiting > 0) parts.push(`${activity.waiting}!`)
  return parts.join(" · ")
}

/** The same thing said out loud, for the row's `title` and a screen reader —
 * where the width the label was compressed for does not apply. */
export function activityTitle(activity: ChatActivity): string {
  const parts: string[] = []
  if (activity.working > 0) parts.push(`${activity.working} answering`)
  if (activity.waiting > 0)
    parts.push(`${activity.waiting} waiting for your answer`)
  return parts.join(", ")
}
