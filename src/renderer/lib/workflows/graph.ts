import { CHAT_PERMISSIONS, type ChatPermission } from "@shared/api"
import type {
  Workflow,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
} from "@shared/workflows"

function isPermission(value: unknown): value is ChatPermission {
  return (
    typeof value === "string" &&
    (CHAT_PERMISSIONS as readonly string[]).includes(value)
  )
}

/**
 * A workflow's graph, as the things done to it rather than as the canvas that
 * draws it.
 *
 * Every edit the canvas makes — a box added, two joined, a selection deleted,
 * a label typed — is a function here from one graph to the next, so the rules
 * that make a diagram *a workflow* are in one place and can be run without a
 * DOM: no arrow from a box to itself, no second arrow between the same two,
 * no arrow left pointing at a box that has gone. The canvas keeps React Flow's
 * own records for what it is drawing and comes back through `fromFlow` on
 * every change; `test/workflows.ts` holds this against the file format too,
 * since a graph is read back from disk every time its tab opens.
 */

/** What a box of each kind is called until somebody renames it. */
export const KIND_LABELS: Record<WorkflowNodeKind, string> = {
  start: "Start",
  claude: "Claude",
  shell: "Shell",
  http: "HTTP",
  condition: "If",
  end: "End",
}

export const KINDS: WorkflowNodeKind[] = [
  "start",
  "claude",
  "shell",
  "http",
  "condition",
  "end",
]

export function isKind(value: unknown): value is WorkflowNodeKind {
  return typeof value === "string" && (KINDS as string[]).includes(value)
}

/** The kinds a run executes — everything but the two ends. */
export function isStep(kind: WorkflowNodeKind): boolean {
  return kind !== "start" && kind !== "end"
}

/**
 * The text fields a box may carry, by name — what `parseGraph` keeps of a
 * hand-edited file, and what the canvas writes back. `permission` is not
 * among them: it is checked against the chat's own list below.
 */
const TEXT_FIELDS = [
  "description",
  "prompt",
  "model",
  "command",
  "method",
  "url",
  "headers",
  "body",
  "pattern",
] as const

type TextField = (typeof TEXT_FIELDS)[number]

/** What a new box of each kind starts out running. An HTTP step defaults to
 * `GET` because a method field left blank is a request that cannot be sent. */
const KIND_DEFAULTS: Partial<Record<WorkflowNodeKind, Partial<WorkflowNode>>> =
  {
    claude: { prompt: "", permission: "edits" },
    shell: { command: "" },
    http: { method: "GET", url: "" },
    condition: { pattern: "" },
  }

/**
 * What a workflow opens on: one `Start`, so the first thing on a fresh canvas
 * is the box every other one hangs off rather than an empty grid and a
 * toolbar to read.
 */
export function emptyGraph(id: string = crypto.randomUUID()): WorkflowGraph {
  return {
    nodes: [{ id, kind: "start", label: KIND_LABELS.start, x: 0, y: 0 }],
    edges: [],
  }
}

/**
 * A graph read back from its file, or null for text that is not one.
 *
 * Checked field by field rather than cast: the file is JSON somebody can open
 * and edit, and a hand-edited node with no position would otherwise reach the
 * canvas as `NaN` and vanish. A node that fails is dropped and the rest kept
 * — one broken box is not a reason to show nothing — and an edge naming a
 * node that is not there goes with it, which is also what `removeNodes` keeps
 * true while the graph is being edited.
 */
export function parseGraph(text: string): WorkflowGraph | null {
  if (!text.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const record = parsed as Partial<WorkflowGraph> | null
  if (!record || !Array.isArray(record.nodes) || !Array.isArray(record.edges))
    return null

  const nodes = record.nodes.flatMap((entry) => {
    const node = entry as Partial<WorkflowNode> | null
    if (
      !node ||
      typeof node.id !== "string" ||
      !isKind(node.kind) ||
      typeof node.label !== "string" ||
      !Number.isFinite(node.x) ||
      !Number.isFinite(node.y)
    )
      return []
    const kept: WorkflowNode = {
      id: node.id,
      kind: node.kind,
      label: node.label,
      x: node.x as number,
      y: node.y as number,
    }
    for (const field of TEXT_FIELDS) {
      const value = node[field]
      if (typeof value === "string" && value) kept[field] = value
    }
    if (isPermission(node.permission)) kept.permission = node.permission
    return [kept]
  })

  const ids = new Set(nodes.map((node) => node.id))
  const edges = record.edges.flatMap((entry) => {
    const edge = entry as Partial<WorkflowEdge> | null
    if (
      !edge ||
      typeof edge.id !== "string" ||
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      !ids.has(edge.from) ||
      !ids.has(edge.to)
    )
      return []
    const kept: WorkflowEdge = { id: edge.id, from: edge.from, to: edge.to }
    if (typeof edge.label === "string" && edge.label) kept.label = edge.label
    return [kept]
  })

  return { nodes, edges }
}

/** The graph as it is written down. Two-space indented: the file is one a
 * person may open, and a diagram on one line is not readable by anybody. */
export function serializeGraph(graph: WorkflowGraph): string {
  return JSON.stringify(graph, null, 2)
}

/** How far apart boxes are put, in canvas px — a box's height plus a gap. */
const ROW = 110

/**
 * Where a new box goes: under the lowest one, in its column, so adding five
 * steps in a row draws a column of five rather than a pile at the origin
 * that has to be dragged apart before it can be read.
 */
export function placeNode(nodes: WorkflowNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 }
  const lowest = nodes.reduce((best, node) => (node.y > best.y ? node : best))
  return { x: lowest.x, y: lowest.y + ROW }
}

