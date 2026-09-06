import {
  CLICKUP_BODY_MAX,
  type ClickupChange,
  type ClickupSnapshot,
  type ClickupWatch,
} from "../src/shared/api"
import {
  describeChanges,
  hexColor,
  newestComment,
  snapshotOf,
  taskRefIn,
} from "../src/main/clickup"
import { fold } from "../src/main/clickup-watch"
import { unreadIn, unreadWatchCount } from "../src/renderer/lib/clickup/store"
import { clickupPriorityTone } from "../src/renderer/lib/clickup/tones"
import { check, finish, section } from "./harness"

/**
 * Watching a ClickUp task: which URLs name one, what a poll saw, and what is
 * worth interrupting somebody for.
 *
 * Every failure here is quiet and expensive in the same way. A URL parsed
 * wrongly is a row that says "no such task" about a task that plainly exists. A
 * field read wrongly is a **notification every two minutes** for a change that
 * never happened — the one bug that would make somebody switch the feature off
 * and never switch it back on. And a change missed is the thing this exists to
 * catch, arriving in an email an hour later instead.
 *
 * All three functions are pure and live on the main side, the way `notify.ts`'s
 * own `ChatNotices` does, so this runs under plain `bun` with no Electron.
 */

const NOW = "2026-09-05T10:00:00.000Z"

function snap(over: Partial<ClickupSnapshot> = {}): ClickupSnapshot {
  return {
    name: "Add login",
    status: "to do",
    statusColor: null,
    priority: null,
    assignees: [],
    due: null,
    description: "IN: email",
    updatedAt: 1_000,
    comment: null,
    ...over,
  }
}

section("which URLs name a task")

// The two shapes the feature was asked for, and they differ by whether the
// workspace id is in the path.
{
  const withTeam = taskRefIn("https://app.clickup.com/t/90181720832/86eutavc5")
  check("the long form finds the task", withTeam?.id === "86eutavc5")
  check("and keeps the workspace", withTeam?.teamId === "90181720832")
}
{
  const short = taskRefIn("https://app.clickup.com/t/86eutavc5")
  check("the short form finds the task", short?.id === "86eutavc5")
  // Nothing before the task, so nothing to read as a workspace — guessing here
  // would send a custom-id lookup into a namespace picked at random.
  check("and has no workspace", short?.teamId === null)
}

check(
  "a query string is cut before the split",
  taskRefIn("https://app.clickup.com/t/86eutavc5?block=abc")?.id === "86eutavc5"
)
check(
  "so is a trailing slash",
  taskRefIn("https://app.clickup.com/t/90181720832/86eutavc5/")?.id ===
    "86eutavc5"
)
check("a bare id is accepted", taskRefIn("86eutavc5")?.id === "86eutavc5")
check(
  "whitespace around it does not count",
  taskRefIn("  86eutavc5 ")?.id === "86eutavc5"
)

// A custom id keeps the workspace, which is the only reason `teamId` is stored
// at all — `fetchTask` cannot look one up without it.
check(
  "a custom id keeps its workspace",
  taskRefIn("https://app.clickup.com/t/90181720832/ABC-123")?.teamId ===
    "90181720832"
)
// A word where the workspace goes is a list view, not a workspace id.
check(
  "a non-numeric segment is not a workspace",
  taskRefIn("https://app.clickup.com/t/v/86eutavc5")?.teamId === null
)

check("nothing is nothing", taskRefIn("") === null)
check("a sentence is not a task", taskRefIn("please look at this") === null)
check(
  "another host's task URL still parses",
  taskRefIn("https://app.clickup.com/t/x")?.id === "x"
)
// The one that matters for safety: a watch's URL is opened in the browser and
// put on a notification, so a scheme that is not the web must not be storable.
check("a file URL is refused", taskRefIn("file:///t/passwd") === null)
check(
  "so is any other scheme",
  taskRefIn("javascript://app.clickup.com/t/x") === null
)

section("what one poll saw")

