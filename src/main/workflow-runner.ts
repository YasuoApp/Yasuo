import type {
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRun,
} from "../shared/workflows"

/**
 * Runs a workflow's graph: which box runs next, what it is handed, and which
 * arrows out of it are taken.
 *
 * Free of everything that does the actual work — a Claude turn, a shell, a
 * request — which arrives as `Steps` so `test/workflow-run.ts` can run a
 * whole graph against fakes. Free of `electron` for the same reason.
 *
 * The rules, in one place:
 *
 * - Boxes run **one at a time, in topological order**. A graph with a loop in
 *   it is refused before anything runs: a workflow is a chain, and a cycle is
 *   a chain that never ends.
 * - A box runs when at least one arrow **into** it fired. An arrow fires when
 *   the box it leaves ran — and, out of a condition, when its label agrees
 *   with the answer: `yes` arrows on a match, `no` arrows otherwise, unlabelled
 *   arrows either way. A box no arrow reached is `skipped`, and so is
 *   everything after it on that branch.
 * - A box's **input** is the output of whichever boxes fired into it, joined
 *   by a blank line when there are several. `{{input}}` in a step's fields is
 *   that; `{{Label}}` is any earlier box's output by its label. `Start`'s
 *   output is what was written after the workflow's name in the chat that
 *   called it — `@create-pr fix the login` hands on `fix the login`.
 * - The first failure ends the run. Everything that had not run is `skipped`,
 *   and the run carries the failing step's own words.
 */

export type ClaudeStep = (
  node: WorkflowNode,
  prompt: string,
  signal: AbortSignal,
  /** Told the chat as soon as the step has one — before the turn, not after
   * — so the pane can open on it while the answer is still being written. */
  onChat: (chatId: string) => void
) => Promise<{ chatId: string; output: string }>

export type Steps = {
  claude: ClaudeStep
  shell: (command: string, signal: AbortSignal) => Promise<string>
  http: (
    request: { method: string; url: string; headers: string; body: string },
    signal: AbortSignal
  ) => Promise<string>
  /**
   * A step that is not Claude has finished, done or failed — for the run's
   * chat to record it between the turns. `summary` is what it ran, filled
   * in. Resolves to the chat it was written into; optional, since a run in a
   * test has nowhere to write.
   */
  finished?: (
    node: WorkflowNode,
    summary: string,
    entry: WorkflowNodeRun
  ) => Promise<string | null>
}

/** Whether a box's own arrows are conditional on its answer. */
const YES = "yes"
const NO = "no"

/**
 * The boxes in an order every arrow points forward in, or null when the
 * graph has a loop. Kahn's algorithm; ties keep the graph's own order, so a
 * run is the same run every time.
 */
export function topologicalOrder(graph: WorkflowGraph): WorkflowNode[] | null {
  const into = new Map<string, number>()
  for (const node of graph.nodes) into.set(node.id, 0)
  for (const edge of graph.edges)
    into.set(edge.to, (into.get(edge.to) ?? 0) + 1)

  const ready = graph.nodes.filter((node) => into.get(node.id) === 0)
  const ordered: WorkflowNode[] = []
  while (ready.length > 0) {
    const node = ready.shift()!
    ordered.push(node)
    for (const edge of graph.edges) {
      if (edge.from !== node.id) continue
      const left = (into.get(edge.to) ?? 1) - 1
      into.set(edge.to, left)
      if (left === 0) {
        const next = graph.nodes.find((candidate) => candidate.id === edge.to)
        if (next) ready.push(next)
      }
    }
  }
  return ordered.length === graph.nodes.length ? ordered : null
}

/**
 * `{{input}}` and `{{Label}}` filled in. A name nothing produced is left as
 * it was, so a typo reads as a typo in the chat rather than as an empty
 * string nobody can see.
 */
export function renderTemplate(
  text: string,
  input: string,
  outputs: Record<string, string>
): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) => {
    if (name === "input") return input
    const found = outputs[name]
    return found === undefined ? whole : found
  })
}

/** Whether a condition's arrow is taken, given the condition's answer. */
export function arrowTaken(
  label: string | undefined,
  matched: boolean
): boolean {
  const word = label?.trim().toLowerCase()
  if (word === YES) return matched
  if (word === NO) return !matched
  return true
}

/** The condition's own test — an empty pattern asks whether there is any
 * input at all. A pattern that does not compile is a failed step. */
export function conditionMatches(
  pattern: string | undefined,
  input: string
): boolean {
  if (!pattern?.trim()) return input.trim().length > 0
  return new RegExp(pattern, "m").test(input)
}

export class WorkflowStopped extends Error {
  constructor() {
    super("Stopped.")
  }
}

/**
 * Runs the graph. `onChange` is given the run whole after every change, which
 * is what the renderer draws; the resolved value is the same record at the
 * end. Never rejects: a step that threw is a run that `failed`, and the
 * sentence is on it.
 */
