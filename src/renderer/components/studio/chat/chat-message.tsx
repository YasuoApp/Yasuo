import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Archive,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleCheck,
  CircleDot,
  Coins,
  Copy,
  FileText,
  Hourglass,
  PenLine,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react"

import type { AssistantMessage, ChatTodo } from "@shared/api"
import { iconFor } from "@/lib/files/icons"
import { nameOf } from "@/lib/files/paths"
import { cn } from "@/lib/utils"
import {
  countsOf,
  isAgentTool,
  isPending,
  summaryOf,
} from "@/lib/chat/activity"
import { dateTimeOf, timeOf } from "@/lib/chat/since"
import { usageDetail, usageLine } from "@/lib/chat/usage"
import { compactLine } from "@/lib/chat/window"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownView } from "../markdown-view"
import { IconButton } from "../icon-button"
import { MentionText } from "./chat-composer"
import { NoteImages } from "./chat-images"
import { rowOf, splitStat } from "@/lib/chat/tool-row"
import { toolMark } from "./chat-marks"

/**
 * One line of an agent conversation.
 *
 * One file for every role rather than a component per role: a turn arrives as
 * `AssistantMessage`s, and a tool call, a decision, an error and a reply have to
 * read as one conversation.
 *
 * A tool call is a row rather than a bubble, and only the user's line gets one:
 * whose turn it is has to be readable without reading it.
 *
 * **A tool row is one grammar, not a string.** A mark saying which kind of
 * tool it was, a verb, the one thing it was about as a chip, and what came back
 * at the far right — `rowOf` in `lib/chat/tool-row.ts` says which
 * words, and why the order never changes. They are separate because they are
 * read at different speeds: the marks are scanned, the chips are looked for,
 * and the outcome is a column. A single line of
 * `Read /Users/…/worktrees/<uuid>/…/x.tsx` defeats all three.
 */
export function ChatMessage({
  of,
  queued = false,
  live = false,
  reply = null,
  edit,
  found = false,
}: {
  /** Whether `⌘F` has a match in this line — a long user line opens for it,
   * or the find would land on words its own fold is hiding. */
  found?: boolean
  /** On a user line, what its Edit does — absent where the line cannot be
   * edited at all, inside a fold. */
  edit?: MessageEdit
  of: AssistantMessage
  /** Whether the turn this line is in is still running — see `ToolRow`. */
  live?: boolean
  /** On a usage line, what its turn said, for the turn's one copy button —
   * `replyOf` in `lib/chat/activity.ts`. */
  reply?: string | null
  /** Sent while the chat was already working, so the CLI is holding it for the
   * next turn — see `queued` in `lib/chat/store.ts`. Only ever true of
   * a user line. */
  queued?: boolean
}) {
  if (of.role === "user") {
    return <UserMessage of={of} queued={queued} edit={edit} found={found} />
  }

  if (of.role === "thinking") {
    return <ThinkingRow of={of} />
  }

  if (of.role === "tool") {
    return <ToolRow of={of} live={live} />
  }

  return <OtherMessage of={of} reply={reply} />
}

/** What the user's bubble can do to the conversation — `edit` on `ChatMessage`. */
export type MessageEdit = {
  /** While the chat is working: the cut is read off a transcript the CLI is
   * still writing, so main refuses it then. */
  disabled: boolean
  /** The files the turns after this message wrote — `editedAfter` — which
   * the edit puts back when asked to. Asked when the editor opens, not on every
   * draw. */
  files: () => string[]
  save: (text: string, restore: boolean) => void
}

/**
 * How tall a user bubble draws before it folds, and the slack past that it may
 * run to first — a message one line over the cap is not worth a button.
 *
 * A pasted log or a long brief is the user's own words, so the reader already
 * knows them; drawn in full they push the answer they were waiting for off the
 * screen.
 */
const FOLDED_HEIGHT = 240
const FOLD_SLACK = 48

