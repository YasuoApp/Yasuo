import { create } from "zustand"

/* The pane a comment is reached in — `reveal` opens its thread's file the way
 * clicking that file's row in the Changes list would. One direction only: that
 * store knows nothing about a comment. */
import { useChanges } from "./changes"
/* Only to say where a comment is in words somebody recognises — `src/main/git.ts`
 * rather than forty characters of checkout before the name. */
import { relativeTo } from "./paths"

/*
 * The record's own types live in the contract rather than here, because a review
 * is written to disk now and main is the one writing it — see `REVIEW_FILE` in
 * `main/store.ts`. Re-exported so every reader of a review still reaches them
 * through this file, which is the same bargain `lib/tree.ts` makes with
 * `@shared/tree`.
 */
export type {
  LineRange,
  ReviewAnchor,
  ReviewNote,
  ReviewSide,
  ReviewSnippet,
  ReviewThread,
} from "@shared/api"
import type {
  LineRange,
  ReviewAnchor,
  ReviewNote,
  ReviewSide,
  ReviewSnippet,
  ReviewThread,
} from "@shared/api"

/**
 * Comments left on the lines of a diff, and the prompt they are handed to an
 * agent as.
 *
 * The `Changes` pane is where a turn's work is read, and reading it is where the
 * remarks happen — "this leaks", "wrong error path", "rename this". Before this
 * they had to be retyped into a chat with the file and line named by hand, which
 * is both the tedious part and the part that goes wrong. So a review is left
 * where it is read: pick the lines, write the remark **in the diff, under the
 * lines it is about**, and write `@claude-review` in it to have Claude answer in
 * the same thread. `lib/files/review-marks.ts` is the drawing half — the column,
 * the band and the threads as block widgets.
 *
 * **A comment is a thread, not a line of text**, and that is the shape rather
 * than a feature: a remark on a range is answered, argued with and added to, the
 * way one on a pull request is. So a range holds *notes*, each with an author,
 * and `reply` adds one. Which also means the future in mind here is already
 * expressible — an **agent** reviewing the diff leaves threads of its own
 * (`author: "agent"`, through `comment` rather than through the composer), and a
 * reply to one is the same reply. Nothing about this file would change for it,
 * which is the reason it is built this way now: retrofitting an author onto a
 * flat string is a migration, and there is nothing yet to migrate.
 *
 * **A review used to be a sitting, and is a record now.** Nothing was written to
 * disk, on three legs: a review was *for* the chat at the end of it, anything
 * worth keeping was in that chat, and a comment read back a week later would
 * point at line numbers that had since moved. The first two went with the
 * `Ask AI to fix…` button — a reviewer who closed the window lost the afternoon.
 * `commentsPrompt` at the foot of this file is that button back, asked for by
 * name; what it does **not** bring back is the idea that a comment's home is a
 * chat. The threads stay here, and handing them over is a copy of them.
 *
 * The third leg was the real one, and it is answered rather than ignored: a
 * thread is addressed by the **lines it quoted**, not by its numbers. `settle`
 * finds them again when the file is next shown, moves the comment to where they
 * are, and marks it `stale` when they are nowhere — see it, and `REVIEW_FILE` in
 * `main/store.ts` for where the lot is kept.
 *
 * Keyed by **root** — a project or one of its `git worktree` checkouts, the same
 * id `FileRoot.id` and the dock's shells use — because that is what is being
 * reviewed and what a turn answering a comment runs in. Comments on several
 * files are one review.
 *
 * **A comment has a side**, the way one on a pull request does. Most are on the
 * *new* side, and their line numbers are the working file's — what an agent can
 * open the file at. A comment on a line that was **deleted** has nowhere in the
 * working file to point at, so it is numbered in the commit instead
 * (`anchor.old`), and the prompt says so where it quotes it: the lines
 * themselves are what the remark is about, and they are captured when it is
 * written. Deleted code is half of what a review is about — "this was load
 * bearing", "why did this go" — and before this it had to be retyped into the
 * chat by hand, which is the thing this feature exists to stop.
 *
 * **A range may cover both sides at once**, and that reverses the rule this
 * started with. It said a range was on one side or the other and never both,
 * because the two are numbered in different files and a pair of numbers cannot
 * be in two. That is still true of the *numbers* — and it turned out to be the
 * wrong thing to build the shape around. What a person selects in a unified diff
 * is a **hunk**: the `-` lines and the `+` lines that replaced them, which is one
 * thought and the most common thing there is to have an opinion about. Refusing
 * it meant two comments saying half a remark each, and — worse — a drag that
 * crossed from one to the other silently stopped moving, which read as the
 * selection being broken rather than as a rule being enforced.
 *
 * So a comment's address is a `ReviewAnchor`: a run of the commit's lines, a run
 * of the working file's, or one of each. Nothing is lost — a thread that is only
 * about deleted lines still says so, and one that is only about the working file
 * still carries numbers an agent can open the file at.
 */

