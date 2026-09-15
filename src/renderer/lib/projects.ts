import { create } from "zustand"

import { isStringArray, recall, remember } from "./tab-memory"

/** Whether the column is showing, and what in it is folded shut. */
const COLUMN_KEY = "projects.column"

/**
 * What the left column can stack.
 *
 * It could stack three: `projects`, and the Database and API panels' own lists.
 * Those two were hidden out of `SIDEBAR_SECTIONS` first and deleted with their
 * panels afterwards, so this is a union of one — kept as a union, and kept
 * beside `SIDEBAR_SECTIONS`, because the two answer different questions: what
 * a section may be, and which are drawn.
 */
export type SidebarSection = "projects"

/**
 * Which of them the column actually draws.
 *
 * Conductor's left column, which is the shape this was held against: the
 * projects and their chats, and nothing else competing for the height. It is
 * the one line saying which sections are drawn, so the next one to arrive is an
 * id added here.
 */
export const SIDEBAR_SECTIONS: SidebarSection[] = ["projects"]

type RememberedColumn = {
  sidebar: boolean
  collapsed: string[]
  /** Optional: written by a build whose Explorer drew every project at once,
   * and so had none. */
  activeFolderId?: string | null
  /** Optional for the same reason: the column held only the projects then. */
  shutSections?: string[]
}

function isRememberedColumn(value: unknown): value is RememberedColumn {
  const record = value as Partial<RememberedColumn> | null
  return (
    typeof record?.sidebar === "boolean" &&
    isStringArray(record?.collapsed) &&
    (record.activeFolderId === undefined ||
      record.activeFolderId === null ||
      typeof record.activeFolderId === "string") &&
    (record.shutSections === undefined || isStringArray(record.shutSections))
  )
}

type ProjectsState = {
  /**
   * Whether the left column is showing.
   *
   * Its own toggle rather than sharing the panels' `⌘B`: the two columns are
   * about different things — one is the workspace's projects, one is whichever
   * panel the section tabs are on — and a single key that took both would leave
   * the workbench with no left edge at all. Remembered, because a column that
   * comes back every launch is a column somebody closes every launch.
   */
  sidebar: boolean
  toggleSidebar: () => void

  /**
   * Which of the column's sections are folded shut.
   *
   * Shut rather than open, the same way the projects are: a section shown again
   * (see `SIDEBAR_SECTIONS`) turns up open rather than hiding until somebody
   * finds the setting. Several can be open at once — that is the point of
   * stacking them instead of switching between them, and it is why the folds are
   * kept while only one section is drawn: they cost nothing and are what the
   * others come back to.
   */
  shutSections: string[]
  toggleSection: (section: SidebarSection) => void

  /**
   * Which projects are drawn shut.
   *
   * Collapsed rather than expanded ids, so a folder added later opens rather
   * than hiding the chats filed under it.
   */
  collapsed: string[]
  toggleFolder: (folderId: string) => void

  /**
   * The project being worked in, or null before anything has been clicked.
   *
   * Explorer draws **this one**, and only this one: what somebody has open is
   * the files of the thing they are working on, and every other project's tree
   * above and below it is a list to scroll past. The workspace still holds them
   * all — that is what the column is, and clicking a row there is what moves
   * this.
   */
  activeFolderId: string | null

  /** Works in a project. The one call the column's rows make. */
  setActive: (folderId: string) => void

  /** Reads the remembered column. Idempotent: Strict Mode mounts twice. */
  restore: () => Promise<void>
}

export const useProjects = create<ProjectsState>((set, get) => {
  let restorePromise: Promise<void> | null = null

  function rememberColumn() {
    const { sidebar, collapsed, activeFolderId, shutSections } = get()
    remember(COLUMN_KEY, { sidebar, collapsed, activeFolderId, shutSections })
  }

  return {
    // Open by default: it is the way to every project and every chat, and
    // closed only because somebody closed it.
    sidebar: true,
    collapsed: [],
    activeFolderId: null,

    setActive(folderId) {
      if (get().activeFolderId === folderId) return
      set({ activeFolderId: folderId })
      rememberColumn()
    },

    toggleSidebar() {
      set({ sidebar: !get().sidebar })
      rememberColumn()
    },

    shutSections: [],

    toggleSection(section) {
      const { shutSections } = get()
      set({
        shutSections: shutSections.includes(section)
          ? shutSections.filter((entry) => entry !== section)
          : [...shutSections, section],
      })
      rememberColumn()
    },

    toggleFolder(folderId) {
      const { collapsed } = get()
      set({
        collapsed: collapsed.includes(folderId)
          ? collapsed.filter((id) => id !== folderId)
          : [...collapsed, folderId],
      })
      rememberColumn()
    },

    restore() {
      restorePromise ??= (async () => {
        const stored = await recall(COLUMN_KEY, isRememberedColumn)
        if (stored) {
          set({
            sidebar: stored.sidebar,
            collapsed: stored.collapsed,
            // Not checked against a list here: the folders are read after
            // this, and `shownRoot` falls back to the first project for an id
            // that names nothing. A project removed while the app was shut is
            // a tree that opens on another one rather than on an error.
            activeFolderId: stored.activeFolderId ?? null,
            shutSections: stored.shutSections ?? [],
          })
        }
      })()
      return restorePromise
    },
  }
})
