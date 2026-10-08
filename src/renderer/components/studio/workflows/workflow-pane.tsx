import { lazy, Suspense, useEffect } from "react"
import { Workflow as WorkflowIcon } from "lucide-react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { useWorkflows, workflowOf } from "@/lib/workflows/store"

/**
 * Behind a `lazy` for the reason every editor is: React Flow and its d3 are
 * a quarter of a megabyte nothing needs until a workflow is opened, and most
 * launches never open one.
 */
const WorkflowCanvas = lazy(() =>
  import("./workflow-canvas").then((mod) => ({ default: mod.WorkflowCanvas }))
)

/**
 * The pane a workflow's tab opens: its canvas, or a notice while there is
 * nothing to draw on.
 *
 * Keyed by the workflow's id, so switching tabs is a fresh canvas with its
 * own viewport and selection rather than one canvas handed a different
 * graph — React Flow holds what it is drawing, and a graph swapped under it
 * would keep the last one's zoom and whichever box was selected.
 */
export function WorkflowPane() {
  const selectedId = useWorkflows((state) => state.selectedId)
  const workflows = useWorkflows((state) => state.workflows)
  const graph = useWorkflows((state) =>
    selectedId ? state.graphs[selectedId] : undefined
  )

  const workflow = selectedId ? workflowOf(workflows, selectedId) : undefined

  // A tab restored from the last launch was never `select`ed, so nothing has
  // read its graph yet; this is the one other way a workflow reaches the pane.
  useEffect(() => {
    if (selectedId && !graph) void useWorkflows.getState().readGraph(selectedId)
  }, [selectedId, graph])

  if (!selectedId || !workflow) {
    return (
      <Empty className="size-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon />
          </EmptyMedia>
          <EmptyTitle>That workflow has gone</EmptyTitle>
          <EmptyDescription>
            The workflow this tab was opened for is no longer in the list. Close
            the tab, or pick another on the left.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const loading = (
    <div className="grid h-full place-items-center">
      <Spinner className="size-4 text-muted-foreground" />
    </div>
  )

  if (!graph) return loading

  return (
    <Suspense fallback={loading}>
      <WorkflowCanvas key={selectedId} id={selectedId} graph={graph} />
    </Suspense>
  )
}
