import { useState } from "react"
import {
  Archive,
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Coins,
  Copy,
  FileText,
  Hourglass,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react"

import type { AssistantMessage, ChatTodo } from "@shared/api"
import { iconFor } from "@/lib/files/icons"
import { nameOf } from "@/lib/files/paths"
import { cn } from "@/lib/utils"
import { isAgentTool } from "@/lib/worktree-chat/activity"
import { dateTimeOf, timeOf } from "@/lib/worktree-chat/since"
import { usageDetail, usageLine } from "@/lib/worktree-chat/usage"
import { compactLine } from "@/lib/worktree-chat/window"
import { MarkdownView } from "../markdown-view"
import { IconButton } from "../icon-button"
import { MentionText } from "./chat-composer"
import { toolLabel, toolMark } from "./chat-marks"

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
 * **A tool row is four things, not a string.** An icon saying which kind of tool
 * it was, what the model said it was doing, the file it was about drawn as a
 * chip with its own file-type icon, and what came back. They are separate
 * because they are read at different speeds: the icons are scanned, the chips
 * are looked for, and the argument is read only when one of the first two
 * caught the eye. A single line of `Read /Users/…/worktrees/<uuid>/…/x.tsx`
 * defeats all three.
 */
export function ChatMessage({
  of,
  queued = false,
}: {
  of: AssistantMessage
  /** Sent while the chat was already working, so the CLI is holding it for the
   * next turn — see `queued` in `lib/worktree-chat/store.ts`. Only ever true of
   * a user line. */
  queued?: boolean
}) {
  if (of.role === "user") {
    return (
      /* `data-line` is how `⌘F` finds this message's rendered text to paint its
         matches on — see `find-marks.ts`. On the two roles that are *speech*,
         which are the two the find searches, and at every depth: a message
         inside an open fold is drawn by this same component. */
      <div data-line={of.id} className="group relative ml-4">
        <div className="relative rounded-lg rounded-br-sm bg-accent/60 py-1.5 pr-8 pl-2.5 text-xs">
          <MentionText text={of.text} />
          {/* In the corner the copy button's margin already leaves, and only
              on hover: a stamp on every bubble is a column of clocks nobody
              asked for, where one under the cursor answers "when was this".
              Nothing for a line written before stamps existed. */}
          {of.at && timeOf(of.at) && (
            <time
              dateTime={of.at}
              title={dateTimeOf(of.at)}
              className={cn(
                "absolute right-1.5 bottom-0.5 text-[0.6rem] text-muted-foreground tabular-nums",
                "opacity-0 transition-opacity select-none group-hover:opacity-100"
              )}
            >
              {timeOf(of.at)}
            </time>
          )}
        </div>
        <CopyMessage text={of.text} />
        {/*
          Under the bubble rather than in it, and in the margin the bubble
          already leaves: what this says is not part of the message, it is what
          is happening to it — and a line that changed shape when the turn ahead
          of it ended would move the transcript under the reader.

          It says `Queued` rather than counting down or naming the turn ahead:
          the CLI folds everything waiting into the next turn at once, so
          "second in line" would be a claim about an order that does not exist.
        */}
        {queued && (
          <p className="flex items-center justify-end gap-1 pt-0.5 pr-1 text-[0.65rem] text-muted-foreground">
            <Hourglass aria-hidden className="size-2.5 shrink-0" />
            Queued behind the turn above
          </p>
        )}
      </div>
    )
  }

  if (of.role === "thinking") {
    return <ThinkingRow of={of} />
  }

  if (of.role === "tool") {
    return <ToolRow of={of} />
  }

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
     */
    return (
      <div
        title={usageDetail(of.usage)}
        className="flex items-baseline gap-1.5 px-1 text-[0.7rem] text-muted-foreground/80"
      >
        <Coins className="size-3 shrink-0 translate-y-0.5" />
        <span className="truncate">{usageLine(of.usage)}</span>
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
          "text-xs break-words whitespace-pre-wrap text-destructive"
        )}
      >
        <TriangleAlert className="mr-1.5 inline size-3 shrink-0 -translate-y-px" />
        {of.text}
      </p>
    )
  }

  // The renderer the Explorer's Markdown preview uses, so a table or a code
  // block in a reply reads the way it does in a file.
  return (
    // `data-line` for the same reason as the user's line above: this is the
    // other half of what `⌘F` searches. The stamp is the hover line alone — a
    // reply has no corner a clock would sit in without sitting on a word.
    <div data-line={of.id} title={stampOf(of)} className="group relative">
      <MarkdownView source={of.text} className="pr-8 pl-1 text-xs" />
      <CopyMessage text={of.text} />
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
        <ChevronRight
          className={cn(
            "size-3 shrink-0 translate-y-0.5 transition-transform",
            open && "rotate-90"
          )}
        />
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
        <div className="mt-1 ml-2.5 max-h-64 overflow-auto border-l pl-2.5 leading-relaxed break-words whitespace-pre-wrap opacity-80">
          {of.text}
        </div>
      )}
    </div>
  )
}

