import { chatRootId } from "@shared/api"

import { useChanges } from "./files/changes"
import { useFiles } from "./files/store"
import { fileRoots, rootOfPath, shownRootOf } from "./files/roots"
import { useProjects } from "./projects"
import { useSettings } from "./settings"
import { PANES, useStudio, type Pane } from "./store"
import {
  groupIds,
  membersOf,
  orderGroups,
  orderWhere,
  orderWithin,
} from "./tab-groups"
import {
  arrange,
  bare,
  bareGroup,
  GROUP,
  groupTabId,
  isGroup,
  kindOf,
  neighbour,
  PREFIX,
} from "./tabs"
import { useWorktreeChats } from "./worktree-chat/store"
import { useWorkflows } from "./workflows/store"

/**
 * The five panels' tabs, addressed alike.
 *
 * The strip above the pane is one strip, so everything about a tab that is not
 * its label and its icon is the same question whichever panel it came from:
 * which tabs are open, which one the pane is showing, what happens when one is
 * picked, closed, or dragged somewhere else. Each panel used to answer those
 * for itself, and the answers only agreed by accident — closing the Database
 * panel's last tab left the pane on its own "pick a table" notice while the
 * strip still held two of another panel's, because nothing in that store had
 * any way to know they were there.
 *
 * So the panels keep what is genuinely theirs — a table's rows, a chat's turn,
 * a file's buffer — and the tab logic lives here, once. A panel joins the
 * strip by adding an entry to `PANELS`: six small functions, none of which
 * mention any other panel.
 *
 * Ids here are the strip's prefixed ones (`db:public.users`) at the edges and
 * the panel's own inside each entry; `PREFIX` and `bare` in `lib/tabs.ts` are
 * the translation, and are also what a test can reach without a store.
 */
type PanelTabs = {
  /** What this panel has open, in its own order, ids as the panel knows them. */
  open: () => string[]
  /** Which of them it would put on screen — null when it would show nothing. */
  active: () => string | null
  /** Puts one on screen, and the pane on this panel with it. */
  select: (id: string) => void
  /**
   * Keeps a tab the panel was only previewing — a double click on it.
   *
   * Only the Explorer has one: a file reached by a single click in the tree is
   * a look rather than an open, and every other panel's tabs are opened
   * deliberately from a list of things that already exist. A panel without one
   * simply has nothing for the second click to do.
   */
  keep?: (id: string) => void
  close: (id: string) => void
  closeOthers: (id: string) => void
  closeAll: () => void
  reorder: (ids: string[]) => void
  /**
   * Which folder one of this panel's tabs gathers into when the strip is
   * grouping them. A panel without one is never grouped; all four have one.
   *
   * What a folder *is* differs: the workspace folder a file sits in, the
   * project a chat is having its conversation in, the folder in the panel's
   * own tree a request is filed under, the schema a table belongs to.
   * `NO_GROUP` is the tab that is under none of them.
   */
  groupOf?: (id: string) => string
  /**
   * The **root** one of this panel's tabs belongs to — a workspace folder — or
   * null when the tab is not in one.
   *
   * What makes the strip per project. A panel that leaves this off is a panel
   * whose tabs belong to the *workspace*: a table and a saved request are the
   * workspace's by deliberate design, so they stay in the strip
   * whatever project is being worked in, and a half-written query does not
   * vanish because somebody clicked another one. Only the two panels whose tabs
   * are genuinely a project's have one — a file, and a chat that edits it.
   *
   * Null rather than absent for a tab whose root has *gone*: the frame between
   * a project leaving the workspace and its tabs closing. Such a tab stays in
   * the strip, because the alternative is a tab that exists and cannot be
   * reached.
   */
  rootOf?: (id: string) => string | null
}

/** The group a tab under no folder at all falls into. */
const NO_GROUP = ""

/*
 * Each panel's two questions, as functions of its store's state rather than
 * reads of it: the commands below want them through `getState`, and the hooks
 * at the bottom want the same derivation as a selector, subscribed to. Written
 * once here, they cannot drift apart.
 */
