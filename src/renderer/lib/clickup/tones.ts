import type { BoardTone, ClickupChangeKind } from "@shared/api"

/**
 * What each kind of change is worth in colour.
 *
 * The classes themselves are **`BOARD_TONES`**, imported from
 * `lib/board/tones.ts` where they were written. That is one palette for the
 * app rather than the board's: a second table of hues here would drift from it
 * the first time either was tuned, and the ids are already `@shared/api`'s
 * `BoardTone` rather than anything a board owns.
 *
 * Seven kinds and six hues, so exactly one pair shares: **description, comment
 * and comment-edited are one family** on purpose — they are the three changes
 * that are somebody writing words, they are the three that carry a diff, and
 * they are the three whose rows never need telling apart by hue because each
 * already has its own icon and its own label above the text.
 *
 * Colour is never the only difference between two rows here, which is the rule
 * `card-chips.tsx` states for the board: every row carries an icon and a
 * written label as well, so nothing is lost by not seeing the hue.
 */
export const CHANGE_TONE: Record<ClickupChangeKind, BoardTone> = {
  // The one people are actually watching for, in the app's most neutral-loud
  // hue: a status move should be the thing the eye lands on down a history.
  status: "blue",
  // The task being renamed is furniture, not news.
  name: "slate",
  assignees: "violet",
  // Rose and amber in that order is the convention `PRIORITY_TONE` already
  // uses, and a priority moving is the one change that is close to an alarm.
  priority: "rose",
  due: "amber",
  description: "emerald",
  comment: "emerald",
  "comment-edited": "emerald",
}

/**
 * A ClickUp priority word as a hue.
 *
 * ClickUp's four are `urgent` / `high` / `normal` / `low`, and they are read
 * here rather than mapped into the board's own three: this is somebody else's
 * vocabulary and the pane draws the word it was given. Anything unrecognised —
 * a workspace with custom priorities, a newer ClickUp — is the neutral, which
 * is the answer that is safe in both directions.
 */
export function clickupPriorityTone(priority: string): BoardTone {
  switch (priority.trim().toLowerCase()) {
    case "urgent":
      return "rose"
    case "high":
      return "amber"
    case "normal":
      return "blue"
    case "low":
      return "slate"
    default:
      return "slate"
  }
}