function UserMessage({
  of,
  queued,
  edit,
  found,
}: {
  of: Extract<AssistantMessage, { role: "user" }>
  queued: boolean
  edit?: MessageEdit
  found: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const body = useRef<HTMLDivElement>(null)

  // The inner node is the one observed: the outer one is capped, so a picture
  // finishing would grow its content without ever resizing it.
  useLayoutEffect(() => {
    const node = body.current
    if (!node) return
    const measure = () =>
      setLong(node.offsetHeight > FOLDED_HEIGHT + FOLD_SLACK)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [editing])

  const folded = long && !open && !found

  if (editing && edit)
    return (
      <EditMessage
        text={of.text}
        files={edit.files()}
        onCancel={() => setEditing(false)}
        onSave={(text, restore) => {
          setEditing(false)
          edit.save(text, restore)
        }}
      />
    )

  return (
    /* `data-line` is how `⌘F` finds this message's rendered text to paint its
       matches on — see `find-marks.ts`. On the two roles that are *speech*,
       which are the two the find searches, and at every depth: a message
       inside an open fold is drawn by this same component. */
    <div data-line={of.id} className="group ml-4">
      <div className="rounded-lg rounded-br-sm bg-accent/60 px-2.5 py-1.5 text-chat">
        {/* A mask rather than a gradient laid over the text: the bubble's colour
            is translucent, so nothing painted on top would match it. */}
        <div
          style={folded ? { maxHeight: FOLDED_HEIGHT } : undefined}
          className={cn(
            folded &&
              "overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]"
          )}
        >
          <div ref={body}>
            <MentionText text={of.text} />
            {of.images && of.images.length > 0 && (
              <NoteImages files={of.images} />
            )}
          </div>
        </div>
        {long && !found && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={cn(
              "mt-1 flex items-center gap-1 rounded text-[0.7rem] text-muted-foreground outline-none",
              "hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            )}
          >
            {open ? (
              <ChevronUp aria-hidden className="size-3" />
            ) : (
              <ChevronDown aria-hidden className="size-3" />
            )}
            {open ? "Show less" : "Show more"}
          </button>
        )}
      </div>
      <MessageActions
        text={of.text}
        onEdit={edit && !edit.disabled ? () => setEditing(true) : undefined}
        editLabel={edit?.disabled ? "Stop the turn to edit" : "Edit message"}
        canEdit={edit !== undefined}
      >
        {/* Beside the copy button and only on hover: a stamp on every bubble
              is a column of clocks nobody asked for, where one under the
              cursor answers "when was this". Nothing for a line written
              before stamps existed. */}
        {of.at && timeOf(of.at) && (
          <time
            dateTime={of.at}
            title={dateTimeOf(of.at)}
            className="text-[0.6rem] text-muted-foreground tabular-nums select-none"
          >
            {timeOf(of.at)}
          </time>
        )}
      </MessageActions>
      {/*
          Under the bubble rather than in it, and in the margin the bubble
          already leaves: what this says is not part of the message, it is what
          is happening to it — and a line that changed shape when the turn ahead
          of it ended would move the transcript under the reader.

          It says `Queued` rather than "behind the turn above": the CLI folds a
          waiting message into the running turn at its next step, between one
          tool call and the next, so it rarely waits for the answer to finish.
        */}
      {queued && (
        <p className="flex items-center justify-end gap-1 pt-0.5 pr-1 text-[0.65rem] text-muted-foreground">
          <Hourglass aria-hidden className="size-2.5 shrink-0" />
          Queued for the next step
        </p>
      )}
    </div>
  )
}

/** Every line that is neither the user's, a thought nor a tool call. */
function OtherMessage({
  of,
  reply,
}: {
  of: AssistantMessage
  reply: string | null
}) {
  if (of.role === "ask") {
    // A row like a tool call rather than a bubble, and for the same reason: it
    // is a note about the turn rather than either side speaking. A refusal is
    // the same row in the destructive colour, because it changed what the turn
    // did.
    const refused = of.text.startsWith("Refused")
    return (
      <div
        className={cn(
          "flex items-baseline gap-1.5 px-1 text-[0.7rem]",
          refused ? "text-destructive/80" : "text-muted-foreground"
        )}
      >
        <ShieldCheck className="size-3 shrink-0 translate-y-0.5" />
        <span className="truncate">{of.text}</span>
      </div>
    )
  }

  if (of.role === "usage") {
    /*
     * What the turn cost, at the end of it.
     *
     * Outside the fold: the cost of a turn is not part of its working — it is the one line that is about the turn rather
     * than in it — and a number somebody has to open a fold to find is a number
     * nobody reads until the bill arrives. One row, muted, with the three prompt
     * figures on the hover line.
     *
     * The turn's one copy button is the end of this row: it is the line that is
     * about the turn as a whole, it is already there under every answer, and a
     * button on it costs no row of its own — see `replyOf`.
     */
    return (
      <div
        title={usageDetail(of.usage)}
        className="flex h-5 items-center gap-1.5 px-1 text-[0.7rem] text-muted-foreground/80"
      >
        <Coins className="size-3 shrink-0" />
        <span className="truncate">{usageLine(of.usage)}</span>
        {reply && <CopyButton text={reply} label="Copy reply" />}
      </div>
    )
  }

  if (of.role === "compact") {
    /*
     * The compaction boundary, drawn as a rule across the conversation.
     *
     * A divider rather than another muted row, and that is the point: everything
     * *above* this line is something the model now knows only as a summary, so
     * the line has a side. A row would have read as one more event in the
     * sequence. The CLI draws the same rule for the same reason.
     */
    return (
      <div className="flex items-center gap-2 px-1 py-0.5 text-[0.7rem] text-muted-foreground/80">
        <span className="h-px flex-1 bg-border" />
        <Archive className="size-3 shrink-0" />
        <span className="shrink-0">{compactLine(of)}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }

  if (of.role === "error") {
    return (
      <p
        className={cn(
          "rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-1.5",
          "text-chat break-words whitespace-pre-wrap text-destructive"
        )}
      >
        <TriangleAlert className="mr-1.5 inline size-3 shrink-0 -translate-y-px" />
        {of.text}
      </p>
    )
  }

  // `ChatMessage` drew the other three roles already.
  if (of.role !== "assistant") return null

  // The renderer the Explorer's Markdown preview uses, so a table or a code
  // block in a reply reads the way it does in a file.
  return (
    // `data-line` for the same reason as the user's line above: this is the
    // other half of what `⌘F` searches. The stamp is the hover line alone — a
    // reply has no corner a clock would sit in without sitting on a word. No
    // copy button: a turn's reply is several of these, copied once from its
    // cost line.
    <div data-line={of.id} title={stampOf(of)}>
      <MarkdownView source={of.text} className="px-1 text-chat" />
    </div>
  )
}

/** The full local date-time for a hover line, or nothing for a line written
 * before `at` existed — `undefined` so no `title` attribute is drawn at all. */
function stampOf(line: AssistantMessage): string | undefined {
  return line.at ? dateTimeOf(line.at) || undefined : undefined
}

/**
 * The model's reasoning: one truncated line that opens onto the whole of it.
 *
 * Folded by default for the reason the activity fold is — a reasoning block is
 * paragraphs, and a chat that ran it out in full would be the model's working
 * louder than its answer. It opens because the one-liner is sometimes the
 * sentence somebody wants the rest of: why it chose the file it chose is in
 * here and nowhere else. Open state is the row's own, like a fold's.
 *
 * Capped and scrolling rather than unbounded: a long think opened under a reply
 * must not push the reply off the screen.
 */
function ThinkingRow({
  of,
}: {
  of: Extract<AssistantMessage, { role: "thinking" }>
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="px-1 text-[0.7rem] text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={stampOf(of)}
        className={cn(
          "flex w-full items-baseline gap-1.5 rounded text-left outline-none",
          "hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        )}
      >
        <Chevron open={open} />
        <Brain className="size-3 shrink-0 translate-y-0.5" />
        <span className="shrink-0 font-medium">Thinking</span>
        {!open && (
          <span className="min-w-0 truncate rounded bg-muted/60 px-1.5 py-0.5 opacity-80">
            {of.text}
          </span>
        )}
      </button>
      {open && (
        // Under the label and off the chevron, the way a fold's rows are: this
        // is the row opened, not a second row.
        <div
          className={cn(
            OPENED,
            "max-h-64 overflow-auto leading-relaxed break-words whitespace-pre-wrap opacity-80"
          )}
        >
          {of.text}
        </div>
      )}
    </div>
  )
}

/**
 * The prompt's row of actions — its time, Edit and Copy — under the bubble's
 * end.
 *
 * **Hover-only**, the whole row. It was always drawn for a while, so that Edit
 * could be found without sweeping the cursor over every message; that was
 * reversed at the user's request, since a pair of buttons under every bubble
 * is a column of them down the transcript. `focus-within` keeps the row up
 * while one of its buttons has keyboard focus, or Tab would land on nothing.
 * Under rather than in the corner: the corner cost the bubble a right padding
 * wide enough for a button, on every line of it.
 */
function MessageActions({
  text,
  onEdit,
  editLabel,
  canEdit,
  children,
}: {
  text: string
  /** Absent while editing is refused — the button is drawn disabled. */
  onEdit?: () => void
  editLabel: string
  /** Whether this line has an Edit at all. */
  canEdit: boolean
  children?: ReactNode
}) {
  return (
    <div className="flex h-5 items-center justify-end gap-0.5 pt-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      <span className="mr-1">{children}</span>
      {canEdit && (
        <IconButton
          label={editLabel}
          disabled={!onEdit}
          onClick={onEdit}
          className="size-5 shrink-0 text-muted-foreground"
        >
          <PenLine />
        </IconButton>
      )}
      <CopyButton text={text} label="Copy message" />
    </div>
  )
}

/**
 * The bubble as a box to type in: the message as it was sent, and Send says
 * it again in its place.
 *
 * Says what it is about to do, because it is not undoable from here: every
 * turn after the message goes, and — ticked by default — the files those turns
 * wrote go back to how they were before it (`editedAfter` names them; the
 * CLI's checkpoints restore them). A box rather than always, because the
 * rewind takes whatever was typed into those files since along with the
 * turns' own edits. ⌘↩ sends and Esc puts the bubble back, the composer's own
 * keys.
 */
function EditMessage({
  text,
  files,
  onCancel,
  onSave,
}: {
  text: string
  files: string[]
  onCancel: () => void
  onSave: (text: string, restore: boolean) => void
}) {
  const [draft, setDraft] = useState(text)
  const [restore, setRestore] = useState(true)
  const boxId = useId()
  const ready = draft.trim() !== "" && draft.trim() !== text.trim()
  // Nothing to put back is not a rewind worth a process.
  const save = () => onSave(draft, restore && files.length > 0)

  return (
    <div className="ml-4 space-y-1.5 rounded-lg border bg-accent/30 p-1.5">
      <Textarea
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) =>
          event.currentTarget.setSelectionRange(
            event.currentTarget.value.length,
            event.currentTarget.value.length
          )
        }
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onCancel()
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (ready) save()
          }
        }}
        className="max-h-64 min-h-12 resize-none bg-background px-2 py-1.5 text-chat md:text-chat"
      />
      <p className="px-0.5 text-[0.65rem] leading-snug text-muted-foreground">
        Everything after this message is removed and the conversation goes on
        from here.
      </p>
      {files.length > 0 && (
        <div className="flex items-start gap-1.5 px-0.5">
          <Checkbox
            id={boxId}
            checked={restore}
            onCheckedChange={(checked) => setRestore(checked === true)}
            className="mt-px"
          />
          <Label
            htmlFor={boxId}
            className="block text-[0.65rem] leading-snug font-normal text-muted-foreground"
          >
            Put the files back —{" "}
            <span className="text-foreground/80">
              {files.slice(0, 5).map((path, index) => (
                <span key={path} title={path}>
                  {index > 0 && ", "}
                  {nameOf(path)}
                </span>
              ))}
              {files.length > 5 && `, and ${files.length - 5} more`}
            </span>{" "}
            as {files.length === 1 ? "it was" : "they were"} before this
            message. Changes typed into {files.length === 1 ? "it" : "them"}{" "}
            since go too; what a shell command wrote stays.
          </Label>
        </div>
      )}
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!ready} onClick={save}>
          Send
        </Button>
      </div>
    </div>
  )
}

