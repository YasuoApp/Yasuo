import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react"
import {
  ArrowUp,
  AtSign,
  Slash,
  Terminal,
  Eye,
  File,
  Folder,
  KeyRound,
  Map,
  MessageCircleQuestion,
  Paperclip,
  PencilLine,
  Plus,
  ShieldOff,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Square,
  Star,
  TextSelect,
  X,
  Check as CheckIcon,
} from "lucide-react"

import {
  CHAT_PERMISSIONS,
  chatEfforts,
  DEFAULT_CHAT_OPTIONS,
  type AgentCommand,
  type AgentModel,
  type ChatImage,
  type ChatWindow,
  type ChatEffort,
  type ChatPermission,
  type ClaudeAccount,
  type ClaudeProfile,
  type WorktreeChatOptions,
} from "@shared/api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu"
import { Claude } from "@/components/ui/svgs/claude"
import { useEditorSelection } from "@/lib/files/editor-selection"
import { nameOf, quotePath, relativeTo } from "@/lib/files/paths"
import { selectionLabel, selectionMention } from "@/lib/files/selected-lines"
import { useGitStatus } from "@/lib/files/git-status"
import { iconFor } from "@/lib/files/icons"
import { useFiles } from "@/lib/files/store"
import { useSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import {
  accountLine,
  useClaudeProfiles,
} from "@/lib/worktree-chat/claude-profiles"
import {
  defaultModelAlias,
  effortFor,
  orderedModels,
  useAgentModels,
} from "@/lib/worktree-chat/models"
import { useAgentCommands } from "@/lib/worktree-chat/commands"
import {
  commandQuery,
  insertCommand,
  LOCAL_COMMANDS,
  rankCommands,
  type CommandQuery,
} from "@/lib/worktree-chat/command-text"
import {
  attachedIn,
  dataUrlOf,
  imageTag,
  namedIn,
  readImage,
  withoutTag,
} from "@/lib/worktree-chat/images"
import { chatMentions, primeMentions } from "@/lib/worktree-chat/mentions"
import { compact } from "@/lib/worktree-chat/usage"
import {
  bandOf,
  remainingOf,
  windowDetail,
  windowHint,
  windowLabel,
  windowSlices,
  WINDOW_TONES,
} from "@/lib/worktree-chat/window"
import {
  insertMention,
  markMentions,
  mentionOf,
  mentionQuery,
  rankPlainMentions,
  PLAIN_LABELS,
  type MentionQuery,
  type MentionSegment,
  type PlainMention,
  type PlainMentionKind,
} from "@/lib/worktree-chat/mention-text"
import { IconButton } from "../icon-button"
import { ImageThumb } from "./chat-images"
import { McpMenu } from "./chat-mcp"
import { PlanUsageMeter } from "./chat-plan-usage"

/**
 * A chat's composer, with two menus: `@` over the checkout's folders and files,
 * and `/` over the commands the user's own `claude` would run here.
 *
 * **`/` is the CLI's list, not this app's.** The commands are asked for over the
 * SDK's control channel in the project's own directory (`main/agent-commands.ts`),
 * so a skill added to a repository or a plugin installed this morning is in the
 * menu without a release. What is picked goes to the CLI as the message and is
 * run by the CLI — with two exceptions, `/clear` and `/rename`, which are about
 * the conversation rather than the code and are this app's to answer; see
 * `lib/worktree-chat/command-text.ts`.
 *
 * A mention is the path and nothing else — the turn runs in this checkout with
 * `Read`, so a path is already something the agent can open, and it is what the
 * agent would have typed itself.
 *
 * What the menu leaves out is as deliberate as what it holds: `.git`,
 * `node_modules` and the rest are never indexed, and what the repository's own
 * `.gitignore` disowns is dropped on top of that (`lib/worktree-chat/
 * mentions.ts`).
 *
 * A row is the file type's own icon, the path, and an estimate of what reading
 * it would cost — the last being the one thing a path alone does not say:
 * `src/main` and `src/main/git.ts` look alike in a menu and are three orders of
 * magnitude apart in a context window. There was a composer whose `@` pasted the
 * context in, and one that listed the Database, API and Notes panels' names; see
 * `lib/worktree-chat/mention-text.ts` for why this one does neither.
 *
 * The tint is drawn *behind* the text by a mirror of it, rather than by making
 * this a rich-text editor: the message is plain text on the wire and in the
 * transcript, and a Milkdown instance in a pane this narrow would be a document
 * model to keep in step for a decoration. The mirror is why the two share
 * `FIELD` — one class list, so one layout.
 */

/** Rows past this are a keystroke away from a shorter list. */
const MAX_ROWS = 40

/**
 * The composer's one menu: the `@` over this checkout's paths, or the `/` over
 * the user's own `claude`'s commands.
 *
 * A tagged union rather than two pieces of state, because they cannot both be
 * open — `/` is only a query at the head of the message — and two would have to
 * be kept agreeing about that. The `kind` is what the arrow keys, Escape and the
 * insertion all branch on, once each.
 */
type Menu =
  | {
      kind: "mention"
      query: MentionQuery
      items: PlainMention[]
      selected: number
    }
  | {
      kind: "command"
      query: CommandQuery
      items: AgentCommand[]
      selected: number
    }

/**
 * The new menu, keeping the highlighted row where the query has not changed.
 *
 * The caret moving without the filter changing — a click, an arrow along the
 * line — must not throw away the row somebody has walked down to. A filter that
 * *has* changed goes back to the top, since the rows under it are different
 * ones. Clamped, because the new list can be shorter than the old selection.
 */
function keepSelection(next: Menu, was: Menu | null): Menu {
  if (!was || was.kind !== next.kind) return next
  if (was.query.filter !== next.query.filter) return next
  return {
    ...next,
    selected: Math.max(0, Math.min(was.selected, next.items.length - 1)),
  }
}

/**
 * Everything that decides where a character lands, on both the textarea and the
 * mirror behind it. The font size is pinned at every breakpoint because the ui
 * `Textarea`'s own `md:text-sm` would move one of the two and not the other.
 */
// The send button used to sit on top of the text, which is what `pr-10` was
// holding room for; it is in the toolbar under the field now, so the text has
// the whole width back.
const FIELD = "px-2.5 pt-2 pb-1 text-xs leading-relaxed md:text-xs"

/** The field's own `min-h-14` and `max-h-48`: a dragged height below the one
 * is a box that no longer shows a line, and up to the other the text still
 * grows the field by itself. */
const FIELD_MIN = 56
const FIELD_GROWS_TO = 192
/** Of the window, so a composer dragged up cannot push the transcript off. */
const FIELD_MAX_SHARE = 0.7

/** The hue each kind is known by — the Explorer's own token, since that is the
 * panel a path belongs to, with a folder drawn in it more faintly than a file
 * so the two are told apart at a glance. */
const KIND_HUE: Record<PlainMentionKind, string> = {
  directory: "color-mix(in oklab, var(--section-files) 60%, transparent)",
  file: "var(--section-files)",
}

/**
 * The one thing anything outside this component may do to the field.
 *
 * The draft is deliberately uncontrolled (see `initialDraft`), so a pane that
 * wants a path in the message cannot put it there by handing a value down — it
 * asks the field to type it, the way the `+` menu's picker does. That is the
 * whole handle, and it should stay that way.
 */
/** One empty list, for a draft with no pictures — shared rather than a fresh
 * `[]` per render or per send. */
const NO_IMAGES: ChatImage[] = []

export type ChatComposerHandle = {
  /** Writes absolute paths at the caret, each one relative to `attachRoot`
   * where it is inside it. */
  insertPaths: (paths: string[]) => void
  /** Holds pictures for the message and writes an `[Image #n]` at the caret
   * for each — see `lib/worktree-chat/images.ts`. */
  insertImages: (images: ChatImage[]) => void
  /**
   * Writes text at the caret, spaced off what is around it — a selection
   * carried over from the dock's shell, fenced, with a question to follow. The
   * same gesture `insertPaths` is, for something that is not a path.
   */
  insertText: (text: string) => void
  /** Puts the caret in the field. */
  focus: () => void
}

export function ChatComposer({
  ref,
  sending,
  onSend,
  onStop,
  placeholder = "Ask about this checkout…",
  options = DEFAULT_CHAT_OPTIONS,
  onOptions,
  attachRoot,
  folderId = null,
  contextWindow,
  initialDraft = "",
  initialImages = NO_IMAGES,
  onLeave,
}: {
  /** The pane's way in, for a file dropped anywhere over the conversation
   * rather than on the field itself — see `ChatComposerHandle`. */
  ref?: RefObject<ChatComposerHandle | null>
  sending: boolean
  /** The message, with the pictures its `[Image #n]` tags still name —
   * renumbered by `attachedIn`, so the two agree. */
  onSend: (text: string, images: ChatImage[]) => void
  onStop: () => void
  placeholder?: string
  /** What the toolbar under the field is showing. */
  options?: WorktreeChatOptions
  /**
   * A whole new set of them, on every change.
   *
   * Whole rather than a patch all the way down to the record — see
   * `WorktreeChatOptions`. Optional so the composer still draws without an
   * owner for the toolbar, in which case it is left off.
   */
  onOptions?: (options: WorktreeChatOptions) => void
  /**
   * The checkout the chat is in: where the file picker opens, and what a picked
   * path is written relative to.
   *
   * A path in a message is for the agent to read, and its cwd is this
   * directory — so `src/main/ipc.ts` is both shorter than the absolute path and
   * the thing the agent would have typed itself.
   */
  attachRoot?: string
  /**
   * The project the chat is in, for the `/` menu's list of commands.
   *
   * The id rather than `attachRoot`'s path: main resolves a project to its
   * directory, and a command set is per directory — a repository's own
   * `.claude/commands` and its skills are only in that checkout. Null asks in
   * the user's home directory, which is the honest answer for a chat with no
   * project behind it.
   */
  folderId?: string | null
  /**
   * How full this chat's context window is, for the toolbar's meter.
   *
   * Named `contextWindow` rather than `window` on purpose: a prop called
   * `window` shadows the global inside this component, and `attach()` reaches
   * for `window.desktop`.
   *
   * Undefined until the CLI has been asked, which is once the chat's first turn
   * has ended — the meter is simply absent until then rather than drawn at zero.
   */
  contextWindow?: ChatWindow
  /**
   * What the field starts with: this chat's unsent draft, or a message written
   * *for* the user — the `Changes` pane's review, which `Ask AI to fix` puts
   * here rather than sending.
   *
   * The **initial** value rather than a controlled one, because a field being
   * typed into is the user's: a value round-tripped through a store on every
   * keystroke would put the caret machinery below (the mention menu's
   * `pending` caret, the mirror's scroll) behind a render it does not control.
   * The pane keys this component by the chat instead, which is React's own way
   * of saying "this is a different field now".
   */
  initialDraft?: string
  /** The pictures that draft's `[Image #n]` tags stand for, `[n - 1]` for each. */
  initialImages?: ChatImage[]
  /**
   * The field on its way out, so the draft can be kept for this chat.
   *
   * A parting shot rather than a change event: what the owner wants is the last
   * thing that was in it, and a store written per keystroke would re-render the
   * pane on every letter typed.
   */
  onLeave?: (text: string, images: ChatImage[]) => void
}) {
  const [draft, setDraft] = useState(initialDraft)
  /**
   * Every picture added to this draft, in the order it was added — `[Image #n]`
   * is `images[n - 1]`. Never shortened while the draft lives, so a number
   * once written always names the same picture; deleting a tag is what takes
   * one out, and `attachedIn` is where that is read.
   */
  const [images, setImages] = useState(initialImages)
  /**
   * The one menu, in whichever of its two kinds is open.
   *
   * One piece of state rather than two, because the two can never both be open —
   * `/` is only a query at the head of the message and `@` needs a word boundary
   * — and two would have to agree about that. It is also what lets the arrow
   * keys and Escape below be written once for both.
   */
  const [menu, setMenu] = useState<Menu | null>(null)

  /**
   * Latched by the first `/` typed in this field, and never cleared.
   *
   * Asking costs a `claude` process (`agent-commands.ts`), so it is not paid for
   * by every composer that mounts — but a menu that closes is not a reason to
   * forget an answer already bought, which is why this only ever goes one way.
   */
  const [wantsCommands, setWantsCommands] = useState(false)
  const commands = useAgentCommands(folderId, wantsCommands)

  // The user's own `claude`'s list, for the two pickers that need it — the
  // model's rows and, per model, which effort levels exist at all.
  const models = useAgentModels()
  // Loaded once at launch (`studio.tsx`); read here for the profile picker,
  // which is drawn only once there is a profile to choose — see `ProfileMenu`.
  const profiles = useClaudeProfiles((state) => state.profiles)

  /* The draft as it stands, for the unmount below: the cleanup runs once and
   * would otherwise close over the empty string it was built with. */
  const latest = useRef({ draft, images })
  useEffect(() => {
    latest.current = { draft, images }
  })

  /* Through a ref as well, so the cleanup below can stay a once-only effect
   * while still calling whatever the current owner is. */
  const onLeaveRef = useRef(onLeave)
  useEffect(() => {
    onLeaveRef.current = onLeave
  })

  // Once, on the way out, whatever has changed since: this is the field being
  // taken off the screen, not a value being reported. Both halves are refs, so
  // there is nothing for this to depend on.
  useEffect(
    () => () =>
      onLeaveRef.current?.(latest.current.draft, latest.current.images),
    []
  )

  /**
   * The lines last selected in a file, carried by the next message as a chip
   * rather than typed into the draft — the file is a tab behind this one, so
   * the selection is made out of sight of the field. The path is the chat's
   * own when the file is in its checkout, and absolute when it is not.
   */
  const selection = useEditorSelection((state) => state.current)
  const selectionPath =
    selection &&
    (attachRoot ? relativeTo(attachRoot, selection.path) : selection.path)

  const field = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)

  /**
   * The height dragged by the box's top edge — the edge rather than the
   * textarea's own corner, because the composer sits at the foot of the pane and
   * grows upwards. A floor rather than a fixed height: up to `FIELD_GROWS_TO`
   * the text still grows the field past it, and past that it scrolls. Held here
   * while dragging and written once on release, since every write is the whole
   * settings bag.
   */
  const savedHeight = useSettings((state) => state.composerHeight)
  const setComposerHeight = useSettings((state) => state.setComposerHeight)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const drag = useRef<{ y: number; height: number } | null>(null)
  const height = dragHeight ?? savedHeight

  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !field.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { y: event.clientY, height: field.current.offsetHeight }
  }
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const max = Math.max(FIELD_MIN, window.innerHeight * FIELD_MAX_SHARE)
    const next = drag.current.height + drag.current.y - event.clientY
    setDragHeight(Math.round(Math.min(max, Math.max(FIELD_MIN, next))))
  }
  const onResizeEnd = () => {
    if (!drag.current) return
    drag.current = null
    if (dragHeight !== null) setComposerHeight(dragHeight)
    setDragHeight(null)
  }
  /** Where the caret has to be put once a pick has re-rendered the value. */
  const pending = useRef<number | null>(null)
  /** Set by Escape and cleared once the caret leaves the query, so a dismissed
   * menu stays dismissed for this word rather than for ever. */
  const dismissed = useRef(false)

  // The index this menu reads is walked on demand, so the first `@` of a launch
  // would otherwise offer a workspace that looks empty.
  useEffect(primeMentions, [])

  // Subscribed rather than read where they are needed: the walk and the
  // `git status` that filters it both land a moment after the first `@` may
  // already have been typed, and this is what redraws the menu — and the tint
  // behind the draft — once they have.
  const index = useFiles((state) => state.index)
  const ignored = useGitStatus((state) => state.byRoot)
  useEffect(() => {
    const element = field.current
    // Only for the field being typed in: this fires once a launch, and a menu
    // opening over a composer nobody is in would be a list appearing by itself.
    if (!element || document.activeElement !== element) return
    refresh(draft, element.selectionStart)
    // `refresh` and the draft are the current render's; this fires for the three
    // reads landing — the file index, the `git status` that filters it, and the
    // command list, which arrives a process later than the `/` that asked for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, ignored, commands.commands, commands.loading, commands.error])

  useEffect(() => {
    const caret = pending.current
    if (caret === null) return
    pending.current = null
    field.current?.focus()
    field.current?.setSelectionRange(caret, caret)
  }, [draft])

  /**
   * Which menu the caret is in, if either.
   *
   * `/` is asked about first because it is the narrower of the two — it only
   * matches at the head of the message — so a draft that is a command query
   * cannot also be a mention query, and the order is really only there to say
   * which one is checked first rather than to resolve a conflict.
   */
  function refresh(text: string, caret: number) {
    const command = commandQuery(text, caret)
    if (command) {
      setWantsCommands(true)
      if (dismissed.current) return
      // Drawn while the list is still being asked for, and drawn empty: the
      // first `/` of a project waits on a `claude` starting, and a menu that
      // appeared only once the answer landed would look like a `/` that did
      // nothing for a second and a half.
      const items = rankCommands(commands.commands, command.filter, MAX_ROWS)
      setMenu((was) =>
        keepSelection(
          { kind: "command", query: command, items, selected: 0 },
          was
        )
      )
      return
    }

    const query = mentionQuery(text, caret)
    if (!query) {
      dismissed.current = false
      setMenu(null)
      return
    }
    if (dismissed.current) return

    const items = rankPlainMentions(
      chatMentions(attachRoot),
      query.filter,
      MAX_ROWS
    )
    if (items.length === 0) {
      setMenu(null)
      return
    }
    setMenu((was) =>
      keepSelection({ kind: "mention", query, items, selected: 0 }, was)
    )
  }

  function pick(item: PlainMention | AgentCommand) {
    const element = field.current
    if (!element || !menu) return

    const next =
      menu.kind === "command"
        ? insertCommand(
            draft,
            menu.query,
            element.selectionStart,
            (item as AgentCommand).name
          )
        : insertMention(
            draft,
            menu.query,
            element.selectionStart,
            mentionOf((item as PlainMention).label)
          )

    pending.current = next.caret
    setDraft(next.text)
    setMenu(null)
  }

  /**
   * Files chosen in the OS picker, written into the draft at the caret.
   *
   * A path written into the text, exactly what the `@` menu inserts and for the
   * same reason: the turn runs in this checkout with `Read`, so a path is
   * already something the agent can open. There is nothing to attach it *to* —
   * print mode takes a prompt, not an upload.
   */
  async function attach() {
    const picked = await window.desktop.pickFiles(attachRoot).catch(() => [])
    insertPaths(picked)
  }

  /** The same insertion for a file arriving any other way: dropped on the pane,
   * or picked in the dialog above. */
  function insertPaths(paths: string[]) {
    if (paths.length === 0) return

    insertAtCaret(
      paths
        .map((path) => (attachRoot ? relativeTo(attachRoot, path) : path))
        .map((path) => {
          // `@`, so a dropped path is tinted like a picked one — but not on one
          // that had to be quoted, since the tint matches whole words and a
          // quoted path is not one.
          const quoted = quotePath(path)
          return quoted === path ? mentionOf(path) : quoted
        })
        .join(" ")
    )
  }

  /**
   * Pictures, as tags rather than paths: a screenshot dragged off macOS's
   * thumbnail is a temporary file that is deleted moments later, so a path to
   * it named nothing by the time the turn went to read it.
   */
  function insertImages(added: ChatImage[]) {
    if (added.length === 0) return

    insertAtCaret(
      added.map((_, index) => imageTag(images.length + index + 1)).join(" ")
    )
    setImages([...images, ...added])
  }

  /** A screenshot copied rather than saved — `⌃⇧⌘4` — is a picture on the
   * clipboard with no file anywhere, and the same tag is the only way to send
   * it. Anything else pasted is the textarea's own business. */
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter((file) =>
      file.type.startsWith("image/")
    )
    if (files.length === 0) return

    event.preventDefault()
    void Promise.all(files.map(readImage)).then((read) =>
      insertImages(read.filter((image) => image !== null))
    )
  }

  function insertAtCaret(written: string) {
    const element = field.current
    const caret = element?.selectionStart ?? draft.length

    // Spaced off whatever is already there, so a path does not run into the end
    // of a sentence somebody was in the middle of.
    const before = draft.slice(0, caret)
    const after = draft.slice(caret)
    const lead = before && !/\s$/.test(before) ? " " : ""
    const tail = after && !/^\s/.test(after) ? " " : ""
    const insertion = `${lead}${written}${tail}`

    pending.current = caret + insertion.length
    setDraft(before + insertion + after)
    setMenu(null)
  }

  // Rebuilt every render on purpose: it closes over the draft and the caret as
  // they stand, and a memoised one would type into the field as it was when the
  // pane last re-rendered.
  useImperativeHandle(ref, () => ({
    insertPaths,
    insertImages,
    insertText: insertAtCaret,
    focus: () => field.current?.focus(),
  }))

  /**
   * Sends, whatever the chat is doing.
   *
   * `sending` used to be a reason not to: a turn was a process, and a second
   * message had nowhere to go until it ended. A chat holds its CLI open now and
   * queues what arrives mid-turn, so the only thing that stops an Enter is an
   * empty field.
   */
  function submit() {
    if (!draft.trim()) return
    const message = attachedIn(draft, images)
    // After the question rather than before it, so the transcript reads as
    // what was asked and then what it was about.
    const text =
      selection && selectionPath
        ? `${message.text}\n\n${selectionMention(selectionPath, selection)}`
        : message.text
    onSend(text, message.images)
    // Taken: the next message is about whatever is selected next.
    if (selection) useEditorSelection.getState().clear()
    setDraft("")
    setImages(NO_IMAGES)
    setMenu(null)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // While an IME candidate window is open every key belongs to it: on a
    // Vietnamese or Japanese keyboard the Enter that accepts a word would
    // otherwise pick a mention, and the arrows would walk this list instead of
    // the candidates.
    if (event.nativeEvent.isComposing) return

    // ⌘/Ctrl chords belong to the window, and the menu answering one would take
    // a shortcut away while it happened to be open.
    if (menu && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const count = menu.items.length
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp": {
          // A command menu is drawn while the list is still being asked for, so
          // there is a moment when it has no rows to walk. Falling through would
          // put `NaN` in `selected` for the rest of the query.
          if (count === 0) break
          const delta = event.key === "ArrowDown" ? 1 : -1
          setMenu({
            ...menu,
            selected: (menu.selected + delta + count) % count,
          })
          event.preventDefault()
          return
        }
        case "Enter":
        case "Tab": {
          const item = menu.items[menu.selected]
          // An empty command menu lets Enter through to `submit` below, which is
          // the right answer for it: `/clear` typed in full is a command whether
          // or not a list ever arrived to offer it.
          if (!item) break
          pick(item)
          event.preventDefault()
          return
        }
        case "Escape":
          dismissed.current = true
          setMenu(null)
          event.preventDefault()
          return
      }
    }

    // The `+` menu's own shortcut, answered here rather than by the window: it
    // is about this field's caret, and a chord bound globally would fire for
    // whichever chat is on screen.
    if ((event.metaKey || event.ctrlKey) && event.key === "u") {
      event.preventDefault()
      void attach()
      return
    }

    // Enter sends and ⇧Enter breaks the line, the way every chat box does.
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    submit()
  }

  /** `@` typed for somebody, from the `+` menu: the menu that follows is the
   * one a typed `@` opens, since `refresh` is what decides it is a query. */
  function startMention() {
    const element = field.current
    const caret = element?.selectionStart ?? draft.length
    const before = draft.slice(0, caret)
    const lead = before && !/\s$/.test(before) ? " " : ""
    const next = `${before}${lead}@${draft.slice(caret)}`

    dismissed.current = false
    pending.current = caret + lead.length + 1
    setDraft(next)
    refresh(next, caret + lead.length + 1)
  }

  /**
   * `/` typed for somebody, from the `+` menu.
   *
   * At the head of the draft rather than at the caret, unlike `startMention`:
   * that is the only place a slash command means anything, so putting one
   * mid-sentence would be the menu offering to insert text that runs as prose.
   * Whatever was already written stays, after it.
   */
  function startCommand() {
    if (commandQuery(draft, draft.length) !== null) {
      // Already in one — the field starts with a bare `/`. Nothing to type.
      field.current?.focus()
      return
    }
    const next = `/${draft.replace(/^\s+/, "")}`
    dismissed.current = false
    pending.current = 1
    setDraft(next)
    refresh(next, 1)
  }

  const segments = markMentions(draft, chatMentions(attachRoot))
  const pictures = namedIn(draft, images)

  return (
    <div className="relative">
      {menu?.kind === "mention" && (
        <MentionMenu
          items={menu.items}
          selected={menu.selected}
          onSelect={pick}
          onHover={(selected) => setMenu({ ...menu, selected })}
        />
      )}

      {menu?.kind === "command" && (
        <CommandMenu
          items={menu.items}
          selected={menu.selected}
          loading={commands.loading}
          error={commands.error}
          onSelect={pick}
          onHover={(selected) => setMenu({ ...menu, selected })}
        />
      )}

      {/* The box's border, background and focus ring are the wrapper's rather
          than the textarea's: the textarea has to be transparent for the tint
          behind it to show through, and a background of its own would wash it
          out in dark mode. */}
      <div
        className={cn(
          "relative rounded-lg border border-input transition-colors dark:bg-input/30",
          "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
        )}
      >
        {/* Straddling the top border, so it is found by aiming at the edge.
            A double-click gives the field back to its text. */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the composer"
          title="Drag to resize · double-click to reset"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onDoubleClick={() => setComposerHeight(null)}
          className="group absolute inset-x-3 -top-1.5 z-10 flex h-3 cursor-ns-resize items-center justify-center"
        >
          <span
            className={cn(
              "h-1 w-8 rounded-full bg-border opacity-0 transition-opacity group-hover:opacity-100",
              dragHeight !== null && "opacity-100"
            )}
          />
        </div>

        {/* The mirror is positioned against the field alone rather than against
            the whole box: `inset-0` used to be the box, and with a toolbar in it
            the tint behind the last line would have been drawn over the
            buttons. */}
        {selection && selectionPath && (
          <div className="flex px-2 pt-1.5">
            <span
              title={selectionMention(selectionPath, selection)}
              className="inline-flex h-5 max-w-full items-center gap-1 rounded-md border bg-muted/50 pr-0.5 pl-1.5 text-[0.7rem] text-muted-foreground"
            >
              <TextSelect className="size-3 shrink-0" />
              <span className="truncate">
                <span className="font-medium text-foreground">
                  {nameOf(selection.path)}
                </span>
                :{selection.fromLine}
                {selection.toLine !== selection.fromLine &&
                  `–${selection.toLine}`}{" "}
                · {selectionLabel(selection)}
              </span>
              <button
                type="button"
                aria-label="Leave the selection out"
                title="Leave the selection out"
                onClick={() => useEditorSelection.getState().clear()}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          </div>
        )}

        {/* The pictures the text still names, so a pasted screenshot is seen
            before it goes rather than as a tag. Taking one out deletes its tag,
            which is what leaves it out of the message — the tag stays the one
            truth about what is attached. */}
        {pictures.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            {pictures.map(({ n, image }) => (
              <ImageThumb
                key={n}
                n={n}
                src={dataUrlOf(image)}
                onRemove={() => {
                  setDraft(withoutTag(draft, n))
                  field.current?.focus()
                }}
              />
            ))}
          </div>
        )}

        <div className="relative">
          <div
            ref={mirror}
            aria-hidden
            className={cn(
              FIELD,
              "pointer-events-none absolute inset-0 overflow-hidden",
              "break-words whitespace-pre-wrap text-transparent select-none"
            )}
          >
            <Marks segments={segments} />
            {/* A draft ending in a newline would otherwise leave the mirror a
                line short of the textarea. */}
            {"\n"}
          </div>

          <textarea
            ref={field}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              refresh(event.target.value, event.target.selectionStart)
            }}
            // A click or an arrow key can move the caret out of a query — or into
            // one — without changing a character.
            onSelect={(event) => {
              const element = event.currentTarget
              refresh(element.value, element.selectionStart)
            }}
            onScroll={(event) => {
              if (mirror.current)
                mirror.current.scrollTop = event.currentTarget.scrollTop
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={3}
            spellCheck={false}
            placeholder={placeholder}
            style={
              height === null
                ? undefined
                : {
                    minHeight: height,
                    maxHeight: Math.max(height, FIELD_GROWS_TO),
                  }
            }
            className={cn(
              FIELD,
              "relative block field-sizing-content max-h-48 min-h-14 w-full resize-none",
              "bg-transparent outline-none placeholder:text-muted-foreground"
            )}
          />
        </div>

        {/* Inside the box rather than under it: these are properties of the
            message about to be sent, and a row of controls floating below the
            border reads as belonging to the pane. */}
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          {onOptions && (
            <>
              <ModelMenu
                models={models}
                model={options.model}
                effort={options.effort}
                onPick={(model, effort) =>
                  onOptions({
                    ...options,
                    model,
                    // `Inherit` is the one pick with no level of its own; every
                    // other lands on one the model accepts — see `effortFor`.
                    effort:
                      model === null
                        ? null
                        : effortFor(chatEfforts(models, model), effort),
                  })
                }
              />
              <PermissionMenu
                permission={options.permission}
                onPick={(permission) => onOptions({ ...options, permission })}
              />
              {profiles.length > 0 && (
                <ProfileMenu
                  profiles={profiles}
                  profileId={options.profileId ?? null}
                  onPick={(profileId) => onOptions({ ...options, profileId })}
                />
              )}
              <McpMenu
                folderId={folderId}
                disabled={options.disabledTools ?? []}
                onPick={(disabledTools) =>
                  onOptions({ ...options, disabledTools })
                }
              />
            </>
          )}

          {/* Only once there is a measurement. A meter reading 0% before the
              first turn would be claiming an empty window, when what is true is
              that nobody has asked the CLI yet — and the answer would be ~19k of
              system prompt, tools and memory files rather than nothing. */}
          {contextWindow && <WindowMeter of={contextWindow} />}
          {onOptions && (
            <PlanUsageMeter
              profileId={options.profileId ?? null}
              sending={sending}
            />
          )}

          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Add to this message"
                    className={cn(
                      "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground",
                      "transition-colors hover:bg-accent hover:text-foreground",
                      "data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
                    )}
                  >
                    <Plus className="size-3.5" />
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => void attach()}>
                  <Paperclip />
                  Attach file
                  <span className="ml-auto text-[0.65rem] text-muted-foreground">
                    ⌘U
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={startMention}>
                  <AtSign />
                  Mention a file…
                  <span className="ml-auto text-[0.65rem] text-muted-foreground">
                    @
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={startCommand}>
                  <Slash />
                  Run a command…
                  <span className="ml-auto text-[0.65rem] text-muted-foreground">
                    /
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/*
              Both, while a turn is running.

              It used to be one or the other, and that was right while sending
              mid-turn was impossible: Stop was the only thing left to do. Now
              there are two things to do and they are not alternatives — stop
              what is running, or add to it — so hiding either behind the state
              of the field would be hiding the one somebody reached for. Stop
              first, because it is the one that is about what is already on
              screen.
            */}
            {sending && (
              <IconButton label="Stop" variant="outline" onClick={onStop}>
                <Square />
              </IconButton>
            )}
            <IconButton
              label={sending ? "Send next" : "Send"}
              variant="outline"
              disabled={!draft.trim()}
              onClick={submit}
            >
              <ArrowUp />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * One control in the composer's toolbar.
 *
 * A plain button rather than `IconButton`, which is icon-only and square: these
 * carry a word each, because "which model" and "how much effort" are not
 * questions a glyph answers. The tooltip is the `title` attribute for the same
 * reason — the label is already on screen, and a floating repeat of it is noise.
 *
 * **Everything it is not asked about goes to the button**, `ref` included, which
 * is what lets two of the three be a menu's trigger: Base UI clones the element
 * it is handed and passes it the trigger's own props, so a component that named
 * its props and dropped the rest would open its menu against no anchor at all.
 * See `IconButton`, which was written against the same failure.
 */
