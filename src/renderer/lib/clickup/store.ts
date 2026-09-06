import { create } from "zustand"

import type {
  ClickupChange,
  ClickupWatch,
  ClickupWatchAnswer,
} from "@shared/api"

import type { ClickupAgentId } from "@shared/clickup-agents"
import { useSettings } from "../settings"
import { useStudio } from "../store"
import { useWorktreeChats } from "../worktree-chat/store"

/**
 * The ClickUp tasks being watched, as the left column draws them.
 *
 * **Main owns this list; this store is a copy of it.** The poll, the diff and
 * the file are all `main/clickup-watch.ts` — see there for why — so everything
 * here either asks main a question or takes what main pushed. There is no
 * timer, no fetch and no merge on this side, which is what keeps the row and
 * the OS notification from ever disagreeing about what changed.
 *
 * Unread is a **field on the record**, unlike a chat's, which is this run's
 * attention and written down nowhere (`lib/worktree-chat/unread.ts`). The
 * difference is what the two are for: a chat answered while this app was
 * running, and a task changed while it very likely was not.
 */

/**
 * The one tab this panel has, as its own store knows it — `clickup:watcher` in
 * the strip.
 *
 * A constant rather than an id off a record, because the tab is not *about* any
 * one task: it is the watch list, and which task it happens to be showing is
 * `showing` inside it. `lib/panels.ts` is the only other reader.
 */
export const CLICKUP_TAB = "watcher"

type ClickupState = {
  watches: ClickupWatch[]
  /** Whether the first read has landed. Before it, the pane draws nothing
   * rather than an empty state — "no tasks yet" for a frame on every launch is
   * a flicker with a suggestion in it. */
  loaded: boolean
  /** Whether a poll asked for by the button is in flight. Main's own ticks are
   * deliberately not reflected here: a spinner that started on its own every
   * two minutes is a column that looks busy for no reason anybody asked for. */
  refreshing: boolean
  /**
   * Why the last poll asked for by the button failed, or null.
   *
   * A **poll** failing is not a **task** failing: every way ClickUp can refuse
   * one task is already `watch.error` on that task's own row, so anything
   * landing here is this app's own fault. It is drawn because the bug that
   * taught us to keep it — main spreading a `history` that legacy records did
   * not have — killed every tick silently, and the file simply stopped
   * changing, which looks exactly like a watcher finding nothing.
   *
   * Only the pressed poll can fill it. Main's own ticks do not reach this
   * store, and a rejection there is logged where main logs.
   */
  pollError: string | null

  /**
   * Whether the ClickUp tab is in the strip.
   *
   * **This was a dialog**, and the argument for the change is in
   * `docs/design.md` § Watching ClickUp tasks: a modal 32rem tall is a bad
   * place to read a diff, and a modal is the one thing in this app that cannot
   * be left open beside the work it is about. A tab can. The panel is
   * workspace-level — no `rootOf` — so it stays in the strip whichever project
   * is being worked in, which is what the watch list has always been.
   */
  open: boolean
  /**
   * Which task the tab is showing, or null before one is picked.
   *
   * The **id** rather than an index, so a row in the left column can open the
   * tab *at* something; `""` means "whatever is first", which is what the
   * footer button's own press means, since nothing out there knows which task
   * is worth landing on.
   */
  showing: string | null
  /** Opens the tab, on `id` or on the first task for `""`. */
  show: (id: string) => void
  /** Takes the tab out of the strip — the ✕, `⌘W`, `Close others`. */
  close: () => void

  refresh: () => Promise<void>
  /** Reads every watched task now. What comes back replaces the list. */
  poll: () => Promise<void>
  add: (url: string) => Promise<ClickupWatchAnswer>
  remove: (id: string) => Promise<void>
  /** Moves one task's `readAt` to now — what opening its row means. The
   * history is kept; see `ClickupWatch.history`. */
  read: (id: string) => Promise<void>
  /** Takes a list main pushed. The one way this store changes without having
   * asked for it. */
  accept: (watches: ClickupWatch[]) => void

  /** Who a task is assigned to — `shared/clickup-agents.ts`. The whole list,
   * since a set of checkboxes has no meaningful per-item call. */
  assign: (id: string, agents: ClickupAgentId[]) => Promise<void>
  /** Which project its agents run in. Null is a real answer. */
  setProject: (id: string, folderId: string | null) => Promise<void>
  /**
   * Runs one proposal, and opens what it produced.
   *
   * The three helper settings are read here rather than passed in, the way the
   * commit box reads them: they are Settings' own, and every caller of this
   * would otherwise have to know that.
   *
   * A run that opened a chat also **re-reads the workspace and the chats**,
   * because main made a folder and a chat behind this store's back and there is
   * no push channel for either — one button is a worse reason to add two than
   * it is to re-read both here.
   */
  run: (id: string, proposalId: string) => Promise<{ error?: string }>
  dismiss: (id: string, proposalId: string) => Promise<void>
  /** Which proposal is in flight, so its card can say so through the reload
   * that follows. Main marks the record `running` too; this is the frame before
   * that lands. */
  running: string | null
}

