import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { ChevronDown, Loader2, Plus, Square, Trash2 } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { CHAT_PERMISSIONS, type ChatPermission } from "@shared/api"
import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowNodeRun,
  WorkflowRun,
} from "@shared/workflows"
import { cn } from "@/lib/utils"
import {
  addNode,
  connect,
  isKind,
  isStep,
  KIND_LABELS,
  KINDS,
  rekindNode,
  serializeGraph,
} from "@/lib/workflows/graph"
import { workflowSlug } from "@/lib/workflows/invoke"
import { useWorkflows, workflowOf } from "@/lib/workflows/store"
import {
  KIND_ICONS,
  NODE_TYPES,
  RunContext,
  type BoxData,
  type BoxNode,
} from "./workflow-nodes"

/**
 * The canvas a workflow is drawn and run on: **React Flow** (`@xyflow/react`),
 * which is the library people reach for to draw boxes and arrows in React —
 * panning, zooming, dragging, connecting handles and a minimap are all its,
 * and none of them are worth writing a second time.
 *
 * React Flow holds what it is drawing. Its node carries the measured size,
 * the selection and the drag in progress, which the graph on disk does not,
 * so this component keeps React Flow's records in its own state and the
 * workflow's graph is **read back out of them** (`fromFlow`) after every
 * change. The store is told only when that read-back differs from what it
 * was last told — a box selected or a window resized changes React Flow's
 * records and not the workflow, and must not write a file.
 *
 * The rules that make a diagram a workflow — no arrow from a box to itself,
 * no second arrow between the same two, a new box put under the lowest — are
 * `lib/workflows/graph.ts`'s, and the handlers here go through it rather than
 * deciding for themselves. What a run *does* is `main/workflow-runner.ts`'s;
 * this draws where it has got to, off the run the store holds.
 */
export function WorkflowCanvas({
  id,
  graph,
}: {
  id: string
  graph: WorkflowGraph
}) {
  return (
    <ReactFlowProvider>
      <Canvas id={id} graph={graph} />
    </ReactFlowProvider>
  )
}