export function ToolbarButton({
  icon,
  label,
  on,
  className,
  ...rest
}: {
  icon: ReactNode
  label: string
  /** A toggle that is on, or a picker with something chosen: either way the
   * control stops being the muted grey of one nobody has touched. */
  on?: boolean
} & ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[0.7rem]",
        "transition-colors hover:bg-accent hover:text-foreground",
        "data-[popup-open]:bg-accent data-[popup-open]:text-foreground",
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        on ? "text-foreground" : "text-muted-foreground",
        className
      )}
      {...rest}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * `--model`, out of the list the user's own `claude` answered with.
 *
 * **The rows are the CLI's, not this app's.** Which models an install offers is
 * a property of the account behind it — `Opus (1M context)`, a Fable that wants
 * credits — so a picker written here could only be wrong in one of two
 * directions: offering a model the account cannot use, which fails a turn after
 * somebody has typed a message, or hiding one they are paying for. See
 * `lib/worktree-chat/models.ts` and `main/agent-models.ts`.
 *
 * Each row is the CLI's own `displayName` over its own `description`, because
 * "which model" is a question about the trade-off and the trade-off is the
 * sentence: `Haiku 4.5 · Fastest for quick answers` is the answer, and `Haiku`
 * is only its name. The digits down the right are this app's — the same nine
 * keys the CLI's own picker offers, and they work.
 *
 * **`Inherit` is last and is the one row that is not a model.** It is `null` on
 * the record, which passes no `--model` at all and leaves the turn on whatever
 * `~/.claude/settings.json` says. It used to be what a new chat opened on, and
 * the reason it is not any more is that it made every chat in the app run on
 * whatever somebody had set for their terminal — Opus, silently, for weeks. It
 * stays because it is a thing somebody can genuinely want, and because chats
 * written before this are on it.
 */