/**
 * Copy, with the check and the tooltip saying "Copied" for a moment.
 *
 * Hover-only, like the Edit beside it — see `MessageActions`.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <IconButton
      label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      className="size-5 shrink-0 text-muted-foreground"
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  )
}

/**
 * One tool call: a row, and what is under it.
 *
 * The lead is what the model said it was doing when it said anything — a
 * `Bash` and a `Task` carry a `description`, and "Check IPC wiring for
 * attachments" is a better row than "Bash". Everything else falls back to the
 * tool's own name, which is what the CLI called it.
 *
 * **Clicking opens it in place**, under the row, rather than over it. An edit's
 * change was a popover first, which was the right answer to the question being
 * asked then — the content is code, so it has to stay up, scroll and take a
 * selection, none of which this app's tooltip does — and the wrong shape once
 * every kind of call had something to open. Three things decided it. A popover
 * is one at a time, so two calls cannot be compared, and comparing what ran
 * with what it printed is most of why anybody opens one. It is positioned
 * against its row, so a long output opens a floating box over the conversation
 * it belongs to. And a chat is already a column that grows downward: a row that
 * expands is the one gesture a reader of a log does not have to learn.
 *
 * What is **not** here is syntax highlighting, which the reference for this had.
 * Every editor in this app is CodeMirror behind a `lazy`, and a turn with
 * fifteen tool calls would be fifteen editor instances mounted to colour output
 * nobody can edit. Monospace, the git colours on a change, and the text itself.
 */
