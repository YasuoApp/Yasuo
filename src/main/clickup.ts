import {
  CLICKUP_BODY_MAX,
  type ClickupBody,
  type ClickupChange,
  type ClickupComment,
  type ClickupSnapshot,
} from "../shared/api"

/**
 * The one place this app talks to ClickUp, and it only ever **reads**.
 *
 * What it reads for is the watcher: a handful of tasks somebody pasted the URL
 * of, polled so that a status change or a customer's comment reaches them here
 * rather than in an email an hour later. Nothing is written back — this app has
 * no business being a second writer on a task somebody else is working in, and
 * a watcher that could edit is a watcher whose failures are expensive.
 *
 * Free of `electron`, the way `git.ts`, `notify.ts` and `updater.ts` are: the
 * token is an **argument** rather than something fetched from `Store`, so
 * `test/clickup-watch.ts` can run the parts worth testing under plain `bun`.
 *
 * It answers with a sentence rather than throwing, for the reason
 * `OneTurnResult` does — a deleted task, an expired key and a machine on a
 * train are all one line in a row, and one row failing must not take the other
 * nine down with it.
 */

/** ClickUp's own v2 API. A constant so a test can point at something else. */
const API = "https://api.clickup.com/api/v2"

/**
 * Long enough for a slow connection, short enough that a wrong host does not
 * hold the poll open past the next tick. A poll has nothing else to do while it
 * waits, but the tick after it does.
 */
const TIMEOUT_MS = 15_000

/** A task reference, as a pasted URL yields one. */
export type TaskRef = { id: string; teamId: string | null }

/**
 * The task a pasted ClickUp URL names, or null.
 *
 * Both shapes people actually paste are accepted, and they differ by whether
 * the workspace id is in the path:
 *
 * - `https://app.clickup.com/t/90181720832/86eutavc5` — workspace, then task
 * - `https://app.clickup.com/t/86eutavc5` — task alone
 *
 * The task is therefore the **last** segment and the workspace the one before
 * it, when there is one. A bare id typed without a URL is accepted too, since
 * somebody who has one has already done the parsing by hand.
 *
 * Query strings and trailing slashes are cut before the split: a URL copied out
 * of the address bar routinely carries `?block=…` from ClickUp's own routing,
 * and a task id with a query glued to it matches nothing with no hint as to
 * why.
 *
 * A **custom** id (`ABC-123`) is a task too, and is why `teamId` is kept rather
 * than dropped once the task id is out: it cannot be looked up without one.
 */
