import { chatRootId } from "@shared/api"

import { useChanges } from "./files/changes"
import { useFiles } from "./files/store"
import { fileRoots, rootOfPath, shownRootOf } from "./files/roots"
import { useProjects } from "./projects"
import { useSettings } from "./settings"
import { PANES, useStudio, type Pane } from "./store"
import { arrange, bare, kindOf, neighbour, orderWhere, PREFIX } from "./tabs"
import { useWorktreeChats } from "./worktree-chat/store"

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

/**
 * The **root** a file is in: a workspace folder (`lib/files/roots.ts`, which
 * takes the longest match — a folder added inside another one is still a
 * project of its own). Every file the Explorer can open is inside a root
 * (`fileRoots` in `main/ipc.ts` is what guarantees it), so null here is the
 * frame between a root going and its tabs closing.
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
    rootOf: fileRootOf,
  },
  worktree: {
    open: () => useWorktreeChats.getState().openIds,
    active: () => worktreeChatActive(useWorktreeChats.getState()),
    select: (id) => useWorktreeChats.getState().select(id),
    close: (id) => useWorktreeChats.getState().close(id),
    closeOthers: (id) => useWorktreeChats.getState().closeOthers(id),
    closeAll: () => useWorktreeChats.getState().closeAll(),
    reorder: (ids) => useWorktreeChats.getState().reorder(ids),
    rootOf: worktreeChatRootOf,
  },
}

/**
 * The root the workbench is working in, or null before anything has been picked.
 *
 * `shownRootOf` and not a field of its own, because that is what the Explorer
 * draws and what the status bar's branch is of: the strip has to agree with
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
 * always in. `allProjectTabs` in Settings lifts the scope altogether, and is
 * read here rather than at each caller so the strip, the pane, ⌘W, a drag and
 * Close All agree about what is on screen.
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
  if (useSettings.getState().allProjectTabs) return true

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
    openInScope(pane).map((id) => ({ id: PREFIX[pane] + id }))
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

  PANELS[kind].select(bare(id, kind))
}

/** Keeps the tab a double click landed on — see `PanelTabs.keep`. */
export function keepTab(id: string) {
  const kind = kindOf(id)
  if (!kind) return

  PANELS[kind].keep?.(bare(id, kind))
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
  PANELS[kind].close(bare(id, kind))

  fillPane(neighbour(order, id))
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

  // Not the panel's own `closeOthers`, for the reason `closeAllInScope` is not
  // `closeAll`: it keeps one tab and drops every other id it holds, including
  // the ones this strip is not drawing.
  const own = bare(id, kind)
  for (const member of openInScope(kind)) {
    if (member !== own) PANELS[kind].close(member)
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

    // `own` is only what the strip was drawing, so it cannot be handed straight
    // to a `reorder` that replaces the panel's whole list — the other projects'
    // tabs would close on a drag. Written back into the slots they already hold
    // instead.
    PANELS[pane].reorder(
      orderWhere(PANELS[pane].open(), (id) => inScope(pane, id), own)
    )
  }
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
  useScope()

  const own = usePanelActive(pane)
  if (own === null) return null

  // A tab from another project is not in the strip, so it cannot be the tab
  // the strip is marking. The pane draws `NothingOpen` for it until
  // `reconcileScope` has picked something that is — or straight away, when this
  // project has nothing open at all.
  if (!inScope(pane, own)) return null

  return PREFIX[pane] + own
}

/** Which tab each panel is showing, subscribed to. Split out because two hooks
 * want the same selectors and the rules say they must all be called. */
function usePanelActive(pane: Pane): string | null {
  return {
    files: useFiles(fileActive),
    changes: useChanges(changesActive),
    worktree: useWorktreeChats(worktreeChatActive),
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
  useSettings((state) => state.allProjectTabs)
}

/**
 * Whether anything at all is in the strip.
 *
 * In the strip, not open: a project whose only tabs belong to another one
 * has an empty strip, and the pane draws `NothingOpen` for it.
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
  if (own !== null && inScope(pane, own)) return

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
