import { create } from "zustand"

import type { WorkspaceFolder } from "@shared/api"
import { isStringArray, recall, remember } from "./tab-memory"
import type { Section } from "./sections"
import * as repo from "./workspace"

/** Where the strip's arrangement and the pane on screen are kept. */
const STRIP_KEY = "workbench.strip"

/**
 * The width of a column's rail, in px — `studio.tsx` gives it to both outer
 * panels as their `collapsedSize`, so closing a column leaves its rail against
 * the window's edge instead of taking the column away entirely.
 *
 * The dock's own `DOCK_STRIP_HEIGHT` is the same argument turned on its side,
 * and for the same failure: a panel that collapses to nothing has nowhere left
 * to hold the way back, so a column dragged shut could only be reopened by
 * knowing the shortcut. The rail is where the question is asked.
 *
 * One number for both, and not one per column: they sit at either edge of the
 * same window, and two rails a few pixels apart in width would read as a
 * mistake. It is also the number rather than a Tailwind `w-9` in the rails,
 * because it and the `collapsedSize` have to agree or a column closes to a
 * sliver of its own button.
 */
export const RAIL_WIDTH = 36

/**
 * Every pane the **studio** draws — the list `lib/panels.ts` walks to reach the
 * workbench's tabs without naming any panel.
 *
 * It held `database` and `api` as well, then deliberately did not — those two
 * panels moved into windows of their own — and now they are gone altogether;
 * see `docs/design.md` § Database and API, removed. The list stays as a list:
 * it is what makes a pane drawable at all, and a pane left out of it is one
 * that can be selected and never shown.
 */
export const PANES: Pane[] = ["files", "changes", "worktree", "board"]

/**
 * `section` is held as a plain string rather than a `Section` on the way in: a
 * build with a Terminal section on the rail wrote `"terminal"` there, and
 * rejecting the whole record over it would throw away the tab order and the
 * pane along with it. `bootstrap` is where it is narrowed.
 */
type RememberedStrip = {
  tabOrder: string[]
  /** A plain string for the same reason `section` is: a build with a Terminal
   * panel wrote `"terminal"` here, and that pane no longer exists. Narrowed in
   * `bootstrap`, which falls back rather than throwing the record away. */
  pane: string
  /** Written by a build whose right-hand panel had four tabs. Read no longer:
   * that panel holds the Explorer and nothing else. */
  section?: string
  sidebar?: boolean
  /** A plain string on the way in, and narrowed in `bootstrap`: a build that
   * had no tabs over the Explorer wrote nothing here. */
  explorerTab?: string
}

function isRememberedStrip(value: unknown): value is RememberedStrip {
  const record = value as Partial<RememberedStrip> | null
  return (
    isStringArray(record?.tabOrder) &&
    typeof record.pane === "string" &&
    // Both optional: written by a build that did not remember the sidebar yet,
    // or did not know it could be closed.
    (record.section === undefined || typeof record.section === "string") &&
    (record.sidebar === undefined || typeof record.sidebar === "boolean") &&
    (record.explorerTab === undefined || typeof record.explorerTab === "string")
  )
}

/**
 * Which of the tabbed panels the workspace pane is showing.
 *
 * What sets it is picking something to look at — a tab, a table in the tree, a
 * request, a chat — wherever that pick was made. It used to have a sidebar to
 * drag along with it, back when one box on the right held four lists; the lists
 * are all on screen at once now, so this is only about the pane.
 *
 * A `Section` and three more, and none of the three has a sidebar of its own:
 * `worktree` draws a project's chats and is opened from the left column,
 * `changes` draws the diff of whichever changed file the Explorer's `Changes`
 * tab has picked, one tab per project, and `board` draws that project's kanban
 * cards, also one tab per project. `showPane` leaves the sections alone for all
 * three, since a click in somebody else's list must not move the section the
 * panel is on.
 *
 * There was a `terminal` pane beside them — a session with a tab, a chat view
 * and a transcript — and it is gone: a shell is a tab of the dock now
 * (`lib/shell/store.ts`), and the agent half of what it was is a project's
 * chat.
 */
export type Pane = Section | "worktree" | "changes" | "board"