/** Where a comment is being left: the checkout and the file. The side is no
 * longer part of it — see `ReviewAnchor`, which carries both. */
export type ReviewPlace = {
  rootId: string
  path: string
}

/** One row of one of the two files: which file, and its line number there. */
export type ReviewRow = { side: ReviewSide; line: number }

/**
 * A range as the editor hands it over: what it names, and where its two ends are
 * **on screen**.
 *
 * The ends are here because they cannot be worked out from the anchor, and
 * getting that wrong is visible. A range covering a hunk holds lines of two
 * files, and which of the two is drawn *above* the other is a fact about the
 * layout rather than about the sides: a deleted chunk sits between the context
 * line before the change and the lines that replaced it, so a range taking in a
 * kept line and then a deleted one has its `new` row on top — and one taking in a
 * deleted line and then its replacement has its `old` row on top. Deriving it
 * from the side drew the band's top rule on its bottom row.
 *
 * So the walk that builds the anchor records what it saw first and last, since it
 * goes down the screen and therefore already knows.
 */
export type ReviewSelection = {
  anchor: ReviewAnchor
  /** The topmost row of the range on screen. */
  first: ReviewRow
  /** The bottommost. The same row as `first` for a range of one. */
  last: ReviewRow
}

/**
 * Where on screen the range being commented on is, in client coordinates.
 *
 * Here so the composer can be drawn **against the lines it is about** rather
 * than in a strip at the foot of the pane: picking a range at the top of a diff
 * and then typing about it four hundred pixels below is the single thing that
 * made this feature tiring to use. The box is positioned, not laid out — nothing
 * in the diff moves for it, which is the objection that took the old block
 * widgets out (see `review-marks.ts`).
 *
 * Client coordinates and not the pane's, so the box is `position: fixed` and
 * needs no positioned ancestor and no knowledge of which pane it is in. Pushed
 * by `codemirror-diff.tsx`, which is the only place that can turn a line number
 * into a pixel — and re-pushed while the diff scrolls, since a range scrolled
 * out from under its box is a box pointing at nothing.
 */
export type ReviewSpot = {
  /** The top of the range's first line. */
  top: number
  /** The bottom of the range's last line — where the box hangs from when there
   * is room below. */
  bottom: number
  /** The left edge of the code, so the box lines up with the lines rather than
   * with the gutter. */
  left: number
  /** The right edge of the editor, which is what the box's width is measured
   * against. */
  right: number
}

/** The range being commented on, before there is a thread. */
export type PendingRange = ReviewSelection & {
  rootId: string
  path: string
  /**
   * Whether the pointer has been let go — which is what opens the box.
   *
   * The range is painted from the moment it is picked and the box is not, and
   * that gap is load-bearing: the box is drawn *in* the diff, under the range, so
   * opening it mid-drag inserts height between the rows and moves them out from
   * under the pointer that is still choosing them. So a drag paints, and the
   * release opens.
   */
  settled: boolean
}

/** How many lines of the file a thread quotes, at most. Enough for a function,
 * short enough that eight comments are still one prompt. */
export const SNIPPET_LIMIT = 24

/** What opening a thread needs: where, what was said, and by whom. */
export type ThreadInput = {
  rootId: string
  path: string
  anchor: ReviewAnchor
  snippet: ReviewSnippet
  body: string
}

