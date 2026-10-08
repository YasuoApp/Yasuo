import type { ChatPermission } from "./api"

/**
 * A workflow: a chain of steps that **runs** — a Claude turn in a project,
 * a shell command, an HTTP call, a branch on what came back — drawn on a
 * canvas and kept by the workspace.
 *
 * Two records, held apart the way a chat's row and its transcript are. The
 * **listing** (`Workflow`) is one line per workflow in `workspace/workflows.json`
 * — what the left column draws, and all it needs to draw it. The **graph**
 * (`WorkflowGraph`) is the diagram itself, one file per workflow under
 * `workspace/workflows/<id>.json`, read when its tab opens and not before: a
 * column of twenty names should not cost twenty diagrams.
 *
 * The graph is this app's own shape and not the canvas library's. React Flow's
 * node carries measured sizes, selection, drag state and a `data` bag, none of
 * which is the workflow — and a file that mirrored a library's internal record
 * would change shape whenever that library did. So what is written down is
 * what a box on the diagram *does*: what kind it is, what it says, what it
 * runs, and where it was put. `lib/workflows/graph.ts` is the translation.
 */

export type Workflow = {
  /** A UUID minted by the renderer; also the graph file's name. */
  id: string
  /** Also how a chat calls it: `@` and `workflowSlug` of this — see
   * `lib/workflows/invoke.ts`. */
  name: string
  /** ISO timestamps. */
  createdAt: string
  updatedAt: string
}

/**
 * What a box on the diagram is.
 *
 * `start` and `end` mark the ends. The four between them are the steps a run
 * executes: `claude` is the one the whole thing exists for — a turn in the
 * chat the workflow was called from — and
 * `shell`, `http` and `condition` are the plumbing around it: push the
 * branch, call the tracker, go one way or the other on what Claude said.
 */
export type WorkflowNodeKind =
  "start" | "claude" | "shell" | "http" | "condition" | "end"

/**
 * One box, flat: the fields a kind does not use are simply absent. Flat
 * rather than a `config` per kind because the file is one a person may edit,
 * and `{ "kind": "shell", "command": "git push" }` is the whole of what a
 * shell step is.
 *
 * Every text field a step runs is a **template**: `{{input}}` is what the box
 * before it produced, and `{{Label}}` is what the box called `Label`
 * produced, wherever it is in the graph.
 */
export type WorkflowNode = {
  id: string
  kind: WorkflowNodeKind
  label: string
  /** A longer note under the label — for the reader, not the run. */
  description?: string
  x: number
  y: number

  /** `claude`: what is sent, and how much the turn may do on its own. */
  prompt?: string
  permission?: ChatPermission
  /** `claude`: `--model`, or absent for the CLI's own default. */
  model?: string

  /** `shell`: run by the user's login shell in the workflow's project. */
  command?: string

  /** `http`. `headers` is one `Name: value` per line. */
  method?: string
  url?: string
  headers?: string
  body?: string

  /**
   * `condition`: a regular expression tested against `{{input}}`. Matching
   * takes the arrows labelled `yes`, not matching the ones labelled `no`; an
   * unlabelled arrow is taken either way. Absent or empty tests whether the
   * input is non-empty.
   */
  pattern?: string
}

export type WorkflowEdge = {
  id: string
  from: string
  to: string
  /** What the arrow says — `yes` / `no` out of a condition, mostly. */
  label?: string
}

export type WorkflowGraph = {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** Where a run has got to, as a whole and box by box. */
export type WorkflowRunStatus = "running" | "done" | "failed" | "stopped"

export type WorkflowNodeStatus =
  "pending" | "running" | "done" | "failed" | "skipped"

export type WorkflowNodeRun = {
  status: WorkflowNodeStatus
  /** What the step produced: Claude's answer, a command's output, a
   * response body, `yes` / `no` for a condition. */
  output?: string
  error?: string
  /** The chat the step was written into — the one the run was called from. */
  chatId?: string
  startedAt?: string
  finishedAt?: string
}

/**
 * One run of a workflow, pushed to every window whole on every change —
 * small enough that a diff is not worth a second shape — and held in the
 * main process for as long as the app runs. Nothing writes it to disk: the
 * lines it wrote into its chat are what it leaves behind.
 */
export type WorkflowRun = {
  workflowId: string
  /** The chat the run was called from, and that every step writes into. */
  chatId: string
  status: WorkflowRunStatus
  startedAt: string
  finishedAt?: string
  /** Why the run stopped short — the failing step's own error, or the
   * sentence refusing to start at all. */
  error?: string
  nodes: Record<string, WorkflowNodeRun>
}
