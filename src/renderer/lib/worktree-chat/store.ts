import { create } from "zustand"

import {
  chatRootId,
  type AssistantMessage,
  type ChatAgent,
  type ChatImage,
  type ChatPlace,
  type ChatWindow,
  type WorktreeChat,
  type WorktreeChatAnswer,
  type WorktreeChatAsk,
  type WorkspaceFolder,
  type WorktreeChatOptions,
} from "@shared/api"
import { workflowInvocation } from "../workflows/invoke"
import { useWorkflows } from "../workflows/store"
import { localCommand } from "./command-text"
import { marksUnread } from "./unread"
import { useProjects } from "../projects"
import { useShells } from "../shell/store"
import { useStudio } from "../store"

/**
 * The chats held in the workspace's projects.
 *
 * A view of what `main/worktree-chat.ts` owns. The turn runs in the
 * main process, so this holds no process and no timers — only the listing, the
 * lines of whichever chats have been opened, and which chat is on screen.
 *
 * **Many** conversations at once: several chats answering in parallel is the
 * point rather than an edge case — a question about one project while another
 * is being refactored. So everything here is keyed by chat id.
 */
type WorktreeChatState = {
  chats: WorktreeChat[]
  loading: boolean

  /** Lines per chat, for the chats that have been opened this run. */
  messages: Record<string, AssistantMessage[]>
  /**
   * Which chats are having their lines read off disk — the first time one is
   * opened, and only then (see `select`).
   *
   * Separate from `messages[id] === undefined`, which is also what a chat
   * nobody has opened looks like: the pane draws a welcome for an empty chat
   * and a skeleton for one still arriving, and it cannot tell those apart from
   * the lines alone.
   */
  reading: string[]
  /**
   * Which chats are working on something.
   *
   * Not "which have been sent to and not answered yet", which is what it was:
   * a chat takes a message while it is answering now, so a turn ending is not
   * the chat going quiet — the one behind it starts on its own. Main owns the
   * answer and says so with `busy`; the optimistic add in `send` is only there
   * so the spinner does not wait for the round trip.
   */
  sending: string[]
  /**
   * When each working chat started working, for the elapsed time under the
   * spinner. Kept beside `sending` rather than in the pane because the pane is
   * one instance reused across the strip: a clock local to it would restart
   * every time somebody looked at another chat and came back. Held across a
   * queued message and an `ask` too — it is how long this stretch of work has
   * been going, not how long the current turn has.
   */
  startedAt: Record<string, number>
  /**
   * How full each chat's context window is, as of its last reply.
   *
   * Live, and only for the chats a session has spoken for this run: main sends
   * it per reply rather than per turn, which is the whole point — the figure on
   * a turn's usage line is the same number an answer late. Nothing keeps it,
   * so a reloaded window falls back to the last usage line (`totalOf`) until
   * the next reply arrives.
   */
  context: Record<string, number>
  /**
   * The same window, measured by the CLI rather than counted from a reply.
   *
   * Beside `context` rather than replacing it, because the two arrive at
   * different times and neither is the other late. `context` moves on every
   * reply and has no denominator; this lands once a turn, over a control
   * request, and carries `maxTokens`, the auto-compact threshold and the split
   * by category — which is what makes a percentage possible at all.
   *
   * Only for the chats a session has answered in this run, and not written down:
   * it describes the process the chat is talking to, and a chat whose session
   * was closed for idleness has none until its next turn.
   */
  window: Record<string, ChatWindow>
  /**
   * The subagents each chat has running right now.
   *
   * Replaced wholesale by every `agents` event rather than added to and removed
   * from — main sends the whole list for exactly that reason (see `ChatAgent`),
   * so a start or a finish that never arrived cannot leave an agent running on
   * screen for ever.
   *
   * Live and never written down, like `sending`: what a subagent *did* is the
   * tool rows it wrote into the transcript, and this is only what is happening
   * while nothing is being written.
   */
  agents: Record<string, ChatAgent[]>
  /** The chats the CLI is compacting right now. A state and not a fraction —
   * compaction is one summarisation call, so there is no progress to report. */
  compacting: Record<string, boolean>
  /** Why the last compaction failed, for the chats where one did. The CLI's own
   * sentence; cleared by the next compaction that starts. */
  compactError: Record<string, string>
  /**
   * The question each chat is stopped on, for the chats that are.
   *
   * One per chat, not a queue: the turn is *held* while it waits, so there
   * cannot be a second one behind it. Keyed by chat rather than by ask because
   * that is how the pane looks it up — the answer names the ask, which is what
   * keeps the two from getting out of step.
   *
   * Lost on a reload, like `sending` and for the same reason: what is on the
   * other end is a process in the main process, not a record.
   */
  asks: Record<string, WorktreeChatAsk>
  /**
   * The messages sent into a chat that was already working, by chat id.
   *
   * **A message sent mid-turn is queued, and this is the only thing that says
   * so.** The CLI takes it either way and folds it into the *next* turn, so what
   * is on screen is a line sitting under an answer that is not being written for
   * it — indistinguishable, until it starts, from the message the turn running
   * above it is about. Which is the thing somebody wants to know before typing a
   * third.
   *
   * Line ids rather than a count, because the mark goes on the line: two queued
   * messages are two rows waiting, and a `2` at the foot of the pane would not
   * say which.
   *
   * In memory and never written down, like `sending` and `unread`: what makes a
   * line queued is a process in the main process, and a reload has neither the
   * process nor the claim. Emptied at the end of the turn they were queued
   * behind — see the `done` branch in `listen`.
   */
  queued: Record<string, string[]>

  /**
   * Which chats have answered since anybody last looked at them.
   *
   * In memory and never written down, like `sending` and for a reason of its
   * own: unread is about *this* run's attention. A window reopened is a column
   * being read from the top, and a dot restored onto a chat from yesterday
   * would be this app telling somebody they had missed something they had
   * already closed the app on.
   *
   * The rule for what lands here, and why an `ask` does not, is
   * `lib/worktree-chat/unread.ts`. Cleared by looking at the chat — `select`,
   * and the window regaining focus while it is the one selected.
   */
  unread: Record<string, true>

  /** Chats with a tab open, oldest first — the strip's membership. */
  openIds: string[]
  selectedId: string | null

  /**
   * Chats that exist on screen and nowhere else — the `+` that has not been
   * spoken into yet.
   *
   * `create` used to write the chat down before returning, which is what left a
   * project's list filling with `Untitled` rows nobody ever said anything in.
   * The tab still opens the instant `+` is clicked — a tab that appears only
   * once you have typed is a `+` that does nothing — but the record is made by
   * the **first message** (`send`), carrying whatever the tab picked up in the
   * meantime: its id, its name, its toolbar. See `ChatSeed`.
   *
   * In memory, so a chat here does not survive a reload — which is the point:
   * there is nothing in it to survive. Everything else in this store works off
   * `chats`, so an unsaved chat is an ordinary chat everywhere but here, in
   * `refresh` (which must not drop it) and in the three calls that would
   * otherwise ask main about a chat it has never heard of.
   */
  unsaved: string[]

  refresh: () => Promise<void>
  /** Puts a chat on screen, reading its lines the first time. */
  select: (id: string) => void
  /**
   * Reads a chat's lines without putting it on screen — `select`'s read
   * alone, for a pane that draws a chat somewhere other than the strip: the
   * workflow editor shows the chat a Claude step ran in under its canvas, and
   * `select` would move the pane, the project and the dock's shell with it.
   */
  read: (id: string) => void
  /**
   * Forgets that a chat has anything unread in it.
   *
   * An action rather than something `select` does privately, because there is a
   * second way to read a chat that involves no click at all: coming back to the
   * window with that chat already on screen. See `listen`.
   */
  markRead: (id: string) => void
  close: (id: string) => void
  closeOthers: (id: string) => void
  closeAll: () => void
  reorder: (ids: string[]) => void

  /**
   * What is typed into a chat's composer and not yet sent, by chat id.
   *
   * **Per chat, which it was not.** The composer held one local draft and the
   * pane was never keyed, so a half-written message followed you into the next
   * chat you clicked and sat under its own field — one draft shared by every
   * conversation. Here it belongs to the chat it was written in: switching tabs
   * and coming back finds it, and switching away does not carry it.
   *
   * It is also how a message can be written *for* somebody: the `Changes` pane's
   * `Ask AI to fix` opens a chat with the whole review already in the field and
   * unsent, so the last word is still the reader's — a prompt assembled by a
   * button is exactly the kind that wants a sentence added before it goes. Which
   * is why `create` takes one and writes it in the same `set` as the chat: the
   * composer reads this as its initial value, and a draft arriving a render
   * later would arrive after the field had been built empty.
   */
  drafts: Record<string, string>
  /** The pictures a draft's `[Image #n]` tags stand for, kept beside it for the
   * same reason: the field is rebuilt on every switch, and a draft that came back
   * with its tags and without their pictures would send text naming nothing. In
   * memory only, like the drafts. */
  draftImages: Record<string, ChatImage[]>
  /** Keeps what is in a field — the composer on its way out. Empty text forgets
   * the entry rather than storing one. */
  keepDraft: (chatId: string, text: string, images?: ChatImage[]) => void
  /** Forgets one, so a field rebuilt later comes up empty rather than repeating
   * a message that has already been sent. */
  clearDraft: (chatId: string) => void

  /**
   * Another chat in the same place — the `+` in the strip.
   *
   * `draft` is text for its composer rather than a message: it is put in the
   * field, not sent. Resolves to the new chat's id, or null if it could not be
   * started — a caller that has something to *say* in it needs to name it, and
   * reading `selectedId` back would be a guess at whether this call is what put
   * it there.
   *
   * The chat is **not written down here** (see `unsaved`): the first message
   * is what makes it a record, so a `+` nobody speaks into leaves no row and no
   * file.
   */
  create: (
    place: ChatPlace,
    options?: { draft?: string }
  ) => Promise<string | null>
  /**
   * Writes an unsaved chat down, and answers whether it is a record now.
   *
   * The moment a chat stops being this window's own — see `unsaved`. Called by
   * `send` on the first message, which is the only time it happens. A chat
   * already written down answers true without a round trip, so it is safe to
   * call on every message.
   */
  save: (id: string) => Promise<boolean>
  remove: (id: string) => Promise<void>
  /** What a chat is called, in the column and on its tab. An empty name is
   * ignored — that is the field being left blank, not a chat being unnamed. */
  rename: (id: string, title: string) => void

  /**
   * Empties a chat's transcript and the session behind it — `/clear`.
   *
   * The chat itself stays: same id, same tab, same title, same options. What
   * goes is the conversation, and with it the CLI session, since a chat's id is
   * its session id and the next message would otherwise resume into the context
   * this was asked to throw away. See `clearWorktreeChat`.
   */
  clear: (id: string) => Promise<void>

  /**
   * A message, or a command this app answers itself.
   *
   * The interception is here rather than in the composer because this is the one
   * door: the `Changes` pane and the composer both send through it, and a
   * `/clear` typed into either has to mean the same thing. See
   * `localCommand` for why only two commands are this app's and everything else
   * goes to the CLI verbatim.
   */
  send: (id: string, prompt: string, images?: ChatImage[]) => Promise<void>
  stop: (id: string) => void
  /**
   * Answers what a chat is waiting on, and takes the card down.
   *
   * Cleared here rather than on the `decision` event coming back: the turn
   * carries on the moment main has the answer, so a card left up until the
   * round trip completes is a card somebody can answer twice.
   */
  answer: (chatId: string, answer: WorktreeChatAnswer) => void
  /** The model, effort and permission for one chat — the composer's toolbar. */
  setOptions: (id: string, options: WorktreeChatOptions) => void

  /** Subscribes to turns. Called once from the workbench: a turn outlives the
   * pane being switched away from, and its lines have to land either way. */
  listen: () => () => void
}