type ReviewState = {
  /** Every thread, across every root, in the order they were opened — which is
   * the order the prompt lists them in. */
  threads: ReviewThread[]
  /** The one range being written about, or null. One at a time: a second box
   * open in another file is a comment nobody is looking at. */
  pending: PendingRange | null
  /**
   * The thread whose reply box is open, or null.
   *
   * On the store rather than inside the box, because the box is a CodeMirror
   * widget: a widget is rebuilt whenever the threads change, so a reply box that
   * remembered itself in its own DOM would close every time anything else in the
   * review moved. What it must *not* hold is the half-typed text — see the
   * `drafts` note in `review-marks.ts`.
   */
  replyTo: string | null
  /**
   * The committed text of the file the diff is showing, or null.
   *
   * Here because of one thing only: a comment on a **deleted** line quotes lines
   * that are not in the working file, so `snippetOf` has to read them out of the
   * commit — and the panel that writes the thread has the working buffer to hand
   * and not this. It is pushed in by the diff (`codemirror-diff.tsx`), which is
   * the one place that holds both halves of what is on screen.
   *
   * One file rather than a cache: the pane draws one diff, and a committed text
   * kept for a file nobody is looking at is a copy of a file going stale.
   */
  committed: { path: string; text: string } | null
  /**
   * Where the pending range is on screen, or null when it is nowhere the reader
   * can see — see `ReviewSpot`.
   *
   * Null is a real state and not just "not measured yet": a range picked in a
   * file, then scrolled off the top of the pane, has no rows on screen to hang a
   * box from. The strip at the foot of the pane is what draws the composer then,
   * which is why that path is kept rather than deleted.
   */
  spot: ReviewSpot | null
  /**
   * A range picked in the review column — a press, or the whole span a
   * shift-click reaches.
   *
   * The anchor arrives **already worked out**, both sides of it, because only the
   * editor can say which rows lie between two points on screen: a run of the
   * unified diff crosses from a chunk's deleted rows into the lines that replaced
   * them, and those are two files. `review-marks.ts` walks it; this only records
   * it.
   *
   * A pick in another file replaces whatever was pending: a comment cannot be
   * about a range that spans two files, which is the one part of the old
   * one-side-only rule that survives.
   */
  pick: (place: ReviewPlace, selection: ReviewSelection) => void
  /**
   * The same, while the pointer is still down.
   *
   * Apart from `pick` only in what it means to the reader — this replaces rather
   * than settles, and a drag that turns back shrinks because the caller
   * recomputes the whole span from its own anchor every time rather than growing
   * what is here.
   */
  stretch: (place: ReviewPlace, selection: ReviewSelection) => void
  /** The pointer let go: the range stops being dragged and the box opens. */
  settle: () => void
  cancel: () => void

  /** Opens the pending range as a thread. Empty text is a cancel. */
  add: (body: string, snippet: ReviewSnippet) => void
  /**
   * Opens a thread anywhere — what `add` is written over.
   *
   * Hands back the thread's id, so a caller with several things to say about one
   * range can `reply` into it rather than opening a thread per sentence.
   */
  comment: (input: ThreadInput) => string
  /** Another note on an existing thread. */
  reply: (threadId: string, body: string) => void
  /** Opens one thread's reply box, or closes whichever is open. */
  openReply: (threadId: string | null) => void
  /**
   * The thread last landed on from the `Comments` tab, or null.
   *
   * What it buys is two things at once: the pane scrolls to it, and it is drawn
   * with a ring so the eye finds it in a file that may have three others. Not
   * persisted and not per root — it is where somebody is *now*, and a place in a
   * diff is not a thing to come back to a week later.
   */
  focused: string | null
  /**
   * Landing on one thread — what a row of the `Comments` tab does.
   *
   * Its own action rather than a `set` in the list, because landing on a thread
   * is two things and the second is easy to forget: the file it is in has to
   * come to the front, or the ring is drawn in a pane nobody is looking at.
   *
   * There were `⌥↓` / `⌥↑` beside this once, walking the open threads across
   * files with `step` and `stepThrough`. They are gone with the two buttons that
   * taught them — the `Comments` tab is the way to a remark now, and a list you
   * can see beats a key you have to know about.
   */
  reveal: (threadId: string) => void
  /**
   * Settles a conversation, or reopens it — see `ReviewThread.resolved`.
   *
   * A **set** rather than a toggle, because the two ends are two different
   * buttons and a toggle would let a stale render resolve what somebody had
   * just reopened. Resolving closes the reply box if it is this thread's: the
   * box is the "there is more to say here" affordance, and leaving it open
   * beside a collapsed thread says both things at once.
   */
  resolve: (threadId: string, resolved: boolean) => void
  /** The whole thread, notes and all: there is no deleting half a
   * conversation. */
  remove: (threadId: string) => void
  /**
   * What the diff on screen is comparing against — see `committed`.
   *
   * Also where a **kept** review is put back on its lines: this fires when a file
   * is shown, which is the one moment both halves of it are to hand, so every
   * thread in that file is `settle`d against them. See `settle`.
   */
  showing: (path: string, text: string, working?: string) => void
  /**
   * Reads the review back off disk. Once, at boot.
   *
   * The threads arrive addressed by line numbers that were true when the app was
   * last closed. Nothing is re-anchored here — the files are not read at boot and
   * would not be worth reading — so a thread is put back where it was and checked
   * the first time its file is shown.
   */
  load: () => Promise<void>
  /** Where the pending range is on screen — see `spot`. */
  locate: (spot: ReviewSpot | null) => void
}

