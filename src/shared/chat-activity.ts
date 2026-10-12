/**
 * How many chats are working, how many have stopped to ask, and how that reads.
 *
 * Shared for the reason `@shared/tree` is: two surfaces draw this count and
 * they must not disagree. The sidebar's project row draws it inside the window
 * (`lib/worktree-chat/running.ts`, which re-exports all of this) and the menu
 * bar's tray draws it outside (`main/tray.ts`) — a `2 · 1!` on a row and a
 * `2 · 1` in the menu bar would be two readings of the same four conversations,
 * and the one somebody checks the other against.
 *
 * Counting *which* chats are which stays on each side, because the two sides
 * hold different things: the renderer has the listing and its store, main has
 * a watcher over the event stream. What is shared is the shape they both
 * produce and the words both draw.
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
   * nothing times them out — see `WorktreeChats.ask` in main. */
  waiting: number
}

export const NOTHING_RUNNING: ChatActivity = { working: 0, waiting: 0 }

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

/** The same thing said out loud, for the row's `title`, for a screen reader and
 * for the tray's tooltip — where the width the label was compressed for does
 * not apply. */
export function activityTitle(activity: ChatActivity): string {
  const parts: string[] = []
  if (activity.working > 0) parts.push(`${activity.working} answering`)
  if (activity.waiting > 0)
    parts.push(`${activity.waiting} waiting for your answer`)
  return parts.join(", ")
}