export const useWorktreeChats = create<WorktreeChatState>((set, get) => ({
  chats: [],
  loading: false,
  messages: {},
  reading: [],
  drafts: {},
  draftImages: {},
  sending: [],
  startedAt: {},
  context: {},
  window: {},
  agents: {},
  compacting: {},
  compactError: {},
  asks: {},
  queued: {},
  unread: {},
  openIds: [],
  selectedId: null,
  unsaved: [],

  async refresh() {
    set({ loading: true })
    try {
      const listed = await window.desktop.listWorktreeChats()
      // A chat main has never heard of is not missing from this list, it is
      // simply not main's yet — and a wholesale replace would close the tab
      // somebody is typing into. Kept at the end, where `create` put them.
      const unsaved = get().unsaved
      const held = get().chats.filter((chat) => unsaved.includes(chat.id))
      set({ chats: [...listed, ...held], loading: false })
    } catch (error) {
      console.error("Could not read the worktree chats", error)
      set({ loading: false })
    }
  },

  select(id) {
    const { openIds, chats } = get()
    const chat = chats.find((entry) => entry.id === id)
    set({
      openIds: openIds.includes(id) ? openIds : [...openIds, id],
      selectedId: id,
      // Looking at it is reading it, which is the whole of what the dot means.
      // Left alone when there is nothing to forget: a new record here on every
      // tab switch is every subscriber of `unread` redrawn for no change.
      unread: get().unread[id] ? without(get().unread, id) : get().unread,
    })

    // The pane too, or clicking a chat row would select a chat nothing is
    // drawing: `worktree` is not a section, so it is only ever reached from a
    // list in somebody else's sidebar, and this is the only thing that shows
    // it. Leaves the sections alone, as a session's pane does.
    useStudio.getState().showPane("worktree")

    /*
     * And the workbench works in this chat's project.
     *
     * Here rather than only on the row in the left column that used to be the
     * one way in: a chat is an ordinary tab in the strip, and switching to one
     * left the crumb, the Explorer's root and the dock's shell wherever they
     * were. The last of those is the one that matters — a chat edits its
     * project with `acceptEdits`, and a terminal beside it pointed at another
     * project is a trap, not an inconvenience.
     *
     * This is what `useFiles.reveal` already does for a file tab, for the same
     * reason — the tree draws one project, so putting something from another
     * one on screen has to move that selection first.
     */
    const place = chat ? placeOf(chat) : null
    if (place) {
      useProjects.getState().setActive(place.folderId)
      useShells.getState().showFor(place.folderId)
    }

    get().read(id)
  },

  read(id) {
    // Read once per run. The main process holds the lines and appends to them,
    // so a re-read on every tab switch would be a file read for an answer we
    // already have.
    if (get().messages[id] || get().reading.includes(id)) return
    set({ reading: [...get().reading, id] })
    void window.desktop
      .readWorktreeChat(id)
      .then((lines) => {
        set({ messages: { ...get().messages, [id]: lines } })
      })
      .catch((error: unknown) => {
        console.error("Could not read that chat", error)
      })
      .finally(() => {
        // In `finally` rather than beside the `set` above: a read that failed
        // leaves no lines, and a chat left marked as reading would sit under
        // a skeleton that never resolves.
        set({ reading: get().reading.filter((entry) => entry !== id) })
      })
  },

  markRead(id) {
    if (!get().unread[id]) return
    set({ unread: without(get().unread, id) })
  },

  close(id) {
    const openIds = get().openIds.filter((entry) => entry !== id)
    set({
      openIds,
      // The one to its right, as an editor does — falling back to the left when
      // it was last.
      selectedId:
        get().selectedId === id ? (openIds.at(-1) ?? null) : get().selectedId,
    })
  },

  closeOthers(id) {
    set({ openIds: [id], selectedId: id })
  },

  closeAll() {
    set({ openIds: [], selectedId: null })
  },

  reorder(ids) {
    // Only ids already open are kept, so a stale list can shuffle the tabs but
    // never conjure or drop one.
    const open = new Set(get().openIds)
    set({ openIds: ids.filter((id) => open.has(id)) })
  },

  async create(place, options) {
    const now = new Date().toISOString()
    const chat: WorktreeChat = {
      /*
       * Minted here rather than by main, which is the whole of what makes an
       * unsaved chat possible: this id is the CLI's session id and the tab's
       * identity in the strip, so it has to be the id main is eventually given
       * rather than one it invents at the first message. A tab that changed id
       * on its first message would be a different tab.
       */
      id: crypto.randomUUID(),
      folderId: place.folderId,
      title: "Untitled",
      createdAt: now,
      updatedAt: now,
    }

    set({
      chats: [...get().chats, chat],
      messages: { ...get().messages, [chat.id]: [] },
      unsaved: [...get().unsaved, chat.id],
      // In the same write as the chat: the composer takes this as its initial
      // value, and one landing a render later would land after the field had
      // been built empty.
      drafts: options?.draft
        ? { ...get().drafts, [chat.id]: options.draft }
        : get().drafts,
    })
    get().select(chat.id)

    return chat.id
  },

  async save(id) {
    if (!get().unsaved.includes(id)) return true

    const chat = get().chats.find((entry) => entry.id === id)
    const place = chat ? placeOf(chat) : null
    // A chat whose project has left the workspace has nowhere to be written
    // down to, which is the same answer its cwd resolve gives a turn.
    if (!chat || !place) return false

    try {
      // Everything the tab picked up before anybody spoke into it goes with it
      // — see `ChatSeed`. `title` is `"Untitled"` unless `/rename` got there
      // first, and main reads that as no name at all.
      await window.desktop.createWorktreeChat(place, {
        id: chat.id,
        title: chat.title,
        options: chat.options,
      })
      set({ unsaved: get().unsaved.filter((entry) => entry !== id) })
      return true
    } catch (error) {
      console.error("Could not start a chat", error)
      return false
    }
  },

  keepDraft(chatId, text, images = []) {
    if (!text) {
      get().clearDraft(chatId)
      return
    }
    const held = get().draftImages[chatId]
    const same = held === images || (!held && images.length === 0)
    if (get().drafts[chatId] === text && same) return
    set({
      drafts: { ...get().drafts, [chatId]: text },
      draftImages:
        images.length > 0
          ? { ...get().draftImages, [chatId]: images }
          : without(get().draftImages, chatId),
    })
  },

  clearDraft(chatId) {
    if (
      get().drafts[chatId] === undefined &&
      get().draftImages[chatId] === undefined
    ) {
      return
    }
    set({
      drafts: without(get().drafts, chatId),
      draftImages: without(get().draftImages, chatId),
    })
  },

  // Written here and then to the record, like `setOptions` and for the same
  // reason: a row that only took its new name once a file had been written
  // would lag behind the Enter that gave it one.
  rename(id, title) {
    const name = title.trim()
    if (!name) return

    set({
      chats: get().chats.map((chat) =>
        chat.id === id ? { ...chat, title: name } : chat
      ),
    })

    // A chat main has never heard of has no record to rename. The name is not
    // lost — `save` carries it over as the chat is written down.
    if (get().unsaved.includes(id)) return

    void window.desktop.renameWorktreeChat(id, name).catch((error: unknown) => {
      console.error("Could not rename that chat", error)
    })
  },

  async remove(id) {
    // A chat that was never written down has nothing on disk to delete, and
    // asking main would be asking about an id it has never heard of.
    if (!get().unsaved.includes(id)) {
      await window.desktop.deleteWorktreeChat(id).catch((error: unknown) => {
        console.error("Could not delete that chat", error)
      })
    }

    const { messages } = get()
    const rest = { ...messages }
    delete rest[id]
    set({
      chats: get().chats.filter((chat) => chat.id !== id),
      messages: rest,
      drafts: without(get().drafts, id),
      draftImages: without(get().draftImages, id),
      queued: without(get().queued, id),
      unsaved: get().unsaved.filter((entry) => entry !== id),
      // Nothing left to read it in. A dot kept for a deleted chat would be
      // counted on its project's row for as long as the window lived.
      unread: without(get().unread, id),
    })
    get().close(id)
  },

  /**
   * A message, whether or not the chat is already answering.
   *
   * The guard that used to be here — drop it if this chat is `sending` — was the
   * renderer's half of a rule the main process no longer has: a chat holds its
   * CLI open, so a second message is queued rather than refused. Enter while a
   * turn is running now does what it does in the terminal.
   */
  async clear(id) {
    // The screen empties first, then the file: this is somebody asking for the
    // transcript to go, and a list that stays up until a round trip completes
    // reads as a command that did nothing.
    set({
      messages: { ...get().messages, [id]: [] },
      sending: get().sending.filter((entry) => entry !== id),
      startedAt: without(get().startedAt, id),
      // The lines those marks were on have gone, and so has the session that
      // was going to run them.
      queued: without(get().queued, id),
      // The card belonging to a paused turn goes with it — main settles that ask
      // on its side, and a question left on screen would have nothing behind it.
      asks: without(get().asks, id),
      // And the dot, which was pointing at lines that no longer exist.
      unread: without(get().unread, id),
      // The meter goes too: `clear` closes the session, so the window it was
      // describing no longer exists, and a percentage left on screen would be
      // reporting a conversation that has been thrown away.
      context: without(get().context, id),
      window: without(get().window, id),
      // Same reason: the session that was running them is closed.
      agents: without(get().agents, id),
      compacting: without(get().compacting, id),
      compactError: without(get().compactError, id),
    })

    // A chat that was never written down has no file to empty and no session
    // behind it: the lines going from the screen is the whole of `/clear` there.
    if (get().unsaved.includes(id)) return

    await window.desktop.clearWorktreeChat(id).catch((error: unknown) => {
      console.error("Could not clear that chat", error)
    })
  },

  async send(id, prompt, images = []) {
    const text = prompt.trim()
    if (!text) return

    /*
     * The two commands this app answers rather than sends.
     *
     * Before the optimistic line below, so a `/clear` never appears in the
     * transcript it is about to empty — and before `sendWorktreeChat`, so the
     * CLI is never handed a message that would read as prose to it.
     */
    const local = localCommand(text)
    if (local?.name === "clear") {
      await get().clear(id)
      return
    }
    if (local?.name === "rename") {
      // A bare `/rename` renames nothing rather than blanking the title, which
      // is `rename`'s own rule for an empty name.
      get().rename(id, local.argument)
      return
    }

    // `@<workflow>` at the head runs that workflow in this chat rather than
    // sending the message — see `lib/workflows/invoke.ts`. Loaded here as
    // well as by the studio, because a popped-out chat window has no studio.
    await useWorkflows.getState().load()
    const invoked = workflowInvocation(text, useWorkflows.getState().workflows)
    if (invoked) {
      // Drawn at once like any message, and written down by main rather than
      // sent; nothing is marked `sending` — the workflow's own turns say so.
      const add = (line: AssistantMessage) =>
        set({
          messages: {
            ...get().messages,
            [id]: [...(get().messages[id] ?? []), line],
          },
        })
      add({
        id: `local-${Date.now()}`,
        role: "user",
        text,
        // The card's start — see `WorkflowBlock`.
        workflow: { id: invoked.workflow.id, name: invoked.workflow.name },
      })
      try {
        if (!(await get().save(id)))
          throw new Error("Could not start that chat.")
        await useWorkflows.getState().run(invoked.workflow.id, {
          chatId: id,
          message: text,
          input: invoked.input,
        })
      } catch (error) {
        // Refused before it ran, so main wrote nothing: the card is closed
        // here, with main's sentence on it.
        add({
          id: `local-error-${Date.now()}`,
          role: "workflow",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    // Shown as sent before the turn starts: a composer that empties and then
    // shows nothing for a second reads as a message that went nowhere. This is
    // the *only* copy on screen — main writes the line down but does not
    // announce it, since a `text` event is a line of the answer and the prompt
    // drawn as one appeared twice.
    const already = get().sending.includes(id)
    const lineId = `local-${Date.now()}`
    set({
      sending: already ? get().sending : [...get().sending, id],
      // A message sent into a chat that is already working does not restart the
      // clock: the work has been going since the first one.
      startedAt: already
        ? get().startedAt
        : { ...get().startedAt, [id]: Date.now() },
      messages: {
        ...get().messages,
        [id]: [
          ...(get().messages[id] ?? []),
          { id: lineId, role: "user", text },
        ],
      },
      // Sent into a chat that was already working, so the CLI queues it behind
      // whatever is running — see `queued`. Read off `sending` rather than
      // asked of main, because `sending` *is* main's answer: it is the `busy`
      // event, and the optimistic add above is what a second message lands on.
      queued: already
        ? { ...get().queued, [id]: [...(get().queued[id] ?? []), lineId] }
        : get().queued,
    })

    try {
      /*
       * The message is what makes the chat a record — see `unsaved`.
       *
       * Inside this `try` so that a chat which could not be written down rolls
       * back exactly like a turn that could not be started: either way the
       * message did not go, and the line saying so is the same line.
       */
      if (!(await get().save(id))) throw new Error("Could not start that chat.")

      await window.desktop.sendWorktreeChat(id, text, images)
    } catch (error) {
      // This line only, not the chat's other marks: a message that could not be
      // sent is not waiting behind anything, and the ones queued before it still
      // are.
      const waiting = (get().queued[id] ?? []).filter(
        (entry) => entry !== lineId
      )
      set({
        sending: get().sending.filter((entry) => entry !== id),
        startedAt: without(get().startedAt, id),
        queued:
          waiting.length > 0
            ? { ...get().queued, [id]: waiting }
            : without(get().queued, id),
        messages: {
          ...get().messages,
          [id]: [
            ...(get().messages[id] ?? []),
            {
              id: `local-error-${Date.now()}`,
              role: "error",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      })
    }
  },

  stop(id) {
    void window.desktop.stopWorktreeChat(id).catch((error: unknown) => {
      console.error("Could not stop that turn", error)
    })
  },

  answer(chatId, answer) {
    const ask = get().asks[chatId]
    if (!ask) return

    set({ asks: without(get().asks, chatId) })

    void window.desktop
      .answerWorktreeChatAsk(ask.id, answer)
      .catch((error: unknown) => {
        console.error("Could not answer that request", error)
      })
  },

  /**
   * Written here and then to the record, rather than waiting on the write.
   *
   * A picker that only moved once a file had been written would lag behind the
   * click that moved it. The failure it trades against is a choice that does not
   * outlive the launch, which is the smaller of the two — and `refresh` reads the
   * record back after every turn, so a write that failed shows up as the control
   * springing back rather than as a chat quietly running on something else.
   */
  setOptions(id, options) {
    set({
      chats: get().chats.map((chat) =>
        chat.id === id ? { ...chat, options } : chat
      ),
    })

    // Same as `rename`: nothing to write to yet, and `save` carries the toolbar
    // over with the chat. A model picked before the first message is kept.
    if (get().unsaved.includes(id)) return

    void window.desktop
      .setWorktreeChatOptions(id, options)
      .catch((error: unknown) => {
        console.error("Could not save that chat's options", error)
      })
  },

  listen() {
    /*
     * Somebody clicked the notification a finished chat rang.
     *
     * `select` and nothing else, because `select` already is the whole gesture:
     * it opens the tab, shows the pane and moves the crumb, the Explorer root
     * and the dock's shell to that chat's project. A reveal that did less would
     * be the one way into a chat that leaves the workbench pointed elsewhere.
     *
     * A chat deleted between the banner being shown and it being clicked
     * selects an id no row carries, which the pane already draws as nothing —
     * the same state a reload with a stale `selectedId` lands in.
     */
    const stopReveal = window.desktop.onRevealWorktreeChat((chatId) => {
      get().select(chatId)
    })

    /*
     * The other way a chat gets read: coming back to the window with that chat
     * already on screen.
     *
     * Without this, a chat sent to and left on screen while its user goes to
     * another app keeps its dot until they click something — a dot over the
     * pane they are already reading. `focus` on the window rather than
     * `visibilitychange`: this is one window, and what matters is whether it
     * has the keyboard, not whether the compositor is drawing it.
     */
    const onFocus = () => {
      const selected = get().selectedId
      if (selected) get().markRead(selected)
    }
    window.addEventListener("focus", onFocus)

    const stopEvents = window.desktop.onWorktreeChatEvent((event) => {
      const { chatId } = event

      /*
       * Whether this leaves something unread in the chat, read before anything
       * below acts on the event — `sending` is what tells quiet from a repeat,
       * and the `busy` branch is about to rewrite it.
       *
       * Set here rather than in each branch because the rule is one rule over
       * the whole stream, the way `main/notify.ts` reads the same events for
       * the notice: two places deciding this is a dot and a banner that can
       * disagree about the same turn.
       */
      if (
        marksUnread(event, {
          sending: get().sending,
          selectedId: get().selectedId,
          focused: document.hasFocus(),
        })
      ) {
        set({ unread: { ...get().unread, [chatId]: true } })
      }

      // The turn has stopped on something. Nothing else arrives for this chat
      // until it is answered, so there is no ordering to worry about here.
      if (event.type === "ask") {
        set({ asks: { ...get().asks, [chatId]: event.ask } })
        return
      }

      /*
       * Whether the chat is working, which is main's to say.
       *
       * Its own event because `done` is no longer the answer: a message sent
       * mid-turn is queued, and the turn that runs it starts without anything
       * arriving here to say so. Set rather than counted — the same value can
       * arrive twice.
       */
      // Where the conversation stands right now. Not a line, so nothing is
      // appended and no chat is re-read: the number simply moves.
      if (event.type === "context") {
        set({ context: { ...get().context, [chatId]: event.tokens } })
        return
      }

      // The measured window, once a turn has ended — the half `context` above
      // cannot give, because a reply carries no denominator. Kept per chat and
      // never written down: it describes a live session.
      if (event.type === "window") {
        set({ window: { ...get().window, [chatId]: event.window } })
        return
      }

      /*
       * The chat has a name of its own now, in place of the sentence it was
       * opened with — see `retitle` in `main/worktree-chat.ts`.
       *
       * Arrives just ahead of `done`, whose re-read of the listing carries the
       * same name — so this is not what usually draws it. It is what draws it on
       * the turn that *failed*, where there is no re-read: a first turn can end
       * in an error and still have been titled.
       */
      if (event.type === "title") {
        const chats = get().chats.map((chat) =>
          chat.id === chatId ? { ...chat, title: event.title } : chat
        )
        set({ chats })

        /*
         * And the **checkout** this chat runs in takes the same name, if it is
         * one nobody has named.
         *
         * Here because this is the moment the name exists, and it is the only
         * one: a worktree cannot be opened nameless the way a chat can — its
         * branch and directory are made before the first prompt — so one created
         * with the branch field left empty waits for exactly this event. Main
         * decides whether there is anything to do, since the three questions
         * ("is this folder a checkout", "is it still on a placeholder branch")
         * are git's to answer; the ordinary reply is that there was not.
         */
        const folderId = chats.find((chat) => chat.id === chatId)?.folderId
        if (folderId) {
          void useStudio.getState().nameWorktree(folderId, event.title)
        }
        return
      }

      // A state, not a fraction: compaction is one summarisation call. The
      // failure is kept beside it so the row can say so rather than simply
      // stopping.
      if (event.type === "compacting") {
        set({
          compacting: event.compacting
            ? { ...get().compacting, [chatId]: true }
            : without(get().compacting, chatId),
          compactError: event.error
            ? { ...get().compactError, [chatId]: event.error }
            : without(get().compactError, chatId),
        })
        return
      }

      // Replaced rather than merged — the event is the whole list, and an empty
      // one is main saying the last subagent has finished.
      if (event.type === "agents") {
        set({
          agents:
            event.agents.length > 0
              ? { ...get().agents, [chatId]: event.agents }
              : without(get().agents, chatId),
        })
        return
      }

      if (event.type === "busy") {
        const sending = get().sending
        const has = sending.includes(chatId)
        if (event.busy === has) return
        set({
          sending: event.busy
            ? [...sending, chatId]
            : sending.filter((entry) => entry !== chatId),
          startedAt: event.busy
            ? { ...get().startedAt, [chatId]: Date.now() }
            : without(get().startedAt, chatId),
        })
        return
      }

      if (event.type === "done") {
        // A turn can end while a card is up — Stop, or a failure — and the
        // question died with the process that asked it.
        if (get().asks[chatId]) set({ asks: without(get().asks, chatId) })
        /*
         * And whatever was queued behind that turn is now the turn.
         *
         * The end of a turn is exactly the moment the CLI folds its queue into
         * the next one, so this is the one edge that clears the marks — all of
         * them, since the fold takes every message waiting rather than the
         * oldest. A turn that ended in an error clears them too: a message
         * queued behind a turn that died is not still waiting, and the line
         * under it is about to say what happened.
         */
        if (get().queued[chatId]) set({ queued: without(get().queued, chatId) })
        // The listing's title and order moved with the turn. Not on a failure:
        // its error line is still being written when this arrives, so the
        // listing would be re-read a beat too early. The line itself comes as
        // its own `error` event — drawing it from this one showed the failure
        // twice.
        if (!event.error) void get().refresh()
        return
      }

      /*
       * The one event that changes a line instead of adding one.
       *
       * Matched on `toolId` rather than on position, because several calls can
       * be outstanding at once and they come back in whatever order the tools
       * finish in. A `toolId` no line carries is dropped: that is the result of
       * a call whose row was written by a build that had no ids.
       */
      if (event.type === "tool-result") {
        const held = get().messages[chatId]
        if (!held) return
        set({
          messages: {
            ...get().messages,
            [chatId]: held.map((line) =>
              line.role === "tool" && line.toolId === event.toolId
                ? {
                    ...line,
                    result: event.result,
                    failed: event.failed,
                    ...(event.output ? { output: event.output } : {}),
                  }
                : line
            ),
          },
        })
        return
      }

      const line: AssistantMessage | null =
        event.type === "text"
          ? {
              id: `s${Date.now()}-${Math.random()}`,
              role: "assistant",
              text: event.text,
            }
          : event.type === "prompt"
            ? {
                id: `s${Date.now()}-${Math.random()}`,
                role: "user",
                text: event.text,
                step: event.step,
              }
            : event.type === "step" || event.type === "workflow"
              ? { id: `s${Date.now()}-${Math.random()}`, ...event.line }
              : event.type === "thinking"
                ? {
                    id: `s${Date.now()}-${Math.random()}`,
                    role: "thinking",
                    text: event.text,
                  }
                : event.type === "tool"
                  ? {
                      id: `s${Date.now()}-${Math.random()}`,
                      role: "tool",
                      name: event.name,
                      summary: event.summary,
                      toolId: event.toolId,
                      title: event.title,
                      path: event.path,
                      input: event.input,
                      stat: event.stat,
                      change: event.change,
                    }
                  : event.type === "usage"
                    ? {
                        id: `s${Date.now()}-${Math.random()}`,
                        role: "usage",
                        usage: event.usage,
                      }
                    : event.type === "decision"
                      ? {
                          id: `s${Date.now()}-${Math.random()}`,
                          role: "ask",
                          text: event.text,
                        }
                      : event.type === "error"
                        ? {
                            id: `s${Date.now()}-${Math.random()}`,
                            role: "error",
                            text: event.text,
                          }
                        : event.type === "compact"
                          ? {
                              id: `s${Date.now()}-${Math.random()}`,
                              role: "compact",
                              trigger: event.trigger,
                              preTokens: event.preTokens,
                              postTokens: event.postTokens,
                              durationMs: event.durationMs,
                            }
                          : null

      if (!line) return
      set({
        messages: {
          ...get().messages,
          [chatId]: [...(get().messages[chatId] ?? []), line],
        },
      })
    })

    return () => {
      window.removeEventListener("focus", onFocus)
      stopEvents()
      stopReveal()
    }
  },
}))

/** One project's chats, newest first. Keyed by root id, which for a chat is
 * its folder — the same key its group and its scope use. */
export function chatsOf(chats: WorktreeChat[], rootId: string): WorktreeChat[] {
  return newestFirst(chats.filter((chat) => chatRootId(chat) === rootId))
}

/**
 * The order the column lists chats in: most recently started at the top.
 *
 * By `createdAt` rather than `updatedAt` — a list ordered by activity
 * rearranges itself under the cursor while a turn is running, which is the row
 * you were reaching for moving as you click it. The file's own order is oldest
 * first, so a new chat landed at the bottom of a long project.
 */
function newestFirst(chats: WorktreeChat[]): WorktreeChat[] {
  return [...chats].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/**
 * The chats belonging to no project — what the column lists as `Ungrouped`.
 *
 * These are the records `chatRootId` reads as null: a chat written while chats
 * lived in a `git worktree` checkout holds that checkout's id, and there is
 * nowhere left to run its next turn. They were hidden for exactly that reason,
 * and hiding them was the wrong answer to it — the conversation is on disk and
 * readable, and a chat that silently stopped existing is worse than one that is
 * listed and says why when you send to it. `WorktreeChats.run` already finishes
 * such a turn with a line saying the project has gone, so the failure is
 * explained rather than mysterious.
 *
 * There is no `+` on that row and no `New chat here` on its menu: a chat needs
 * a directory to run in, and `Ungrouped` names the absence of one.
 */
export function ungroupedChats(chats: WorktreeChat[]): WorktreeChat[] {
  return newestFirst(chats.filter((chat) => chatRootId(chat) === null))
}

/**
 * The place a record names.
 *
 * Null for a record naming none — a chat written while chats lived in a
 * `git worktree` checkout has only that checkout's id, and there is nowhere
 * left to run its next turn. Its lines are still on disk and still readable.
 */
export function placeOf(chat: WorktreeChat): ChatPlace | null {
  const rootId = chatRootId(chat)
  return rootId ? { folderId: rootId } : null
}

/** The place a root id names, for the callers that have only the id: the `+` at
 * the end of a group's strip, and `New chat` on a row. */
export function placeOfRoot(
  rootId: string,
  folders: WorkspaceFolder[]
): ChatPlace | null {
  const folder = folders.find((entry) => entry.id === rootId)
  return folder ? { folderId: folder.id } : null
}

/** One key dropped from a record. Written out because the destructuring form
 * leaves a binding nothing reads, which is a lint error here. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record }
  delete rest[key]
  return rest
}