/**
 * The review, written down.
 *
 * Fire-and-forget after every change: the whole collection is a few dozen short
 * records, and a review that is one write behind at the moment the app is
 * killed has lost the last remark rather than the review.
 *
 * Debounced, because this store is written to by a **drag**: every row a range
 * crosses is a `set`, and a file write per row is a file write per fifty
 * milliseconds. What is saved is read at call time, so the last write
 * in a burst is the one that lands.
 */
let pendingWrite: ReturnType<typeof setTimeout> | null = null

function keep(threads: ReviewThread[]): void {
  if (pendingWrite) clearTimeout(pendingWrite)
  pendingWrite = setTimeout(() => {
    pendingWrite = null
    void window.desktop.saveReviewThreads(threads).catch((error: unknown) => {
      console.error("Could not save the review", error)
    })
  }, WRITE_DELAY_MS)
}

/** Long enough that a drag is one write, short enough that closing the app a
 * second after a comment keeps it. */
const WRITE_DELAY_MS = 300

/** Ids are unique within a run and mean nothing outside it, which is all a
 * draft needs — see the note above about a review being a sitting. */
let counter = 0
const nextId = (kind: string) => `${kind}-${Date.now()}-${(counter += 1)}`

export const useReview = create<ReviewState>((set, get) => ({
  threads: [],
  pending: null,
  replyTo: null,
  committed: null,
  spot: null,
  pick(place, selection) {
    set({
      pending: { ...selection, ...place, settled: false },
    })
  },

  stretch(place, selection) {
    set({
      pending: { ...selection, ...place, settled: false },
    })
  },

  settle() {
    const { pending } = get()
    // Nothing to settle is the common case: every mouseup in the app that is
    // not the end of a pick comes through here.
    if (!pending || pending.settled) return
    set({ pending: { ...pending, settled: true } })
  },

  cancel() {
    // The spot goes with the range: it describes where that range was, and a
    // stale one is a box hanging beside lines nobody picked.
    set({ pending: null, spot: null })
  },

  add(body, snippet) {
    const { pending } = get()
    if (!pending || !body.trim()) {
      set({ pending: null, spot: null })
      return
    }

    get().comment({ ...pending, snippet, body })
    set({ pending: null, spot: null })
  },

  comment(input) {
    const id = nextId("thread")
    const note: ReviewNote = { id: nextId("note"), body: input.body.trim() }

    set({
      threads: [
        ...get().threads,
        {
          id,
          rootId: input.rootId,
          path: input.path,
          anchor: input.anchor,
          snippet: input.snippet,
          notes: [note],
        },
      ],
    })
    keep(get().threads)
    return id
  },

  reply(threadId, body) {
    const text = body.trim()
    if (!text) return

    set({
      // The box closes with the reply in it: leaving it open reads as a second
      // reply being expected.
      replyTo: get().replyTo === threadId ? null : get().replyTo,
      threads: get().threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              notes: [...thread.notes, { id: nextId("note"), body: text }],
            }
          : thread
      ),
    })

    keep(get().threads)
  },

  openReply(threadId) {
    if (get().replyTo === threadId) return
    set({ replyTo: threadId })
  },

  focused: null,

  reveal(threadId) {
    const thread = get().threads.find((entry) => entry.id === threadId)
    if (!thread) return
    set({ focused: threadId })
    // Guarded: `openPath` on the file already showing is a `set` per click for
    // nothing, and every subscriber of the changes store re-rendering with it.
    if (useChanges.getState().selectedPath[thread.rootId] !== thread.path) {
      useChanges.getState().openPath(thread.rootId, thread.path)
    }
  },

  resolve(threadId, resolved) {
    const threads = get().threads.map((thread) =>
      thread.id === threadId ? { ...thread, resolved } : thread
    )
    set({
      threads,
      replyTo: resolved && get().replyTo === threadId ? null : get().replyTo,
    })
    keep(threads)
  },

  remove(threadId) {
    set({
      threads: get().threads.filter((thread) => thread.id !== threadId),
      replyTo: get().replyTo === threadId ? null : get().replyTo,
    })
    keep(get().threads)
  },

  showing(path, text, working) {
    /*
     * The threads in this file, put back on their lines.
     *
     * Here rather than at boot because this is the one moment both texts exist:
     * the diff has just been handed the commit, and the working buffer is the one
     * it is drawing. A file nobody opens is never checked, which is right — a
     * comment is only wrong once somebody is looking at it.
     *
     * Identity is what makes this cheap enough to run on every rebuild: `settle`
     * hands back the same object when nothing moved, so the common case leaves
     * the array untouched and nothing re-renders.
     */
    const threads = get().threads
    const checked = threads.map((thread) =>
      thread.path === path
        ? settle(thread, { old: text, new: working ?? null })
        : thread
    )
    const changed = checked.some((thread, at) => thread !== threads[at])
    if (changed) set({ threads: checked })

    // Guarded rather than set blind: this is called from an effect that runs on
    // every rebuild of the diff, and a `set` with the same pair would re-render
    // every subscriber of the review for nothing.
    const held = get().committed
    if (held?.path === path && held.text === text) {
      if (changed) void keep(get().threads)
      return
    }
    set({ committed: { path, text } })
    if (changed) void keep(get().threads)
  },

  async load() {
    try {
      set({ threads: await window.desktop.listReviewThreads() })
    } catch (error) {
      // A review that cannot be read is a review this run does without. Worth
      // saying out loud, and not worth refusing to open the pane over.
      console.error("Could not read the review", error)
    }
  },

  locate(spot) {
    // Guarded like `showing`, and for the same reason doubled: this is pushed
    // from a scroll handler, so an unguarded `set` would re-render every
    // subscriber of the review on every frame of a scroll.
    const held = get().spot
    if (
      held === spot ||
      (held !== null &&
        spot !== null &&
        held.top === spot.top &&
        held.bottom === spot.bottom &&
        held.left === spot.left &&
        held.right === spot.right)
    ) {
      return
    }
    set({ spot })
  },
}))