/**
 * Every subagent's own lines, keyed by the `toolId` of the call that ran it —
 * `splitSubagents`, provided by the pane.
 *
 * A context rather than a prop because the row that needs it is three folds
 * down from the only component holding the whole transcript, and each level
 * between would carry a map it never reads.
 */
const SubagentContext = createContext<ReadonlyMap<string, AssistantMessage[]>>(
  new Map()
)
export const SubagentSteps = SubagentContext.Provider

function ToolRow({
  of,
  live,
}: {
  of: Extract<AssistantMessage, { role: "tool" }>
  live: boolean
}) {
  const [open, setOpen] = useState(false)
  const agent = isAgentTool(of.name)
  const words = rowOf(of)
  /*
   * What a subagent did, drawn under its row when it opens — and counted on
   * the row while it is shut, with whatever it is running right now, since
   * that is the question a turn waiting on three agents is being watched with.
   * Live only while this call is still out: a finished agent's last call has
   * an answer, and an interrupted one's never will.
   */
  const steps = useContext(SubagentContext).get(of.toolId ?? "") ?? []
  const progress =
    steps.length > 0
      ? summaryOf(countsOf(steps), live && isPending(of))
      : undefined

  /*
   * The glyph is where the call's state goes: a spinner while it runs, the
   * mark in red once it failed. Only while the turn is live for the spinner —
   * a call with no result in a finished turn was interrupted, and a spinner
   * there would turn forever. Done is the plain mark, since that is nearly
   * every row and a tick on each would be noise.
   */
  const mark =
    live && isPending(of) ? (
      <Spinner
        aria-label="Running"
        className="size-3 shrink-0 translate-y-0.5 text-foreground/70"
      />
    ) : (
      toolMark(
        of.name,
        cn("size-3 shrink-0 translate-y-0.5", of.failed && "text-destructive")
      )
    )

  // An agent with steps says what it did rather than `6 lines` of its report,
  // which says nothing. Its report is drawn once it opens.
  const outcome = agent && progress && !of.failed ? progress : words.outcome
  /* The report is the subagent's last sentence too, on a `claude` that
     forwards what a subagent says — opened, it was drawn twice. */
  const reported = steps.some((line) => line.role === "assistant")
  const detail: typeof of = reported ? { ...of, output: undefined } : of

  /*
   * Openable where there is something to open, and a plain row otherwise.
   *
   * Main decides what "something" means rather than this: `input` and `output`
   * are written only where the row is not already showing the whole of it (see
   * `describeCall` and `detailOf` in `main/claude-agent.ts`), so this is a test
   * of their presence and not a second guess at their length. A row that opened
   * onto the sentence it was already displaying is worse than one that does not
   * open.
   */
  const openable = Boolean(
    of.input || of.output || of.change || of.todos || steps.length > 0
  )
  const panel = Boolean(
    detail.input || detail.output || detail.change || detail.todos
  )

  /*
   * The row's hover line is the model's own sentence about the call, where
   * it wrote one — "Check IPC wiring for attachments" over `bun test` — and
   * the stamp otherwise. The sentence led the row once, and a row that led
   * with a sentence next to one that led with `Read` was two grammars.
   */
  const stamp = stampOf(of)
  const title = words.caption
    ? stamp
      ? `${words.caption}\n${stamp}`
      : words.caption
    : stamp

  const line = (
    <>
      {/* The chevron is the one thing that says "this opens", at every level
          of the transcript; a row with nothing to open keeps its width so the
          marks below it line up. */}
      {openable ? <Chevron open={open} /> : <span className={CHEVRON_GAP} />}
      {mark}
      <span className={TOOL_VERB}>{words.verb}</span>
      {/* A file chip stays while the row is open — the panel never draws the
          path — but a command or a brief is what the panel opens onto, and the
          same argument in both places reads as two. */}
      {words.object && (words.object.kind === "file" || !open || !panel) && (
        <ObjectChip of={of} />
      )}
      {outcome && <Outcome text={outcome} failed={of.failed} />}
    </>
  )

  return (
    <div>
      {openable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={title}
          className={cn(TOOL_ROW, "hover:bg-muted/60 hover:text-foreground")}
        >
          {line}
        </button>
      ) : (
        <div className={TOOL_ROW} title={title}>
          {line}
        </div>
      )}

      {/* Under the row and off its chevron, the way a fold's rows are off
          its own: what the call was made with, then — for a subagent — the
          transcript it ran. One shape for everything that opens. */}
      {open && (panel || steps.length > 0) && (
        <div className={cn(OPENED, "space-y-2")}>
          {panel && <ToolDetail of={detail} />}
          {steps.length > 0 && (
            <div className="space-y-3">
              {steps.map((step) => (
                <ChatMessage key={step.id} of={step} live={live} />
              ))}
            </div>
          )}
        </div>
      )}
      {/* Outside the fold: a screenshot is the result, and a picture somebody
          has to open a row to find is one nobody looks at. */}
      {of.images && of.images.length > 0 && (
        <div className="pl-9">
          <NoteImages files={of.images} />
        </div>
      )}
    </div>
  )
}