export async function runWorkflow(
  workflowId: string,
  graph: WorkflowGraph,
  steps: Steps,
  signal: AbortSignal,
  onChange: (run: WorkflowRun) => void,
  /** The chat the run was called from, and what was written after the
   * workflow's name there — `Start`'s output. */
  call: { chatId: string; input: string } = { chatId: "", input: "" }
): Promise<WorkflowRun> {
  const run: WorkflowRun = {
    workflowId,
    chatId: call.chatId,
    status: "running",
    startedAt: new Date().toISOString(),
    nodes: Object.fromEntries(
      graph.nodes.map((node) => [node.id, { status: "pending" }])
    ),
  }
  const tell = () => onChange(structuredClone(run))

  const order = topologicalOrder(graph)
  if (!order)
    return finish(run, "failed", "The workflow has a loop in it.", tell)
  if (!order.some((node) => node.kind === "start"))
    return finish(run, "failed", "The workflow has no Start.", tell)
  tell()

  /** Which arrows fired, by edge id. */
  const fired = new Set<string>()
  /** Every box's output, by label, for `{{Label}}`. */
  const byLabel: Record<string, string> = {}

  for (const node of order) {
    if (signal.aborted) return finish(run, "stopped", undefined, tell)

    const incoming = graph.edges.filter((edge) => edge.to === node.id)
    const reached =
      node.kind === "start" || incoming.some((edge) => fired.has(edge.id))
    if (!reached) {
      run.nodes[node.id] = { status: "skipped" }
      tell()
      continue
    }

    const input =
      node.kind === "start"
        ? call.input
        : incoming
            .filter((edge) => fired.has(edge.id))
            .map((edge) => run.nodes[edge.from]?.output ?? "")
            .filter((text) => text.length > 0)
            .join("\n\n")

    const entry: WorkflowNodeRun = {
      status: "running",
      startedAt: new Date().toISOString(),
    }
    run.nodes[node.id] = entry
    tell()

    let matched = true
    try {
      entry.output = await execute(
        node,
        input,
        byLabel,
        steps,
        signal,
        entry,
        tell
      )
      if (node.kind === "condition") matched = entry.output === YES
    } catch (error) {
      if (signal.aborted || error instanceof WorkflowStopped) {
        entry.status = "skipped"
        delete entry.startedAt
        return finish(run, "stopped", undefined, tell)
      }
      entry.status = "failed"
      entry.error = error instanceof Error ? error.message : String(error)
      entry.finishedAt = new Date().toISOString()
      await record(node, input, byLabel, steps, entry)
      return finish(run, "failed", `${node.label}: ${entry.error}`, tell)
    }

    entry.status = "done"
    entry.finishedAt = new Date().toISOString()
    await record(node, input, byLabel, steps, entry)
    byLabel[node.label] = entry.output
    for (const edge of graph.edges) {
      if (edge.from !== node.id) continue
      if (node.kind !== "condition" || arrowTaken(edge.label, matched))
        fired.add(edge.id)
    }
    tell()
  }

  return finish(run, "done", undefined, tell)
}

/**
 * What a step that is not Claude ran, filled in — the line the run's chat
 * shows for it. Null for the boxes that are not recorded: the ends, which do
 * nothing, and Claude, whose turn is already in the chat.
 */
export function stepSummary(
  node: WorkflowNode,
  input: string,
  outputs: Record<string, string>
): string | null {
  const fill = (text: string | undefined) =>
    renderTemplate(text ?? "", input, outputs).trim()
  switch (node.kind) {
    case "shell":
      return fill(node.command)
    case "http":
      return `${(node.method ?? "GET").trim().toUpperCase() || "GET"} ${fill(node.url)}`
    case "condition":
      return node.pattern?.trim() ? `/${node.pattern.trim()}/` : "has any input"
    default:
      return null
  }
}

/** Hands a finished step to the run's chat, if there is one — see
 * `Steps.finished`. Never fails the run: a chat that could not be written to
 * is a record lost, not a step that did not happen. */
async function record(
  node: WorkflowNode,
  input: string,
  outputs: Record<string, string>,
  steps: Steps,
  entry: WorkflowNodeRun
): Promise<void> {
  const summary = stepSummary(node, input, outputs)
  if (summary === null || !steps.finished) return
  try {
    const chatId = await steps.finished(node, summary, entry)
    if (chatId) entry.chatId = chatId
  } catch {
    // See above.
  }
}

async function execute(
  node: WorkflowNode,
  input: string,
  outputs: Record<string, string>,
  steps: Steps,
  signal: AbortSignal,
  entry: WorkflowNodeRun,
  tell: () => void
): Promise<string> {
  const fill = (text: string | undefined) =>
    renderTemplate(text ?? "", input, outputs)

  switch (node.kind) {
    case "start":
    case "end":
      return input
    case "condition":
      return conditionMatches(node.pattern, input) ? YES : NO
    case "shell": {
      const command = fill(node.command)
      if (!command.trim()) throw new Error("No command to run.")
      return steps.shell(command, signal)
    }
    case "http": {
      const url = fill(node.url)
      if (!url.trim()) throw new Error("No URL to call.")
      return steps.http(
        {
          method: (node.method ?? "GET").trim().toUpperCase() || "GET",
          url,
          headers: fill(node.headers),
          body: fill(node.body),
        },
        signal
      )
    }
    case "claude": {
      const prompt = fill(node.prompt)
      if (!prompt.trim()) throw new Error("Nothing to ask.")
      const { output } = await steps.claude(node, prompt, signal, (chatId) => {
        entry.chatId = chatId
        tell()
      })
      return output
    }
  }
}

function finish(
  run: WorkflowRun,
  status: WorkflowRun["status"],
  error: string | undefined,
  tell: () => void
): WorkflowRun {
  run.status = status
  run.finishedAt = new Date().toISOString()
  if (error) run.error = error
  for (const entry of Object.values(run.nodes)) {
    if (entry.status === "pending" || entry.status === "running")
      entry.status = "skipped"
  }
  tell()
  return run
}