export function ModelMenu({
  models,
  model,
  effort,
  onPick,
}: {
  models: AgentModel[]
  model: string | null
  effort: ChatEffort | null
  onPick: (model: string | null, effort: ChatEffort | null) => void
}) {
  const rows = orderedModels(models)
  const chosen = rows.find((entry) => entry.value === model)
  /* What the CLI's `default` row actually is. Read once for the menu rather
   * than per row: it is one answer about one row, and the rest do not ask. */
  const alias = defaultModelAlias(models)
  // Held only so the digit shortcuts can close it: a click is Base UI's own
  // business, and a menu still open after the pick it was asked for reads as a
  // key that did nothing.
  const [open, setOpen] = useState(false)

  const buttonLabel =
    model === null
      ? "Inherit"
      : chosen
        ? effort && chatEfforts(models, model).includes(effort)
          ? `${chosen.label} · ${EFFORT_LABELS[effort]}`
          : chosen.label
        : (model ?? "Model")

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            // The CLI's own mark rather than a generic sparkle: what this
            // picker chooses is which Claude model answers, and every other
            // brand in the app is drawn as itself (`components/ui/svgs`). It
            // keeps its brand hue in both states, so `on` shows in the label
            // rather than the icon — the rule the other marks follow.
            icon={<Claude />}
            // The raw value where no row matches it: a chat can be carrying a
            // `--model` this CLI no longer lists, and the honest answer is what
            // the record says rather than the name of some other model.
            label={buttonLabel}
            title="Which model answers and how much thinking it gets"
            on={model !== null}
          />
        }
      />
      <DropdownMenuContent
        align="start"
        className="w-72"
        // The digits, for the rows that have one. Base UI's own typeahead is
        // over the labels, so a number reaches here unclaimed.
        onKeyDown={(event) => {
          const at = Number(event.key)
          if (!at || at > rows.length) return
          event.preventDefault()
          const target = rows[at - 1]!
          onPick(
            target.value,
            effortFor(chatEfforts(models, target.value), effort)
          )
          setOpen(false)
        }}
      >
        {rows.map((entry) => {
          const levels = chatEfforts(models, entry.value)
          const supportsEffort = levels.length > 0
          const isSelected = model === entry.value

          if (supportsEffort) {
            return (
              <DropdownMenuSub key={entry.value}>
                <DropdownMenuSubTrigger
                  onClick={() => onPick(entry.value, effortFor(levels, effort))}
                  className="flex cursor-pointer items-center gap-2 px-2 py-1.5"
                >
                  <div className="flex size-4 shrink-0 items-center justify-center">
                    {isSelected && (
                      <CheckIcon className="size-3.5 text-foreground" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-xs font-normal">
                      {entry.label}
                    </span>
                    {/* `Default (recommended)` names no model, so the row says
                        which one it is standing for — see `defaultModelAlias`. */}
                    {entry.value === "default" && alias && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {alias}
                      </span>
                    )}
                    {entry.isNew && (
                      <span className="rounded border border-muted-foreground/40 px-1 py-[0.5px] text-[9px] leading-tight font-semibold tracking-tight text-muted-foreground uppercase">
                        NEW
                      </span>
                    )}
                  </div>
                  {isSelected && effort && (
                    <span className="text-[11px] font-normal text-muted-foreground/80">
                      {EFFORT_LABELS[effort]}
                    </span>
                  )}
                  {entry.isFavorite && (!isSelected || !effort) && (
                    <Star className="size-3.5 shrink-0 text-muted-foreground/70" />
                  )}
                </DropdownMenuSubTrigger>
                {/* The five levels and nothing else. There was a `Default` row
                    above them, and what it did was put the tick on a word: a
                    chat on it ran at a level the CLI never says out loud, so
                    neither the menu nor the toolbar could name how hard it was
                    thinking. Every pick now lands on a level — see
                    `DEFAULT_CHAT_EFFORT`. */}
                <DropdownMenuSubContent className="w-36">
                  {levels.map((level) => (
                    <DropdownMenuItem
                      key={level}
                      onClick={() => onPick(entry.value, level)}
                      className="flex cursor-pointer items-center justify-between px-2 py-1.5 text-xs"
                    >
                      <span className="flex items-center gap-1.5">
                        <EffortIcon effort={level} />
                        {EFFORT_LABELS[level]}
                      </span>
                      {isSelected && effort === level && (
                        <CheckIcon className="size-3.5 text-foreground" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          }

          return (
            <DropdownMenuItem
              key={entry.value}
              onClick={() => onPick(entry.value, null)}
              className="flex cursor-pointer items-center gap-2 px-2 py-1.5"
            >
              <div className="flex size-4 shrink-0 items-center justify-center">
                {isSelected && (
                  <CheckIcon className="size-3.5 text-foreground" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-xs font-normal">
                  {entry.label}
                </span>
                {/* `Default (recommended)` names no model, so the row says
                    which one it is standing for — see `defaultModelAlias`. */}
                {entry.value === "default" && alias && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {alias}
                  </span>
                )}
                {entry.isNew && (
                  <span className="rounded border border-muted-foreground/40 px-1 py-[0.5px] text-[9px] leading-tight font-semibold tracking-tight text-muted-foreground uppercase">
                    NEW
                  </span>
                )}
              </div>
              {entry.isFavorite && (
                <Star className="size-3.5 shrink-0 text-muted-foreground/70" />
              )}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onPick(null, null)}
          className="flex cursor-pointer items-center gap-2 px-2 py-1.5"
        >
          <div className="flex size-4 shrink-0 items-center justify-center">
            {model === null && (
              <CheckIcon className="size-3.5 text-foreground" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-normal">Inherit</span>
            <span className="truncate text-[10px] text-muted-foreground">
              Whatever your own `claude` is set to
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The levels as a row says them — the CLI's own words, capitalised, since
 * `xhigh` is a flag value and not something to put in front of somebody. */
const EFFORT_LABELS: Record<ChatEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Very high",
  max: "Max",
}

function EffortIcon({ effort }: { effort: ChatEffort | null }) {
  if (effort === "low") return <SignalLow />
  if (effort === "medium") return <SignalMedium />
  if (effort === "high") return <SignalHigh />
  if (effort === null) return <Signal className="opacity-60" />
  // `xhigh` and `max` are both the full four bars: lucide has no fifth, and the
  // word beside it is what tells them apart.
  return <Signal />
}

/**
 * How much this chat's turns may do.
 *
 * One picker rather than the plan toggle it replaced plus a picker beside it:
 * plan mode *is* a permission — the read-only one, asked a particular way — and
 * two controls over one question can be put into a state neither means. It is
 * the only control here that never reads "Default", because there is no such
 * thing: a turn runs at whatever this says, and `Edits` is what it says until
 * somebody changes it.
 */
function PermissionMenu({
  permission,
  onPick,
}: {
  permission: ChatPermission
  onPick: (permission: ChatPermission) => void
}) {
  const chosen = PERMISSION_MARKS[permission] ?? PERMISSION_MARKS.edits

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            icon={<chosen.icon />}
            label={chosen.short}
            title={chosen.detail}
            on={permission !== "edits"}
            // The one mode that is worth spotting from across the pane: a chat
            // left on it approves whatever the next turn reaches for.
            className={permission === "full" ? "text-destructive" : undefined}
          />
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        {CHAT_PERMISSIONS.map((entry) => {
          const mark = PERMISSION_MARKS[entry]
          return (
            <DropdownMenuItem
              key={entry}
              onClick={() => onPick(entry)}
              variant={entry === "full" ? "destructive" : undefined}
            >
              <mark.icon />
              <span className="flex min-w-0 flex-col">
                {mark.label}
                {/* The second line is the whole point of the menu being wider
                    than the others: "read only" and "full access" are the two
                    somebody has to be sure about before picking. */}
                <span className="text-[0.7rem] text-muted-foreground">
                  {mark.detail}
                </span>
              </span>
              {permission === entry && <Check />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Which `ClaudeProfile` this chat's turns run under — `CLAUDE_CONFIG_DIR`,
 * picked per chat the way the model and the permission already are.
 *
 * Drawn only once a profile exists (see `ChatComposer`): with none configured
 * the only choice is "this account", which is not a choice, and a fourth
 * toolbar button that always says the same thing is one nobody asked for.
 * Adding, naming and pointing a profile at a directory is Settings' own —
 * `SettingsDialog`'s Claude section — this is only the picker.
 *
 * **Each row says which account it actually is**, because a name somebody typed
 * is not one: "Claude Hùng" beside "Claude Personal" tells you nothing about
 * which login either one is, and a directory that was never signed into reads
 * exactly like one that works until the turn fails. The line under the name is
 * the address (`accountLine`), asked of `claude` when the menu is first opened
 * and held for the run — a menu of four profiles must not be four processes
 * every time it is dropped down, and a login does not change while somebody is
 * deciding who to send a message as. Re-asking is Settings' Check button.
 */
export function ProfileMenu({
  profiles,
  profileId,
  onPick,
}: {
  profiles: ClaudeProfile[]
  profileId: string | null
  onPick: (profileId: string | null) => void
}) {
  const chosen = profiles.find((profile) => profile.id === profileId)
  const accounts = useClaudeProfiles((state) => state.accounts)
  const checking = useClaudeProfiles((state) => state.checking)
  const checkUnknown = useClaudeProfiles((state) => state.checkUnknown)

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // On open rather than on mount: every chat in the workspace has one of
        // these toolbars, and none of them is a reason to run `claude`.
        if (open) {
          checkUnknown(["", ...profiles.map((profile) => profile.configDir)])
        }
      }}
    >
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            icon={<KeyRound />}
            label={chosen?.name ?? "Account"}
            title="Which CLAUDE_CONFIG_DIR this chat's turns run under"
            on={profileId !== null}
          />
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem
          onClick={() => onPick(null)}
          className="flex cursor-pointer items-center gap-2 px-2 py-1.5"
        >
          <div className="flex size-4 shrink-0 items-center justify-center">
            {profileId === null && (
              <CheckIcon className="size-3.5 text-foreground" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-normal">This account</span>
            <AccountLine
              account={accounts[""]}
              busy={checking.includes("")}
              fallback="Whichever your own `claude` is already signed into"
            />
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {profiles.map((profile) => (
          <DropdownMenuItem
            key={profile.id}
            onClick={() => onPick(profile.id)}
            className="flex cursor-pointer items-center gap-2 px-2 py-1.5"
          >
            <div className="flex size-4 shrink-0 items-center justify-center">
              {profileId === profile.id && (
                <CheckIcon className="size-3.5 text-foreground" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs font-normal">
                {profile.name}
              </span>
              {/* A profile with no directory yet would otherwise be drawn as
                  the default account, since that is what an empty
                  `CLAUDE_CONFIG_DIR` resolves to — the one thing this row must
                  not claim to be. */}
              {profile.configDir.trim() ? (
                <AccountLine
                  account={accounts[profile.configDir.trim()]}
                  busy={checking.includes(profile.configDir.trim())}
                />
              ) : (
                <span className="truncate text-[10px] text-muted-foreground">
                  No directory set
                </span>
              )}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The line under an account's name in the picker: who it is, or what is wrong.
 *
 * Coloured only where it is trouble. A signed-in row is the ordinary case and
 * four green lines in a four-row menu is noise; what has to catch the eye is
 * the one profile that will not run — see `accountLine`.
 */
function AccountLine({
  account,
  busy,
  fallback,
}: {
  account: ClaudeAccount | undefined
  /** A check in flight, so the row says so rather than "Not checked" for the
   * fraction of a second the ask takes. */
  busy?: boolean
  /** What to say before anything has been asked, for the row that has a
   * sentence of its own worth keeping. */
  fallback?: string
}) {
  const { text, tone } = accountLine(account)

  return (
    <span
      className={cn(
        "truncate text-[10px]",
        tone === "bad" && !busy ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {busy && !account ? "Checking…" : !account && fallback ? fallback : text}
    </span>
  )
}

/** What each mode is called on the button, in the menu, and on the hover line.
 * The detail says what it *does*, since none of these four names are self
 * evident to somebody who has not read `PERMISSIONS`. */
const PERMISSION_MARKS: Record<
  ChatPermission,
  {
    label: string
    /** The toolbar has room for one word. */
    short: string
    detail: string
    icon: typeof Map
  }
> = {
  plan: {
    label: "Plan",
    short: "Plan",
    detail: "Reads, and answers with a plan. Changes nothing.",
    icon: Map,
  },
  read: {
    label: "Read only",
    short: "Read",
    detail: "Reads and answers. No edits, no shell.",
    icon: Eye,
  },
  ask: {
    label: "Ask",
    short: "Ask",
    detail: "Asks exactly what the claude CLI would, under your own settings.",
    icon: MessageCircleQuestion,
  },
  edits: {
    label: "Edits",
    short: "Edits",
    detail: "Edits files and runs commands in this checkout.",
    icon: PencilLine,
  },
  full: {
    label: "Full access",
    short: "Full",
    detail: "Nothing is asked, including tools this app has not listed.",
    icon: ShieldOff,
  },
}

/** The tick a chosen row carries, pushed to the end. */
function Check() {
  return <CheckIcon className="ml-auto size-3 text-muted-foreground" />
}

/**
 * A message's own text with its paths tinted — the same marks the composer
 * showed while it was being typed, so a sent line still reads as pointing at a
 * file rather than mentioning one in passing.
 *
 * Without a root, unlike the composer: a transcript row does not know which
 * checkout it was typed in, and the index's own workspace-relative paths are
 * the same string for a chat whose cwd is its folder — which is every chat that
 * has not been pointed at a subdirectory.
 */
export function MentionText({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  return (
    <span className={cn("break-words whitespace-pre-wrap", className)}>
      <Marks segments={markMentions(text, chatMentions())} visible />
    </span>
  )
}

/**
 * The runs, tinted by kind.
 *
 * `visible` is the difference between the two callers: the message renders the
 * text, and the composer's mirror renders only the tint, with the glyphs coming
 * from the real textarea sitting on top of it.
 */
function Marks({
  segments,
  visible,
}: {
  segments: MentionSegment[]
  visible?: boolean
}) {
  return (
    <>
      {segments.map((segment, index) =>
        // A run's only identity is where it sits in the text.
        segment.kind === null ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span
            key={index}
            style={{
              // Tinted from the hue itself rather than a second token per
              // panel.
              backgroundColor: `color-mix(in oklab, ${KIND_HUE[segment.kind]} 16%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${KIND_HUE[segment.kind]} 28%, transparent)`,
              color: visible ? KIND_HUE[segment.kind] : undefined,
            }}
            className="rounded-[0.25rem] font-medium"
          >
            {segment.text}
          </span>
        )
      )}
    </>
  )
}

/**
 * How full the context window is, in the composer's toolbar.
 *
 * **A bar and not a spinner, because this is the number that can actually be
 * measured.** What the CLI shows while `/compact` runs is a spinner: compaction
 * is one summarisation call, so there is no fraction of it to report, and a
 * determinate bar drawn there would be an animation pretending to measure
 * something. The window either side of it is measurable, and it is the thing
 * somebody is really watching — see `lib/worktree-chat/window.ts`.
 *
 * Read against the **auto-compact threshold** rather than the raw window
 * (`fractionOf`): on a 1M-context model the CLI compacts at 967k, so a bar drawn
 * against 1M would sit calm right up to the moment the conversation is
 * summarised out from under it.
 *
 * The breakdown behind it is the same data `/context` prints, which is why the
 * rows are the CLI's own category names. Their colours are not: those are its
 * terminal theme's, so `WINDOW_TONES` maps them here.
 */
function WindowMeter({ of }: { of: ChatWindow }) {
  const band = bandOf(of)
  const slices = windowSlices(of)
  const hint = windowHint(of)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            // The detail on the title as well as in the menu: the meter is a
            // glance, and hovering should answer the question without a click.
            title={hint ? `${windowDetail(of)}\n${hint}` : windowDetail(of)}
            aria-label={`Context window: ${windowLabel(of)} before auto-compacting`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[0.7rem]",
              "transition-colors hover:bg-accent data-[popup-open]:bg-accent",
              band === "full"
                ? "text-destructive"
                : band === "near"
                  ? "text-amber-600 dark:text-amber-500"
                  : "text-muted-foreground"
            )}
          >
            {/* The bar **drains** rather than fills, because the label counts
                down: a bar growing beside a number shrinking would be two
                readings of one window pointing opposite ways. `remainingOf` is
                already clamped — there is no less than nothing left. */}
            <span
              aria-hidden
              className="h-1 w-8 overflow-hidden rounded-full bg-border"
            >
              <span
                className="block h-full rounded-full bg-current transition-[width]"
                style={{ width: `${remainingOf(of) * 100}%` }}
              />
            </span>
            {windowLabel(of)}
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
          {windowDetail(of)}
        </div>
        <DropdownMenuSeparator />
        {slices.map((slice) => (
          <div
            key={slice.name}
            className="flex items-center gap-2 px-2 py-1 text-xs"
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[2px]"
              style={{ background: WINDOW_TONES[slice.tone] }}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                // A deferred row is listed and not charged, so it is drawn as an
                // aside rather than as one of the things filling the window.
                slice.deferred && "text-muted-foreground"
              )}
            >
              {slice.name}
            </span>
            <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">
              {compact(slice.tokens)}
            </span>
          </div>
        ))}
        {slices.length === 0 && (
          <div className="px-2 py-1 text-[0.7rem] text-muted-foreground">
            No breakdown was reported.
          </div>
        )}
        {hint && (
          <>
            <DropdownMenuSeparator />
            <div className="max-w-64 px-2 py-1.5 text-[0.7rem] leading-relaxed text-muted-foreground">
              {hint}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The `/` menu: the commands the user's own `claude` would run in this project.
 *
 * Laid out like `MentionMenu` on purpose — same box, same placement above the
 * composer, same pointer-down rows — because they are one menu in two moods and
 * two shapes would read as two features. What differs is what a row has to say:
 * a command is chosen by what it *does*, so the description is the row rather
 * than a footnote under it, and it is clamped to two lines because a skill's
 * description is written for a model and runs to a paragraph.
 *
 * The three states below the rows are the reason this menu draws at all while
 * empty. The first `/` of a project waits on a `claude` starting (see
 * `agent-commands.ts`), and a menu that appeared only once the answer landed
 * would look like a keystroke that did nothing for a second.
 */
function CommandMenu({
  items,
  selected,
  loading,
  error,
  onSelect,
  onHover,
}: {
  items: AgentCommand[]
  selected: number
  loading: boolean
  error: string | null
  onSelect: (command: AgentCommand) => void
  onHover: (index: number) => void
}) {
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    list.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [selected])

  return (
    <ul
      ref={list}
      className={cn(
        "absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto overscroll-contain",
        "rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      )}
    >
      {items.map((command, index) => (
        <li key={command.name}>
          <button
            type="button"
            data-selected={index === selected}
            // Pointer *down*, not click: a click lands after the textarea has
            // lost focus, which is what hides the menu the row is in.
            onPointerDown={(event) => {
              event.preventDefault()
              onSelect(command)
            }}
            onPointerEnter={() => onHover(index)}
            className={cn(
              "w-full rounded-sm px-2 py-1 text-left text-xs",
              index === selected && "bg-accent text-accent-foreground"
            )}
          >
            <span className="flex items-start gap-1.5">
              <Terminal
                aria-hidden
                className="mt-px size-3.5 shrink-0 opacity-70"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-mono font-medium">
                    /{command.name}
                  </span>
                  {/* The argument hint beside the name rather than in the
                      description, because it is part of what you are about to
                      type: a command taking `[low|medium|high]` should say so
                      before it is sent without one. */}
                  {command.argumentHint && (
                    <span className="truncate font-mono text-[10px] text-muted-foreground/70">
                      {command.argumentHint}
                    </span>
                  )}
                  {/* Said on the row rather than discovered afterwards: these
                      two do not reach the CLI at all, and somebody who knows
                      what `/clear` does in a terminal is owed the difference. */}
                  {(LOCAL_COMMANDS as readonly string[]).includes(
                    command.name
                  ) && (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                      this app
                    </span>
                  )}
                </span>
                {command.description && (
                  <span className="mt-0.5 line-clamp-2 block text-[0.7rem] leading-snug text-muted-foreground">
                    {command.description}
                  </span>
                )}
              </span>
            </span>
          </button>
        </li>
      ))}

      {items.length === 0 && (
        <li className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
          {loading
            ? "Asking claude what it can run…"
            : (error ?? "No command matches that.")}
        </li>
      )}
    </ul>
  )
}

function MentionMenu({
  items,
  selected,
  onSelect,
  onHover,
}: {
  items: PlainMention[]
  selected: number
  onSelect: (mention: PlainMention) => void
  onHover: (index: number) => void
}) {
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    list.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [selected])

  return (
    <ul
      ref={list}
      // Above the composer rather than at the caret: the composer is at the
      // bottom of the pane, so there is one place a menu fits.
      className={cn(
        "absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto overscroll-contain",
        "rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      )}
    >
      {items.map((mention, index) => (
        <li key={`${mention.kind}:${mention.label}`}>
          <button
            type="button"
            data-selected={index === selected}
            // Pointer *down*, not click: a click lands after the textarea has
            // lost focus, which is what hides the menu the row is in.
            onPointerDown={(event) => {
              event.preventDefault()
              onSelect(mention)
            }}
            onPointerEnter={() => onHover(index)}
            className={cn(
              "w-full rounded-sm px-2 py-1 text-left text-xs",
              index === selected && "bg-accent text-accent-foreground"
            )}
          >
            <span className="flex items-start gap-1.5">
              <MentionIcon of={mention} />
              {/* The icon sits beside both lines, so the path and the estimate
                  under it share one left edge rather than each being padded to
                  guess at the icon's width. */}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-mono font-medium">
                    {mention.label}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                    {PLAIN_LABELS[mention.kind]}
                  </span>
                </span>
                {/* On its own line, and the reason the row has two: the path is
                    what is inserted, and the estimate beside it would push one
                    of the two out of sight in a narrow pane. */}
                <span className="block truncate text-[0.7rem] text-muted-foreground">
                  {mention.detail}
                </span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * A row's icon: the file type's own where the studio has one, and a Lucide
 * glyph otherwise.
 *
 * The same two-step the Explorer's tree and a tool row's chip make (`iconFor`
 * in `lib/files/icons.ts`), and deliberately the same pictures: a `.ts` in this
 * menu has to be the `.ts` of the tree it was walked out of, or the two lists
 * are two vocabularies for one workspace. A dot in the panel's hue was here
 * first and said only "this is a row".
 *
 * A folder keeps the plain glyph for the reason the tree gives: folders are the
 * structure, and forty coloured folder icons would compete with the files they
 * hold. `mt-px` is the optical nudge onto the first line — the icon is beside
 * two lines of text, so it cannot be baseline-aligned to either.
 */
function MentionIcon({ of }: { of: PlainMention }) {
  if (of.kind === "directory") {
    return <Folder aria-hidden className="mt-px size-3.5 shrink-0 opacity-70" />
  }

  const url = iconFor(of.label)
  return url ? (
    <img src={url} alt="" aria-hidden className="mt-px size-3.5 shrink-0" />
  ) : (
    <File aria-hidden className="mt-px size-3.5 shrink-0 opacity-70" />
  )
}