/** An anchor naming nothing at all, which is not a comment. Every producer of
 * one has a path where the rows it walked turned out to be a folded bar and
 * nothing else. */
export function isEmptyAnchor(anchor: ReviewAnchor): boolean {
  return anchor.old === null && anchor.new === null
}

/** One row added to a range, or a range of one where there was none. */
export function growRange(range: LineRange | null, line: number): LineRange {
  if (!range) return { fromLine: line, toLine: line }
  return {
    fromLine: Math.min(range.fromLine, line),
    toLine: Math.max(range.toLine, line),
  }
}

/**
 * One row folded into an anchor, on the side it belongs to.
 *
 * How every anchor is built: the caller walks the rows between two points on
 * screen and hands each one to this. The result is min/max per side, which is
 * what makes a run crossing from a chunk's deleted rows into the lines that
 * replaced them come out as one comment about both.
 */
export function withRow(
  anchor: ReviewAnchor,
  side: ReviewSide,
  line: number
): ReviewAnchor {
  return { ...anchor, [side]: growRange(anchor[side], line) }
}

/** Nothing named yet — what a walk starts from. */
export const EMPTY_ANCHOR: ReviewAnchor = { old: null, new: null }

/** One root's threads, in the order they were opened. */
export function threadsOf(
  state: { threads: ReviewThread[] },
  rootId: string | null
): ReviewThread[] {
  if (rootId === null) return []
  return state.threads.filter((thread) => thread.rootId === rootId)
}

/**
 * The ones still asking for something.
 *
 * The badge on a row of the Changes list counts these rather than the lot,
 * because a count there is read as "how much is left" and a file worked through
 * should say so. The threads themselves are not filtered anywhere: a resolved
 * conversation stays on its lines, collapsed, and is still a row in the
 * `Comments` tab.
 *
 * `resolved` is absent on everything written before the field existed, so this
 * is a truthiness check and not `=== false`.
 */
export function openThreads(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => !thread.resolved)
}

/** Which lines of a file already carry a comment, for the column that draws a
 * mark beside them. */