{
  const seen = snapshotOf(
    {
      name: "Add login",
      text_content: "IN: email",
      status: { status: "in progress" },
      priority: { id: "2", priority: "high" },
      assignees: [{ username: "Tanaka" }, { username: "Duong" }],
      due_date: "1788566400000",
      date_updated: "1788000000000",
    },
    null
  )

  check("the name comes across", seen.name === "Add login")
  check(
    "the status is the word inside the object",
    seen.status === "in progress"
  )
  // The word rather than the number: this is drawn in a row and compared
  // against nothing of this app's.
  check("the priority is the word", seen.priority === "high")
  // Sorted, so ClickUp handing them back in another order is not read as
  // somebody being reassigned — which would fire a banner every poll.
  check("assignees are sorted", seen.assignees.join() === "Duong,Tanaka")
  check("the due date is a number", seen.due === 1788566400000)
  check("date_updated is a number", seen.updatedAt === 1788000000000)
}

{
  // Every one of these is a shape ClickUp really sends, and each would be a
  // change announced on every single poll if it were read wrongly.
  const bare = snapshotOf({ name: "x" }, null)
  check("a missing status is empty, not undefined", bare.status === "")
  check("a missing priority is null", bare.priority === null)
  check("a missing due date is null", bare.due === null)
  check("a missing date_updated is 0", bare.updatedAt === 0)
  check("missing assignees are an empty list", bare.assignees.length === 0)
}
check(
  "an empty due_date is no due date, not 1970",
  snapshotOf({ due_date: "" }, null).due === null
)

section("the one colour this app did not choose")

// ClickUp's own hue for a status, and the only value in this feature that ends
// up in a CSS `style` — so it is checked on the way in rather than where it is
// drawn.
check(
  "a status colour comes across",
  snapshotOf({ status: { status: "done", color: "#2ecd6f" } }, null)
    .statusColor === "#2ecd6f"
)
check(
  "a task with no colour has none",
  snapshotOf({ status: { status: "done" } }, null).statusColor === null
)
check("three digits are a colour", hexColor("#0f0") === "#0f0")
check("eight are too, alpha and all", hexColor("#2ecd6fcc") === "#2ecd6fcc")
check("whitespace around one does not count", hexColor("  #fff ") === "#fff")
// Each of these would otherwise reach a style property as somebody else's
// string, which is how a colour becomes a payload.
check("a name is not a colour", hexColor("rebeccapurple") === null)
check("nor is a function", hexColor("rgb(0,0,0)") === null)
check("nor an expression", hexColor("#fff; background: url(x)") === null)
check("nor a non-string", hexColor(123) === null)

// A recoloured status is not a change to the task, so it must never announce —
// the field is deliberately absent from `describeChanges`.
check(
  "recolouring a status announces nothing",
  describeChanges(
    snap({ statusColor: "#aaaaaa" }),
    snap({ statusColor: "#2ecd6f" }),
    NOW
  ).length === 0
)

// ClickUp's four words, and anything else is the neutral: this is somebody
// else's vocabulary and a workspace may have its own.
check("urgent is the loud one", clickupPriorityTone("urgent") === "rose")
check("high is next", clickupPriorityTone("high") === "amber")
check("normal is the plain one", clickupPriorityTone("normal") === "blue")
check("case does not count", clickupPriorityTone("  Urgent ") === "rose")
check(
  "a word this build has not heard of is neutral",
  clickupPriorityTone("blocker") === "slate"
)

section("the newest comment")

{
  // Read by date rather than by position: ClickUp returns comments newest first
  // on a task and oldest first on a list, and trusting the order announces the
  // wrong one on exactly one of the two.
  const newest = newestComment({
    comments: [
      {
        id: "c1",
        date: "1000",
        comment_text: "first",
        user: { username: "A" },
      },
      {
        id: "c2",
        date: "3000",
        comment_text: "latest",
        user: { username: "B" },
      },
      {
        id: "c3",
        date: "2000",
        comment_text: "middle",
        user: { username: "C" },
      },
    ],
  })
  check("the newest by date wins", newest?.id === "c2")
  check("with its author", newest?.by === "B")
  check("and its text", newest?.text === "latest")
}
check("no comments is null", newestComment({ comments: [] }) === null)
check("no comments key is null", newestComment({}) === null)
check(
  "a comment with no id is skipped",
  newestComment({ comments: [{ date: "9000", comment_text: "x" }] }) === null
)

