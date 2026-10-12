import { create } from "zustand"

import type {
  ChatSearchMatch,
  SearchOptions,
  WorkspaceSearch,
} from "@shared/api"

/**
 * The left column's Search — `Find in files`, over the workspace's files and
 * everything said in its chats (`main/content-search.ts`).
 *
 * On a store rather than in the section, because the section is unmounted
 * whenever the column shows Projects instead, and coming back to a search one
 * had open should find it where it was. Per run, like the chat's `⌘F`: nothing
 * here is written down.
 */

/** Long enough that a word typed at speed is one search, short enough that a
 * pause reads as the answer arriving. */
const DEBOUNCE_MS = 250

/**
 * Where a chat's find bar should land once that chat is on screen — see
 * `hitAt`. Taken and cleared by the chat pane, which is the only thing that
 * knows when the chat's lines have been read.
 */
export type ChatLanding = { chatId: string } & Pick<
  ChatSearchMatch,
  "messageId" | "offset" | "length"
>

export type SearchKind = "chats" | "files"

type WorkspaceSearchState = {
  query: string
  options: SearchOptions
  result: WorkspaceSearch | null
  searching: boolean
  /** Bumped to put the caret in the field — `⇧⌘F`, or the rail's button. */
  focused: number
  /** Result groups folded shut, by file path or chat id. */
  shut: string[]
  /**
   * Whole kinds folded shut — `Chats` or `Files`. Kept apart from `shut`,
   * which every new answer clears: a kind somebody folded away is a kind they
   * are not looking for, and the next query should not open it again.
   */
  shutKinds: SearchKind[]
  landing: ChatLanding | null

  setQuery: (query: string) => void
  toggleOption: (option: keyof SearchOptions) => void
  /** Runs the search now — Enter in the field, and Refresh. */
  run: () => void
  focus: () => void
  toggleGroup: (key: string) => void
  toggleKind: (kind: SearchKind) => void
  /** Folds every group, or opens them all if they already are. */
  toggleAll: () => void
  land: (landing: ChatLanding) => void
  clearLanding: () => void
}

export const useWorkspaceSearch = create<WorkspaceSearchState>((set, get) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Which call's answer is wanted: anything older is dropped on arrival. */
  let generation = 0

  async function search() {
    if (timer) clearTimeout(timer)
    timer = null

    const { query, options } = get()
    const asked = (generation += 1)
    if (!query) {
      set({ result: null, searching: false })
      return
    }

    set({ searching: true })
    try {
      const result = await window.desktop.searchWorkspace(query, options)
      if (asked !== generation) return
      set({ result, searching: false, shut: [] })
    } catch (error) {
      if (asked !== generation) return
      set({
        result: {
          files: [],
          chats: [],
          truncated: false,
          error: error instanceof Error ? error.message : String(error),
        },
        searching: false,
      })
    }
  }

  function later() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void search(), DEBOUNCE_MS)
  }

  return {
    query: "",
    options: { matchCase: false, wholeWord: false, regex: false },
    result: null,
    searching: false,
    focused: 0,
    shut: [],
    shutKinds: [],
    landing: null,

    setQuery(query) {
      set({ query })
      later()
    },

    toggleOption(option) {
      const { options } = get()
      set({ options: { ...options, [option]: !options[option] } })
      void search()
    },

    run: () => void search(),

    focus: () => set({ focused: get().focused + 1 }),

    toggleGroup(key) {
      const { shut } = get()
      set({
        shut: shut.includes(key)
          ? shut.filter((entry) => entry !== key)
          : [...shut, key],
      })
    },

    toggleKind(kind) {
      const { shutKinds } = get()
      set({
        shutKinds: shutKinds.includes(kind)
          ? shutKinds.filter((entry) => entry !== kind)
          : [...shutKinds, kind],
      })
    },

    toggleAll() {
      const { result, shut } = get()
      if (!result) return
      const keys = [
        ...result.files.map((file) => file.path),
        ...result.chats.map((chat) => chat.chatId),
      ]
      set({ shut: shut.length >= keys.length ? [] : keys })
    },

    land: (landing) => set({ landing }),
    clearLanding: () => set({ landing: null }),
  }
})
