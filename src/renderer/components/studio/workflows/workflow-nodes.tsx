import { createContext, useContext, type ReactNode } from "react"
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react"
import {
  Check,
  CirclePlay,
  CircleStop,
  Globe,
  Loader2,
  MessageSquare,
  Split,
  SquareTerminal,
  X,
} from "lucide-react"

import type {
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowRun,
} from "@shared/workflows"
import { cn } from "@/lib/utils"

/** What a box carries beside its position and kind: everything it says and
 * runs. The kind is React Flow's `type`, so it is not repeated here. */
export type BoxData = Omit<WorkflowNode, "id" | "kind" | "x" | "y">

export type BoxNode = Node<BoxData, WorkflowNodeKind>

/**
 * The run the canvas is drawing, for each box to read its own line of.
 *
 * A context rather than a field on `data`: the run is not the workflow, and
 * a status written into `data` would be read back by `fromFlow` as something
 * to save. Null between runs.
 */
export const RunContext = createContext<WorkflowRun | null>(null)

/**
 * The six boxes, drawn in the studio's own colours rather than React Flow's.
 *
 * One component for all of them, keyed on the node's type: they differ in
 * the icon, the shape of the corners, the hue of the border, and which of
 * the two handles they have. A `Start` has no way in and an `End` no way out
 * — the handle is simply not drawn, which is also what stops an arrow being
 * dragged to it.
 *
 * The ends take the git tones (`GIT_TONES`), which already read as go / stop
 * on both themes; the steps between them are the card's own colour, told
 * apart by their icons, with the condition in the caution tone since it is
 * the one box with more than one way out.
 */
const SHAPE: Record<WorkflowNodeKind, string> = {
  start:
    "rounded-full border-[#007100] bg-[#007100]/10 dark:border-[#73c991] dark:bg-[#73c991]/10",
  claude: "rounded-lg border-primary/60 bg-card",
  shell: "rounded-lg border-border bg-card",
  http: "rounded-lg border-border bg-card",
  condition:
    "rounded-lg border-[#895503] bg-[#895503]/10 dark:border-[#e2c08d] dark:bg-[#e2c08d]/10",
  end: "rounded-full border-[#ad0707] bg-[#ad0707]/10 dark:border-[#c74e39] dark:bg-[#c74e39]/10",
}

export const KIND_ICONS: Record<WorkflowNodeKind, ReactNode> = {
  start: <CirclePlay className="size-3.5 shrink-0" />,
  claude: <MessageSquare className="size-3.5 shrink-0 text-primary" />,
  shell: <SquareTerminal className="size-3.5 shrink-0" />,
  http: <Globe className="size-3.5 shrink-0" />,
  condition: <Split className="size-3.5 shrink-0" />,
  end: <CircleStop className="size-3.5 shrink-0" />,
}

/** The line under the label: what the box will do, in its own words. */
function summaryOf(kind: WorkflowNodeKind, data: BoxData): string | undefined {
  switch (kind) {
    case "claude":
      return data.prompt?.trim() || "No prompt yet"
    case "shell":
      return data.command?.trim() || "No command yet"
    case "http":
      return data.url?.trim()
        ? `${data.method ?? "GET"} ${data.url.trim()}`
        : "No URL yet"
    case "condition":
      return data.pattern?.trim()
        ? `matches /${data.pattern.trim()}/`
        : "has any input"
    default:
      return data.description
  }
}

/** Which way the handles go: an arrow leaves a box from its bottom and
 * arrives at the top of the next, so a workflow reads downwards. */
const HANDLE =
  "!size-2.5 !rounded-full !border-2 !border-background !bg-muted-foreground"

export function Box({ id, type, data, selected }: NodeProps<BoxNode>) {
  const kind = type
  const run = useContext(RunContext)
  const status = run?.nodes[id]?.status

  return (
    <div
      title={data.description}
      className={cn(
        "max-w-60 min-w-40 border px-3 py-2 text-xs shadow-sm transition-shadow",
        SHAPE[kind],
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        status === "running" &&
          "ring-2 ring-primary/60 ring-offset-2 ring-offset-background",
        status === "failed" && "border-[#ad0707] dark:border-[#c74e39]",
        status === "skipped" && "opacity-50"
      )}
    >
      {kind !== "start" && (
        <Handle type="target" position={Position.Top} className={HANDLE} />
      )}
      <div className="flex items-center gap-1.5">
        {KIND_ICONS[kind]}
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {data.label || " "}
        </span>
        {/* The run's mark on this box, in the slot after the label so the
            label stays put as the run passes through. */}
        {status === "running" && (
          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
        )}
        {status === "done" && (
          <Check className="size-3 shrink-0 text-[#007100] dark:text-[#73c991]" />
        )}
        {status === "failed" && (
          <X className="size-3 shrink-0 text-[#ad0707] dark:text-[#c74e39]" />
        )}
      </div>
      {kind !== "start" && kind !== "end" && (
        <div className="mt-0.5 line-clamp-2 font-mono text-[0.68rem] break-all text-muted-foreground">
          {summaryOf(kind, data)}
        </div>
      )}
      {kind !== "end" && (
        <Handle type="source" position={Position.Bottom} className={HANDLE} />
      )}
    </div>
  )
}

/** The same component under each of the type names React Flow keys on. */
export const NODE_TYPES = {
  start: Box,
  claude: Box,
  shell: Box,
  http: Box,
  condition: Box,
  end: Box,
}
