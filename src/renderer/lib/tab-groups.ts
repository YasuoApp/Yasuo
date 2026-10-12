/**
 * Gathering a panel's tabs into one tab per folder.
 *
 * The workbench strip is shared by five panels, and a panel that opens a tab
 * per thing spends the strip faster than the other four together: eight files
 * of one repository, a shell and an agent beside them, and the table somebody
 * is actually comparing against has been scrolled off the end. Grouped, the
 * strip says which folder and a second strip inside the tab says which of its
 * files — two questions that stop sharing a row.
 *
 * What a group *is* differs per panel — a workspace folder for the Explorer's
 * files and the sessions, a folder in the panel's own tree for a request or a
 * note — so `groupOf` is each panel's answer in `lib/panels.ts`. What is here
 * is the shape of the thing, which is the same for all of them, and is pure so
 * that `test/tab-groups.ts` can ask about it without a store.
 */

/**
 * The groups a list falls into, in the order their tabs appear.
 *
 * First appearance wins, which is what keeps a folder's tab still while its own
 * members come and go: opening a ninth file in a folder already in the strip
 * moves nothing.
 */
export function groupIds<T>(items: T[], of: (item: T) => string): string[] {
  return [...new Set(items.map(of))]
}

/** One group's members, in the panel's own order. */
export function membersOf<T>(
  items: T[],
  of: (item: T) => string,
  group: string
): T[] {
  return items.filter((item) => of(item) === group)
}

/**
 * The list rearranged so its groups appear in `order`, each group's own members
 * keeping their sequence — what dragging a folder's tab across the strip means
 * for the panel underneath it.
 *
 * A group `order` does not name keeps its members, after the ones it does: the
 * strip only ever hands back the tabs it is drawing, and a panel may hold more
 * than the strip shows.
 */
export function orderGroups<T>(
  items: T[],
  of: (item: T) => string,
  order: string[]
): T[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(of(item))
    if (group) group.push(item)
    else groups.set(of(item), [item])
  }

  const named = order.filter((group) => groups.has(group))
  const rest = [...groups.keys()].filter((group) => !named.includes(group))

  return [...named, ...rest].flatMap((group) => groups.get(group)!)
}

/**
 * The list with the items `picks` matches replaced by `members`, written back
 * into the slots they already occupy.
 *
 * In place rather than appended, which is the whole point: a drag that only
 * ever saw *some* of what a panel holds must not move the rest. Two callers
 * want exactly that — reordering one folder's files cannot move another
 * folder's tab in the strip above, and reordering the strip cannot disturb the
 * tabs of a checkout that is not on screen.
 *
 * A `members` that does not name exactly what `picks` matches is refused: a
 * stale list is a list some of whose tabs have closed, and dropping them here
 * would close them a second way.
 */
export function orderWhere<T>(
  items: T[],
  picks: (item: T) => boolean,
  members: T[]
): T[] {
  const own = items.filter(picks)
  if (
    members.length !== own.length ||
    !members.every((member) => own.includes(member))
  ) {
    return items
  }

  let next = 0
  return items.map((item) => (picks(item) ? members[next++]! : item))
}

/** One group's members reordered, leaving every other group's exactly where
 * they are — `orderWhere` with "is in this group" as the predicate. */
export function orderWithin<T>(
  items: T[],
  of: (item: T) => string,
  group: string,
  members: T[]
): T[] {
  return orderWhere(items, (item) => of(item) === group, members)
}
