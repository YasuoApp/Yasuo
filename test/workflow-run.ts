import {
  arrowTaken,
  conditionMatches,
  renderTemplate,
  runWorkflow,
  topologicalOrder,
  WorkflowStopped,
  type Steps,
} from "../src/main/workflow-runner"
import { parseHeaders } from "../src/main/workflow-steps"
import { blocksOf } from "../src/renderer/lib/worktree-chat/activity"
import type { AssistantMessage } from "../src/shared/api"
import type {
  WorkflowGraph,
  WorkflowNode,
  WorkflowRun,
} from "../src/shared/workflows"
import { check, finish, section } from "./harness"

/**
 * Running a workflow, against fakes for the three things a step does.
 *
 * What is being held still is the order boxes run in, what each is handed,
 * which arrows out of a condition are taken, and what a failure leaves
 * behind — none of which needs a `claude`, a shell or a network to be wrong.
 */

const node = (
  id: string,
  kind: WorkflowNode["kind"],
  rest: Partial<WorkflowNode> = {}
): WorkflowNode => ({ id, kind, label: id, x: 0, y: 0, ...rest })

const edge = (from: string, to: string, label?: string) => ({
  id: `${from}-${to}`,
  from,
  to,
  ...(label ? { label } : {}),
})

/** Steps that record what they were asked and answer predictably. */
function fakes(overrides: Partial<Steps> = {}) {
  const asked: string[] = []
  const steps: Steps = {
    claude: async (box, prompt, _signal, onChat) => {
      asked.push(`claude:${box.id}:${prompt}`)
      // Told before the answer, the way the real step tells it: the chat
      // exists from the first message, and the pane opens on it then.
      onChat(`chat-${box.id}`)
      return { chatId: `chat-${box.id}`, output: `answer to ${prompt}` }
    },
    shell: async (command) => {
      asked.push(`shell:${command}`)
      return `ran ${command}`
    },
    http: async (request) => {
      asked.push(`http:${request.method} ${request.url}`)
      return `200 from ${request.url}`
    },
    ...overrides,
  }
  return { asked, steps }
}

async function runOf(
  graph: WorkflowGraph,
  steps: Steps,
  signal = new AbortController().signal
): Promise<{ run: WorkflowRun; seen: WorkflowRun[] }> {
  const seen: WorkflowRun[] = []
  const run = await runWorkflow("w", graph, steps, signal, (snapshot) =>
    seen.push(snapshot)
  )
  return { run, seen }
}

section("order")

const chain: WorkflowGraph = {
  nodes: [
    node("end", "end"),
    node("push", "shell", { command: "git push" }),
    node("fix", "claude", { prompt: "fix it" }),
    node("start", "start"),
  ],
  edges: [edge("start", "fix"), edge("fix", "push"), edge("push", "end")],
}
check(
  "boxes come out in arrow order whatever order they were drawn in",
  topologicalOrder(chain)
    ?.map((box) => box.id)
    .join() === "start,fix,push,end"
)
check(
  "a loop is no order at all",
  topologicalOrder({
    nodes: [node("a", "shell"), node("b", "shell")],
    edges: [edge("a", "b"), edge("b", "a")],
  }) === null
)

section("templates")

check(
  "{{input}} is what came before",
  renderTemplate("Review: {{input}}", "the diff", {}) === "Review: the diff"
)
check(
  "{{Label}} is an earlier box's output",
  renderTemplate("Push {{ Fix }} now", "", { Fix: "done" }) === "Push done now"
)
check(
  "a name nothing produced is left as typed",
  renderTemplate("{{Nope}}", "", {}) === "{{Nope}}"
)

section("conditions")

check("a pattern that matches", conditionMatches("^DONE", "DONE\nall good"))
check("a pattern that does not", !conditionMatches("^DONE", "nope"))
check("no pattern asks for any input", conditionMatches("", "x"))
check("and none is none", !conditionMatches(undefined, "  "))
check("a yes arrow is taken on a match", arrowTaken("yes", true))
check("and not otherwise", !arrowTaken("Yes", false))
check("a no arrow is the other way round", arrowTaken("no", false))
check("an unlabelled arrow is always taken", arrowTaken(undefined, false))