export function taskRefIn(typed: string): TaskRef | null {
  const text = typed.trim()
  if (!text) return null

  // A watch's URL is opened in the user's browser and put on a notification, so
  // what may be stored as one is settled **here**: anything with a scheme has
  // to be a web link. Without this a pasted `file:///t/x` would be a watched
  // "task" whose row asks the OS to open a path nobody chose.
  if (text.includes("://") && !/^https?:\/\//i.test(text)) return null

  const at = text.indexOf("/t/")
  if (at === -1) {
    // Not a URL at all. A bare id is one word of the characters ClickUp uses;
    // anything with a space or a slash in it is somebody pasting the wrong
    // thing, and guessing at it would watch a task nobody asked for.
    return /^[A-Za-z0-9_-]+$/.test(text) ? { id: text, teamId: null } : null
  }

  const path = text
    .slice(at + 3)
    .split(/[?#]/)[0]!
    .split("/")
    .filter((part) => part.length > 0)

  const id = path.at(-1)
  if (!id) return null
  // Only when there is something before the task, and only when it looks like
  // an id rather than a word: `app.clickup.com/t/<task>` has nothing there, and
  // reading whatever is as a workspace would send a custom-id lookup at random.
  const before = path.length > 1 ? path.at(-2) : undefined
  const teamId = before && /^\d+$/.test(before) ? before : null
  return { id, teamId }
}

/** What `fetchTask` answers with: what one poll saw, or why it could not. */
export type SnapshotAnswer = { snapshot: ClickupSnapshot } | { error: string }

/**
 * One task as the watcher needs it, comments included.
 *
 * **Two requests, deliberately.** The task itself does not carry its comments,
 * and a comment is the single thing most worth being told about — a customer
 * asking a question on a task is exactly the event this feature exists for. At
 * a handful of tasks on a two-minute tick that is well inside the 100
 * requests a minute a personal token is allowed.
 *
 * The comments request is allowed to fail on its own: a task readable by a key
 * whose comments are not is a task still worth watching for a status change,
 * and refusing the whole snapshot over it would turn a partial answer into a
 * row that says only "error".
 */
export async function fetchTask(
  token: string,
  ref: TaskRef,
  api = API
): Promise<SnapshotAnswer> {
  if (!token) return { error: NO_KEY }
  if (!ref.id) return { error: "That is not a ClickUp task URL." }

  // A custom id (`ABC-123`) needs both the flag and the workspace; a normal one
  // needs neither, and sending them anyway makes ClickUp look the id up in a
  // namespace it is not in.
  const custom = !/^[a-z0-9]+$/i.test(ref.id)
  if (custom && !ref.teamId) {
    return {
      error:
        "A custom task id needs the workspace in the URL — copy the link from the task itself.",
    }
  }
  const query = custom
    ? `?custom_task_ids=true&team_id=${encodeURIComponent(ref.teamId!)}`
    : ""

  const got = await get(
    token,
    `${api}/task/${encodeURIComponent(ref.id)}${query}`
  )
  if ("error" in got) return got

  const comments = await get(
    token,
    `${api}/task/${encodeURIComponent(ref.id)}/comment${query}`
  )

  return {
    snapshot: snapshotOf(
      got.body,
      "error" in comments ? null : newestComment(comments.body)
    ),
  }
}

/**
 * ClickUp's task JSON narrowed to what is diffed, with the newest comment.
 *
 * Everything is checked rather than cast: this is where a shape this app does
 * not own crosses into it, and a field read wrongly here is a notification that
 * fires every two minutes for a change that never happened.
 */
export function snapshotOf(
  value: unknown,
  comment: ClickupComment | null
): ClickupSnapshot {
  const task = (value ?? {}) as Record<string, unknown>
  return {
    name: str(task.name),
    status: str((task.status as { status?: unknown } | null)?.status),
    // ClickUp's **own** hue for that status, which is the one colour in this
    // feature that is not this app's invention: the pane draws the same dot the
    // user's board does, so "it went green" means the same thing in both. Kept
    // out of `describeChanges` on purpose — recolouring a status is not a change
    // to the task.
    statusColor: hexColor((task.status as { color?: unknown } | null)?.color),
    // The **word**, not the number: this is drawn in a row and never compared
    // against anything of this app's, so `urgent` is more use than `1`.
    priority: strOrNull(
      (task.priority as { priority?: unknown } | null)?.priority
    ),
    assignees: names(task.assignees),
    due: epoch(task.due_date),
    // `text_content` is the description with ClickUp's own markup stripped,
    // which is what a person typed and what a diff should compare.
    description: str(task.text_content ?? task.description),
    updatedAt: epoch(task.date_updated) ?? 0,
    comment,
  }
}

/**
 * A `#rgb` / `#rrggbb` / `#rrggbbaa` from ClickUp, or null for anything else.
 *
 * Checked **here**, on the way in, rather than where it is drawn: this is the
 * one value in the feature that ends up in a CSS `style` rather than in a
 * Tailwind class, and a string from somebody else's API reaching a style
 * property unchecked is how a colour becomes a payload. The renderer can then
 * use whatever this returns without asking again.
 */
export function hexColor(value: unknown): string | null {
  if (typeof value !== "string") return null
  const hex = value.trim()
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex) ? hex : null
}

/** The newest comment in ClickUp's `comments` array, or null. */
export function newestComment(value: unknown): ClickupComment | null {
  const list = (value as { comments?: unknown } | null)?.comments
  if (!Array.isArray(list)) return null

  let newest: ClickupComment | null = null
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const raw = entry as Record<string, unknown>
    const id = str(raw.id)
    if (!id) continue
    const at = epoch(raw.date) ?? 0
    // By date rather than by position: ClickUp returns comments newest first
    // on a task and oldest first on a list, and a reader that trusted the order
    // would announce the wrong one on exactly one of the two.
    if (newest && at <= newest.at) continue
    newest = {
      id,
      by: str((raw.user as { username?: unknown } | null)?.username),
      // `comment_text` is the flattened text; `comment` is an array of blocks.
      text: str(raw.comment_text),
      at,
    }
  }
  return newest
}

/**
 * What changed between two polls, as the sentences a row and a notification
 * both draw.
 *
 * **The first poll is not a change.** A task added to the watch list arrives
 * with no `before`, and announcing everything about it would mean adding a task
 * always fired a notification about a status nobody had changed.
 *
 * `updatedAt` alone is deliberately **not** reported. ClickUp moves
 * `date_updated` for things this app cannot see — a custom field, a
 * subtask, a time entry — and a row that says "updated" with nothing under it
 * is a row that trains somebody to ignore it. A poll where only the timestamp
 * moved yields no changes at all, which is the honest answer: something
 * happened, and this app cannot say what.
 */
export function describeChanges(
  before: ClickupSnapshot | null,
  after: ClickupSnapshot,
  now: string = new Date().toISOString()
): ClickupChange[] {
  if (!before) return []

  const at = now
  const changes: ClickupChange[] = []
  // The sentence is what a notification says; `kind` and the two values are
  // what the dialog draws instead of it, and are carried rather than parsed
  // back out of the English above.
  const say = (change: Omit<ClickupChange, "at">) =>
    changes.push({ ...change, at })

  if (before.status !== after.status) {
    say({
      text: `Status → ${after.status || "none"}`,
      kind: "status",
      from: before.status || "none",
      to: after.status || "none",
    })
  }
  if (before.name !== after.name) {
    say({
      text: `Renamed to “${after.name}”`,
      kind: "name",
      from: before.name,
      to: after.name,
    })
  }
  if (before.assignees.join() !== after.assignees.join()) {
    say({
      text:
        after.assignees.length === 0
          ? "Unassigned"
          : `Assigned to ${after.assignees.join(", ")}`,
      kind: "assignees",
      from: before.assignees.join(", ") || "nobody",
      to: after.assignees.join(", ") || "nobody",
    })
  }
  if ((before.priority ?? "") !== (after.priority ?? "")) {
    say({
      text: `Priority → ${after.priority ?? "none"}`,
      kind: "priority",
      from: before.priority ?? "none",
      to: after.priority ?? "none",
    })
  }
  if (before.due !== after.due) {
    say({
      text: after.due === null ? "Due date cleared" : `Due ${dayOf(after.due)}`,
      kind: "due",
      from: before.due === null ? "none" : dayOf(before.due),
      to: after.due === null ? "none" : dayOf(after.due),
    })
  }
  if (before.description !== after.description) {
    // The sentence is still "edited", because that is what fits in a row and in
    // an OS banner. What moved is carried beside it as both texts, for the
    // dialog to diff — the description is where requirements live, and "it
    // changed" is the least useful true thing this app could say about one.
    say({
      text: "Description edited",
      kind: "description",
      body: bodyOf(before.description, after.description),
    })
  }

  // A new comment is a **different** newest comment, not merely a newer one:
  // an edited comment keeps its id, and announcing that as new would say
  // somebody commented when nobody did.
  const said = after.comment
  if (said && said.id !== before.comment?.id) {
    // `from` is who said it so the dialog can draw the name apart from the
    // words; there is no `to`, since a comment has no previous value — the one
    // before it is a different comment. `body` is the **whole** comment against
    // nothing, so what the row had to cut at 120 characters is still readable.
    say({
      text: `${said.by || "Someone"}: ${oneLine(said.text)}`,
      kind: "comment",
      from: said.by || "Someone",
      body: bodyOf("", said.text),
    })
  } else if (said && before.comment && said.text !== before.comment.text) {
    // The same comment, reworded. This used to be announced as nothing at all,
    // and the reason was right for what it was aimed at: reporting it as a
    // *new* comment says somebody commented when nobody did. As its own kind it
    // says what happened, and the two texts make it worth reading — an argument
    // being edited under you is exactly what a watcher is for.
    //
    // Only the **newest** comment is watched, so an edit to an older one is
    // invisible here. That is the same bound `newestComment` already has.
    say({
      text: `${said.by || "Someone"} edited: ${oneLine(said.text)}`,
      kind: "comment-edited",
      from: said.by || "Someone",
      body: bodyOf(before.comment.text, said.text),
    })
  }

  return changes
}

/**
 * The two texts a change is diffed from, each cut to `CLICKUP_BODY_MAX`.
 *
 * The cut is marked rather than silent: a diff whose last line simply stops
 * reads as the rest of the paragraph having been deleted, which is a lie about
 * the very thing somebody opened it to check.
 */
function bodyOf(before: string, after: string): ClickupBody {
  return { before: capped(before), after: capped(after) }
}

function capped(text: string): string {
  if (text.length <= CLICKUP_BODY_MAX) return text
  return `${text.slice(0, CLICKUP_BODY_MAX)}\n\n[… cut by Yasuo, the rest is in ClickUp]`
}

/** A comment as one line of a row, cut where a row would cut it anyway — so
 * the ellipsis is this app's rather than CSS's, and reads the same in an OS
 * notification, which does its own wrapping. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return "commented"
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

/** A due date as the day it falls on, in UTC — ClickUp stores a date-only due
 * as midnight UTC, so reading it locally names the day before for everybody
 * west of Greenwich. */
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const NO_KEY = "No ClickUp key saved. Settings › ClickUp."

/**
 * One GET against ClickUp, with every way it can fail turned into a sentence.
 *
 * The one place the token is put on a request, and the one place ClickUp's
 * `err` field is read: it carries a readable reason on a 4xx (`Team not
 * authorized`) where the status code alone says nothing.
 */
async function get(
  token: string,
  url: string
): Promise<{ body: unknown } | { error: string }> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    // A timeout arrives here as a `TimeoutError` rather than as a status, and
    // its own message says nothing about ClickUp.
    const reason = error instanceof Error ? error.message : String(error)
    return { error: `Could not reach ClickUp: ${reason}` }
  }

  if (!response.ok) {
    const said = await readError(response)
    if (response.status === 401) return { error: "ClickUp refused the key." }
    if (response.status === 404) {
      return { error: "ClickUp has no such task, or the key cannot see it." }
    }
    return {
      error: `ClickUp answered ${response.status}${said ? `: ${said}` : ""}`,
    }
  }

  try {
    return { body: await response.json() }
  } catch {
    return { error: "ClickUp answered with something that was not JSON." }
  }
}

/** The `err` sentence out of a failed response, or empty. Never throws: this
 * runs on a path that is already reporting a failure. */
async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    const said = (body as { err?: unknown })?.err
    return typeof said === "string" ? said : ""
  } catch {
    return ""
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

/** ClickUp sends every timestamp as a string of milliseconds, and `Number("")`
 * is 0 — which would be a due date in 1970 and a change announced every poll. */
function epoch(value: unknown): number | null {
  const raw =
    typeof value === "string" ? value : typeof value === "number" ? value : null
  if (raw === null || raw === "") return null
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/** The assignees' names, in a stable order so that ClickUp reordering them is
 * not read as somebody being assigned. */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => str((entry as { username?: unknown } | null)?.username))
    .filter((name) => name.length > 0)
    .sort()
}
