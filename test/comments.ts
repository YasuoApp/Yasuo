import { check, finish, section } from "./harness"

/**
 * Comments left on the lines of a diff.
 *
 * The pure halves are what is checked here — how an anchor is built and how it
 * reads, which lines carry a mark, and where a comment lands again after the
 * file has moved under it — with no store, no editor and no chat in the way.
 * Everything else in the feature is a gutter cell or a widget.
 */
const {
  anchorLabel,
  commentedLines,
  commentsPrompt,
  EMPTY_ANCHOR,
  isDeletedOnly,
  isEmptyAnchor,
  openThreads,
  rangeLabel,
  settle,
  snippetOf,
  threadsOf,
  useReview,
  withRow,
} = await import("../src/renderer/lib/files/review")

/** A thread, written out at the call site the way the store would hold it. The
 * notes are bodies, one per line said. */
const thread = (
  path: string,
  fromLine: number,
  toLine: number,
  said: string[],
  snippet = "",
  side: "new" | "old" = "new"
) =>
  anchored(
    path,
    side === "new"
      ? { old: null, new: { fromLine, toLine } }
      : { old: { fromLine, toLine }, new: null },
    side === "new" ? { old: null, new: snippet } : { old: snippet, new: null },
    said
  )

const anchored = (
  path: string,
  anchor: {
    old: { fromLine: number; toLine: number } | null
    new: { fromLine: number; toLine: number } | null
  },
  snippet: { old: string | null; new: string | null },
  said: string[]
) => {
  const at = anchor.new?.fromLine ?? anchor.old?.fromLine ?? 0
  return {
    id: `${path}:${at}`,
    rootId: "root",
    path,
    anchor,
    snippet,
    notes: said.map((body, index) => ({ id: `${path}:${at}:${index}`, body })),
  }
}