type FilesState = ReturnType<typeof useFiles.getState>

const fileActive = (state: FilesState): string | null =>
  state.selectedId && state.openIds.includes(state.selectedId)
    ? state.selectedId
    : null

/**
 * The **root** a file is in: a workspace folder (`lib/files/roots.ts`, which
 * takes the longest match — a folder added inside another one is still a
 * project of its own).
 *
 * Every file the Explorer can open is inside a root (`fileRoots` in
 * `main/ipc.ts` is what guarantees it), so `NO_GROUP` here is the frame between
 * a root going and its tabs closing.
 */
const fileGroupOf = (filePath: string): string =>
  rootOfPath(fileRoots(), filePath)?.id ?? NO_GROUP

/** The chat the strip has selected. */
const worktreeChatActive = (
  state: ReturnType<typeof useWorktreeChats.getState>
): string | null =>
  state.selectedId && state.openIds.includes(state.selectedId)
    ? state.selectedId
    : null

const changesActive = (
  state: ReturnType<typeof useChanges.getState>
): string | null =>
  state.selectedId && state.openIds.includes(state.selectedId)
    ? state.selectedId
    : null

const workflowActive = (
  state: ReturnType<typeof useWorkflows.getState>
): string | null =>
  state.selectedId && state.openIds.includes(state.selectedId)
    ? state.selectedId
    : null

/**
 * The root a file is in, for scoping — `fileGroupOf`'s answer, with the missing
 * case spelled as null rather than as the group tabs under nothing.
 */
const fileRootOf = (filePath: string): string | null =>
  rootOfPath(fileRoots(), filePath)?.id ?? null

/** The place a chat is in. A chat's root id *is* a `FileRoot.id` — both are
 * the project's folder id — so no translation is needed. */
const worktreeChatRootOf = (id: string): string | null => {
  const chat = useWorktreeChats
    .getState()
    .chats.find((candidate) => candidate.id === id)
  return chat ? chatRootId(chat) : null
}

/** The place a chat belongs to. Prefixed so a chat's group can never collide
 * with a group of any other panel's, which are only ever compared as strings. */
const worktreeChatGroupOf = (id: string): string => {
  const root = worktreeChatRootOf(id)
  return root ? `w:${root}` : NO_GROUP
}

/** The place a group names, or null when it is not one of a chat's — what the
 * strip's label and the pane's welcome block ask. Its id is a root's, which is
 * a project. */
export function groupRootId(group: string): string | null {
  return group.startsWith("w:") ? group.slice(2) : null
}