export function commentedLines(
  threads: ReviewThread[],
  path: string,
  side: ReviewSide = "new"
): Set<number> {
  const lines = new Set<number>()
  for (const thread of threads) {
    if (thread.path !== path) continue
    const range = thread.anchor[side]
    if (!range) continue
    for (let line = range.fromLine; line <= range.toLine; line += 1) {
      lines.add(line)
    }
  }
  return lines
}

/** `12` for one line, `12–18` for a range — an en dash, the way a line range is
 * written. */
export function rangeLabel(range: LineRange): string {
  return range.fromLine === range.toLine
    ? String(range.fromLine)
    : `${range.fromLine}–${range.toLine}`
}

/**
 * An anchor as the one string a heading and a row both show.
 *
 * The working file's numbers lead where there are any, because those are the
 * ones somebody can open the file at; the commit's follow in brackets, said to
 * be the commit's, because `12` means two different lines depending on which
 * file it is a line of and that is the whole ambiguity to kill. A thread with
 * only deleted lines is the one case where the commit's numbers lead, and it is
 * marked as such wherever it is drawn.
 */
export function anchorLabel(anchor: ReviewAnchor): string {
  if (anchor.new && anchor.old) {
    return `${rangeLabel(anchor.new)} (was ${rangeLabel(anchor.old)})`
  }
  const only = anchor.new ?? anchor.old
  return only ? rangeLabel(only) : "?"
}

/** Whether a thread is about deleted lines and nothing else — the one shape
 * whose numbers are not the working file's, and so the one that has to say so. */
export function isDeletedOnly(anchor: ReviewAnchor): boolean {
  return anchor.new === null && anchor.old !== null
}

/**
 * One thread put back on the lines it was written about, in a file that has
 * moved on.
 *
 * **This is the price of keeping a review**, and it is the whole of the argument
 * that used to say not to: a comment read back tomorrow points at line 12, and
 * line 12 is whatever moved into it. So the numbers are not what a thread is
 * addressed by — the **snippet** is. It was already captured, for the prompt, and
 * it turns out to be the durable address.
 *
 * Three answers, in order, and the order is the point:
 *
 * 1. **The lines are still there.** Nothing moved under this comment; leave it
 *    exactly as it is, which is the common case and costs one comparison.
 * 2. **They are somewhere else in the file.** Something was inserted or removed
 *    above; move the anchor to where they are now. Only when the snippet appears
 *    **once** — a comment on `}` would otherwise land on whichever `}` came
 *    first, which is worse than saying nothing.
 * 3. **They are gone**, or they are ambiguous. Mark it `stale`. Not delete it: a
 *    remark whose code has gone is still something somebody said, and often the
 *    most interesting thing in the review.
 *
 * A **truncated** snippet (`SNIPPET_LIMIT`) is handled by the same three, and
 * needs no case of its own: its `…` line is not part of the file, but everything
 * above it is, and that prefix identifies the start of the run exactly as well.
 * So the marker is dropped and the rest is looked for. What is lost is only that
 * a comment on a 400-line block is recognised by its first 24 lines — which is
 * what it was already quoted by.
 *
 * Pure, and checked in `test/review.ts`.
 */
export function settle(
  thread: ReviewThread,
  text: { old: string | null; new: string | null }
): ReviewThread {
  let moved = thread.anchor
  let lost = false

  for (const side of ["old", "new"] as const) {
    const range = thread.anchor[side]
    const quoted = thread.snippet[side]
    const file = text[side]
    // Nothing to check: this side is not part of the anchor, or the file it
    // would be checked against is not to hand. Left where it is rather than
    // called stale — an unread file is not a missing line.
    if (!range || !quoted || file === null) continue

    const found = placeOf(file, quoted, range)
    if (found === "gone") lost = true
    else if (found !== range.fromLine) {
      moved = { ...moved, [side]: shifted(range, found) }
    }
  }

  const stale = lost || undefined
  if (moved === thread.anchor && stale === thread.stale) return thread
  return { ...thread, anchor: moved, stale }
}

/**
 * Which line a quoted run starts at now, or `"gone"`.
 *
 * Checked where it was first, so a file nothing has happened to costs one string
 * comparison per thread rather than a search.
 */