section("what is worth interrupting somebody for")

// A task just added has no `before`, and announcing everything about it would
// mean adding a task always fired a banner about a status nobody changed.
check(
  "the first poll announces nothing",
  describeChanges(null, snap(), NOW).length === 0
)

check(
  "an unchanged task announces nothing",
  describeChanges(snap(), snap(), NOW).length === 0
)

// The whole reason `updatedAt` is not reported on its own: ClickUp moves it for
// custom fields, subtasks and time entries this app cannot see, and a banner
// saying "updated" with nothing under it trains somebody to ignore the lot.
check(
  "a bumped timestamp alone announces nothing",
  describeChanges(snap(), snap({ updatedAt: 9_999 }), NOW).length === 0
)

{
  const changes = describeChanges(snap(), snap({ status: "in progress" }), NOW)
  check("a status change is announced", changes.length === 1)
  check("in words", changes[0]?.text === "Status → in progress")
  check("stamped with when this app noticed", changes[0]?.at === NOW)
  // The sentence names only what the field became; the dialog draws both sides,
  // and gets them from here rather than parsing this app's own English.
  check("and with both sides of it", changes[0]?.kind === "status")
  check("what it was", changes[0]?.from === "to do")
  check("what it became", changes[0]?.to === "in progress")
}

{
  // "none" rather than an empty string on either side: these are drawn, and a
  // blank half either side of the arrow reads as a bug.
  const cleared = describeChanges(snap({ priority: "urgent" }), snap(), NOW)[0]
  check("a cleared field says none", cleared?.from === "urgent")
  check("on the side that lost it", cleared?.to === "none")

  const emptied = describeChanges(
    snap({ assignees: ["Tanaka"] }),
    snap(),
    NOW
  )[0]
  check("an empty assignee list says nobody", emptied?.to === "nobody")

  const due = describeChanges(
    snap({ due: Date.parse("2026-09-05T00:00:00.000Z") }),
    snap(),
    NOW
  )[0]
  // The day in UTC on both sides, for the reason the sentence uses it.
  check("a due date carries its day", due?.from === "2026-09-05")
  check("and none where it was cleared", due?.to === "none")
}

{
  // Nothing to put on the left of an arrow: the edit has no readable before,
  // and the comment before a comment is a different comment.
  const edited = describeChanges(
    snap(),
    snap({ description: "IN: email, password" }),
    NOW
  )[0]
  check(
    "a description edit is a kind with no values",
    edited?.kind === "description"
  )
  check("neither side", edited?.from === undefined && edited?.to === undefined)

  const said = describeChanges(
    snap(),
    snap({ comment: { id: "c1", by: "Tanaka", text: "hi", at: 5 } }),
    NOW
  )[0]
  check("a comment carries who said it", said?.from === "Tanaka")
  check("and nothing it replaced", said?.to === undefined)
}

check(
  "a rename is announced",
  describeChanges(snap(), snap({ name: "Add SSO login" }), NOW)[0]?.text ===
    "Renamed to “Add SSO login”"
)
check(
  "being assigned is announced",
  describeChanges(snap(), snap({ assignees: ["Tanaka"] }), NOW)[0]?.text ===
    "Assigned to Tanaka"
)
check(
  "being unassigned is announced",
  describeChanges(snap({ assignees: ["Tanaka"] }), snap(), NOW)[0]?.text ===
    "Unassigned"
)
check(
  "a priority change is announced",
  describeChanges(snap(), snap({ priority: "urgent" }), NOW)[0]?.text ===
    "Priority → urgent"
)
// The day in UTC, since ClickUp stores a date-only due as midnight UTC — read
// locally it names the day before for everybody west of Greenwich.
check(
  "a due date is announced as its own day",
  describeChanges(
    snap(),
    snap({ due: Date.parse("2026-09-05T00:00:00.000Z") }),
    NOW
  )[0]?.text === "Due 2026-09-05"
)
{
  const edited = describeChanges(
    snap(),
    snap({ description: "IN: email, password" }),
    NOW
  )[0]
  // The sentence stays what fits in a row and in an OS banner…
  check(
    "the description moving is one sentence",
    edited?.text === "Description edited"
  )
  // …and both texts ride along, since the dialog diffs them and there is
  // nowhere to fetch the old one from: ClickUp only serves what a task has now.
  check("carrying what it was", edited?.body?.before === "IN: email")
  check("and what it became", edited?.body?.after === "IN: email, password")
}