/**
 * Which of the Explorer's two lists is showing: the project's files, or the
 * ones it has changed.
 *
 * Two tabs where the panel's own title used to be, which is what the space was
 * worth: a header reading `Explorer` said what the reader could already see,
 * and `Changes` is asked for often enough — after every agent turn — to deserve
 * a click rather than a button that opened a pane. The names are the ones
 * Conductor uses, so the strip reads `All files | Changes`.
 *
 * The list of changed files is here and **not** in the pane it opens: the pane
 * is the diff. A list in both places is one question answered twice, which is
 * what the old `Files | Changes` toggle under the header was.
 *
 * `comments` is the third, and it is the same bargain a third time: the
 * comments left on a diff live *in* the diff, under the lines they are about,
 * which is where they belong and also means "where are they all" had no answer
 * short of opening every changed file. That question is a list, and this is the
 * column lists live in.
 */
export type ExplorerTab = "files" | "changes" | "comments"

const EXPLORER_TABS: ExplorerTab[] = ["files", "changes", "comments"]

type StudioState = {
  /** Storage is open and the workspace has been read. */
  loaded: boolean
  storageError: string | null

  /**
   * The folders the workspace is pointed at, in the order they were added.
   *
   * There is no "open" one. Everything the studio shows — sessions, specs,
   * captures — is the whole workspace's at once, which is the point: a
   * frontend and the API it calls are two folders, not two applications to
   * switch between.
   */
  folders: WorkspaceFolder[]
  /** Each folder's checked-out branch, or null when it is not a git
   * repository. Missing until the branch has been read. */
  branches: Record<string, string | null>

  pane: Pane
  /**
   * Puts a panel's own selection on screen, and brings its sidebar with it.
   *
   * Called by whatever the user picked, not by the rail. The sidebar follows
   * because the two halves are about the same thing: opening a note from the
   * tab strip while the Explorer's tree is showing used to mark a row in a
   * list nobody could see, which is the same failure as a folded folder — one
   * level up.
   */
  showPane: (pane: Pane) => void

  /**
   * Whether the Explorer panel is showing at all.
   *
   * `⌘B`, the editors' shortcut for it, and the same thing the View menu does.
   * There is no longer a *which* list to remember with it: the panel holds the
   * Explorer and nothing else, and the workspace's other three lists are
   * sections of the left column.
   *
   * Remembered with the strip, because a workbench that forgets is a workbench
   * that hands back the space every launch. What is not remembered is the
   * width: the panel keeps that itself, and it comes back on expand.
   */
  sidebar: boolean
  toggleSidebar: () => void

  /**
   * Which of the Explorer's two tabs is showing.
   *
   * Remembered with the strip and not per project: it is a way of working —
   * reviewing, or reading — rather than a fact about a branch, and one that
   * reset every time the left column moved would be one nobody could stay in.
   */
  explorerTab: ExplorerTab
  setExplorerTab: (tab: ExplorerTab) => void

  /**
   * The workbench tab strip's order, as prefixed ids (`db:public.users`).
   *
   * Each panel still owns *which* tabs it has open; this owns where they sit
   * relative to each other, which no single panel can answer — a request
   * dropped between two tables is a position none of the three stores has
   * anywhere to record. Empty until the first drag, and reconciled against the
   * tabs that actually exist on every render, so an id left here by a closed
   * tab is inert rather than something to clean up.
   */
  tabOrder: string[]
  setTabOrder: (ids: string[]) => void

  init: () => Promise<void>
  /**
   * Re-reads every folder's branch.
   *
   * For a checkout made outside the studio — in a Terminal session, or in
   * somebody's own terminal. The watcher on each folder's `.git` is what calls
   * this (`lib/files/watch.ts`); nothing else in the app would notice.
   */
  refreshBranches: () => Promise<void>
  /** Points the workspace at another folder on this machine. */
  addFolder: (input: { path: string; name: string }) => Promise<void>
  renameFolder: (id: string, name: string) => Promise<void>
  /** Drops a folder from the workspace. The directory itself is untouched. */
  removeFolder: (id: string) => Promise<void>
}

