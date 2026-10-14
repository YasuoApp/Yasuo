import { create } from "zustand"

import type {
  ChatSearchMatch,
  SearchKinds,
  SearchOptions,
  WorkspaceSearch,
} from "@shared/api"
import { nameOf } from "./files/paths"
import { isDirty, useFiles } from "./files/store"
import { useProjects } from "./projects"

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

/**
 * Where the search looks. `thisProject` rather than a folder id, because what
 * somebody switched on is "the project I am in", and that follows the column's
 * selection — `activeFolderId`, read at each search.
 */
export type SearchScope = {
  kinds: SearchKinds
  include: string
  exclude: string
  thisProject: boolean
}

type WorkspaceSearchState = {
  query: string
  options: SearchOptions
  scope: SearchScope
  /** The include/exclude fields shown — closed, they still apply, and the
   * filter button says so. */
  filtersOpen: boolean
  replaceOpen: boolean
  replacement: string
  replacing: boolean
  /** What the last replace did, under the field until the query changes. */
  notice: string | null
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
  setScope: (scope: Partial<SearchScope>) => void
  toggleFilters: () => void
  toggleReplace: () => void
  setReplacement: (replacement: string) => void
  /**
   * Replaces in `paths`, or in every file the result holds. A file with unsaved
   * edits is left out and said to be: writing under a dirty buffer would leave
   * the tab holding text that no longer matches either side.
   */
  replace: (paths?: string[]) => Promise<void>
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

    const { query, options, scope } = get()
    const asked = (generation += 1)
    if (!query) {
      set({ result: null, searching: false })
      return
    }

    set({ searching: true })
    try {
      const result = await window.desktop.searchWorkspace(query, options, {
        kinds: scope.kinds,
        include: scope.include,
        exclude: scope.exclude,
        folderId: scope.thisProject
          ? useProjects.getState().activeFolderId
          : null,
      })
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

  // A search scoped to "this project" is asked again when the project changes,
  // or its rows would be the last project's under the next one's name.
  useProjects.subscribe((state, previous) => {
    if (state.activeFolderId === previous.activeFolderId) return
    const { scope, query } = get()
    if (scope.thisProject && query) later()
  })

  return {
    query: "",
    options: { matchCase: false, wholeWord: false, regex: false },
    scope: { kinds: "all", include: "", exclude: "", thisProject: false },
    filtersOpen: false,
    replaceOpen: false,
    replacement: "",
    replacing: false,
    notice: null,
    result: null,
    searching: false,
    focused: 0,
    shut: [],
    shutKinds: [],
    landing: null,

    setQuery(query) {
      set({ query, notice: null })
      later()
    },

    toggleOption(option) {
      const { options } = get()
      set({ options: { ...options, [option]: !options[option] } })
      void search()
    },

    setScope(scope) {
      set({ scope: { ...get().scope, ...scope } })
      // The globs are typed, so they wait like the query does; a click is an
      // answer at once.
      if ("include" in scope || "exclude" in scope) later()
      else void search()
    },

    toggleFilters: () => set({ filtersOpen: !get().filtersOpen }),
    toggleReplace: () => set({ replaceOpen: !get().replaceOpen }),
    setReplacement: (replacement) => set({ replacement }),

    async replace(paths) {
      const { query, options, replacement, result, replacing } = get()
      if (replacing || !query || !result) return
      const targets = paths ?? result.files.map((file) => file.path)
      const docs = useFiles.getState().docs
      const dirty = targets.filter((target) => isDirty(docs[target]))
      const clean = targets.filter((target) => !isDirty(docs[target]))

      set({ replacing: true })
      let notice: string
      try {
        const done = await window.desktop.replaceInFiles(
          query,
          options,
          replacement,
          clean
        )
        // Open tabs over what was just written, re-read now rather than on a
        // watcher's debounce — or not at all, for a folder the tree has shut.
        await useFiles.getState().syncPaths(done.files)
        notice = done.error ?? replaceNotice(done.replaced, done.files.length)
        if (dirty.length > 0)
          notice += ` ${plural(dirty.length, "file")} with unsaved edits skipped.`
        if (done.failed.length > 0)
          notice += ` ${plural(done.failed.length, "file")} not written: ${done.failed
            .map((failed) => `${nameOf(failed.path)} (${failed.error})`)
            .join(", ")}.`
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error)
      }
      set({ replacing: false })
      await search()
      set({ notice })
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

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`

function replaceNotice(replaced: number, files: number): string {
  if (replaced === 0) return "Nothing replaced."
  return `Replaced ${plural(replaced, "occurrence")} in ${plural(files, "file")}.`
}