function Canvas({ id, graph }: { id: string; graph: WorkflowGraph }) {
  const { resolvedTheme } = useTheme()
  // `getNodes` / `getEdges` are for the handlers that are handed one list and
  // need the other — React Flow's own copy of the state below.
  const { deleteElements, getNodes, getEdges } = useReactFlow<BoxNode, Edge>()

  const [nodes, setNodes] = useState<BoxNode[]>(() => toNodes(graph))
  const [edges, setEdges] = useState<Edge[]>(() => toEdges(graph))
  // What the store was last told, as text: the comparison that keeps a
  // selection or a measurement from being written to disk.
  const told = useRef(serializeGraph(graph))

  const run = useWorkflows((state) => state.runs[id] ?? null)
  const running = run?.status === "running"

  useEffect(() => {
    const next = fromFlow(nodes, edges)
    const text = serializeGraph(next)
    if (text === told.current) return
    told.current = text
    useWorkflows.getState().setGraph(id, next)
  }, [id, nodes, edges])

  const onNodesChange = useCallback(
    (changes: NodeChange<BoxNode>[]) =>
      setNodes((prev) => applyNodeChanges(changes, prev)),
    []
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) =>
      setEdges((prev) => applyEdgeChanges(changes, prev)),
    []
  )
  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((prev) => {
        const current = fromFlow(getNodes(), prev)
        const next = connect(current, connection.source, connection.target)
        // Unchanged is `connect` refusing it — a loop, or an arrow already
        // drawn.
        if (next.edges.length === current.edges.length) return prev
        return [...prev, toEdge(next.edges[next.edges.length - 1]!)]
      })
    },
    [getNodes]
  )

  const add = (kind: WorkflowNodeKind) => {
    setNodes((prev) => {
      const next = addNode(fromFlow(prev, getEdges()), kind)
      const added = next.nodes[next.nodes.length - 1]!
      // The new box is the selection, so the inspector opens on it and its
      // label can be typed straight away.
      return [
        ...prev.map((node) => ({ ...node, selected: false })),
        { ...toNode(added), selected: true },
      ]
    })
  }

  const selectedNodes = nodes.filter((node) => node.selected)
  const selectedEdges = edges.filter((edge) => edge.selected)
  const anySelected = selectedNodes.length + selectedEdges.length > 0

  const removeSelection = () =>
    void deleteElements({ nodes: selectedNodes, edges: selectedEdges })

  const node = selectedNodes.length === 1 ? selectedNodes[0] : undefined
  const edge =
    !node && selectedEdges.length === 1 ? selectedEdges[0] : undefined

  const patchNode = (patch: Partial<BoxData>) => {
    if (!node) return
    setNodes((prev) =>
      prev.map((entry) =>
        entry.id === node.id
          ? { ...entry, data: { ...entry.data, ...patch } }
          : entry
      )
    )
  }

  const setKind = (kind: WorkflowNodeKind) => {
    if (!node) return
    setNodes((prev) =>
      prev.map((entry) =>
        entry.id === node.id ? toNode(rekindNode(fromNode(entry), kind)) : entry
      )
    )
    // A `Start` has no way in and an `End` no way out, so the arrows that
    // used the handle just taken away go with it rather than dangling.
    setEdges((prev) =>
      prev.filter((entry) =>
        kind === "start"
          ? entry.target !== node.id
          : kind === "end"
            ? entry.source !== node.id
            : true
      )
    )
  }

  const setEdgeLabel = (label: string) => {
    if (!edge) return
    setEdges((prev) =>
      prev.map((entry) =>
        entry.id === edge.id ? { ...entry, label: label || undefined } : entry
      )
    )
  }

  return (
    <RunContext.Provider value={run}>
      <div className="flex h-full min-h-0">
        <div className="relative min-w-0 flex-1">
          <ReactFlow<BoxNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            colorMode={resolvedTheme === "light" ? "light" : "dark"}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            snapToGrid
            snapGrid={[8, 8]}
            defaultEdgeOptions={EDGE_DEFAULTS}
            className="bg-background text-xs"
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls showInteractive={false} />
            <Panel position="top-left" className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="xs">
                      <Plus />
                      Add
                      <ChevronDown />
                    </Button>
                  }
                />
                <DropdownMenuContent align="start" className="w-40">
                  {KINDS.map((kind) => (
                    <DropdownMenuItem key={kind} onClick={() => add(kind)}>
                      {KIND_ICONS[kind]}
                      {KIND_LABELS[kind]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {anySelected && (
                <Button variant="outline" size="xs" onClick={removeSelection}>
                  <Trash2 />
                  Delete
                </Button>
              )}
            </Panel>
            <Panel position="top-right" className="flex items-center gap-1">
              <RunControls id={id} run={run} />
            </Panel>
            {run && (
              <Panel position="bottom-center">
                <RunStatus run={run} nodes={nodes} />
              </Panel>
            )}
          </ReactFlow>
        </div>

        {/* The inspector: what the selected box or arrow says and runs. A
            column beside the canvas rather than a panel over it, so a prompt
            has room and never covers the box it belongs to. */}
        {node && (
          <NodeInspector
            node={node}
            line={run?.nodes[node.id]}
            editable={!running}
            onPatch={patchNode}
            onKind={setKind}
          />
        )}
        {edge && (
          <aside className={ASIDE}>
            <Field label="Arrow label" htmlFor="workflow-edge-label">
              <Input
                id="workflow-edge-label"
                key={edge.id}
                autoFocus
                value={typeof edge.label === "string" ? edge.label : ""}
                onChange={(event) => setEdgeLabel(event.target.value)}
                placeholder="yes / no"
                className="h-7 text-xs"
              />
              <p className="text-[0.7rem] text-muted-foreground">
                Out of an If box, <code>yes</code> is taken when the pattern
                matches and <code>no</code> when it does not. An unlabelled
                arrow is taken either way.
              </p>
            </Field>
          </aside>
        )}
      </div>
    </RunContext.Provider>
  )
}

const ASIDE =
  "flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l p-3 text-xs"

/**
 * How this workflow is run, and Stop while it is running.
 *
 * There is no Run button: a workflow runs **in a chat**, called by `@` and
 * its slug at the head of a message, and that chat is its project and its
 * conversation (`lib/workflows/invoke.ts`). A run here would have neither.
 */
function RunControls({ id, run }: { id: string; run: WorkflowRun | null }) {
  const workflow = useWorkflows((state) => workflowOf(state.workflows, id))

  if (run?.status === "running") {
    return (
      <Button
        variant="outline"
        size="xs"
        onClick={() => void useWorkflows.getState().stop(id)}
      >
        <Square />
        Stop
      </Button>
    )
  }
  if (!workflow) return null
  return (
    <div className="rounded-md border bg-background px-2 py-1 text-[0.7rem] text-muted-foreground">
      Run it from a chat:{" "}
      <span className="font-mono text-foreground">
        @{workflowSlug(workflow)}
      </span>
    </div>
  )
}

/** One line on where the run has got to, under the canvas. */
function RunStatus({ run, nodes }: { run: WorkflowRun; nodes: BoxNode[] }) {
  const current = nodes.find((node) => run.nodes[node.id]?.status === "running")
  const text =
    run.status === "running"
      ? current
        ? `Running ${current.data.label}…`
        : "Starting…"
      : run.status === "done"
        ? "Done"
        : run.status === "stopped"
          ? "Stopped"
          : `Failed — ${run.error ?? "unknown error"}`

  return (
    <div
      className={cn(
        "flex max-w-xl items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[0.7rem] shadow-sm",
        run.status === "failed"
          ? "border-[#ad0707]/40 text-[#ad0707] dark:border-[#c74e39]/40 dark:text-[#c74e39]"
          : "text-muted-foreground"
      )}
    >
      {run.status === "running" && (
        <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
      )}
      <span className="truncate">{text}</span>
    </div>
  )
}

const PERMISSION_LABELS: Record<ChatPermission, string> = {
  plan: "Plan",
  read: "Read only",
  ask: "Ask",
  edits: "Edits",
  full: "Full access",
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]

/**
 * The selected box: its kind, its label, what it runs, and what it produced
 * the last time it ran.
 *
 * Read-only while a run is going: a prompt edited under a running step is a
 * file that no longer says what the chat was sent.
 */
function NodeInspector({
  node,
  line,
  editable,
  onPatch,
  onKind,
}: {
  node: BoxNode
  line: WorkflowNodeRun | undefined
  editable: boolean
  onPatch: (patch: Partial<BoxData>) => void
  onKind: (kind: WorkflowNodeKind) => void
}) {
  const kind = node.type ?? "claude"
  const text = (field: keyof BoxData) =>
    typeof node.data[field] === "string" ? (node.data[field] as string) : ""
  const set = (field: keyof BoxData) => (value: string) =>
    onPatch({ [field]: value || undefined })

  return (
    <aside className={ASIDE}>
      <Field label="Kind" htmlFor="workflow-kind">
        <Select
          value={kind}
          items={KIND_LABELS}
          onValueChange={(next) => {
            if (isKind(next)) onKind(next)
          }}
          disabled={!editable}
        >
          <SelectTrigger id="workflow-kind" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((candidate) => (
              <SelectItem key={candidate} value={candidate} className="text-xs">
                {KIND_ICONS[candidate]}
                {KIND_LABELS[candidate]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Label" htmlFor="workflow-label">
        <Input
          id="workflow-label"
          key={node.id}
          autoFocus
          value={node.data.label}
          onChange={(event) => onPatch({ label: event.target.value })}
          onFocus={(event) => event.target.select()}
          disabled={!editable}
          className="h-7 text-xs"
        />
        {isStep(kind) && (
          <p className="text-[0.7rem] text-muted-foreground">
            Later boxes can use this box&apos;s output as{" "}
            <code>{`{{${node.data.label}}}`}</code>.
          </p>
        )}
      </Field>

      {kind === "claude" && (
        <>
          <Field label="Prompt" htmlFor="workflow-prompt">
            <Textarea
              id="workflow-prompt"
              value={text("prompt")}
              onChange={(event) => set("prompt")(event.target.value)}
              rows={8}
              disabled={!editable}
              placeholder={"Fix the failing tests.\n\n{{input}}"}
              className="font-mono text-xs"
            />
            <p className="text-[0.7rem] text-muted-foreground">
              Sent as a new chat in the project. <code>{"{{input}}"}</code> is
              what the box before produced.
            </p>
          </Field>
          <Field label="Permission" htmlFor="workflow-permission">
            <Select
              value={node.data.permission ?? "edits"}
              items={PERMISSION_LABELS}
              onValueChange={(next) => {
                if (
                  typeof next === "string" &&
                  (CHAT_PERMISSIONS as readonly string[]).includes(next)
                )
                  onPatch({ permission: next as ChatPermission })
              }}
              disabled={!editable}
            >
              <SelectTrigger
                id="workflow-permission"
                size="sm"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHAT_PERMISSIONS.map((permission) => (
                  <SelectItem
                    key={permission}
                    value={permission}
                    className="text-xs"
                  >
                    {PERMISSION_LABELS[permission]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[0.7rem] text-muted-foreground">
              A turn that stops to ask waits in its chat until you answer there.
            </p>
          </Field>
          <Field label="Model" htmlFor="workflow-model">
            <Input
              id="workflow-model"
              value={text("model")}
              onChange={(event) => set("model")(event.target.value)}
              disabled={!editable}
              placeholder="default"
              className="h-7 font-mono text-xs"
            />
          </Field>
        </>
      )}

      {kind === "shell" && (
        <Field label="Command" htmlFor="workflow-command">
          <Textarea
            id="workflow-command"
            value={text("command")}
            onChange={(event) => set("command")(event.target.value)}
            rows={5}
            disabled={!editable}
            placeholder="git push origin HEAD"
            className="font-mono text-xs"
          />
          <p className="text-[0.7rem] text-muted-foreground">
            Run by your login shell in the project. A non-zero exit fails the
            run.
          </p>
        </Field>
      )}

      {kind === "http" && (
        <>
          <Field label="Method" htmlFor="workflow-method">
            <Select
              value={(text("method") || "GET").toUpperCase()}
              items={Object.fromEntries(
                METHODS.map((method) => [method, method])
              )}
              onValueChange={(next) => {
                if (typeof next === "string") set("method")(next)
              }}
              disabled={!editable}
            >
              <SelectTrigger id="workflow-method" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((method) => (
                  <SelectItem key={method} value={method} className="text-xs">
                    {method}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="URL" htmlFor="workflow-url">
            <Input
              id="workflow-url"
              value={text("url")}
              onChange={(event) => set("url")(event.target.value)}
              disabled={!editable}
              placeholder="https://api.example.com/…"
              className="h-7 font-mono text-xs"
            />
          </Field>
          <Field label="Headers" htmlFor="workflow-headers">
            <Textarea
              id="workflow-headers"
              value={text("headers")}
              onChange={(event) => set("headers")(event.target.value)}
              rows={3}
              disabled={!editable}
              placeholder={
                "Authorization: Bearer …\nContent-Type: application/json"
              }
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Body" htmlFor="workflow-body">
            <Textarea
              id="workflow-body"
              value={text("body")}
              onChange={(event) => set("body")(event.target.value)}
              rows={5}
              disabled={!editable}
              placeholder={'{"text": "{{input}}"}'}
              className="font-mono text-xs"
            />
          </Field>
        </>
      )}

      {kind === "condition" && (
        <Field label="Pattern" htmlFor="workflow-pattern">
          <Input
            id="workflow-pattern"
            value={text("pattern")}
            onChange={(event) => set("pattern")(event.target.value)}
            disabled={!editable}
            placeholder="^DONE"
            className="h-7 font-mono text-xs"
          />
          <p className="text-[0.7rem] text-muted-foreground">
            A regular expression tested against the input. Matching takes the
            arrows labelled <code>yes</code>, otherwise <code>no</code>. Empty
            asks whether there is any input at all.
          </p>
        </Field>
      )}

      <Field label="Description" htmlFor="workflow-description">
        <Textarea
          id="workflow-description"
          value={text("description")}
          onChange={(event) => set("description")(event.target.value)}
          rows={3}
          disabled={!editable}
          placeholder="A note for whoever reads this later."
          className="text-xs"
        />
      </Field>

      {line && line.status !== "pending" && <RunLine line={line} />}
    </aside>
  )
}

/** What the box did last time: its status and its output. What the run
 * said is in the chat that called it, not here. */
function RunLine({ line }: { line: WorkflowNodeRun }) {
  return (
    <div className="flex flex-col gap-1.5 border-t pt-3">
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] font-medium tracking-wider text-muted-foreground uppercase">
          Last run
        </span>
        <span
          className={cn(
            "text-[0.7rem]",
            line.status === "failed" && "text-[#ad0707] dark:text-[#c74e39]",
            line.status === "done" && "text-[#007100] dark:text-[#73c991]"
          )}
        >
          {line.status}
        </span>
      </div>
      {line.error && (
        <pre className="max-h-40 overflow-auto rounded-md border border-[#ad0707]/40 p-2 font-mono text-[0.68rem] whitespace-pre-wrap text-[#ad0707] dark:border-[#c74e39]/40 dark:text-[#c74e39]">
          {line.error}
        </pre>
      )}
      {line.output !== undefined && (
        <pre className="max-h-60 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[0.68rem] whitespace-pre-wrap">
          {line.output || "(empty)"}
        </pre>
      )}
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

/** Every arrow is drawn the same way: stepped, with a head at the end. */
const EDGE_DEFAULTS = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed },
}

/*
 * The translation between the graph on disk and React Flow's records — see
 * `shared/workflows.ts` for why they are two shapes.
 */
function toNode(node: WorkflowNode): BoxNode {
  const { id, kind, x, y, ...data } = node
  return { id, type: kind, position: { x, y }, data }
}

function fromNode(node: BoxNode): WorkflowNode {
  const kept: WorkflowNode = {
    id: node.id,
    kind: node.type ?? "claude",
    label: node.data.label,
    x: Math.round(node.position.x),
    y: Math.round(node.position.y),
  }
  for (const [field, value] of Object.entries(node.data)) {
    if (field === "label" || value === undefined || value === "") continue
    ;(kept as Record<string, unknown>)[field] = value
  }
  return kept
}

function toNodes(graph: WorkflowGraph): BoxNode[] {
  return graph.nodes.map(toNode)
}

function toEdge(edge: WorkflowEdge): Edge {
  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    label: edge.label,
    ...EDGE_DEFAULTS,
  }
}

function toEdges(graph: WorkflowGraph): Edge[] {
  return graph.edges.map(toEdge)
}

/** The workflow in the records: positions rounded, since a box snapped to
 * the grid at 103.99999 is at 104, and the file is one a person may read. */
function fromFlow(nodes: BoxNode[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map(fromNode),
    edges: edges.map((edge) => {
      const kept: WorkflowEdge = {
        id: edge.id,
        from: edge.source,
        to: edge.target,
      }
      if (typeof edge.label === "string" && edge.label) kept.label = edge.label
      return kept
    }),
  }
}