const PANELS: Record<Pane, PanelTabs> = {
  changes: {
    open: () => useChanges.getState().openIds,
    active: () => changesActive(useChanges.getState()),
    select: (id) => useChanges.getState().select(id),
    close: (id) => useChanges.getState().close(id),
    closeOthers: (id) => useChanges.getState().closeOthers(id),
    closeAll: () => useChanges.getState().closeAll(),
    reorder: (ids) => useChanges.getState().reorder(ids),
    // The tab's id **is** the root's, so this is the identity — an
    // `Changes` tab is about one project and belongs in the strip exactly
    // while that project is the one being worked in.
    rootOf: (id) => id,
  },
  files: {
    open: () => useFiles.getState().openIds,
    // `open` rather than `select`: a tab restored from the last launch, or one
    // reached from the strip after its document was pruned, has to be read
    // before the pane has anything to draw. Reading one already held is a no-op.
    select: (id) => void useFiles.getState().open(id),
    keep: (id) => useFiles.getState().keep(id),
    active: () => fileActive(useFiles.getState()),
    close: (id) => useFiles.getState().close(id),
    closeOthers: (id) => useFiles.getState().closeOthers(id),
    closeAll: () => useFiles.getState().closeAll(),
    reorder: (ids) => useFiles.getState().reorder(ids),
    groupOf: fileGroupOf,
    rootOf: fileRootOf,
  },
  /* A project's chats, grouped under it when grouping is switched on. */
  worktree: {
    open: () => useWorktreeChats.getState().openIds,
    active: () => worktreeChatActive(useWorktreeChats.getState()),
    select: (id) => useWorktreeChats.getState().select(id),
    close: (id) => useWorktreeChats.getState().close(id),
    closeOthers: (id) => useWorktreeChats.getState().closeOthers(id),
    closeAll: () => useWorktreeChats.getState().closeAll(),
    reorder: (ids) => useWorktreeChats.getState().reorder(ids),
    groupOf: worktreeChatGroupOf,
    rootOf: worktreeChatRootOf,
  },
  /* The workspace's workflows: no `rootOf`, so a tab stays in the strip
   * whichever project is being worked in — see `rootOf` on `PanelTabs`, which
   * was written for exactly this and had no panel to apply to until now. No
   * `groupOf` either, since there is no folder for one to gather into. */
  workflows: {
    open: () => useWorkflows.getState().openIds,
    active: () => workflowActive(useWorkflows.getState()),
    select: (id) => useWorkflows.getState().select(id),
    close: (id) => useWorkflows.getState().close(id),
    closeOthers: (id) => useWorkflows.getState().closeOthers(id),
    closeAll: () => useWorkflows.getState().closeAll(),
    reorder: (ids) => useWorkflows.getState().reorder(ids),
  },
}

/**
 * Which store each panel's tabs live in — what the group memory below watches.
 */
const STORES = {
  files: useFiles,
  changes: useChanges,
  worktree: useWorktreeChats,
  workflows: useWorkflows,
} as const

/**
 * How a panel is gathering its tabs right now, or null when it is not.
 *
 * The setting is read here rather than at each call site so there is one answer
 * to "is this panel grouped", and so that turning it off is immediate
 * everywhere: nothing about a group is stored, so the strip simply stops
 * folding and every tab is its own again.
 */
/**
 * The root the workbench is working in, or null before anything has been picked.
 *
 * `shownRootOf` and not a field of its own, because that is what the Explorer
 * draws and what the crumb in the title bar names: the strip has to agree with
 * both, including their fallbacks — the first project when nothing is picked, a
 * project when the remembered one has gone.
 */
function activeRootId(): string | null {
  const { folders } = useStudio.getState()
  const { activeFolderId } = useProjects.getState()
  return shownRootOf(folders, activeFolderId)?.id ?? null
}

/**
 * Whether one of a panel's tabs belongs in the strip right now.
 *
 * The strip is **per project** for the two panels whose tabs are a project's
 * — see `rootOf` on `PanelTabs`. Everything else is the workspace's and is
 * always in.
 *
 * "In the strip" is not "open": the tab stays open, its editor keeps its
 * document and its unsaved edits, and coming back to that project shows it
 * again. That distinction is the one `lib/files/roots.ts` was split for —
 * `shownRootOf` is what is drawn, `fileRootsOf` is what may be read — and this
 * is the same line drawn one level up.
 */
function inScope(pane: Pane, id: string): boolean {
  const { rootOf } = PANELS[pane]
  if (!rootOf) return true

  const root = activeRootId()
  // No project picked yet is no scope to enforce: hiding everything would be a
  // strip that empties itself on an empty workspace.
  if (root === null) return true

  const own = rootOf(id)
  return own === null || own === root
}

/** What a panel has in the strip: its own tabs, less the other projects'. */
function openInScope(pane: Pane): string[] {
  return PANELS[pane].open().filter((id) => inScope(pane, id))
}

function grouper(pane: Pane): ((id: string) => string) | null {
  const { groupOf } = PANELS[pane]
  if (!groupOf) return null
  return useSettings.getState().groupTabs ? groupOf : null
}

