import { useState } from "react"
import {
  Check,
  ChevronRight,
  CircleSlash,
  Loader2,
  Square,
  Workflow,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { WorkflowBlock } from "@/lib/worktree-chat/activity"
import { useWorkflows } from "@/lib/workflows/store"
import { ChatActivity } from "./chat-activity"
import { ChatMessage } from "./chat-message"

/**
 * A workflow run in the chat that called it, as one card: the message that
 * called it above, and everything the run did — its prompts, Claude's
 * working and answers, its shell and HTTP steps — inside, drawn as the same
 * conversation the rest of the chat is (`WorkflowBlock`).
 *
 * A card rather than lines in the flow, because a run is one thing somebody
 * asked for: five boxes' worth of turns spread through the chat read as five
 * things that happened to it, and the answer to "did `@create-pr` work" was
 * at the bottom of all of them. The header says that; the inside is there
 * for when it did not.
 *
 * **Open while it runs, shut once it has ended** — at mount, then the
 * reader's own, like a fold (`ChatActivity`). A run watched to its end stays
 * open; a transcript read back shows each run as its one line.
 */
export function ChatWorkflow({
  of,
  chatId,
}: {
  of: WorkflowBlock
  chatId: string
}) {
  const run = useWorkflows((state) => state.runs[of.workflow.id])
  const live = run?.chatId === chatId ? run : undefined
  const status = statusOf(of, live)
  const [open, setOpen] = useState(status === "running")

  return (
    <div className="flex flex-col gap-2">
      {/* Its own `data-block`, so the outline — one entry per user message —
          still lands on the message that called the run. */}
      <div data-block={of.start.id}>
        <ChatMessage of={of.start} />
      </div>
      <div
        className={cn(
          "rounded-lg border bg-card/40",
          status === "failed" && "border-destructive/40"
        )}
      >
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90"
              )}
            />
            <Workflow
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate font-medium">{of.workflow.name}</span>
            <StatusMark status={status} />
          </button>
          {status === "running" && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void useWorkflows.getState().stop(of.workflow.id)}
            >
              <Square />
              Stop
            </Button>
          )}
        </div>
        {of.end?.error && (
          <p className="border-t px-2.5 py-1.5 text-[0.7rem] whitespace-pre-wrap text-destructive">
            {of.end.error}
          </p>
        )}
        {open && of.blocks.length > 0 && (
          <div className="transcript-gap flex flex-col border-t p-2.5">
            {of.blocks.map((block) => (
              <div key={block.id} data-block={block.id}>
                {block.kind === "activity" ? (
                  <ChatActivity of={block} />
                ) : block.kind === "line" ? (
                  <ChatMessage of={block.line} />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

type Status = "starting" | "running" | "done" | "failed" | "stopped" | "lost"

/**
 * How the run stands: its end line where there is one; else the live run in
 * this window; else, for a message only just sent (`local-`, the store's own
 * optimistic id), not started yet; else a run the app was quit in the middle
 * of, which nothing will ever close.
 */
function statusOf(
  of: WorkflowBlock,
  live: { status: "running" | "done" | "failed" | "stopped" } | undefined
): Status {
  if (of.end) return of.end.status
  if (live) return live.status
  return of.start.id.startsWith("local-") ? "starting" : "lost"
}

function StatusMark({ status }: { status: Status }) {
  const { Icon, label, tone } = STATUS[status]
  return (
    <span
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1 text-[0.7rem] text-muted-foreground",
        tone
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3",
          (status === "starting" || status === "running") && "animate-spin"
        )}
      />
      {label}
    </span>
  )
}

const STATUS: Record<
  Status,
  { Icon: typeof Check; label: string; tone: string }
> = {
  starting: { Icon: Loader2, label: "Starting…", tone: "" },
  running: { Icon: Loader2, label: "Running…", tone: "" },
  done: {
    Icon: Check,
    label: "Done",
    tone: "text-[#007100] dark:text-[#73c991]",
  },
  failed: { Icon: X, label: "Failed", tone: "text-destructive" },
  stopped: { Icon: Square, label: "Stopped", tone: "" },
  lost: { Icon: CircleSlash, label: "Did not finish", tone: "" },
}