/**
 * The row's shape, shared by the button and the plain `div` so the two align
 * to the pixel whether or not a call had anything to open — and by the merged
 * row in `chat-activity.tsx`, which is the same row said of several calls.
 */
export const TOOL_ROW = cn(
  "flex w-full items-baseline gap-1.5 rounded px-1 text-left",
  "text-[0.7rem] text-muted-foreground"
)

/** The verb never gives way: it is one short word, and a row that read
 * `R…` beside a long command said nothing. It used to shrink a fraction with
 * the rest, and a command chip's width is what squeezed it. */
export const TOOL_VERB = "shrink-0 font-medium text-foreground/80"

/**
 * The outcome, at the far right: `89 lines`, `+3 −1`, `3 files`. Pushed
 * there with `ml-auto` so the column of outcomes lines up down an open fold
 * whatever the objects beside them were, which is what makes it a column.
 *
 * Unshrinkable but capped, because this is not always a count: main caps a
 * result at 120 characters, and a fetch whose whole reply is one line of
 * prose arrives as all 120 of them. With no cap, that one row set the
 * transcript's scroll width and put a horizontal scrollbar under the whole
 * conversation; shrinking with the row instead, `140 lines` was `140…` beside
 * any long command. So it keeps its width up to a share of the row, and it is
 * the object's chip that gives way first.
 */