/** The ids a panel puts in the strip: its own tabs, or one per folder. */
function stripIds(pane: Pane): string[] {
  const ids = openInScope(pane)
  const of = grouper(pane)
  return of ? groupIds(ids, of).map((group) => GROUP + group) : ids
}

/** One group's tabs, in the panel's own order. Empty for a panel that is not
 * grouping, which has no groups to ask about. */
export function groupMembers(pane: Pane, group: string): string[] {
  const of = grouper(pane)
  return of ? membersOf(openInScope(pane), of, group) : []
}

/**
 * Which tab each group was last showing.
 *
 * Kept by watching the panels rather than written by `selectTab`, because a tab
 * is just as often picked from a sidebar, from `⌘P`, or by jumping to a
 * definition — none of which come through the strip. Each panel already knows
 * what it is showing; this only remembers the last answer per group, so that
 * coming back to a folder lands where it was left.
 *
 * A Map rather than anything on a store: it is a convenience that can be wrong
 * without consequence — an entry naming a tab that has since closed falls back
 * to the group's last — and nothing draws from it, so nothing has to re-render
 * when it changes. It is not written to disk for the same reason.
 */
const groupActive = new Map<string, string>()

for (const pane of PANES) {
  STORES[pane].subscribe(() => {
    const of = PANELS[pane].groupOf
    if (!of) return
    const active = PANELS[pane].active()
    if (active !== null) groupActive.set(groupTabId(pane, of(active)), active)
  })
}

/** The member a group's tab would show: the one it was left on, or its last. */
function shownMember(pane: Pane, group: string): string | null {
  const members = groupMembers(pane, group)
  const remembered = groupActive.get(groupTabId(pane, group))
  return (
    (remembered !== undefined && members.includes(remembered)
      ? remembered
      : members.at(-1)) ?? null
  )
}

/**
 * Every open tab as the strip shows it: prefixed ids, in the arranged order.
 *
 * Built from the same two things the strip itself is — each panel's membership
 * and the studio's `tabOrder` — but without a label or an icon in it, which is
 * what lets the commands below answer "which tab is next to this one" without
 * being handed anything by the component.
 */
export function tabIds(): string[] {
  const open = PANES.flatMap((pane) =>
    stripIds(pane).map((id) => ({ id: PREFIX[pane] + id }))
  )
  return arrange(open, useStudio.getState().tabOrder).map((item) => item.id)
}

/**
 * Puts a tab on screen.
 *
 * The pane follows from the panel's own `select`, so a table opened from the
 * tree and one opened from the strip behave alike.
 */
export function selectTab(id: string) {
  const kind = kindOf(id)
  if (!kind) return

  const own = bare(id, kind)
  if (!isGroup(own)) {
    PANELS[kind].select(own)
    return
  }

  // A group has no pane of its own: what it puts on screen is one of its
  // members, and the second strip inside the tab is how the others are reached.
  const member = shownMember(kind, bareGroup(own))
  if (member !== null) PANELS[kind].select(member)
}

/**
 * Keeps the tab a double click landed on — see `PanelTabs.keep`.
 *
 * A group's own tab keeps the member it is showing, which is the same thing
 * `selectTab` does with a group: the tab stands for whichever of its members is
 * on screen, and that is the one the click was about.
 */
export function keepTab(id: string) {
  const kind = kindOf(id)
  if (!kind) return

  const keep = PANELS[kind].keep
  if (!keep) return

  const own = bare(id, kind)
  if (!isGroup(own)) {
    keep(own)
    return
  }

  const member = shownMember(kind, bareGroup(own))
  if (member !== null) keep(member)
}

/**
 * Closes one tab, and leaves the pane showing something.
 *
 * Each panel already picks its own next tab, which is what should happen while
 * it still has one — closing one of two tables goes to the other table, not off
 * to whatever the strip happens to hold next. What it cannot do is answer for
 * the tab that was its last: the pane would sit on that panel's "nothing
 * selected" notice with the strip still full. So when the panel on screen has
 * nothing left to show, the tab beside the closed one takes over, whichever
 * panel that belongs to.
 */