section("a straight run")
{
  const { asked, steps } = fakes()
  const { run, seen } = await runOf(chain, steps)
  check("finishes done", run.status === "done")
  check(
    "ran the steps in order",
    asked.join("|") === "claude:fix:fix it|shell:git push"
  )
  check(
    "every box is done",
    Object.values(run.nodes).every((line) => line.status === "done")
  )
  check("a Claude box records its chat", run.nodes.fix?.chatId === "chat-fix")
  check(
    "the end carries the last output",
    run.nodes.end?.output === "ran git push"
  )
  check("the run was reported as it went", seen.length > 4)
  check(
    "the first report has every box pending",
    Object.values(seen[0]!.nodes).every((line) => line.status === "pending")
  )
  check(
    "and a middle one has a box running",
    seen.some((snapshot) => snapshot.nodes.fix?.status === "running")
  )
}

section("what a box is handed")
{
  const { asked, steps } = fakes()
  const graph: WorkflowGraph = {
    nodes: [
      node("start", "start"),
      node("Fix", "claude", { prompt: "fix" }),
      node("Push", "shell", { command: "push {{input}} / {{Fix}}" }),
    ],
    edges: [edge("start", "Fix"), edge("Fix", "Push")],
  }
  await runOf(graph, steps)
  check(
    "input and a label both fill in",
    asked[1] === "shell:push answer to fix / answer to fix"
  )
}
{
  const { asked, steps } = fakes()
  const graph: WorkflowGraph = {
    nodes: [
      node("start", "start"),
      node("Fix", "claude", { prompt: "fix {{input}}" }),
    ],
    edges: [edge("start", "Fix")],
  }
  const run = await runWorkflow(
    "w",
    graph,
    steps,
    new AbortController().signal,
    () => {},
    { chatId: "c1", input: "the login" }
  )
  check(
    "what followed the name in the chat is Start's output",
    asked[0] === "claude:Fix:fix the login",
    asked
  )
  check("the run says which chat called it", run.chatId === "c1")
}

section("a branch")
{
  const branch: WorkflowGraph = {
    nodes: [
      node("start", "start"),
      node("check", "claude", { prompt: "check" }),
      node("if", "condition", { pattern: "answer" }),
      node("yes", "shell", { command: "echo yes" }),
      node("no", "shell", { command: "echo no" }),
      node("always", "shell", { command: "echo always" }),
      node("after-no", "shell", { command: "echo after no" }),
    ],
    edges: [
      edge("start", "check"),
      edge("check", "if"),
      edge("if", "yes", "yes"),
      edge("if", "no", "no"),
      edge("if", "always"),
      edge("no", "after-no"),
    ],
  }
  const { asked, steps } = fakes()
  const { run } = await runOf(branch, steps)
  check("the condition answered yes", run.nodes.if?.output === "yes")
  check("the yes arrow was taken", run.nodes.yes?.status === "done")
  check("the no arrow was not", run.nodes.no?.status === "skipped")
  check("nor anything after it", run.nodes["after-no"]?.status === "skipped")
  check("the unlabelled arrow was", run.nodes.always?.status === "done")
  check(
    "only the taken branches ran",
    asked.filter((line) => line.startsWith("shell:")).join("|") ===
      "shell:echo yes|shell:echo always"
  )
  check("a skipped box is not a failure", run.status === "done")
}

section("a failure")
{
  const { asked, steps } = fakes({
    shell: async () => {
      throw new Error("exit 1")
    },
  })
  const { run } = await runOf(chain, steps)
  check("the run failed", run.status === "failed")
  check("naming the box and its words", run.error === "push: exit 1")
  check("the box is marked", run.nodes.push?.status === "failed")
  check("with the error on it", run.nodes.push?.error === "exit 1")
  check("what came before stays done", run.nodes.fix?.status === "done")
  check("what came after is skipped", run.nodes.end?.status === "skipped")
  check("and was never asked", asked.length === 1)
}