export function Outcome({
  text,
  failed = false,
}: {
  text: string
  failed?: boolean
}) {
  /* A stat gets the editors' own git colours, the same two the diff block
     under the row uses, so `+14 −3` is read as a change and not as a count.
     Found by parsing the text rather than by a flag, so a merged row's
     `3 files · +20 −5` colours its tail the same way. */
  const { head, stat } = splitStat(text)
  return (
    <span className={cn(TOOL_OUTCOME, failed && "text-destructive/80")}>
      {stat && !failed ? (
        <>
          {head}
          {stat.added > 0 && (
            <span className="text-[#007100] dark:text-[#73c991]">
              +{stat.added}
            </span>
          )}
          {stat.added > 0 && stat.removed > 0 && " "}
          {stat.removed > 0 && (
            <span className="text-[#ad0707] dark:text-[#c74e39]">
              −{stat.removed}
            </span>
          )}
        </>
      ) : (
        text
      )}
    </span>
  )
}

export const TOOL_OUTCOME =
  "ml-auto max-w-[45%] min-w-0 shrink-0 truncate pl-2 text-right tabular-nums"

/** The chevron's width, kept on a row that has none. */
const CHEVRON_GAP = "size-3 shrink-0"

/** The one glyph that says "this opens", at every level: on the turn, on a
 * merged row, on a call, on a thought. A chevron that behaved differently one
 * level down would read as a different control. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        "size-3 shrink-0 translate-y-0.5 transition-transform",
        open && "rotate-90"
      )}
    />
  )
}

/**
 * What is drawn under anything that opened — a turn, a merged row, a call, a
 * thought — ruled off its chevron. `ml-2.5` puts the rule under the glyph's
 * centre (the row's `px-1` plus half of `size-3`), so an open thing reads as
 * its contents *belonging to* that line, which is the only thing saying where
 * a long turn's rows end and the next block begins. One rule at every level
 * is what makes the levels read as levels.
 */