export function closeTab(id: string) {
  const kind = kindOf(id)
  if (!kind) return

  // Read before the close, while the closed tab still has neighbours.
  const order = tabIds()
  const own = bare(id, kind)

  // Closing a folder's tab closes everything filed under it — the tab is the
  // folder, and there is nothing left of it once its members have gone.
  if (isGroup(own)) {
    for (const member of groupMembers(kind, bareGroup(own))) {
      PANELS[kind].close(member)
    }
  } else {
    PANELS[kind].close(own)
  }

  fillPane(neighbour(order, id))
}

/**
 * Closes one of a panel's own tabs, whether or not the strip is grouping them.
 *
 * The strip's `closeTab` takes a strip id, and while a panel is grouped that
 * names a folder rather than a tab. What still closes one thing is everything
 * outside the strip — the ✕ on a row in a sidebar, and the second strip inside
 * a folder's tab — so this is their way in. The folder's tab only leaves the
 * strip with its last member, and that is the one case where the pane has to
 * move: the neighbour is read beforehand for it.
 */
export function closePanelTab(pane: Pane, id: string) {
  const of = grouper(pane)
  const order = tabIds()

  PANELS[pane].close(id)

  fillPane(neighbour(order, of ? groupTabId(pane, of(id)) : PREFIX[pane] + id))
}

/**
 * Puts something on screen when the panel showing has nothing to show, and
 * leaves the pane alone otherwise.
 *
 * `prefer` is the tab that stood beside a closed one; without it the strip is
 * taken from the front. Not exported any more: Explorer's Sessions list was
 * the one caller that closed a tab without going through the strip, and it went
 * with the panel it listed.
 */
function fillPane(prefer: string | null = null) {
  const { pane } = useStudio.getState()
  if (PANELS[pane].active() !== null) return

  // Checked against the strip as it is now: a panel's close may have taken more
  // tabs with it than the one asked for, and `select` on an id no longer open
  // would put a tab back rather than do nothing.
  const order = tabIds()
  const next = prefer && order.includes(prefer) ? prefer : (order[0] ?? null)
  if (next) selectTab(next)
}

/**
 * What ⌘W closes: the tab on screen — and, in a folder's tab, the one of its
 * members that is on screen rather than the whole folder.
 *
 * ⌘W has always closed one thing. A key that suddenly closed eight files, or
 * ended three ptys, because they happen to share a project would be the same
 * key doing something else. Closing the last member still takes the folder's
 * tab with it, which is the only way that tab was ever going to go.
 */
export function closeShownTab(id: string) {
  const kind = kindOf(id)
  if (!kind) return

  const own = bare(id, kind)
  if (!isGroup(own)) {
    closeTab(id)
    return
  }

  const active = PANELS[kind].active()
  if (active !== null) closePanelTab(kind, active)
}

/**
 * Closes every tab a panel has **in the strip**, leaving another project's
 * alone.
 *
 * One `close` per tab rather than the panel's own `closeAll`, which replaces the
 * whole list: "all" here means all of what is on screen, and a project nobody
 * is looking at is not on screen. The fast path is kept for the common case,
 * where nothing is out of scope and the panel can drop its list in one write.
 */
function closeAllInScope(pane: Pane) {
  const own = openInScope(pane)
  if (own.length === PANELS[pane].open().length) {
    PANELS[pane].closeAll()
    return
  }
  for (const id of own) PANELS[pane].close(id)
}

/**
 * Keeps one tab and closes the rest — every panel's, not just this tab's.
 *
 * "Others" is the strip, so the other four panels lose all of theirs, and the
 * kept tab is selected at the end: it may well belong to a panel that was not
 * the one on screen. The strip is what is *drawn*, so this stops at the
 * project's edge too — a menu item cannot close tabs the menu was not opened
 * over.
 */
