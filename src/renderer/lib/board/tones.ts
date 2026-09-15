import type { BoardPriority, BoardTone } from "@shared/api"

/**
 * What a column's hue draws as — the classes for the id a record holds.
 *
 * The split `GIT_TONES` has from `GitFileState`: the record on disk says which
 * of six was picked, and what that is worth in pixels lives here, so a change of
 * palette is one file and touches nothing that was saved.
 *
 * Six uses per tone, and they are deliberately not one colour applied at six
 * strengths:
 *
 * - `dot` is the mark in the column header — the only place a tone is at full
 *   strength, because it is the thing being read.
 * - `head` tints the header behind it, faintly. A column is furniture and a card
 *   is content; a header at card strength would compete with the cards under it.
 * - `edge` is the card's left border, which is what carries the hue **down** the
 *   column so a card dragged into the wrong one is visible as wrong at a glance.
 * - `ring` is the insertion line while dragging, so the gap being aimed at is
 *   the colour of the column it is in rather than one accent for the whole app.
 *
 * - `chip` is a filled label on a card — a tag, or a priority. Read at a
 *   glance and over the card's own background rather than the app's, so this is
 *   the one that carries a tint *and* a text colour; the others only ever tint
 *   something that already had its own.
 * - `text` is the hue on a glyph with nothing behind it, which is what a 12px
 *   icon in a dense row needs: `chip` would put a tinted box around it and
 *   `dot` is a background. Added for a list whose rows are too tight for a
 *   chip.
 *
 * `slate` is the neutral, and it is first in the picker for that reason: a
 * column with nothing to say about itself should be able to say nothing.
 */
export const BOARD_TONES: Record<
  BoardTone,
  {
    dot: string
    head: string
    edge: string
    ring: string
    chip: string
    text: string
  }
> = {
  slate: {
    dot: "bg-slate-400 dark:bg-slate-500",
    head: "bg-slate-500/5 dark:bg-slate-400/5",
    edge: "border-l-slate-300 dark:border-l-slate-600",
    ring: "bg-slate-400 dark:bg-slate-500",
    chip: "bg-slate-500/12 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300",
    text: "text-slate-600 dark:text-slate-400",
  },
  blue: {
    dot: "bg-blue-500 dark:bg-blue-400",
    head: "bg-blue-500/8 dark:bg-blue-400/8",
    edge: "border-l-blue-400 dark:border-l-blue-500",
    ring: "bg-blue-500 dark:bg-blue-400",
    chip: "bg-blue-500/12 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
    text: "text-blue-600 dark:text-blue-400",
  },
  violet: {
    dot: "bg-violet-500 dark:bg-violet-400",
    head: "bg-violet-500/8 dark:bg-violet-400/8",
    edge: "border-l-violet-400 dark:border-l-violet-500",
    ring: "bg-violet-500 dark:bg-violet-400",
    chip: "bg-violet-500/12 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
    text: "text-violet-600 dark:text-violet-400",
  },
  amber: {
    dot: "bg-amber-500 dark:bg-amber-400",
    head: "bg-amber-500/8 dark:bg-amber-400/8",
    edge: "border-l-amber-400 dark:border-l-amber-500",
    ring: "bg-amber-500 dark:bg-amber-400",
    chip: "bg-amber-500/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
    text: "text-amber-600 dark:text-amber-400",
  },
  emerald: {
    dot: "bg-emerald-500 dark:bg-emerald-400",
    head: "bg-emerald-500/8 dark:bg-emerald-400/8",
    edge: "border-l-emerald-400 dark:border-l-emerald-500",
    ring: "bg-emerald-500 dark:bg-emerald-400",
    chip: "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  rose: {
    dot: "bg-rose-500 dark:bg-rose-400",
    head: "bg-rose-500/8 dark:bg-rose-400/8",
    edge: "border-l-rose-400 dark:border-l-rose-500",
    ring: "bg-rose-500 dark:bg-rose-400",
    chip: "bg-rose-500/12 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
    text: "text-rose-600 dark:text-rose-400",
  },
}

/** What the picker calls each of them. */
export const TONE_LABEL: Record<BoardTone, string> = {
  slate: "Neutral",
  blue: "Blue",
  violet: "Violet",
  amber: "Amber",
  emerald: "Green",
  rose: "Rose",
}

/** The tone of a column that names one this build has never heard of — a board
 * written by a newer version. The neutral, which is the one answer that is safe
 * in both directions. */
export function toneOf(tone: string): BoardTone {
  return tone in BOARD_TONES ? (tone as BoardTone) : "slate"
}

/** The hues a tag can come out as: every one but the neutral. A tag is a label
 * somebody chose to write, so it is always worth a colour — `slate` is reserved
 * for the things that are allowed to say nothing. */
const TAG_TONES: BoardTone[] = ["blue", "violet", "amber", "emerald", "rose"]

/**
 * A tag's hue, from the tag itself.
 *
 * Derived rather than stored, which is what keeps tags free text (see
 * `BoardCard.tags`): the same word is the same colour on every card of every
 * project, with nothing on disk remembering that and nothing to reconcile when
 * a tag is typed on a second card. The cost is that two unrelated tags can
 * collide on a hue — acceptable, because the chip carries the word too and the
 * colour is only there to make the same word findable down a column.
 *
 * Lowercased first, so `API` and `api` — which `tagsOf` already treats as one
 * label — cannot come out as two colours.
 */
export function tagTone(tag: string): BoardTone {
  const key = tag.trim().toLowerCase()
  // djb2, for no reason beyond being short and well spread over words this
  // size; nothing on disk depends on the answer, so it can change freely.
  let hash = 5381
  for (let at = 0; at < key.length; at += 1) {
    hash = (hash * 33 + key.charCodeAt(at)) | 0
  }
  return TAG_TONES[Math.abs(hash) % TAG_TONES.length] ?? "blue"
}

/** Which hue each priority is drawn in, and what it is called. Rose / amber /
 * emerald in that order is the one convention nobody has to learn. */
export const PRIORITY_TONE: Record<BoardPriority, BoardTone> = {
  high: "rose",
  medium: "amber",
  low: "emerald",
}

export const PRIORITY_LABEL: Record<BoardPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
}

/** What a due date's chip is worth, by how it reads against today — the states
 * `dueState` in `cards.ts` answers with. `later` is deliberately colourless: a
 * date a fortnight out is information, not a warning. */
export const DUE_TONES: Record<"overdue" | "soon" | "later", string> = {
  overdue: "text-rose-600 dark:text-rose-400",
  soon: "text-amber-600 dark:text-amber-400",
  later: "text-muted-foreground",
}