export const useClickup = create<ClickupState>((set, get) => ({
  watches: [],
  loaded: false,
  refreshing: false,
  pollError: null,
  open: false,
  showing: null,

  show(id) {
    set({ open: true, showing: id || get().showing })
    // The pane, or the tab would be selected with nothing drawing it — the move
    // `board` and `changes` both make. No `setActive` beside it, unlike theirs:
    // this tab is not scoped to a project, so there is no project to move to.
    useStudio.getState().showPane("clickup")
    // Opening a task *is* reading it, wherever it was opened from — so the
    // dot clears here rather than in each of the callers.
    if (id) void get().read(id)
  },

  close() {
    // `showing` is left alone: the tab reopened is the task somebody was on,
    // which is what every other panel's ✕ does to its own selection.
    set({ open: false })
  },

  async refresh() {
    const watches = await window.desktop.listClickupWatches().catch((error) => {
      console.error("Could not read the ClickUp watches", error)
      return [] as ClickupWatch[]
    })
    set({ watches, loaded: true })
  },

  async poll() {
    if (get().refreshing) return
    set({ refreshing: true, pollError: null })
    try {
      const watches = await window.desktop.refreshClickupWatches()
      set({ watches, loaded: true })
    } catch (error) {
      set({ pollError: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ refreshing: false })
    }
  },

  async add(url) {
    const answer = await window.desktop
      .addClickupWatch(url)
      .catch((error: unknown) => ({
        // The bridge itself failing is not a shape `ClickupWatchAnswer` covers:
        // main answers with a sentence for everything it can see, and this is
        // for the case where it never answered at all.
        error: error instanceof Error ? error.message : String(error),
      }))
    // The list is not set from the answer: main pushes the whole list on a
    // successful add (`onClickupWatches`), and taking the row from here as well
    // would append a second copy of it for one frame.
    return answer
  },

  async remove(id) {
    await window.desktop.removeClickupWatch(id)
  },

  async read(id) {
    // Cheap enough to ask every time a row is opened, but the guard keeps a
    // click on a row with nothing new on it from a round trip and a re-render.
    const watch = get().watches.find((entry) => entry.id === id)
    if (!watch || unreadIn(watch).length === 0) return
    await window.desktop.readClickupWatch(id)
  },

  accept(watches) {
    set({ watches, loaded: true })
  },

  running: null,

  async assign(id, agents) {
    await window.desktop.assignClickupAgents(id, agents)
  },

  async setProject(id, folderId) {
    await window.desktop.setClickupWatchProject(id, folderId)
  },

  async run(id, proposalId) {
    if (get().running) return {}
    set({ running: proposalId })
    try {
      const settings = useSettings.getState()
      const answer = await window.desktop.runClickupProposal(
        id,
        proposalId,
        settings.reviewModel,
        settings.reviewEffort,
        settings.reviewProfileId
      )
      if ("error" in answer) return { error: answer.error }

      if (answer.chatId) {
        // The checkout became a project and the brief became a chat, neither of
        // which this window has heard about. Read both, then open the chat —
        // in that order, or the tab would be selected before the store holding
        // it has a row.
        await useStudio.getState().init()
        await useWorktreeChats.getState().refresh()
        useWorktreeChats.getState().select(answer.chatId)
      }
      return {}
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    } finally {
      set({ running: null })
    }
  },

  async dismiss(id, proposalId) {
    await window.desktop.dismissClickupProposal(id, proposalId)
  },
}))

/**
 * The changes on one task that landed after somebody last looked at it.
 *
 * **Derived rather than stored**, which is what lets the history survive being
 * read: `markRead` moves `readAt` and touches nothing else, so there is no
 * second list to keep in step with this one. Compared as ISO strings, which
 * sort the same way the instants do and never go near a local `Date`.
 *
 * A record with no `readAt` has never been opened, so everything on it is
 * unread — which is also the honest reading of a file written before this
 * field existed.
 */
export function unreadIn(watch: ClickupWatch): ClickupChange[] {
  const history = watch.history ?? []
  if (!watch.readAt) return history
  return history.filter((change) => change.at > watch.readAt!)
}

/** How many watched tasks have something nobody has looked at — the count on
 * the section's own header, which is the only number this feature shows. */
export function unreadWatchCount(watches: ClickupWatch[]): number {
  return watches.filter((watch) => unreadIn(watch).length > 0).length
}