export function addNode(
  graph: WorkflowGraph,
  kind: WorkflowNodeKind,
  id: string = crypto.randomUUID()
): WorkflowGraph {
  const node: WorkflowNode = {
    id,
    kind,
    label: KIND_LABELS[kind],
    ...placeNode(graph.nodes),
    ...KIND_DEFAULTS[kind],
  }
  return { ...graph, nodes: [...graph.nodes, node] }
}

export function updateNode(
  graph: WorkflowGraph,
  id: string,
  patch: Partial<Omit<WorkflowNode, "id">>
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === id ? { ...node, ...patch } : node
    ),
  }
}

/**
 * A box made another kind: what the old kind ran is dropped, what the new
 * one needs is filled in, and the label follows if it was still the kind's
 * own — a `Shell` renamed `Push` keeps `Push` when it becomes `Claude`.
 */
export function rekindNode(
  node: WorkflowNode,
  kind: WorkflowNodeKind
): WorkflowNode {
  const kept: WorkflowNode = {
    id: node.id,
    kind,
    label:
      node.label === KIND_LABELS[node.kind] ? KIND_LABELS[kind] : node.label,
    x: node.x,
    y: node.y,
    ...KIND_DEFAULTS[kind],
  }
  if (node.description) kept.description = node.description
  return kept
}

/** The text fields a box of this kind runs, for the inspector to draw. */
export function fieldsOf(kind: WorkflowNodeKind): TextField[] {
  switch (kind) {
    case "claude":
      return ["prompt", "model"]
    case "shell":
      return ["command"]
    case "http":
      return ["method", "url", "headers", "body"]
    case "condition":
      return ["pattern"]
    default:
      return []
  }
}

/** Takes boxes out, and every arrow into or out of them with them. */
export function removeNodes(
  graph: WorkflowGraph,
  ids: string[]
): WorkflowGraph {
  const gone = new Set(ids)
  return {
    nodes: graph.nodes.filter((node) => !gone.has(node.id)),
    edges: graph.edges.filter(
      (edge) => !gone.has(edge.from) && !gone.has(edge.to)
    ),
  }
}

/**
 * Joins two boxes, or leaves the graph exactly as it was: an arrow from a box
 * to itself says nothing, and a second arrow between the same two is the
 * first one drawn twice.
 */
export function connect(
  graph: WorkflowGraph,
  from: string,
  to: string,
  id: string = crypto.randomUUID()
): WorkflowGraph {
  if (from === to) return graph
  if (graph.edges.some((edge) => edge.from === from && edge.to === to))
    return graph
  const ids = new Set(graph.nodes.map((node) => node.id))
  if (!ids.has(from) || !ids.has(to)) return graph
  return { ...graph, edges: [...graph.edges, { id, from, to }] }
}

export function updateEdge(
  graph: WorkflowGraph,
  id: string,
  patch: Partial<Pick<WorkflowEdge, "label">>
): WorkflowGraph {
  return {
    ...graph,
    edges: graph.edges.map((edge) =>
      edge.id === id ? { ...edge, ...patch } : edge
    ),
  }
}

export function removeEdges(
  graph: WorkflowGraph,
  ids: string[]
): WorkflowGraph {
  const gone = new Set(ids)
  return { ...graph, edges: graph.edges.filter((edge) => !gone.has(edge.id)) }
}

/**
 * The name a new workflow gets: `Untitled workflow`, then `Untitled workflow
 * 2` and so on past whatever is already in the list, so two made in a row are
 * two rows that can be told apart before either is renamed.
 */
export function untitledName(workflows: Workflow[]): string {
  const base = "Untitled workflow"
  const taken = new Set(workflows.map((workflow) => workflow.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const name = `${base} ${n}`
    if (!taken.has(name)) return name
  }
}