export function closeOtherTabs(id: string) {
  const kind = kindOf(id)
  if (!kind) return

  for (const pane of PANES) {
    if (pane !== kind) closeAllInScope(pane)
  }

  const own = bare(id, kind)
  if (isGroup(own)) {
    // Everything this panel holds outside the kept folder. The panel's own
    // `closeOthers` cannot answer this: it keeps a single tab, and what is
    // being kept here is a folder's worth of them.
    const kept = new Set(groupMembers(kind, bareGroup(own)))
    for (const member of openInScope(kind)) {
      if (!kept.has(member)) PANELS[kind].close(member)
    }
  } else {
    // Not the panel's own `closeOthers`, for the reason `closeAllInScope` is
    // not `closeAll`: it keeps one tab and drops every other id it holds,
    // including the ones this strip is not drawing.
    for (const member of openInScope(kind)) {
      if (member !== own) PANELS[kind].close(member)
    }
  }

  selectTab(id)
}

export function closeAllTabs() {
  for (const pane of PANES) closeAllInScope(pane)
}

/**
 * The strip's new arrangement, after a drag.
 *
 * `tabOrder` is the only place a tab's position relative to another panel's can
 * be recorded. Each panel is also handed its own tabs in the sequence they now
 * appear in: nothing draws the strip from that any more, but it is what keeps a
 * panel's idea of "the next tab" — where closing one falls back to — matching
 * what the user can see.
 */
export function reorderTabs(ids: string[]) {
  useStudio.getState().setTabOrder(ids)

  for (const pane of PANES) {
    const own = ids
      .filter((id) => kindOf(id) === pane)
      .map((id) => bare(id, pane))

    const of = grouper(pane)
    // A grouped strip hands back folders, and what the panel underneath has to
    // be told is where its own tabs went: its members, gathered folder by
    // folder in the order the folders now appear.
    PANELS[pane].reorder(
      of
        ? orderGroups(PANELS[pane].open(), of, own.map(bareGroup))
        : // `own` is only what the strip was drawing, so it cannot be handed
          // straight to a `reorder` that replaces the panel's whole list — the
          // other projects' tabs would close on a drag. Written back into the
          // slots they already hold instead.
          orderWhere(PANELS[pane].open(), (id) => inScope(pane, id), own)
    )
  }
}

/**
 * The strip inside the tab on screen: which folder it is, its tabs in order,
 * and which of them the pane is showing. Null when the panel on screen is not
 * grouping, or has nothing open.
 *
 * `reorder` here is the drag in that inner strip, which must not move anything
 * in the outer one — see `orderWithin`.
 */
export function shownGroupOf(pane: Pane): {
  /** The group's strip id, so a caller can close it like any other tab. */
  id: string
  /** The folder itself, as the panel names it — what the group-level calls
   * below want, and the one field here that is not a strip id. */
  group: string
  /**
   * Its tabs, addressed the way the strip addresses everything: prefixed.
   *
   * Prefixed rather than as the panel knows them because that is what a strip
   * is handed and hands back — `useTabItems` is keyed by it, `selectTab` takes
   * it — and a component holding both shapes at once got them the wrong way
   * round: the ids came out `term:term:<id>`, which names nothing, so no tab
   * was marked and clicking one did nothing at all. `bare` is the way back for
   * the two calls below that want a panel's own id.
   */
  members: string[]
  active: string
} | null {
  const of = grouper(pane)
  if (!of) return null

  const active = PANELS[pane].active()
  if (active === null) return null

  const group = of(active)
  return {
    id: groupTabId(pane, group),
    group,
    members: groupMembers(pane, group).map((id) => PREFIX[pane] + id),
    active: PREFIX[pane] + active,
  }
}

/**
 * Keeps one of a folder's tabs and closes the rest of *that folder's*.
 *
 * The "close others" of the strip inside a folder's tab, which means the strip
 * it is on: the workbench's own is `closeOtherTabs`, and that one closes every
 * panel's. The pane is settled once at the end rather than after each close —
 * the kept tab is still open, so until the loop finishes there is nothing to
 * settle.
 */