section("refused before it starts")
{
  const { steps } = fakes()
  const loop = await runOf(
    {
      nodes: [node("start", "start"), node("a", "shell", { command: "x" })],
      edges: [edge("start", "a"), edge("a", "start")],
    },
    steps
  )
  check(
    "a loop",
    loop.run.status === "failed" && /loop/.test(loop.run.error ?? "")
  )
  const noStart = await runOf(
    { nodes: [node("a", "shell", { command: "x" })], edges: [] },
    steps
  )
  check(
    "no Start",
    noStart.run.status === "failed" && /Start/.test(noStart.run.error ?? "")
  )
  const empty = await runOf(
    {
      nodes: [node("start", "start"), node("a", "shell")],
      edges: [edge("start", "a")],
    },
    steps
  )
  check(
    "a shell box with nothing to run",
    empty.run.error === "a: No command to run."
  )
}

section("stopped")
{
  const controller = new AbortController()
  const { steps } = fakes({
    claude: async () => {
      controller.abort()
      throw new WorkflowStopped()
    },
  })
  const { run } = await runOf(chain, steps, controller.signal)
  check("the run is stopped, not failed", run.status === "stopped")
  check("the box it was on is skipped", run.nodes.fix?.status === "skipped")
  check("and so is the rest", run.nodes.push?.status === "skipped")
}

section("headers")

check(
  "one per line",
  JSON.stringify(
    parseHeaders("Authorization: Bearer x\n\nContent-Type: a/b")
  ) === JSON.stringify({ Authorization: "Bearer x", "Content-Type": "a/b" })
)
check("a value may hold a colon", parseHeaders("X: a:b").X === "a:b")

section("recorded in the run's chat")
{
  const recorded: string[] = []
  const { steps } = fakes({
    finished: async (box, summary, entry) => {
      recorded.push(`${box.kind}:${summary}:${entry.status}:${entry.output}`)
      return "run-chat"
    },
  })
  const graph: WorkflowGraph = {
    nodes: [
      node("start", "start"),
      node("Fix", "claude", { prompt: "fix" }),
      node("push", "shell", { command: "git push {{Fix}}" }),
      node("if", "condition", { pattern: "ran" }),
      node("end", "end"),
    ],
    edges: [
      edge("start", "Fix"),
      edge("Fix", "push"),
      edge("push", "if"),
      edge("if", "end", "yes"),
    ],
  }
  const { run } = await runOf(graph, steps)
  check(
    "every step but Claude and the ends is handed over, filled in",
    recorded.join("|") ===
      "shell:git push answer to fix:done:ran git push answer to fix|condition:/ran/:done:yes"
  )
  check("and points its box at the chat", run.nodes.push?.chatId === "run-chat")
  check("Claude's own box keeps its chat", run.nodes.Fix?.chatId === "chat-Fix")
}
{
  const recorded: string[] = []
  const { steps } = fakes({
    shell: async () => {
      throw new Error("exit 1")
    },
    finished: async (_box, _summary, entry) => {
      recorded.push(`${entry.status}:${entry.error}`)
      return null
    },
  })
  await runOf(chain, steps)
  check(
    "a failed step is recorded with its error",
    recorded.join() === "failed:exit 1"
  )
}
{
  const { steps } = fakes({
    finished: async () => {
      throw new Error("disk full")
    },
  })
  const { run } = await runOf(chain, steps)
  check(
    "a record that could not be written does not fail the run",
    run.status === "done"
  )
}

section("a step is a boundary between turns")
{
  const lines: AssistantMessage[] = [
    { id: "p1", role: "user", text: "fix", step: "Fix" },
    { id: "a1", role: "assistant", text: "fixed" },
    {
      id: "s1",
      role: "step",
      kind: "shell",
      label: "push",
      summary: "git push",
      status: "done",
    },
    { id: "p2", role: "user", text: "check", step: "Check" },
    { id: "a2", role: "assistant", text: "checked" },
  ]
  const shown = blocksOf(lines)
    .filter((block) => block.kind === "line")
    .map((block) => block.id)
  check(
    "the first answer stays an answer, not working folded into the next",
    shown.join() === "p1,a1,s1,p2,a2"
  )
}

finish()
