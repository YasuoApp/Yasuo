import {
  groupIds,
  membersOf,
  orderGroups,
  orderWhere,
  orderWithin,
} from "../src/renderer/lib/tab-groups"
import { check, finish, section } from "./harness"

/**
 * Gathering a panel's tabs under the folder each belongs to.
 *
 * Two strips are built from these: the workbench's, which holds one tab per
 * folder, and the one inside a folder's tab, which holds that folder's own. So
 * a wrong answer here is not an error — it is a tab that jumps to another
 * project when somebody drags one, or a file that disappears out of the folder
 * it is filed under. Pure on purpose, so this can ask without five stores.
 */

/** A tab and the folder it is filed under, short enough to read in a failure. */
const FOLDER: Record<string, string> = {
  "App.tsx": "web",
  "store.ts": "web",
  "index.css": "web",
  "main.go": "api",
  "db.sql": "api",
  "notes.md": "",
}
const of = (id: string) => FOLDER[id] ?? ""

const web = ["App.tsx", "store.ts", "index.css"]
const api = ["main.go", "db.sql"]
const all = [...web, ...api, "notes.md"]

section("which folders the strip holds")

check(
  "one entry per folder, in the order their tabs first appear",
  groupIds(all, of).join() === ["web", "api", ""].join()
)

check(
  "a folder opened between two of another's does not appear twice",
  groupIds(["App.tsx", "main.go", "store.ts"], of).join() ===
    ["web", "api"].join()
)

check(
  "a folder's own tabs, in the panel's order",
  membersOf(all, of, "web").join() === web.join()
)

check(
  "the top level is a folder like any other",
  membersOf(all, of, "").join() === "notes.md"
)

section("dragging a folder's tab across the strip")

check(
  "the folder moves with everything filed under it",
  orderGroups(all, of, ["api", "web", ""]).join() ===
    [...api, ...web, "notes.md"].join()
)

check(
  "and each folder's own tabs keep their sequence",
  orderGroups(all, of, ["api", "web", ""]).slice(2, 5).join() === web.join()
)

check(
  "a folder the strip did not name keeps its tabs, after the ones it did",
  orderGroups(all, of, ["api"]).join() === [...api, ...web, "notes.md"].join()
)

section("dragging inside a folder's tab")

check(
  "the folder's own tabs are reordered",
  membersOf(
    orderWithin(all, of, "web", ["index.css", "App.tsx", "store.ts"]),
    of,
    "web"
  ).join() === ["index.css", "App.tsx", "store.ts"].join()
)

/*
 * The one that would go unnoticed: the two strips answer two questions, and a
 * drag in the inner one has no business being visible in the outer. Written
 * back into the slots the folder already occupies rather than appended, so the
 * folders themselves cannot change places.
 */
check(
  "and no other folder's tab moves",
  groupIds(
    orderWithin(all, of, "web", ["index.css", "App.tsx", "store.ts"]),
    of
  ).join() === ["web", "api", ""].join()
)

check(
  "a stale list — one whose tabs are not the folder's — is refused",
  orderWithin(all, of, "web", ["App.tsx", "store.ts"]).join() === all.join()
)

check(
  "so is one naming a tab from somewhere else",
  orderWithin(all, of, "web", ["App.tsx", "store.ts", "main.go"]).join() ===
    all.join()
)

/*
 * The strip is per checkout, so a drag in it has only ever seen *some* of what
 * the panel holds — and the panel's `reorder` replaces its whole list. This is
 * what keeps the tabs of the branch nobody is looking at from closing on a drag.
 *
 * `web` stands in for the checkout on screen here: the same predicate shape,
 * asked about scope rather than about a folder.
 */
section("dragging a strip that is only part of what a panel holds")

const shown = (id: string) => of(id) === "web"

check(
  "the shown tabs are reordered",
  orderWhere(all, shown, ["index.css", "App.tsx", "store.ts"]).join() ===
    ["index.css", "App.tsx", "store.ts", "main.go", "db.sql", "notes.md"].join()
)

check(
  "and the ones the strip never drew are still there, in their own slots",
  orderWhere(all, shown, ["index.css", "App.tsx", "store.ts"])
    .filter((id) => !shown(id))
    .join() === ["main.go", "db.sql", "notes.md"].join()
)

check(
  "a list missing one of the shown tabs is refused rather than closing it",
  orderWhere(all, shown, ["index.css", "App.tsx"]).join() === all.join()
)

check(
  "and so is one naming a tab the strip was not drawing",
  orderWhere(all, shown, ["App.tsx", "store.ts", "main.go"]).join() ===
    all.join()
)

finish()