{
  // A description that is a spec, fifty changes deep, in a file rewritten every
  // two minutes: cut, and the cut is marked rather than silent — a diff whose
  // last line simply stops reads as the rest having been deleted.
  const huge = "y".repeat(CLICKUP_BODY_MAX + 500)
  const cut = describeChanges(snap(), snap({ description: huge }), NOW)[0]
  check(
    "a long description is capped",
    (cut?.body?.after.length ?? 0) < huge.length
  )
  check(
    "and says it was cut",
    cut?.body?.after.includes("cut by Yasuo") === true
  )
}

{
  const comment = {
    id: "c1",
    by: "Tanaka",
    text: "これ、少し違いますね",
    at: 5,
  }
  const changes = describeChanges(snap(), snap({ comment }), NOW)
  check("a new comment is announced", changes.length === 1)
  check("as who said what", changes[0]?.text === "Tanaka: これ、少し違いますね")
  // Against nothing, which diffs as the whole of it added — and is what makes
  // a comment the row had to cut at 120 characters readable in full.
  check("with the whole of it", changes[0]?.body?.after === comment.text)
  check("against nothing", changes[0]?.body?.before === "")
}

{
  // An edited comment keeps its id, so it is announced as an **edit** and never
  // as a new comment: the second would say somebody commented when nobody did,
  // which is the failure this whole function is written against.
  const before = snap({ comment: { id: "c1", by: "A", text: "one", at: 5 } })
  const after = snap({
    comment: { id: "c1", by: "A", text: "one edited", at: 9 },
  })
  const changes = describeChanges(before, after, NOW)
  check("the same comment edited is announced once", changes.length === 1)
  check("as an edit, not as a comment", changes[0]?.kind === "comment-edited")
  check("with both texts to diff", changes[0]?.body?.before === "one")
  check("and the new one", changes[0]?.body?.after === "one edited")
}

{
  // The one that would fire every two minutes if the edit check were on the
  // timestamp rather than on the text.
  const same = { id: "c1", by: "A", text: "one", at: 5 }
  check(
    "a comment that did not change announces nothing",
    describeChanges(snap({ comment: same }), snap({ comment: same }), NOW)
      .length === 0
  )
}

{
  const before = snap({ comment: { id: "c1", by: "A", text: "one", at: 5 } })
  const after = snap({ comment: { id: "c2", by: "B", text: "two", at: 9 } })
  check(
    "a different newest comment is a new comment",
    describeChanges(before, after, NOW)[0]?.text === "B: two"
  )
}

{
  const long = "x".repeat(400)
  const changes = describeChanges(
    snap(),
    snap({ comment: { id: "c1", by: "A", text: long, at: 5 } }),
    NOW
  )
  // Cut here rather than by CSS, so a row and an OS banner — which does its own
  // wrapping — say the same thing.
  check("a long comment is cut", (changes[0]?.text.length ?? 0) <= 130)
  check("with an ellipsis", changes[0]?.text.endsWith("…") === true)
}

{
  const changes = describeChanges(
    snap(),
    snap({
      status: "in progress",
      assignees: ["Duong"],
      comment: { id: "c9", by: "Tanaka", text: "started", at: 9 },
    }),
    NOW
  )
  check("several changes at once are several sentences", changes.length === 3)
}

section("unread is derived, so the history survives being read")

function watch(over: Partial<ClickupWatch> = {}): ClickupWatch {
  return {
    id: "86eutavc5",
    teamId: null,
    url: "https://app.clickup.com/t/86eutavc5",
    seen: snap(),
    history: [],
    readAt: null,
    addedAt: "2026-09-01T00:00:00.000Z",
    polledAt: null,
    error: null,
    ...over,
  }
}

// A declaration rather than `const change = () => ({…})`: this file has no
// semicolons, and an arrow returning an object literal followed by a bare block
// is one expression to the parser.
function change(at: string, text = "Status → done"): ClickupChange {
  return { text, at }
}