/**
 * A message's copy button, in its top-right corner and revealed by hovering it.
 *
 * In the corner rather than under, so the button sits against the message it
 * belongs to. It was drawn permanently, on the argument that a button nobody
 * sees is a button nobody finds — but a transcript is a column of messages and
 * that put an icon against every one of them, which reads as chrome rather than
 * as an affordance. The space is reserved either way (the message's own right
 * padding), so nothing reflows when it appears and it never covers a word.
 *
 * It stays up while focused and for as long as the check is showing: a click
 * that fades the button out from under the cursor would take its own answer
 * with it. The check and the tooltip both say "Copied" for a moment, the way
 * the grid's cell dialog does.
 */
function CopyMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <IconButton
      label={copied ? "Copied" : "Copy message"}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      className={cn(
        "absolute top-0.5 right-0.5 text-muted-foreground",
        "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
        copied && "opacity-100"
      )}
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
function ToolRow({ of }: { of: Extract<AssistantMessage, { role: "tool" }> }) {
  const [open, setOpen] = useState(false)
  const agent = isAgentTool(of.name)

  /*
   * An edit says how much it moved, not what the CLI said about it.
   *
   * The result of an `Edit` is a sentence — "The file /Users/…/review-panel.tsx
   * has been updated. Here's the result of running `cat -n`…" — and it was the
   * widest thing in the row: forty characters of a path the chip beside it was
   * already showing, then a clause about `cat -n`. `+3 −1` is the same fact in
   * the form a reader wants it, and the lines themselves are one click away.
   *
   * The sentence comes back when the call **failed**, which is the one time it
   * is the thing worth reading — an edit that could not find its `old_string`
   * says so there and nowhere else.
   */
  const stat = of.failed ? undefined : of.stat
  const said = stat ?? of.result

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
  const openable = Boolean(of.input || of.output || of.change || of.todos)

  return (
    <div>
      {openable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={stampOf(of)}
          className={cn(TOOL_ROW, "hover:bg-muted/60 hover:text-foreground")}
        >
          {/* The tool's own mark on both kinds of row, openable or not: a
              chevron in its place said "this opens" at the cost of the one
              thing the eye actually scans a transcript for, which is what ran.
              That it opens is the argument chip disappearing into the panel. */}
          {toolMark(of.name, "size-3 shrink-0 translate-y-0.5")}
          <ToolLine of={of} said={said} agent={agent} open={open} />
        </button>
      ) : (
        <div className={TOOL_ROW} title={stampOf(of)}>
          {toolMark(of.name, "size-3 shrink-0 translate-y-0.5")}
          <ToolLine of={of} said={said} agent={agent} />
        </div>
      )}

      {openable && open && <ToolDetail of={of} />}
    </div>
  )
}

/** The row's shape, shared by the button and the plain `div` so the two align
 * to the pixel whether or not a call had anything to open. */
const TOOL_ROW = cn(
  "flex w-full items-baseline gap-1.5 rounded px-1 text-left",
  "text-[0.7rem] text-muted-foreground"
)

/** Everything on the row after its leading glyph, in one component so the
 * openable and plain versions cannot drift apart. */
