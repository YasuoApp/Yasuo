import {
  addNode,
  connect,
  emptyGraph,
  parseGraph,
  placeNode,
  rekindNode,
  removeEdges,
  removeNodes,
  serializeGraph,
  untitledName,
  updateEdge,
  updateNode,
} from "../src/renderer/lib/workflows/graph"
import type { WorkflowGraph } from "../src/shared/workflows"
import { check, finish, section } from "./harness"

/**
 * A workflow's graph: the file it is read back from, and the edits the canvas
 * makes to it.
 *
 * Both are worth holding still. The file is JSON somebody can open and
 * change by hand, and the canvas draws whatever it is handed — a node with no
 * position reaches it as `NaN` and vanishes. The edits are where the rules
 * live that make a diagram a workflow rather than any graph at all, and a
 * rule that lives in a drag handler is a rule nobody can run.
 */

section("a new workflow")

const fresh = emptyGraph("s")
check("opens on one Start box", fresh.nodes.length === 1)
check("which is a start", fresh.nodes[0]?.kind === "start")
check("and no arrows", fresh.edges.length === 0)

section("reading the file back")

const round = parseGraph(serializeGraph(fresh))
check("what was written is what is read", round?.nodes[0]?.id === "s")

check("empty text is not a graph", parseGraph("") === null)
check("prose is not a graph", parseGraph("not json") === null)
check("an object with no lists is not a graph", parseGraph("{}") === null)

const handEdited = JSON.stringify({
  nodes: [
    {
      id: "a",
      kind: "claude",
      label: "Review",
      x: 0,
      y: 0,
      prompt: "Review {{input}}",
      permission: "read",
      model: 7,
    },
    { id: "b", kind: "shell", label: "No position" },
    { id: "c", kind: "unknown", label: "Odd kind", x: 1, y: 1 },
    {
      id: "d",
      kind: "end",
      label: "Done",
      x: 0,
      y: 200,
      description: "",
      permission: "sudo",
    },
  ],
  edges: [
    { id: "ab", from: "a", to: "b" },
    { id: "ad", from: "a", to: "d", label: "yes" },
    { id: "ax", from: "a", to: "x" },
  ],
})
const edited = parseGraph(handEdited)
check(
  "a box without a position is dropped and the rest kept",
  edited?.nodes.map((node) => node.id).join() === "a,d"
)
check(
  "an arrow to a dropped box goes with it",
  edited?.edges.map((edge) => edge.id).join() === "ad"
)
check("an arrow's label survives", edited?.edges[0]?.label === "yes")
check(
  "an empty description is not written down",
  edited?.nodes[1] !== undefined && !("description" in edited.nodes[1])
)
check(
  "a step's prompt survives",
  edited?.nodes[0]?.prompt === "Review {{input}}"
)
check("and its permission", edited?.nodes[0]?.permission === "read")
check(
  "a model that is not text is dropped",
  edited?.nodes[0] !== undefined && !("model" in edited.nodes[0])
)
check(
  "a permission that is not one of the five is dropped",
  edited?.nodes[1] !== undefined && !("permission" in edited.nodes[1])
)

section("adding a box")

check("the first box goes at the origin", placeNode([]).y === 0)
const two = addNode(addNode(fresh, "shell", "t1"), "claude", "t2")
check(
  "a Claude box starts out allowed to edit",
  two.nodes[2]?.permission === "edits"
)
check(
  "an HTTP box starts out as GET",
  addNode(fresh, "http").nodes[1]?.method === "GET"
)

section("changing a box's kind")

const pushed = updateNode(two, "t1", { label: "Push", command: "git push" })
const rekinded = rekindNode(pushed.nodes[1]!, "claude")
check("keeps a name somebody typed", rekinded.label === "Push")
check("drops what the old kind ran", rekinded.command === undefined)
check("takes the new kind's defaults", rekinded.permission === "edits")
check(
  "renames a box still called by its kind",
  rekindNode(two.nodes[2]!, "http").label === "HTTP"
)
check(
  "each new box goes under the lowest",
  two.nodes[1]!.y > two.nodes[0]!.y && two.nodes[2]!.y > two.nodes[1]!.y
)
check(
  "in the same column",
  two.nodes[2]!.x === two.nodes[1]!.x && two.nodes[1]!.x === fresh.nodes[0]!.x
)
check("and is named for its kind", two.nodes[1]?.label === "Shell")

section("joining boxes")

const joined = connect(two, "s", "t1", "e1")
check("an arrow is drawn", joined.edges.length === 1)
check("to the box asked for", joined.edges[0]?.to === "t1")
check("not from a box to itself", connect(joined, "t1", "t1") === joined)
check("not twice between the same two", connect(joined, "s", "t1") === joined)
check("not to a box that is not there", connect(joined, "s", "nope") === joined)

section("editing")

const relabelled = updateNode(joined, "t1", { label: "Triage" })
check("a box's label", relabelled.nodes[1]?.label === "Triage")
check("leaves the others", relabelled.nodes[0]?.label === "Start")
const edgeLabelled = updateEdge(joined, "e1", { label: "always" })
check("an arrow's label", edgeLabelled.edges[0]?.label === "always")

section("removing")

const chain = connect(joined, "t1", "t2", "e2")
const without = removeNodes(chain, ["t1"])
check("the box goes", !without.nodes.some((node) => node.id === "t1"))
check("and every arrow touching it", without.edges.length === 0)
check("the others stay", without.nodes.length === 2)
const lessOne = removeEdges(chain, ["e2"])
check(
  "an arrow alone",
  lessOne.edges.length === 1 && lessOne.nodes.length === 3
)

section("naming")

const named = (names: string[]) =>
  names.map((name, index) => ({
    id: String(index),
    name,
    createdAt: "",
    updatedAt: "",
  }))
check(
  "the first is Untitled workflow",
  untitledName([]) === "Untitled workflow"
)
check(
  "the second is numbered",
  untitledName(named(["Untitled workflow"])) === "Untitled workflow 2"
)
check(
  "past whatever numbers are taken",
  untitledName(named(["Untitled workflow", "Untitled workflow 2"])) ===
    "Untitled workflow 3"
)
check(
  "a renamed one frees its name",
  untitledName(named(["Release", "Untitled workflow 2"])) ===
    "Untitled workflow"
)

const typed: WorkflowGraph = fresh
check("the shapes agree", typed.nodes.length === 1)

finish()