/**
 * Strict Mode invokes mount effects twice, so `init` has to be idempotent,
 * not merely fast.
 */
let initPromise: Promise<void> | null = null

export const useStudio = create<StudioState>((set, get) => {
  /** Reads each folder's branch, dropping any that leaves the workspace while
   * the read is in flight. */
  async function load(folders: WorkspaceFolder[]): Promise<void> {
    set({ folders })

    await Promise.all(
      folders.map(async (folder) => {
        const branch = await repo.gitBranch(folder.id).catch(() => null)
        // Discarded if the folder was removed while this was in flight: a
        // branch for a folder nothing shows is a leak, not a cache.
        if (!get().folders.some((current) => current.id === folder.id)) return

        set((state) => ({
          branches: { ...state.branches, [folder.id]: branch },
        }))
      })
    )
  }

  function rememberStrip() {
    const { tabOrder, pane, sidebar, explorerTab } = get()
    remember(STRIP_KEY, { tabOrder, pane, sidebar, explorerTab })
  }

  /** Opens storage and reads the workspace. */
  async function bootstrap() {
    // Before the folders, so the strip is arranged by the time the panels have
    // anything to arrange — restoring it afterwards showed one frame of the
    // default order.
    const strip = await recall(STRIP_KEY, isRememberedStrip)
    if (strip) {
      set({
        tabOrder: strip.tabOrder,
        // `terminal` is what an older build may have been left on, and there
        // is no such pane any more — Explorer is where its sidebar went. The
        // same narrowing catches `database` and `api`, which a build that still
        // had those panels could have been shut on.
        pane: PANES.includes(strip.pane as Pane)
          ? (strip.pane as Pane)
          : "files",
        // A build that never wrote this had no way to close the sidebar, so
        // the absence means open rather than "unknown".
        sidebar: strip.sidebar ?? true,
        explorerTab: EXPLORER_TABS.includes(strip.explorerTab as ExplorerTab)
          ? (strip.explorerTab as ExplorerTab)
          : "files",
      })
    }

    let folders: WorkspaceFolder[]
    try {
      folders = (await repo.getWorkspace()).folders
    } catch (error) {
      set({
        loaded: true,
        storageError:
          error instanceof Error ? error.message : "Could not read ~/.yasuo",
      })
      return
    }

    set({ loaded: true })
    await load(folders)
  }

  /** Forgets everything read for a folder that has left the workspace. */
  function prune(folders: WorkspaceFolder[]) {
    const kept = new Set(folders.map((folder) => folder.id))
    set((state) => ({
      folders,
      branches: Object.fromEntries(
        Object.entries(state.branches).filter(([id]) => kept.has(id))
      ),
    }))
  }

  return {
    loaded: false,
    storageError: null,

    folders: [],
    branches: {},

    // `files`, because a pane the studio does not draw cannot be the one it
    // starts on — this was `database` while that panel still existed.
    pane: "files",
    sidebar: true,
    explorerTab: "files",
    tabOrder: [],

    showPane(pane) {
      // Only the pane. Picking something used to bring a sidebar with it, back
      // when one box held four lists and marking a row in the hidden one was
      // half an answer; the lists are all on screen at once now — three in the
      // left column, the Explorer on the right — so there is nothing to move.
      set({ pane })
      rememberStrip()
    },

    toggleSidebar() {
      set((state) => ({ sidebar: !state.sidebar }))
      rememberStrip()
    },

    setExplorerTab(tab) {
      set({ explorerTab: tab })
      rememberStrip()
    },

    setTabOrder(ids) {
      set({ tabOrder: ids })
      rememberStrip()
    },

    init() {
      initPromise ??= bootstrap()
      return initPromise
    },

    async refreshBranches() {
      await load(get().folders)
    },

    async addFolder(input) {
      // Not caught: the dialog that called this reports the failure and stays
      // open, which is the only place a bad path can be corrected.
      const workspace = await repo.addFolder(input)
      await load(workspace.folders)
    },

    async renameFolder(id, name) {
      set({ folders: (await repo.renameFolder(id, name)).folders })
    },

    async removeFolder(id) {
      prune((await repo.removeFolder(id)).folders)
    },
  }
})