function placeOf(
  text: string,
  quoted: string,
  range: LineRange
): number | "gone" {
  const lines = text.split("\n")
  const all = quoted.split("\n")
  // `snippetOf` ends a run it had to cut with a line saying how much it left
  // out. That line is not in the file; everything above it is, and identifies
  // the start just as well.
  const wanted = all.at(-1)?.startsWith("… ") ? all.slice(0, -1) : all
  if (wanted.length === 0) return "gone"

  if (sameAt(lines, wanted, range.fromLine)) return range.fromLine

  let at: number | null = null
  for (let line = 1; line + wanted.length - 1 <= lines.length; line += 1) {
    if (!sameAt(lines, wanted, line)) continue
    // Twice is as bad as never: moving to the first of two identical runs is a
    // comment quietly reattached to the wrong code.
    if (at !== null) return "gone"
    at = line
  }
  return at ?? "gone"
}

/** Whether the file holds this run starting at `line`, counting from 1. */
function sameAt(lines: string[], wanted: string[], line: number): boolean {
  if (line < 1 || line + wanted.length - 1 > lines.length) return false
  return wanted.every((text, at) => lines[line - 1 + at] === text)
}

/** The same run, starting somewhere else. */
function shifted(range: LineRange, fromLine: number): LineRange {
  return { fromLine, toLine: fromLine + (range.toLine - range.fromLine) }
}

/**
 * The lines a thread quotes, taken out of the file's text.
 *
 * Truncated with a line saying so rather than silently, since a prompt that
 * stops mid-function reads as the reviewer having meant only that much.
 */
export function snippetOf(
  text: string,
  fromLine: number,
  toLine: number,
  limit = SNIPPET_LIMIT
): string {
  const lines = text.split("\n").slice(fromLine - 1, toLine)
  if (lines.length <= limit) return lines.join("\n")
  return [
    ...lines.slice(0, limit),
    `… ${lines.length - limit} more line${lines.length - limit === 1 ? "" : "s"}`,
  ].join("\n")
}

/**
 * A pile of comments as the message that hands them over — the `Comments` tab's
 * `Send to a chat`.
 *
 * **This was deleted and is back because it was asked for.** `Ask AI to fix…`
 * opened a chat with every remark written into its composer, and what it got
 * wrong was deciding that a comment's *destination* is a chat; the note left
 * where it went (`docs/design.md` § Comments) said it was a `⌘A` and a copy away
 * from returning, and until somebody wanted it there was no button whose only
 * purpose was to move remarks out of the pane they belong in. Somebody wanted
 * it. What is different this time is where the remarks stay: they are a record
 * on disk, this is a **copy** of them, and nothing here resolves, moves or
 * deletes a thread. Sending twice is allowed and means what it says.
 *
 * It produces **text for a composer**, unsent — which is the other half of the
 * old argument and still holds. A prompt assembled by a button is exactly the
 * kind that wants a sentence added before it goes, and a turn nobody typed into
 * is a turn nobody asked for.
 *
 * **Open threads only.** A resolved conversation is one somebody has already
 * dealt with, and the pile is a list of things to do.
 *
 * Each remark carries where it is, the lines it quoted and what was said,
 * because those are the three things that would otherwise be retyped by hand —
 * which is the tedium this whole feature exists to remove. The quoted lines are
 * the thread's own snippet rather than the file as it reads now: that is what
 * the reviewer was looking at, and it is already capped (`SNIPPET_LIMIT`).
 */
export function commentsPrompt(
  threads: ReviewThread[],
  rootPath: string
): string {
  const open = openThreads(threads)
  if (open.length === 0) return ""

  const blocks = open.map((thread, at) => {
    const where = `${relativeTo(rootPath, thread.path) || thread.path}:${anchorLabel(thread.anchor)}`
    const quoted = thread.snippet.new ?? thread.snippet.old
    const said = thread.notes.map((note) => note.body.trim()).filter(Boolean)

    return [
      `${at + 1}. ${where}${isDeletedOnly(thread.anchor) ? " (lines this change deleted)" : ""}`,
      // Unlabelled: what a fence holds is code, and the line above says which
      // file it came out of.
      ...(quoted ? ["", "```", quoted, "```"] : []),
      "",
      // The whole thread, oldest first, because a reply is usually where the
      // remark got specific. Run together as one paragraph per note rather than
      // marked up as a conversation: with one voice there is nothing to
      // attribute — see the note on `ReviewNote`.
      ...said,
    ].join("\n")
  })

  return [
    `I have left ${open.length} ${open.length === 1 ? "comment" : "comments"} on the current diff of this project. Each one names the file and lines it is about, quotes the lines as they read when it was written, and then says what I meant.`,
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ]
    .join("\n")
    .trimEnd()
}
