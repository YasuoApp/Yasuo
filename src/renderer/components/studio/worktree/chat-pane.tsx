import { useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import { Archive } from "lucide-react"

import {
  chatOptions,
  type ChatPermission,
  type ChatPlace,
  type WorktreeChatOptions,
} from "@shared/api"
import { isStudioShortcut } from "@/lib/shortcuts"
import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import { blockOf, blocksOf } from "@/lib/worktree-chat/activity"
import { clearFind, paintFind, rectOfHit } from "@/lib/worktree-chat/find-marks"
import { hitsIn } from "@/lib/worktree-chat/search"
import { placeOf, useWorktreeChats } from "@/lib/worktree-chat/store"
import { chatLine, totalOf, usageDetail } from "@/lib/worktree-chat/usage"
import { ChatAsk } from "./chat-ask"
import { ChatFind } from "./chat-find"
import { ChatComposer, type ChatComposerHandle } from "./chat-composer"
import { ChatActivity } from "./chat-activity"
import { ChatMessage } from "./chat-message"
import { ChatSkeleton, ChatTranscriptSkeleton } from "./chat-skeleton"
import { WorktreeWelcome } from "./worktree-welcome"

/**
 * A project's chat: the pane the strip's chat tabs draw into.
 *
 * The conversation is hosted rather than tailed — one agent-SDK turn at a time
 * in the project's own directory, streamed back a message at a time (see
 * `main/worktree-chat.ts`). So this is the app's own chat UI rather than a
 * reader: a session's chat view tails the transcript the interactive CLI
 * writes, and therefore cannot be anything else.
 *
 * The rows and the composer are its own — `ChatMessage` and `ChatComposer`
 * beside this file. They were the assistant panel's until that panel was
 * removed, and came here with it: this is the only chat left in the app.
 *
 * One pane for every chat, keyed by which one the strip has selected — the tabs
 * above it are `lib/panels.ts`'s, gathered under the project when grouping is
 * switched on.
 */
export function WorktreeChatPane() {
  const chats = useWorktreeChats((state) => state.chats)
  const selectedId = useWorktreeChats((state) => state.selectedId)
  const openIds = useWorktreeChats((state) => state.openIds)

  const shown =
    selectedId && openIds.includes(selectedId)
      ? chats.find((chat) => chat.id === selectedId)
      : undefined

  // A tab whose chat was deleted underneath it. Said here rather than through
  // `NothingOpen`, which is about a rail section having nothing selected — this
  // pane has no section, and the answer is about the chat.
  if (!shown) {
    return (
      <div className="grid h-full place-items-center p-6">
        <p className="max-w-xs text-center text-xs text-muted-foreground">
          That chat has been deleted. Pick another from the strip, or start one
          from its project.
        </p>
      </div>
    )
  }

  return (
    <Conversation
      /*
       * One instance per chat rather than one reused across the strip.
       *
       * Everything below that is not in the store is this instance's — the find
       * bar, the scroll box, the refs — and a switch used to carry all of it
       * into the next conversation. Two of those leaks were patched where they
       * were found, each by naming the chat the state belonged to: the find bar
       * reads itself back through `find?.chatId === chatId`, and the composer
       * carries `key={chatId}` so one chat's half-written message could not sit
       * under another's. This is that fix for the whole pane instead of a third
       * one: nothing survives the switch, so nothing can be about the wrong
       * chat.
       *
       * The one piece of state that *should* survive is already module-level
       * for its own reasons — `places`, where each chat was left reading — so
       * remounting does not cost the reader their place. The transcript is
       * re-rendered on a switch either way (see `RESTORE_MS`).
       */
      key={shown.id}
      chatId={shown.id}
      // The chat's own place rather than the workbench's: a chat tab can be on
      // screen for a moment before the context has followed it, and the caption
      // saying what this turn may do has to be about *this* chat.
      place={placeOf(shown)}
      // Through `chatOptions` on both sides of the contract: main builds the
      // turn's argument list out of the same reading, and a toolbar showing
      // `Edits` over a turn that ran as a plan is the one disagreement worth
      // ruling out.
      options={chatOptions(shown.options)}
    />
  )
}

/**
 * What the empty field asks for. The permission is what the turn will actually
 * do, so it is what the prompt should be inviting.
 *
 * `where` is the word for the directory, and it is the chat's rather than a
 * constant: a chat in a project's own working tree is not in a checkout, and a
 * placeholder saying otherwise is the composer being wrong about the one thing
 * that decides how carefully somebody phrases the next sentence.
 */
const placeholderFor = (permission: ChatPermission, where: string): string =>
  permission === "plan"
    ? `Ask for a plan for ${where}…`
    : permission === "read"
      ? `Ask about ${where}…`
      : `Ask to make changes in ${where}…`

/**
 * The line under the composer: what this chat's next turn may do, in the words
 * somebody would want to have read before it ran.
 *
 * The last two say **where**, and that is the point of them. There was a second
 * wording for a chat in a `git worktree` checkout — "in this branch only",
 * which is the isolation argument — and it does not hold here: the directory
 * *is* the branch the user has checked out, so the caption says so rather than
 * borrowing a reassurance. See `SYSTEM_PROMPT` in `main/worktree-chat.ts`,
 * which tells the model the same thing.
 */
function captionFor(permission: ChatPermission): string | null {
  switch (permission) {
    case "plan":
      return "Plan mode: this turn reads and changes nothing"
    case "read":
      return "Read only: this turn reads and changes nothing"
    case "ask":
      return "Like the claude CLI: anything your settings do not allow will ask you"
    // Nothing for `edits`: it is the mode a chat is normally in, so its caption
    // was under the composer of every chat all day saying what the toolbar
    // above it already says. The modes that still speak are the ones somebody
    // would be surprised by — the two that refuse, and the one that asks
    // nothing at all.
    case "edits":
      return null
    case "full":
      return "Full access: nothing is asked, in this project's own working tree"
  }
}

/**
 * Where each chat was left reading, by chat id.
 *
 * The pane is one instance reused across the strip's chats, so without this a
 * switch away and back landed at the newest turn — right the first time a chat
 * is opened and wrong every time after, which is how scrolling up to read a
 * plan and glancing at another tab lost the place.
 *
 * Module level rather than a ref because the pane unmounts when the chat it is
 * showing is deleted, and the other chats' places are not that chat's to lose.
 */
const places = new Map<string, { top: number; pinned: boolean }>()

/**
 * How long a restored position keeps being re-applied as the transcript settles.
 * The lines are in the store already, but a switch re-renders every message and
 * its markdown, code and images arrive over the next few frames — so the height
 * at the moment of the switch is short of the real one and a single write lands
 * clamped at the bottom. Bounded in time rather than waiting to reach the
 * target, because a chat that has been compacted meanwhile never will.
 */
const RESTORE_MS = 400

/** How far above the top of the pane a line found by search is put. Enough that
 * what comes before it is visible — a message with nothing above it reads as the
 * start of the conversation. */
const FOUND_MARGIN = 48

/** When a position written down now stops being re-applied. Its own function
 * because both writers of `restore` want the same window, and because reading
 * the clock is not something a component body may do. */
function heldUntil(): number {
  return Date.now() + RESTORE_MS
}

function Conversation({
  chatId,
  place,
  options,
}: {
  chatId: string
  /** Null once the checkout or project a chat names has gone. */
  place: ChatPlace | null
  options: WorktreeChatOptions
}) {
  const messages = useWorktreeChats((state) => state.messages[chatId])
  const reading = useWorktreeChats((state) => state.reading.includes(chatId))
  const sending = useWorktreeChats((state) => state.sending.includes(chatId))
  const startedAt = useWorktreeChats((state) => state.startedAt[chatId])
  const agents = useWorktreeChats((state) => state.agents[chatId])
  const context = useWorktreeChats((state) => state.context[chatId])
  const contextWindow = useWorktreeChats((state) => state.window[chatId])
  const compacting = useWorktreeChats((state) => state.compacting[chatId])
  const compactError = useWorktreeChats((state) => state.compactError[chatId])
  const ask = useWorktreeChats((state) => state.asks[chatId])
  /** The messages sent into this chat while it was already working, which the
   * CLI has queued behind the turn on screen — see `queued` in the store. */
  const queued = useWorktreeChats((state) => state.queued[chatId])
  const send = useWorktreeChats((state) => state.send)
  const stop = useWorktreeChats((state) => state.stop)
  const answer = useWorktreeChats((state) => state.answer)
  const setOptions = useWorktreeChats((state) => state.setOptions)
  /**
   * This chat's unsent draft — what was typed and left, or a message written
   * *for* the user: the `Changes` pane's review, which `Ask AI to fix` puts in
   * the field rather than sending (`drafts` on the store).
   *
   * Read here and handed down as the field's initial value, which is why the
   * composer is keyed by the chat below: a draft belongs to the conversation it
   * was written in, and the same field instance carried across a switch is how
   * one chat's half-written message came to sit under another one's.
   */
  const seeded = useWorktreeChats((state) => state.drafts[chatId])
  const keepDraft = useWorktreeChats((state) => state.keepDraft)
  const clearDraft = useWorktreeChats((state) => state.clearDraft)

  // Where the file picker opens and what a picked path is written relative to.
  // The record's own path rather than one built here, and undefined for a
  // project that has left the workspace — there is nowhere to resolve against.
  const root = useStudio((state) =>
    state.folders.find((entry) => entry.id === place?.folderId)
  )?.path

  // Memoised, unlike the bare `messages ?? []` it was: the find below folds it
  // into blocks and matches, and a fresh array on every render would recompute
  // both on every keystroke in the composer.
  const lines = useMemo(() => messages ?? [], [messages])
  // A chat with no lines *yet* is not an empty chat, and the two have nothing
  // in common to say — one gets the skeleton, the other the welcome.
  const empty = !reading && lines.length === 0

  const box = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const composer = useRef<ChatComposerHandle>(null)

  /**
   * `⌘F`, and what it has found — null while the bar is shut.
   *
   * **It carries the chat it is about**, and is read back through that
   * (`find?.chatId === chatId` everywhere below) rather than cleared by an
   * effect on the way past: this pane is one instance reused across the strip's
   * chats, so a search left open in one would otherwise follow the reader into
   * the next and count matches in a conversation they had not searched. Switching
   * away shuts it; switching back opens a fresh one. Same self-healing the
   * `Changes` list's chat filter does.
   *
   * `opened` counts the presses rather than being a boolean, so pressing `⌘F`
   * with the bar already up puts the caret back in the field and selects what is
   * there — which is what the key does in every editor, and what makes a second
   * press a new search rather than a no-op.
   *
   * In memory and per run, like every other "where somebody is" in this app.
   */
  const [find, setFind] = useState<{
    chatId: string
    query: string
    /** Which match the arrows are on, counted up without bound and taken modulo
     * the number of matches — so a query that finds fewer than before cannot
     * leave this pointing past the end. */
    at: number
    opened: number
  } | null>(null)
  const showing = useStudio((state) => state.pane) === "worktree"

  /*
   * The key itself.
   *
   * On the window and on the capture phase, the way `⌘P` is claimed, but with a
   * condition `⌘P` does not need: **only while this pane is the one on screen**.
   * The panes are stacked and hidden with `invisible` rather than unmounted, so
   * this component is alive and listening while somebody is reading a diff — and
   * in a diff, a file or the block editor `⌘F` already belongs to CodeMirror's
   * own search panel, over the text it is about. That is the right answer there
   * and not one this bar could give.
   */
  useEffect(() => {
    if (!showing) return

    function onKeyDown(event: KeyboardEvent) {
      if (!isStudioShortcut(event, "f")) return
      event.preventDefault()
      setFind((held) =>
        held?.chatId === chatId
          ? { ...held, opened: held.opened + 1 }
          : { chatId, query: "", at: 0, opened: 1 }
      )
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }, [chatId, showing])

  /**
   * A file dropped anywhere over the conversation, typed in as its path.
   *
   * The same substitution the terminal makes (`terminal-view.tsx`) and for the
   * same reason: what goes to the turn is a prompt, so a picture is *named* to
   * it rather than uploaded — the agent runs here with `Read`, which is how it
   * opens an image. Anywhere over the pane rather than on the field alone,
   * because a screenshot is dragged at the conversation, not at a 60-pixel box.
   *
   * Any file, not only a picture, for the reason the `+` menu takes any: a path
   * is a path, and a `.csv` dropped in is as good an instruction as a `.png`.
   *
   * `dragleave` fires on every crossing into a child as well as on the way out,
   * so the depth is counted rather than trusted — read as a boolean the tint
   * flickers off the moment the pointer moves over a message.
   */
  const [dropping, setDropping] = useState(false)
  const depth = useRef(0)

  const carriesFiles = (event: DragEvent) =>
    [...event.dataTransfer.types].includes("Files")

  function onDrop(event: DragEvent) {
    if (!carriesFiles(event)) return
    event.preventDefault()
    depth.current = 0
    setDropping(false)

    // Empty for anything with no file behind it — an image dragged out of a
    // web page is bytes Chromium is holding, and there is no path to type.
    // Those are dropped rather than written out to the workspace: what the
    // turn would then read is a copy nobody can find again.
    const paths = [...event.dataTransfer.files]
      .map((file) => window.desktop.getPathForFile(file))
      .filter(Boolean)
    composer.current?.insertPaths(paths)
  }
  /**
   * Whether the view is following the end of the transcript. Deliberately not
   * "is scrolled to the bottom": a message rendering taller a frame later —
   * markdown, a code block, an image — leaves the view short of the bottom
   * without anybody having scrolled, and reading the distance alone is what
   * made the pane stop following after the first such block.
   */
  const pinned = useRef(true)
  const lastTop = useRef(0)

  // A position being put back, and whether that is still in force — see
  // `RESTORE_MS`. While it is, the view's own scroll events say nothing about
  // what the user wants: they are this restore's, and reading them would pin the
  // chat to the bottom it was momentarily clamped at.
  const restore = useRef<{ top: number; until: number } | null>(null)
  const restoring = () => {
    const pending = restore.current
    if (!pending) return false
    if (Date.now() < pending.until) return true
    restore.current = null
    return false
  }

  // Follows the newest turn, but only while it is pinned: yanking the view down
  // while somebody reads further up is what makes a transcript unusable.
  // `ask` is in here too: a question arriving is the one thing that must not be
  // left below the fold, since the turn is waiting on it.
  useEffect(() => {
    const element = box.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [messages, sending, ask])

  // Opening a chat lands at its newest turn; coming back to one lands where it
  // was left (`places`). Either way the pin is set from the chat being shown
  // rather than inherited: the pane is one instance reused across the strip's
  // chats, and the previous conversation's scroll position and pin are what a
  // switch used to arrive with.
  useEffect(() => {
    const element = box.current
    const seen = places.get(chatId)
    pinned.current = seen ? seen.pinned : true
    lastTop.current = seen?.top ?? 0
    restore.current =
      seen && !seen.pinned ? { top: seen.top, until: heldUntil() } : null
    if (!element) return
    element.scrollTop = pinned.current ? element.scrollHeight : (seen?.top ?? 0)
  }, [chatId])

  // The transcript settles over several frames — lines arrive from disk after
  // the switch, and a block that has just mounted grows as its markdown, code
  // and images render. Scrolling once from an effect lands on whatever height
  // existed at that moment, so the bottom is held here instead, for as long as
  // the content keeps changing size.
  useEffect(() => {
    const element = box.current
    const inner = content.current
    if (!element || !inner) return
    const observer = new ResizeObserver(() => {
      if (pinned.current) {
        element.scrollTop = element.scrollHeight
        lastTop.current = element.scrollTop
        return
      }
      // The other half of the same problem: a position put back before the
      // transcript had its full height was clamped, so it is written again
      // every time that height changes.
      const pending = restoring() ? restore.current : null
      if (!pending) return
      element.scrollTop = pending.top
      lastTop.current = element.scrollTop
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [empty, reading])

  const blocks = useMemo(() => blocksOf(lines), [lines])

  /*
   * `⌘F` — see `ChatFind`, and `find` for why it carries the chat it is about.
   *
   * A match is an **occurrence**, so `hits` is longer than the number of
   * messages carrying them and `n of m` counts what is painted. What each one is
   * drawn *in* is still a block, because that is the unit the transcript is laid
   * out in and the only thing a match inside a collapsed fold has on screen.
   */
  /** The search, but only while it is this chat's — see `find`. */
  const finding = find?.chatId === chatId ? find : null
  const hits = useMemo(
    () => (finding ? hitsIn(lines, finding.query) : []),
    [finding, lines]
  )
  const at = finding && hits.length > 0 ? finding.at % hits.length : 0
  const current = hits[at] ?? null
  const currentBlock = current ? blockOf(blocks, current.messageId) : null
  /** The folds holding a match, which are the only blocks still ringed — see
   * the wrapper below. `flatMap` drops a line this transcript no longer draws. */
  const foundBlocks = useMemo(
    () => new Set(hits.flatMap((hit) => blockOf(blocks, hit.messageId) ?? [])),
    [hits, blocks]
  )

  /*
   * Landing on the match the arrows are on.
   *
   * Through `restore` rather than a bare `scrollIntoView`, which is the same
   * problem the effect above solves and so the same answer: the transcript
   * settles over several frames — lines arrive from disk after a switch, and
   * markdown, code and images grow as they render — so a single scroll lands on
   * whatever height existed at that instant. Writing the position into `restore`
   * puts the `ResizeObserver` in charge of holding it while that is going on.
   *
   * `handled` is what makes this land once per step rather than on every line a
   * running turn appends: the token is the match being walked to, and it is not
   * written until the node is actually found, so the effect keeps trying while
   * the chat is still being read off disk.
   */
  const handled = useRef<string | null>(null)
  useEffect(() => {
    const element = box.current
    const root = content.current
    if (!element || !root || !current || !currentBlock || !finding) return

    const token = `${chatId}:${at}:${finding.query}`
    if (handled.current === token) return

    /*
     * The match itself where its text is on screen, and the block holding it
     * where it is not — a match inside a collapsed fold has nothing narrower to
     * land on, which is the same reason that fold is the one thing still ringed.
     */
    const found =
      rectOfHit(root, current, finding.query) ??
      element
        .querySelector(`[data-block="${CSS.escape(currentBlock)}"]`)
        ?.getBoundingClientRect()
    if (!found) return

    handled.current = token
    pinned.current = false
    const top = Math.max(
      0,
      element.scrollTop +
        found.top -
        element.getBoundingClientRect().top -
        FOUND_MARGIN
    )
    restore.current = { top, until: heldUntil() }
    element.scrollTop = top
    lastTop.current = top
  }, [current, currentBlock, at, chatId, finding, lines])

  /*
   * And marking the matches themselves — see `paintFind`.
   *
   * Re-painted through a `MutationObserver` as well as on the search changing,
   * because the transcript's own DOM moves under it for reasons this component
   * never hears about: a fold opened by hand, a code block or an image
   * finishing, a line landing mid-turn. Nothing here touches the DOM — the
   * marks are ranges in the highlight registry — so a repaint cannot be what
   * triggers the next one.
   */
  useEffect(() => {
    const root = content.current
    if (!root || !finding) {
      clearFind()
      return
    }

    const paint = () => paintFind(root, hits, current, finding.query)
    paint()

    const observer = new MutationObserver(paint)
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    return () => {
      observer.disconnect()
      clearFind()
    }
  }, [finding, hits, current])

  // The chat's own running cost, added up from the turns' own lines rather than
  // kept anywhere — see `totalOf`. Null for a chat with no usage lines at all,
  // which is every chat written before there were any.
  const total = totalOf(lines)
  // With the context window where it stands *now* rather than where the last
  // turn left it: main sends that per reply, so it moves while a turn works.
  const line = chatLine(total, context)
  const detail = total
    ? usageDetail({ ...total, context: context ?? total.context })
    : undefined

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current += 1
        setDropping(true)
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return
        // Without this the drop is refused and Chromium navigates the window to
        // the file instead, which takes the whole studio with it.
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDropping(false)
      }}
      onDrop={onDrop}
    >
      {/* Over the pane rather than around it: a border on the container would
          move the transcript by a pixel as the pointer came in. */}
      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed border-ring bg-background/70">
          <p className="text-xs text-muted-foreground">
            Drop to write the path into your message
          </p>
        </div>
      )}

      {/* `⌘F`, hanging over the top-right corner of the transcript the way an
          editor's does — see `ChatFind` for why it is a bar and not a dialog.
          Keyed by the chat so a bar carried across a switch cannot keep the
          previous conversation's field. */}
      {finding && (
        <ChatFind
          key={chatId}
          query={finding.query}
          opened={finding.opened}
          at={at}
          total={hits.length}
          // A new query starts at its first match rather than wherever the last
          // one had walked to: `at` is an index into a list that has just been
          // replaced.
          onQuery={(query) => setFind({ ...finding, query, at: 0 })}
          onStep={(by) => {
            if (hits.length === 0) return
            // Wrapped here rather than counted up, so `at` is always an index
            // into the list as it stands: `at + by` can go negative, which is
            // what the `+ hits.length` is for.
            setFind({ ...finding, at: (at + by + hits.length) % hits.length })
          }}
          onClose={() => setFind(null)}
        />
      )}

      <div
        ref={box}
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
          if (restoring()) {
            lastTop.current = scrollTop
            return
          }
          // Reaching the bottom pins; only scrolling *up* unpins. Content
          // growing under a still view fires a scroll event too, and treating
          // that as leaving the bottom is what stopped the pane following a
          // turn that was still rendering.
          if (scrollHeight - scrollTop - clientHeight < 8) pinned.current = true
          else if (scrollTop < lastTop.current - 1) pinned.current = false
          lastTop.current = scrollTop
          places.set(chatId, { top: scrollTop, pinned: pinned.current })
        }}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          empty ? "grid place-items-center px-6" : "px-4 py-4"
        )}
      >
        {reading ? (
          <div
            ref={content}
            className="mx-auto flex w-full max-w-2xl flex-col gap-3"
          >
            <ChatTranscriptSkeleton />
          </div>
        ) : empty ? (
          // Where this chat is, which is what somebody with three checkouts of
          // one project open needs before they ask for anything.
          <div className="w-full max-w-md">
            <WorktreeWelcome place={place} />
          </div>
        ) : (
          <div
            ref={content}
            className="mx-auto flex w-full max-w-2xl flex-col gap-3"
          >
            {blocks.map((block) => (
              /*
               * A wrapper per block, for the one thing a block cannot carry
               * itself: where it is. The palette's search opens a chat *at* a
               * line, and both halves of landing on it — the scroll above and
               * the ring below — need a node to find and mark. Drawn for every
               * block rather than only the found one, so the transcript's
               * layout does not change under a reader when one is.
               */
              <div
                key={block.id}
                data-block={block.id}
                /*
                 * A match is marked on the **words**, not on the block — see
                 * `paintFind`, which paints them into the highlight registry.
                 *
                 * The ring is what is left of that for the one case the words
                 * cannot answer: a **fold**. A turn's working is collapsed, so a
                 * message the model wrote mid-turn has no text on screen to
                 * paint — and a match that is counted, scrolled to and then
                 * invisible is worse than one that was never counted. So a fold
                 * holding a match says so, and says harder when it is the one
                 * the arrows are on. An open fold gets both, which is the honest
                 * answer for a container: the ring is where, the highlight is
                 * what.
                 */
                className={cn(
                  "rounded-lg",
                  block.kind === "activity" &&
                    foundBlocks.has(block.id) &&
                    "ring-1 ring-ring/25 ring-offset-4 ring-offset-background",
                  block.kind === "activity" &&
                    block.id === currentBlock &&
                    "ring-2 ring-ring/70"
                )}
              >
                {block.kind === "activity" ? (
                  <ChatActivity of={block} />
                ) : (
                  <ChatMessage
                    of={block.line}
                    queued={queued?.includes(block.line.id) === true}
                  />
                )}
              </div>
            ))}
            {/* At the end of the transcript rather than over it: it is the turn
                asking, so it belongs where the turn had got to. */}
            {ask && (
              <ChatAsk ask={ask} onAnswer={(given) => answer(chatId, given)} />
            )}
            {/*
              Compaction, which is a state and never a percentage.

              An indeterminate row on purpose: the CLI reports `compacting` and
              then not, because one summarisation call has no fraction of itself
              to report. A determinate bar here would be an animation pretending
              to measure something — what *is* measurable is the window either
              side, which lands as the `compact` line above and moves the meter
              in the composer.

              Above the turn's own spinner, since compaction happens to the
              conversation rather than as part of the answer.
            */}
            {compacting && (
              <div className="flex items-center gap-2 px-1 text-[0.7rem] text-muted-foreground">
                <Archive className="size-3 shrink-0 animate-pulse" />
                <span>Compacting the conversation…</span>
              </div>
            )}
            {/* Kept until the next compaction starts: a failure that vanished
                with the spinner would leave a window that never shrank and no
                reason on screen for it. */}
            {!compacting && compactError && (
              <div className="flex items-center gap-2 px-1 text-[0.7rem] text-destructive">
                <Archive className="size-3 shrink-0" />
                <span className="truncate">
                  Could not compact: {compactError}
                </span>
              </div>
            )}
            {/* Not while a question is up — the turn is held, not working, and
                a spinner under the card would say otherwise.

                A running subagent counts as working even when the chat does
                not: a turn that started one in the background is *over* as far
                as the CLI's own result is concerned, and on a `claude` too old
                to report its state that is all `sending` has to go on. The
                agents are what is still out there, so they draw their own
                spinner. */}
            {(sending || (agents ?? []).length > 0) && !ask && (
              <ChatSkeleton startedAt={startedAt} agents={agents} />
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t p-3">
        <div className="mx-auto w-full max-w-2xl space-y-1.5">
          <ChatComposer
            // One field per chat: its draft is that chat's, and a field kept
            // across a switch is one draft shared by every conversation.
            key={chatId}
            ref={composer}
            initialDraft={seeded ?? ""}
            // The field on its way out — switching chats, or this panel being
            // taken down — hands back what was in it, and that is what makes
            // coming back to a chat find the sentence you left in it.
            onLeave={(text) => keepDraft(chatId, text)}
            sending={sending}
            onSend={(text) => {
              // Before the send, so the draft cannot outlive the message: the
              // field empties itself, and this is what stops a rebuild of it
              // putting the sent text back.
              clearDraft(chatId)
              void send(chatId, text)
            }}
            onStop={() => stop(chatId)}
            placeholder={
              ask
                ? "Answer above to carry on…"
                : sending
                  ? // Said rather than left to be discovered: the field is live
                    // while a turn runs, and somebody who last used this app a
                    // version ago has every reason to think it is not.
                    "Type ahead — this goes when the turn ends…"
                  : placeholderFor(options.permission, "this project")
            }
            options={options}
            onOptions={(next) => setOptions(chatId, next)}
            attachRoot={root}
            // The id rather than the path, because main resolves it: a command
            // set is per directory, and which directory a project is in is the
            // store's to say — see `agentCommands`.
            folderId={place?.folderId ?? null}
            contextWindow={contextWindow}
          />

          {/* Said plainly rather than left implicit: a turn here edits files
              and runs commands without asking, in the working tree the user
              has open. It has to follow the permission rather than describe the
              usual one — a caption that lies about the turn is worse than none,
              in either direction. */}
          <div className="flex items-baseline justify-between gap-3 px-1 text-[0.7rem]">
            <p
              className={cn(
                "min-w-0",
                options.permission === "full"
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {ask
                ? "The turn is waiting on your answer. Stop ends it instead."
                : captionFor(options.permission)}
            </p>

            {/* Beside the caption rather than at the end of the transcript: the
                per-turn lines are up there, and what belongs here is the one
                number somebody compares against `/cost` in a terminal — this
                chat, so far. */}
            {line && (
              <p
                title={detail}
                className="shrink-0 text-muted-foreground/80 tabular-nums"
              >
                {line}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