async function main() {
  section("building an anchor row by row")

  /*
   * This is the arithmetic the store used to do and no longer does: which rows a
   * gesture covered is a question only the editor can answer, so `review-marks.ts`
   * walks the rows between two heights and folds each one in through `withRow`.
   * What is checked here is the folding, which is the part that has to be right
   * for a range crossing a hunk to come out as one comment about two files.
   */
  const walk = (rows: ["new" | "old", number][]) =>
    rows.reduce((anchor, [side, line]) => withRow(anchor, side, line), EMPTY_ANCHOR) // prettier-ignore

  /** The same walk as the editor's, as the store is handed it: the anchor plus
   * the two rows the walk saw first and last, which is what the band is closed
   * at — see `ReviewSelection`. */
  const pickup = (rows: ["new" | "old", number][]) => ({
    anchor: walk(rows),
    first: { side: rows[0]![0], line: rows[0]![1] },
    last: { side: rows.at(-1)![0], line: rows.at(-1)![1] },
  })

  check(
    "rows on one side come out as one run, whichever order they arrive in",
    (() => {
      const grown = walk([
        ["new", 10],
        ["new", 14],
        ["new", 4],
      ])
      return (
        grown.new?.fromLine === 4 &&
        grown.new?.toLine === 14 &&
        grown.old === null
      )
    })(),
    "a walk goes downwards, but a drag that turns back walks upwards"
  )

  check(
    "rows on both sides come out as one anchor naming both",
    (() => {
      const across = walk([
        ["old", 40],
        ["old", 41],
        ["new", 12],
        ["new", 13],
      ])
      return (
        across.old?.fromLine === 40 &&
        across.old?.toLine === 41 &&
        across.new?.fromLine === 12 &&
        across.new?.toLine === 13
      )
    })(),
    "a run through a hunk crosses two files, and is still one remark"
  )

  check(
    "a walk that touched nothing is not a comment",
    isEmptyAnchor(EMPTY_ANCHOR) && !isEmptyAnchor(walk([["new", 1]])),
    "every row of the run was a folded bar, which is a line of neither file"
  )

  section("a review read back against a file that moved")

  /*
   * A review outlives the app now, so a thread comes back addressed by numbers
   * that were true yesterday. `settle` re-addresses it by the **lines it quoted**,
   * which is the durable half of what it stores — see the function.
   */
  const commented = (fromLine: number, toLine: number, quoted: string) => ({
    ...anchored(
      "/w/a.ts",
      { old: null, new: { fromLine, toLine } },
      { old: null, new: quoted },
      ["this leaks"]
    ),
  })

  const file = (...lines: string[]) => lines.join("\n")

  check(
    "a thread whose lines have not moved is handed back untouched",
    (() => {
      const one = commented(2, 2, "open(fd)")
      return settle(one, { old: null, new: file("a", "open(fd)", "b") }) === one
    })(),
    "identity, because `showing` runs on every rebuild of the diff and an array of fresh objects would re-render the pane for nothing"
  )

  check(
    "a thread follows its lines when something is inserted above",
    (() => {
      const moved = settle(commented(2, 3, "open(fd)\nuse(fd)"), {
        old: null,
        new: file("added", "a", "open(fd)", "use(fd)", "b"),
      })
      return (
        moved.anchor.new?.fromLine === 3 &&
        moved.anchor.new?.toLine === 4 &&
        !moved.stale
      )
    })(),
    "the run keeps its length; only where it starts changed"
  )

  check(
    "and when something above it is deleted",
    (() => {
      const moved = settle(commented(4, 4, "open(fd)"), {
        old: null,
        new: file("a", "open(fd)", "b"),
      })
      return moved.anchor.new?.fromLine === 2 && !moved.stale
    })()
  )

  check(
    "a thread whose lines are gone is marked outdated, not dropped",
    (() => {
      const gone = settle(commented(2, 2, "open(fd)"), {
        old: null,
        new: file("a", "b", "c"),
      })
      return gone.stale === true && gone.notes.length === 1
    })(),
    "a remark whose code has gone is still something somebody said"
  )

  check(
    "a run that now appears twice is outdated rather than guessed at",
    (() => {
      const twice = settle(commented(5, 5, "}"), {
        old: null,
        new: file("a", "}", "b", "}", "c"),
      })
      return twice.stale === true
    })(),
    "moving to the first of two identical runs is a comment quietly reattached to the wrong code"
  )

  check(
    "a truncated snippet follows on the lines it did keep",
    (() => {
      const cut = commented(2, 5, "open(fd)\n… 3 more lines")
      const here = settle(cut, { old: null, new: file("a", "open(fd)", "b") })
      const moved = settle(cut, {
        old: null,
        new: file("x", "a", "open(fd)", "b"),
      })
      return !here.stale && !moved.stale && moved.anchor.new?.fromLine === 3
    })(),
    "the `…` line is not in the file, but the prefix above it identifies the start just as well"
  )

  check(
    "a side with no text to check against is left where it is",
    (() => {
      const deleted = anchored(
        "/w/a.ts",
        { old: { fromLine: 7, toLine: 7 }, new: null },
        { old: "gone()", new: null },
        ["why did this go?"]
      )
      return settle(deleted, { old: null, new: "a\nb" }) === deleted
    })(),
    "an unread file is not a missing line"
  )

  section("how an anchor reads")

  check(
    "one line is one number and a run is two",
    anchorLabel({ old: null, new: { fromLine: 12, toLine: 12 } }) === "12" &&
      anchorLabel({ old: null, new: { fromLine: 12, toLine: 18 } }) === "12–18"
  )

  check(
    "a hunk leads with the working file's numbers and says what the others were",
    anchorLabel({
      old: { fromLine: 8, toLine: 9 },
      new: { fromLine: 12, toLine: 14 },
    }) === "12–14 (was 8–9)",
    "those are the ones somebody can open the file at"
  )

  check(
    "only a wholly deleted range is marked deleted",
    isDeletedOnly({ old: { fromLine: 8, toLine: 9 }, new: null }) &&
      !isDeletedOnly({
        old: { fromLine: 8, toLine: 9 },
        new: { fromLine: 12, toLine: 12 },
      }),
    "a hunk has lines in the working file, so its numbers are not the commit's"
  )

  section("the store's own picking")

  const review = useReview.getState()
  const place = { rootId: "root", path: "/w/a.ts" }
  const oneLine = (line: number) => pickup([["new", line]])

  review.pick(place, oneLine(10))
  check(
    "a press paints one line and does not open the box yet",
    useReview.getState().pending?.anchor.new?.fromLine === 10 &&
      useReview.getState().pending?.anchor.new?.toLine === 10 &&
      useReview.getState().pending?.settled === false,
    "a box drawn mid-drag takes height off the diff and moves the rows"
  )

  review.stretch(place, pickup([["new", 10], ["new", 16]])) // prettier-ignore
  check(
    "a drag replaces the range with the whole span it now covers",
    useReview.getState().pending?.anchor.new?.fromLine === 10 &&
      useReview.getState().pending?.anchor.new?.toLine === 16
  )

  review.stretch(place, pickup([["new", 10], ["new", 12]])) // prettier-ignore
  check(
    "and turning back shrinks it, because the caller recomputes rather than grows",
    useReview.getState().pending?.anchor.new?.toLine === 12,
    "a range grown from itself could only ever get bigger"
  )

  review.settle()
  check(
    "letting go is what opens the box",
    useReview.getState().pending?.settled === true
  )

  review.settle()
  check(
    "and a second mouseup changes nothing",
    useReview.getState().pending?.settled === true,
    "every release in the app comes through here, not only the ones that mean it"
  )

  section("writing one")

  review.pick({ rootId: "root", path: "/w/b.ts" }, oneLine(3))
  check(
    "a pick in another file replaces what was pending",
    useReview.getState().pending?.path === "/w/b.ts",
    "a comment cannot be about a range that spans two files"
  )

  review.settle()
  review.add("  rename this  ", { old: null, new: "const x = 1" })
  const saved = useReview.getState()
  check(
    "adding opens a thread, trims the body and clears the range",
    saved.threads.length === 1 &&
      saved.threads[0]?.notes.length === 1 &&
      saved.threads[0]?.notes[0]?.body === "rename this" &&
      saved.pending === null,
    saved.threads
  )

  review.pick({ rootId: "root", path: "/w/b.ts" }, oneLine(9))
  review.settle()
  review.add("   ", { old: null, new: "" })
  check(
    "an empty comment is a cancel rather than a blank remark",
    useReview.getState().threads.length === 1 &&
      useReview.getState().pending === null
  )

  section("the deleted side, and both at once")

  review.pick(place, pickup([["old", 772], ["old", 775]])) // prettier-ignore
  review.settle()
  review.add("why did this go?", { old: "  return", new: null })
  const removed = useReview.getState().threads.at(-1)
  check(
    "a comment on deleted lines is kept as the commit's",
    removed?.anchor.new === null &&
      removed?.anchor.old?.fromLine === 772 &&
      removed?.notes[0]?.body === "why did this go?",
    removed
  )

  review.remove(removed!.id)

  review.pick(place, pickup([["old", 40], ["new", 12], ["new", 13]])) // prettier-ignore
  review.settle()
  review.add("this swap is wrong", { old: "gone()", new: "kept()\nadded()" })
  const both = useReview.getState().threads.at(-1)
  check(
    "and a comment on a hunk keeps both halves",
    both?.anchor.old?.fromLine === 40 &&
      both?.anchor.new?.fromLine === 12 &&
      both?.snippet.old === "gone()" &&
      both?.snippet.new === "kept()\nadded()",
    both
  )

  review.remove(both!.id)

  check(
    "a line number means one row on one side and nothing on the other",
    (() => {
      const lines = [
        thread("/w/a.ts", 12, 12, ["kept"]),
        thread("/w/a.ts", 40, 41, ["gone"], "", "old"),
      ]
      const now = commentedLines(lines, "/w/a.ts")
      const before = commentedLines(lines, "/w/a.ts", "old")
      return (
        now.size === 1 &&
        now.has(12) &&
        before.size === 2 &&
        before.has(40) &&
        !before.has(12)
      )
    })(),
    "the gutter asks about one side at a time, and the removed rows are the other"
  )

  section("answering one")

  const opened = useReview.getState().threads[0]!.id
  review.reply(opened, "  because the fd is never closed  ")
  check(
    "a reply is another note on the same thread",
    useReview.getState().threads.length === 1 &&
      useReview.getState().threads[0]?.notes.length === 2 &&
      useReview.getState().threads[0]?.notes[1]?.body ===
        "because the fd is never closed",
    useReview.getState().threads[0]
  )

  review.reply(opened, "   ")
  check(
    "an empty reply says nothing",
    useReview.getState().threads[0]?.notes.length === 2
  )

  const second = review.comment({
    rootId: "root",
    path: "/w/c.ts",
    anchor: { old: null, new: { fromLine: 2, toLine: 3 } },
    snippet: { old: null, new: "if (x) {}" },
    body: "this branch is unreachable",
  })
  review.reply(second, "no, x is set above")
  const argued = useReview.getState().threads.find((t) => t.id === second)
  check(
    "a thread grows the notes said into it, oldest first",
    argued?.notes.length === 2 &&
      argued?.notes[0]?.body === "this branch is unreachable" &&
      argued?.notes[1]?.body === "no, x is set above",
    "a reply is another note rather than a second thread on the same lines"
  )

  check(
    "a count is of threads, not of the notes in them",
    (() => {
      const mine = threadsOf(useReview.getState(), "root")
      const notes = mine.reduce((sum, one) => sum + one.notes.length, 0)
      return mine.length === 2 && notes === 4
    })(),
    "a thread argued with twice is one place to go and look"
  )

  section("which box is open")

  review.openReply(second)
  check(
    "a reply box is a thread being open, on the store",
    useReview.getState().replyTo === second,
    "a widget is rebuilt whenever the review changes; a box that remembered itself in its own DOM would close every time"
  )

  review.reply(second, "and here is why")
  check(
    "saying it closes the box",
    useReview.getState().replyTo === null,
    "a box left open reads as a second reply being expected"
  )

  review.openReply(second)
  review.remove(second)
  check(
    "and deleting the thread takes its box with it",
    useReview.getState().replyTo === null
  )

  section("settling one")

  const settling = useReview.getState().threads[0]!.id
  review.openReply(settling)
  review.resolve(settling, true)
  const settled = () =>
    useReview.getState().threads.find((thread) => thread.id === settling)
  check(
    "resolving a thread marks it and closes its reply box",
    settled()?.resolved === true && useReview.getState().replyTo === null,
    "the box is the 'there is more to say here' affordance"
  )
  check(
    "it is kept, notes and all — folded is not deleted",
    (settled()?.notes.length ?? 0) > 0 &&
      useReview.getState().threads.some((thread) => thread.id === settling)
  )
  check(
    "and it stops being counted",
    !openThreads(useReview.getState().threads).some(
      (thread) => thread.id === settling
    )
  )

  review.resolve(settling, false)
  check(
    "reopening puts it back in the count",
    settled()?.resolved === false &&
      openThreads(useReview.getState().threads).some(
        (thread) => thread.id === settling
      ),
    "a set rather than a toggle: the two ends are two buttons"
  )

  check(
    "a thread written before the field existed reads as open",
    openThreads([thread("/w/a.ts", 1, 1, ["old record"])]).length === 1,
    "`resolved` is absent on everything on disk already"
  )

  section("what the diff draws")

  check(
    "every line of every range is marked, and only for that file",
    (() => {
      const lines = commentedLines(
        [
          thread("/w/a.ts", 3, 5, ["one"]),
          thread("/w/b.ts", 9, 9, ["elsewhere"]),
        ],
        "/w/a.ts"
      )
      return lines.size === 3 && lines.has(3) && lines.has(5) && !lines.has(9)
    })()
  )

  check("a single line reads as one number", rangeLabel({ fromLine: 7, toLine: 7 }) === "7") // prettier-ignore
  check("and a range as two", rangeLabel({ fromLine: 7, toLine: 9 }) === "7–9")

  section("the quoted lines")

  const text = ["one", "two", "three", "four", "five"].join("\n")

  check(
    "the range comes out inclusive of both ends",
    snippetOf(text, 2, 4) === "two\nthree\nfour"
  )

  check(
    "a long range is cut with a line saying how much is missing",
    snippetOf(text, 1, 5, 2) === "one\ntwo\n… 3 more lines",
    "a prompt that stops mid-function reads as the reviewer having meant that much"
  )

  section("the pile handed to a chat")

  /*
   * `Send … to a new chat` — the button that was deleted and is back. What is
   * checked is the three things that would otherwise be retyped by hand, since
   * that tedium is the whole reason the feature exists: which file, which lines,
   * and what was said. Plus the one rule that is not obvious from reading it —
   * a settled conversation is not a thing to do.
   */
  const pile = [
    thread(
      "/repo/src/a.ts",
      12,
      14,
      ["this leaks", "and the caller too"],
      "const x = 1"
    ),
    { ...thread("/repo/src/b.ts", 3, 3, ["done with this"]), resolved: true },
    thread("/repo/src/c.ts", 8, 8, ["wrong error path"]),
  ]
  const prompt = commentsPrompt(pile, "/repo")

  check(
    "only the open ones are counted",
    prompt.startsWith("I have left 2 comments"),
    prompt.slice(0, 60)
  )
  check("and only the open ones are in it", !prompt.includes("done with this"))
  check(
    "each says where it is, relative to the project",
    prompt.includes("1. src/a.ts:12–14") && prompt.includes("2. src/c.ts:8"),
    prompt
  )
  check(
    "the lines it quoted come through fenced",
    prompt.includes("```\nconst x = 1\n```"),
    prompt
  )
  check(
    "every note of a thread is said, not only the first",
    prompt.includes("this leaks") && prompt.includes("and the caller too")
  )
  check(
    "a review with nothing open is not a message",
    commentsPrompt([{ ...pile[1]! }], "/repo") === ""
  )

  finish()
}

await main()