{
  const history = [
    change("2026-09-05T12:00:00.000Z"),
    change("2026-09-05T09:00:00.000Z"),
    change("2026-09-04T09:00:00.000Z"),
  ]
  const read = watch({ history, readAt: "2026-09-05T10:00:00.000Z" })

  check(
    "only what landed after the last look is unread",
    unreadIn(read).length === 1
  )
  check(
    "and it is the newest",
    unreadIn(read)[0]?.at === "2026-09-05T12:00:00.000Z"
  )
  // The whole point of `readAt` over a consumed list: reading does not destroy
  // the log the expanded row draws.
  check("the history is untouched by reading", read.history.length === 3)
}

check(
  "a task never opened has everything unread",
  unreadIn(watch({ history: [change("2026-09-05T12:00:00.000Z")] })).length ===
    1
)
check(
  "a task added and not touched has nothing unread",
  unreadIn(watch({ readAt: "2026-09-01T00:00:00.000Z" })).length === 0
)
// A record written before `history` existed reads as empty rather than throwing.
check(
  "a record with no history is not a crash",
  unreadIn({ ...watch(), history: undefined as unknown as ClickupChange[] })
    .length === 0
)

check(
  "the header counts tasks, not changes",
  unreadWatchCount([
    watch({
      id: "a",
      history: [
        change("2026-09-05T12:00:00.000Z"),
        change("2026-09-05T11:00:00.000Z"),
      ],
    }),
    watch({
      id: "b",
      readAt: "2026-09-06T00:00:00.000Z",
      history: [change("2026-09-05T12:00:00.000Z")],
    }),
  ]) === 1
)

section("folding a poll's answer into a record")

{
  const before = watch({
    seen: snap(),
    history: [change("2026-09-01T00:00:00.000Z")],
  })
  const { watch: after, changes } = fold(
    before,
    snap({ status: "in progress" }),
    NOW
  )

  check("the snapshot is written back", after.seen?.status === "in progress")
  check("polledAt moves", after.polledAt === NOW)
  check("the change is reported", changes[0]?.text === "Status → in progress")
  check("and lands at the head of the history", after.history[0]?.at === NOW)
  check("above what was already there", after.history.length === 2)
}

{
  // The snapshot is written back even with nothing to announce: it carries the
  // comment id and timestamps the *next* poll is diffed against.
  const before = watch({ seen: snap(), polledAt: "2026-09-01T00:00:00.000Z" })
  const { watch: after, changes } = fold(
    before,
    snap({ updatedAt: 9_999 }),
    NOW
  )
  check("a quiet poll announces nothing", changes.length === 0)
  check("but still moves polledAt", after.polledAt === NOW)
  check("and still stores the snapshot", after.seen?.updatedAt === 9_999)
}

{
  // **The bug this function was pulled out for.** A record written before
  // `history` existed has none, and spreading `undefined` threw — which killed
  // the whole poll before it wrote anything, on every tick, silently.
  const legacy = {
    ...watch({ seen: snap() }),
    history: undefined as unknown as ClickupChange[],
    readAt: undefined as unknown as string | null,
  }
  const { watch: after } = fold(legacy, snap({ status: "done" }), NOW)
  check(
    "a record with no history folds rather than throwing",
    after.history.length === 1
  )
  check("its readAt reads as never opened", after.readAt === null)
  check("and the change is unread", unreadIn(after).length === 1)
}

{
  const many = Array.from({ length: 60 }, (_, at) =>
    change(`2026-08-${String((at % 28) + 1).padStart(2, "0")}T00:00:00.000Z`)
  )
  const { watch: after } = fold(
    watch({ seen: snap(), history: many }),
    snap({ status: "done" }),
    NOW
  )
  // Capped, or the file grows without bound on a task somebody argues over for
  // a month.
  check("the history is capped", after.history.length === 50)
  check("keeping the newest", after.history[0]?.at === NOW)
}

{
  // A row that had been failing stops saying so the moment it reads.
  const { watch: after } = fold(
    watch({ seen: snap(), error: "ClickUp refused the key." }),
    snap(),
    NOW
  )
  check("a successful poll clears the error", after.error === null)
}

finish()
