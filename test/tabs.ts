import {
  arrange,
  bare,
  kindOf,
  neighbour,
  PREFIX,
} from "../src/renderer/lib/tabs"
import { check, finish, section } from "./harness"

/**
 * The workbench tab strip's ordering.
 *
 * The strip is one row over four panels, each of which owns only which tabs it
 * has open — so where a tab sits relative to another panel's is held apart from
 * all of them, written once when a drag lands and reconciled against reality on
 * every render afterwards. That reconciliation is what breaks quietly: it is
 * asked about a saved order that may name tabs that have since closed, and
 * about tabs opened since that the order has never seen, and a wrong answer is
 * a tab that jumps or disappears rather than an error.
 */

/** Ids as the strip builds them, short enough to read in a failure. */
const t1 = `${PREFIX.files}/w/src/users.ts`
const t2 = `${PREFIX.files}/w/src/orders.ts`
const t3 = `${PREFIX.files}/w/src/items.ts`
const a1 = `${PREFIX.worktree}chat-1`
const a2 = `${PREFIX.worktree}chat-2`
const x1 = `${PREFIX.changes}root-1`

const tab = (id: string) => ({ id })
const ids = (items: { id: string }[]) => items.map((item) => item.id)

section("no arrangement yet")

check(
  "an empty order leaves the panels grouped",
  ids(arrange([tab(t1), tab(a1), tab(t2)], [])).join() === [t1, a1, t2].join()
)

section("a tab dropped into another panel's run")

/** The reported bug: an API tab put between two Database tabs sprang back. */
const interleaved = [t1, a1, t2]
check(
  "the arrangement is what the strip shows",
  ids(arrange([tab(t1), tab(t2), tab(a1)], interleaved)).join() ===
    [t1, a1, t2].join(),
  ids(arrange([tab(t1), tab(t2), tab(a1)], interleaved))
)

check(
  "it survives the panels reporting their own tabs in their own order",
  ids(arrange([tab(a1), tab(t2), tab(t1)], interleaved)).join() ===
    [t1, a1, t2].join()
)

section("the order goes stale")

check(
  "an id for a closed tab matches nothing",
  ids(arrange([tab(t1), tab(a1)], [t1, t2, a1])).join() === [t1, a1].join()
)

check(
  "an id repeated in the order does not place the tab twice",
  ids(arrange([tab(t1), tab(a1)], [t1, a1, t1])).join() === [t1, a1].join()
)

check(
  "closing everything leaves nothing",
  arrange([], [t1, a1, t2]).length === 0
)

section("a tab opened since the last drag")

check(
  "a new table lands after the last table, not at the end of the strip",
  ids(arrange([tab(t1), tab(t2), tab(t3), tab(a1)], [t1, a1, t2])).join() ===
    [t1, a1, t2, t3].join(),
  ids(arrange([tab(t1), tab(t2), tab(t3), tab(a1)], [t1, a1, t2]))
)

check(
  "a new request lands after the last request",
  ids(arrange([tab(t1), tab(a1), tab(a2), tab(t2)], [t1, a1, t2])).join() ===
    [t1, a1, a2, t2].join()
)

check(
  "the first tab of a panel with none open goes to the end",
  ids(arrange([tab(t1), tab(a1), tab(x1)], [a1, t1])).join() ===
    [a1, t1, x1].join()
)

check(
  "several new tabs of one panel keep their own sequence",
  ids(arrange([tab(t1), tab(t2), tab(t3), tab(a1)], [a1, t1])).join() ===
    [a1, t1, t2, t3].join(),
  ids(arrange([tab(t1), tab(t2), tab(t3), tab(a1)], [a1, t1]))
)

check(
  "a strip whose whole order is stale still shows everything",
  ids(arrange([tab(t1), tab(a1)], ["db:gone", "api:gone"])).join() ===
    [t1, a1].join()
)

/**
 * What the pane falls back to. The bug this answers: closing the Database
 * panel's last tab left the pane on that panel's own "pick a table" notice
 * while two sessions were still in the strip, because the only panel asked was
 * the one that had just emptied.
 */
section("the tab beside a closed one")

check("the tab after it takes over", neighbour([t1, t2, x1], t2) === x1)
check(
  "closing the last tab falls back to the one before",
  neighbour([t1, t2, x1], x1) === t2
)
check("the only tab has no neighbour", neighbour([t1], t1) === null)
check(
  "a tab the strip does not hold has none",
  neighbour([t1, t2], x1) === null
)
check("neither does one in an empty strip", neighbour([], t1) === null)

section("ids carry their panel")

check("a file id names the files panel", kindOf(t1) === "files")
check("a chat id names the worktree panel", kindOf(a1) === "worktree")
check("a changes id names the changes panel", kindOf(x1) === "changes")
check("an unprefixed id names none", kindOf("public.users") === null)

/**
 * Every pane, not the three that happened to be spelled out above.
 *
 * `kindOf` was a hand-written list against a longer `PREFIX` map, and the
 * missing one was `changes` — which made that tab unselectable and
 * uncloseable, silently, because both callers give up on a null. The checks
 * above did not catch it because they name the panels one at a time. This one
 * cannot miss a panel: it is the map.
 */
check(
  "every panel's own prefix names it back",
  (Object.keys(PREFIX) as (keyof typeof PREFIX)[]).every(
    (pane) => kindOf(`${PREFIX[pane]}whatever`) === pane
  ),
  Object.keys(PREFIX).filter(
    (pane) => kindOf(`${PREFIX[pane as keyof typeof PREFIX]}whatever`) !== pane
  )
)

check("the prefix comes back off", bare(t1, "files") === "/w/src/users.ts")
check(
  // An absolute path is the id here, and `bare` must take the prefix off and
  // nothing else — a second colon belongs to the panel, not to us.
  "an id carrying a colon of its own survives the round trip",
  bare(`${PREFIX.files}a:b`, "files") === "a:b"
)

/**
 * No prefix may begin with another, or `kindOf` would answer with whichever it
 * happened to test first — a rule the map is small enough to hide a breach of.
 */
const prefixes = Object.values(PREFIX)
check(
  "no prefix is a prefix of another",
  prefixes.every((one) =>
    prefixes.every((other) => one === other || !other.startsWith(one))
  ),
  prefixes
)

finish()