export function closeOthersInGroup(pane: Pane, group: string, keep: string) {
  for (const member of groupMembers(pane, group)) {
    if (member !== keep) PANELS[pane].close(member)
  }
  fillPane()
}

/** Reorders one folder's tabs, leaving every other folder's exactly where they
 * are in the panel's own list. */
export function reorderWithinGroup(pane: Pane, group: string, ids: string[]) {
  const of = grouper(pane)
  if (!of) return
  PANELS[pane].reorder(orderWithin(PANELS[pane].open(), of, group, ids))
}

/**
 * The tab the pane is showing, as the strip addresses it — null when the panel
 * on screen has nothing to show.
 *
 * Read back out of the panels rather than kept anywhere: each one already
 * knows what it is displaying, and a second answer would be one more thing to
 * hold in step with them. The studio pane asks the same question to decide
 * whether to draw a panel at all.
 */
export function useActiveTabId(pane: Pane): string | null {
  useGrouping()
  useScope()

  const own = usePanelActive(pane)
  if (own === null) return null

  // A tab from another project is not in the strip, so it cannot be the tab
  // the strip is marking. The pane draws `NothingOpen` for it until
  // `reconcileScope` has picked something that is — or straight away, when this
  // project has nothing open at all.
  if (!inScope(pane, own)) return null

  const of = grouper(pane)
  return of ? groupTabId(pane, of(own)) : PREFIX[pane] + own
}

/** Which tab each panel is showing, subscribed to. Split out because two hooks
 * want the same selectors and the rules say they must all be called. */
function usePanelActive(pane: Pane): string | null {
  return {
    files: useFiles(fileActive),
    changes: useChanges(changesActive),
    worktree: useWorktreeChats(worktreeChatActive),
    workflows: useWorkflows(workflowActive),
  }[pane]
}

/**
 * What the strip's **scope** is a question about, subscribed to.
 *
 * Which project is being worked in, and what projects there are — the two
 * things `activeRootId` reads that no panel's own store knows. Without this a
 * strip would keep the tabs of the project it was on until something else
 * happened to redraw it.
 *
 * Called for the subscription alone; the value is read back through `getState`
 * where it is used, which is what keeps the scoping rule in one place.
 */
function useScope() {
  useProjects((state) => state.activeFolderId)
  useStudio((state) => state.folders)
}

/**
 * Everything a grouped strip is a question about, subscribed to.
 *
 * `groupOf` reads more than the panel whose tab it is being asked about — which
 * folder a request is filed under, which folders the workspace has, whether
 * grouping is even on — so a component drawing the strip has to re-render when
 * any of that changes and not only when its own panel's membership does.
 * Called for the subscriptions alone; the values are read back through
 * `getState` where they are actually used, which is what keeps the grouping
 * rules in one place instead of half in each component.
 *
 * Deliberately not the whole of any store: `useFiles` is written on every
 * keystroke in an editor, and a strip that redrew with the text would be a
 * strip redrawn a hundred times a minute. Each of these changes only when a
 * tab, a folder or a record does.
 */
function useGrouping() {
  useScope()
  useSettings((state) => state.groupTabs)
  useStudio((state) => state.folders)
  useFiles((state) => state.openIds)
  useWorktreeChats((state) => state.chats)
  useWorktreeChats((state) => state.openIds)
  useWorkflows((state) => state.openIds)
}

/**
 * Every folder tab the strip is drawing, with the tabs filed under each.
 *
 * What a folder's tab looks like is worked out from its members' — the icon of
 * the one on screen, the dot if any of them is unsaved — so the component
 * building tabs wants them together rather than one lookup at a time.
 */
export function useTabGroups(): {
  pane: Pane
  group: string
  members: string[]
  shown: string
}[] {
  useGrouping()

  return PANES.flatMap((pane) => {
    const of = grouper(pane)
    if (!of) return []

    return groupIds(openInScope(pane), of).flatMap((group) => {
      const members = groupMembers(pane, group)
      const shown = shownMember(pane, group)
      return shown === null ? [] : [{ pane, group, members, shown }]
    })
  })
}