export const OPENED = "mt-1 mb-1.5 ml-2.5 border-l pl-2.5"

/**
 * The one thing a call was about, as a chip: a file by name with its own
 * file-type icon and the path on hover, a command in monospace, a sentence as
 * prose. One chip per row, and one shape for it, so a row is read the same
 * way whatever the tool was. Exported for the merged row, which is a run of
 * these.
 *
 * The name rather than the path, for the reason the diff header does the
 * same: a checkout's own path is forty characters of
 * `~/.vsclaude/workspace/worktrees/<uuid>/<branch>/` before it says anything
 * about the file, and in a chip that truncates, the forty characters are what
 * survives.
 */
export function ObjectChip({
  of,
}: {
  of: Extract<AssistantMessage, { role: "tool" }>
}) {
  const object = rowOf(of).object
  if (!object) return null

  if (object.kind === "file") {
    const url = iconFor(object.path)
    return (
      <span
        title={object.path}
        className="inline-flex min-w-0 shrink items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5"
      >
        {url ? (
          <img src={url} alt="" aria-hidden className="size-3 shrink-0" />
        ) : (
          <FileText className="size-3 shrink-0" />
        )}
        <span className="truncate">{nameOf(object.path)}</span>
      </span>
    )
  }

  /* Borderless where the file chip has a border — a path is a thing to
     click, this is the head of what the panel opens onto — and in mono only
     for something that ran: a brief or a todo item is a sentence. */
  return (
    <span
      className={cn(
        "min-w-0 truncate rounded bg-muted/60 px-1.5 py-0.5 opacity-90",
        object.kind === "code" && "font-mono"
      )}
    >
      {object.text}
    </span>
  )
}

/**
 * What a call was made with and what came back, opened under its row.
 *
 * Up to three blocks in the order the call happened: the argument, the change it
 * made, and what it printed. A call has whichever of them it has — a `Read` that
 * returned 600 lines has only the last, an `Edit` has the middle, a `Bash`
 * usually has the first and the last. Each is its own box rather than three in
 * one bordered panel: the rule down the left is already saying what the blocks
 * belong to, and a second border around them was a box inside a rail.
 *
 * Each block scrolls on its own rather than the panel scrolling around all of
 * them: a wide command must not drag a narrow output sideways with it, and two
 * blocks that each cap their height are two things to read where one tall box
 * past both of them is a haystack.
 */
