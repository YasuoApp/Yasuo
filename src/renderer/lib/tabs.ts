import type { Pane } from "./store"

/**
 * How the workbench's one tab strip addresses tabs belonging to four panels.
 *
 * The strip hands back an id and nothing else, so which panel a tab belongs to
 * has to travel in the id itself — `db:public.users`, `api:<uuid>`. Kept apart
 * from the component so the ordering below can be tested without pulling the
 * renderer in with it.
 */
export const PREFIX: Record<Pane, string> = {
  files: "file:",
  // The id after it is a **root** id rather than anything the panel made up:
  // there is one `Changes` tab per project, and that is what it is about.
  changes: "changes:",
  worktree: "chat:",
  workflows: "workflow:",
}

/**
 * What marks a tab id as a *group's* rather than one of the panel's own.
 *
 * A grouped strip holds one tab per folder, and that tab has to be addressable
 * exactly like any other — the order, the drag, `⌘W` and `neighbour` all work
 * on strip ids and must not learn a second shape. So a group is
 * `api:@<folderId>` where one of its requests is `api:<requestId>`.
 *
 * A character rather than a longer marker, and this one because no id it has to
 * stay clear of can start with it: a file tab is an absolute path, and the rest
 * are uuids. Without it the API panel would collide with itself — a folder
 * there can be open as a tab *and* be the group its requests gather into.
 */
export const GROUP = "@"

/**
 * Which panel a strip id belongs to.
 *
 * **Read off `PREFIX` rather than listed here**, and that is the whole point:
 * this was five hand-written `if`s against a map of six, and the one it had
 * fallen behind on was `changes`. Nothing failed loudly — `selectTab` and
 * `closeTab` both open with `const kind = kindOf(id); if (!kind) return`, so the
 * `Changes` tab simply could not be selected or closed, and its ✕ did nothing at
 * all. A list that has to be kept in step with another list is a list that will
 * not be.
 *
 * The loop relies on no prefix beginning with another, or the answer would be
 * whichever happened to be tested first; `test/tabs.ts` asserts that separately,
 * which is what makes iterating in insertion order safe.
 */
export function kindOf(id: string): Pane | null {
  for (const [pane, prefix] of Object.entries(PREFIX) as [Pane, string][]) {
    if (id.startsWith(prefix)) return pane
  }
  return null
}

/** The id as its own panel knows it, with the prefix taken back off. Still
 * carries the `GROUP` marker when it is a group's — `isGroup` is the question,
 * and `bareGroup` takes the marker off. */
export function bare(id: string, kind: Pane): string {
  return id.slice(PREFIX[kind].length)
}

/** The strip id of one group of a panel's tabs. */
export function groupTabId(kind: Pane, group: string): string {
  return PREFIX[kind] + GROUP + group
}

/** Whether a bare id names a group rather than one of the panel's own tabs. */
export function isGroup(bareId: string): boolean {
  return bareId.startsWith(GROUP)
}

/** The group's own id — a folder id — with the marker taken back off. */
export function bareGroup(bareId: string): string {
  return bareId.slice(GROUP.length)
}

/**
 * The tab that takes a closed one's place: the one after it in the strip, or —
 * closing the tab at the end — the one before.
 *
 * `order` is the strip as it stood *before* the close, so the id being closed
 * is still in it. Neither neighbour is necessarily the closed tab's own panel's:
 * that is the point, and it is what lets closing the last table leave the pane
 * on the session sitting next to it rather than on an empty Database panel.
 */
export function neighbour(order: string[], closed: string): string | null {
  const index = order.indexOf(closed)
  if (index === -1) return null
  return order[index + 1] ?? order[index - 1] ?? null
}

/**
 * The open tabs in the order the user arranged them.
 *
 * `order` is the last arrangement and `open` is what is actually open now, and
 * neither is authoritative alone: the first goes stale as tabs are opened and
 * closed, the second knows nothing about a drag. So this reconciles them on
 * every render, which is what lets the stored order be written once on drop and
 * never maintained afterwards — an id for a tab that has since closed simply
 * matches nothing.
 *
 * A tab the order has never seen is one opened since the last drag. It goes
 * after the last tab of its own panel rather than at the end of the strip, so
 * opening a second table still puts it beside the first even in a strip that
 * has been interleaved. With no tab of that panel on screen, it goes at the end.
 *
 * Generic over the item so the test does not have to build a `TabStripItem`
 * with an icon and a label to ask a question about ordering.
 */
export function arrange<T extends { id: string }>(
  open: T[],
  order: string[]
): T[] {
  if (order.length === 0) return open

  const remaining = new Map(open.map((item) => [item.id, item]))
  const arranged: T[] = []

  for (const id of order) {
    const item = remaining.get(id)
    if (!item) continue
    arranged.push(item)
    // An id repeated in a stale order must not place the same tab twice.
    remaining.delete(id)
  }

  // Whatever is left, walked in the given order so several new tabs of one
  // panel keep their own sequence.
  for (const item of open) {
    if (!remaining.has(item.id)) continue
    remaining.delete(item.id)

    const kind = kindOf(item.id)
    let after = -1
    for (let index = arranged.length - 1; index >= 0; index -= 1) {
      if (kindOf(arranged[index]!.id) === kind) {
        after = index
        break
      }
    }
    if (after === -1) arranged.push(item)
    else arranged.splice(after + 1, 0, item)
  }

  return arranged
}