function ToolLine({
  of,
  said,
  agent,
  open = false,
}: {
  of: Extract<AssistantMessage, { role: "tool" }>
  said?: string
  agent: boolean
  /** Whether the panel below is showing. An open row keeps its label and drops
   * everything the panel is now saying in full — the same argument in both
   * places reads as two, and the row is what the eye follows down the fold. */
  open?: boolean
}) {
  return (
    <>
      {/* Shrinks, but a fraction as readily as anything after it: the lead is
          the row, so it gives way only once the result and the argument have
          nothing left to give. A `description` is capped at 120 characters too,
          and unshrinkable it widened the column the same way a result did. */}
      <span className="min-w-0 shrink-[0.05] truncate font-medium text-foreground/80">
        {agent ? "Agent" : (of.title ?? toolLabel(of.name))}
      </span>

      {/* What came back, next to what it was — `Read` and `631 lines` are one
          fact, and putting the count at the end of the row would leave it
          against whichever argument happened to be longest.

          Truncating rather than `shrink-0`, because this is not always a count:
          main caps a result at 120 characters, and a fetch whose whole reply is
          one line of prose arrives as all 120 of them. Unshrinkable, that one row
          set the transcript's scroll width and put a horizontal scrollbar under
          the whole conversation — every other row then truncated against the
          widened column instead of the pane. A short `+4 −1` still shrinks by
          nothing, since flex takes it out of the widest item first. */}
      {said && (!open || of.failed) && (
        <span
          className={cn("min-w-0 truncate", of.failed && "text-destructive/80")}
        >
          {said}
        </span>
      )}

      {/* The subagent's own name reads as a second label rather than an
          argument: which agent ran is the sentence, not a parameter of it. */}
      {agent && of.summary && (
        <span className="shrink-0 text-foreground/60">· {of.summary}</span>
      )}
      {agent && of.title && (
        <span className="min-w-0 truncate font-mono opacity-70">
          {of.title}
        </span>
      )}

      {of.path ? (
        <FileChip path={of.path} />
      ) : (
        !agent &&
        !open &&
        of.summary && (
          /* A chip rather than bare text, for the reason `FileChip` is one: a
             command sitting loose on the row read as part of the sentence
             beside it, and what it is is a value the call was given. Borderless
             where that one has a border — a path is a thing to click, this is
             the head of what the panel opens onto. */
          <span className="min-w-0 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono opacity-90">
            {of.summary}
          </span>
        )
      )}
    </>
  )
}

/**
 * The file a call was about, as a chip.
 *
 * The name rather than the path, with the path on the hover line, for the
 * reason the diff header does the same: a checkout's own path is forty
 * characters of `~/.yasuo/workspace/worktrees/<uuid>/<branch>/` before it says
 * anything about the file, and in a row that truncates, the forty characters are
 * what survives.
 */
function FileChip({ path }: { path: string }) {
  const url = iconFor(path)
  return (
    <span
      title={path}
      className="inline-flex min-w-0 shrink items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5"
    >
      {url ? (
        <img src={url} alt="" aria-hidden className="size-3 shrink-0" />
      ) : (
        <FileText className="size-3 shrink-0" />
      )}
      <span className="truncate">{nameOf(path)}</span>
    </span>
  )
}

/**
 * What a call was made with and what came back, opened under its row.
 *
 * Up to three blocks in the order the call happened: the argument, the change it
 * made, and what it printed. A call has whichever of them it has — a `Read` that
 * returned 600 lines has only the last, an `Edit` has the middle, a `Bash`
 * usually has the first and the last — and the rules are *between* blocks rather
 * than around them, so a panel holding one block is a plain box.
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
    <div className="mt-1 mb-1.5 ml-1 divide-y overflow-hidden rounded-md border bg-muted/30">
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
        <>
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
        </>
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
    <ul className="max-h-64 space-y-0.5 overflow-auto px-2 py-1.5 text-[0.65rem] leading-relaxed">
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
        "max-h-64 overflow-auto px-2 py-1.5 font-mono text-[0.65rem] leading-relaxed whitespace-pre",
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