function ToolDetail({
  of,
}: {
  of: Extract<AssistantMessage, { role: "tool" }>
}) {
  /* Whole where main kept it, and the row's own where it did not — except for a
     call showing a change or a todo list, whose argument is what the block below
     is already drawing in full. */
  const argument = of.change || of.todos ? of.input : (of.input ?? of.summary)

  return (
    <div className="space-y-1">
      {of.todos && <TodoList todos={of.todos} />}

      {argument && (
        <Block
          text={argument}
          // A shell command is the one argument read as something that ran
          // rather than as a value, and a prompt glyph is what says so.
          gutter={SHELL_TOOLS.has(of.name) ? "$" : undefined}
        />
      )}

      {of.change && (
        <div>
          {/* The editors' own git colours and the same two glyphs, so somebody
              with the `Changes` pane in their eye reads this without learning
              anything new. */}
          <Block text={of.change} diff />
          {/*
            Which of the two diffs this is, said where it is being read.
            Those answers drift apart the moment anything else touches the file,
            and a block captioned nothing that showed the call's change while
            somebody read it as the file's would be worse than no block.
          */}
          <p className="px-2 py-1 text-[0.65rem] opacity-60">
            What this call changed. The file&apos;s own diff is in Changes.
          </p>
        </div>
      )}

      {of.output && (
        <Block
          text={of.output}
          className={cn(of.failed && "text-destructive/80")}
        />
      )}
    </div>
  )
}

/**
 * The list a `TodoWrite` wrote, as a checklist.
 *
 * The one call whose argument is prose rather than code, so it is the one block
 * in the panel that is not a `pre`: monospace and `whitespace-pre` are for text
 * whose indentation is its own, and a todo is a sentence. It wraps for the same
 * reason — a task cut off at the panel's edge with a scrollbar under it is the
 * one thing a checklist must not do.
 *
 * A done item is struck through *and* muted rather than only muted: the list is
 * scanned down its left edge for where the turn is up to, and three shades of
 * grey are not three states.
 */
function TodoList({ todos }: { todos: ChatTodo[] }) {
  return (
    <ul className="max-h-64 space-y-0.5 overflow-auto rounded-md bg-muted/30 px-2 py-1.5 text-[0.65rem] leading-relaxed">
      {todos.map((todo, at) => {
        const Mark = TODO_MARKS[todo.status]
        return (
          <li key={at} className="flex items-baseline gap-1.5">
            <Mark
              className={cn(
                "size-3 shrink-0 translate-y-0.5",
                todo.status === "completed" &&
                  "text-[#007100] dark:text-[#73c991]",
                todo.status === "in_progress" && "text-foreground"
              )}
            />
            <span
              className={cn(
                "min-w-0",
                todo.status === "completed" && "line-through opacity-50",
                todo.status === "in_progress" && "font-medium text-foreground"
              )}
            >
              {todo.content}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const TODO_MARKS = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CircleCheck,
} as const

/** The tools whose argument is a command rather than a value. A set rather than
 * a comparison because the CLI has grown a second one before. */
const SHELL_TOOLS = new Set(["Bash", "BashOutput"])

/**
 * One block of monospace text inside the panel.
 *
 * `pre` rather than a list of rows: the indentation is the content's own, and
 * for a diff it is half of what a change looks like. `whitespace-pre` and not
 * `pre-wrap`, because a command line that wrapped is one that can no longer be
 * read back as the thing that ran — it scrolls instead.
 */
function Block({
  text,
  gutter,
  diff = false,
  className,
}: {
  text: string
  gutter?: string
  diff?: boolean
  className?: string
}) {
  return (
    <pre
      className={cn(
        "max-h-64 overflow-auto rounded-md bg-muted/30 px-2 py-1.5 font-mono text-[0.65rem] leading-relaxed whitespace-pre",
        className
      )}
    >
      {text.split("\n").map((line, at) => (
        <div
          key={at}
          className={cn(
            diff &&
              line.startsWith("+") &&
              "text-[#007100] dark:text-[#73c991]",
            diff && line.startsWith("-") && "text-[#ad0707] dark:text-[#c74e39]"
          )}
        >
          {/* On the first line only: a prompt repeated down the left of a
              heredoc would claim every line of it was a command. */}
          {gutter && (
            <span className="mr-1.5 opacity-40 select-none">
              {at === 0 ? gutter : " "}
            </span>
          )}
          {line}
        </div>
      ))}
    </pre>
  )
}