/**
 * The strip inside the tab on screen, as a component can subscribe to it.
 *
 * The same answer as `shownGroupOf`, re-read whenever anything it depends on
 * changes — a file opened, a request moved to another folder, the setting
 * turned off.
 */
export function useShownGroup(pane: Pane) {
  useGrouping()
  usePanelActive(pane)
  return shownGroupOf(pane)
}

/**
 * Whether anything at all is in the strip.
 *
 * In the strip, not open: a project whose only tabs belong to another one
 * has an empty strip, and the pane says `Nothing open` rather than
 * `No tab open` — which is the truthful pair of words for it, since there is
 * nothing above to pick from.
 *
 * `openInScope` per pane rather than a boolean selector each, which is what this
 * was: scope is not a fact any one panel's store holds, so the cheap version
 * cannot answer it. The subscriptions are still the arrays rather than derived
 * booleans — those references are stable, and a selector building a new array
 * would re-render on every write to the store it reads.
 */
export function useHasOpenTabs(): boolean {
  useScope()
  useFiles((state) => state.openIds)
  useWorktreeChats((state) => state.openIds)
  useWorktreeChats((state) => state.chats)
  useWorkflows((state) => state.openIds)

  // Every pane in `PANES`, and the reason this is worth saying: a panel left out
  // of that list can never be drawn. The workbench only shows a pane once the
  // strip has a tab, so a missing one reads as a row that does nothing — a chat
  // opened, selected and invisible until some *other* panel happened to have a
  // tab of its own. `database` and `api` are left out on purpose (they have
  // windows of their own); the subscriptions above stay so that putting either
  // back is the one line in `PANES` and nothing else.
  return PANES.some((pane) => openInScope(pane).length > 0)
}

/**
 * Puts something from *this* project on screen, when what was showing is not.
 *
 * Called when the context moves. Most ways of moving it already land on a tab
 * that is in scope — a project row opens a chat in it, selecting a
 * file tab or a chat tab moves the context to *its* root rather than the other
 * way round — but picking a project row moves the context and selects nothing,
 * which would otherwise leave the pane drawing a file from the branch just left
 * while the strip no longer holds its tab.
 *
 * Prefers the pane already on screen, so switching project with a file open
 * lands on this project's file rather than on whatever the strip happens to
 * start with. Cannot loop: every id it selects is in scope, and the `setActive`
 * that a panel's `select` performs is a no-op for the root already current.
 */
export function reconcileScope() {
  const { pane } = useStudio.getState()

  const own = PANELS[pane].active()
  if (own !== null && inScope(pane, own)) {
    /*
     * A workspace tab — a workflow — is in every project's scope, so by the
     * rule above it would stay on screen through a project switch. But a
     * project row was clicked to *go somewhere*, and a pane that did not move
     * reads as the click doing nothing. So the project's own tabs win when it
     * has any: its chats first, since a project's rows are its chats, then
     * whatever else of its the strip holds. With none, the workflow stays —
     * there is nothing of the project's to show instead.
     */
    if (!PANELS[pane].rootOf) {
      const ids = tabIds()
      const theirs =
        ids.find((id) => kindOf(id) === "worktree") ??
        ids.find((id) => {
          const kind = kindOf(id)
          return kind !== null && PANELS[kind].rootOf !== undefined
        })
      if (theirs !== undefined) selectTab(theirs)
    }
    return
  }

  const mine = openInScope(pane)[0]
  if (mine !== undefined) {
    PANELS[pane].select(mine)
    return
  }

  // Nothing of this panel's in this project. Whatever the strip does hold,
  // then — and nothing at all is a legitimate answer, which `NothingOpen` says.
  const next = tabIds()[0]
  if (next !== undefined) selectTab(next)
}
