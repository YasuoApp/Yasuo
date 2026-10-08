import { useState } from "react"
import { Pencil, Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { Workflow } from "@shared/workflows"
import { closePanelTab } from "@/lib/panels"
import { useWorkflows } from "@/lib/workflows/store"
import { IconButton } from "../icon-button"
import { PanelHeader } from "../panel-header"
import { RenameRow, useMenuFocusHandoff } from "../rename-row"
import { SideRow } from "../side-row"

/**
 * The left column's Workflows: one row per workflow the workspace holds, a `+`
 * that makes one, and a menu on each row to rename or delete it.
 *
 * A row opens the workflow in the pane. Everything else about a workflow —
 * the boxes, the arrows, what they say — is the canvas's, so this list is as
 * short as the projects' is: a name, and what can be done to the name.
 */
export function WorkflowsSection() {
  const workflows = useWorkflows((state) => state.workflows)
  const loaded = useWorkflows((state) => state.loaded)
  const selectedId = useWorkflows((state) => state.selectedId)
  const { create, open, rename, remove } = useWorkflows.getState()

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Workflow | null>(null)
  const menuFocus = useMenuFocusHandoff()

  // Newest first: the one just made is the one about to be drawn in, and a
  // list that put it at the bottom would scroll away from it.
  const rows = [...workflows].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )

  return (
    <>
      <PanelHeader title="Workflows">
        <IconButton label="New workflow" onClick={() => void create()}>
          <Plus />
        </IconButton>
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loaded && rows.length === 0 ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>No workflows yet</EmptyTitle>
              <EmptyDescription>
                A workflow is a diagram of how a piece of work goes — the steps,
                the decisions, and the arrows between them. Press + to draw one.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          rows.map((workflow) =>
            renamingId === workflow.id ? (
              <RenameRow
                key={workflow.id}
                name={workflow.name}
                label="Workflow name"
                lead={
                  <WorkflowIcon className="size-3 shrink-0 text-muted-foreground" />
                }
                onRename={async (name) => {
                  await rename(workflow.id, name)
                  setRenamingId(null)
                  return null
                }}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <ContextMenu key={workflow.id}>
                <ContextMenuTrigger
                  render={
                    <SideRow
                      active={selectedId === workflow.id}
                      title={workflow.name}
                      className="rounded-md text-foreground"
                      onClick={() => open(workflow.id)}
                    >
                      <WorkflowIcon className="size-3 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {workflow.name}
                      </span>
                    </SideRow>
                  }
                />
                <ContextMenuContent
                  className="w-44"
                  // Rename hands focus to the field it opens — see
                  // `useMenuFocusHandoff`.
                  finalFocus={menuFocus.finalFocus}
                >
                  <ContextMenuItem
                    onClick={() => {
                      menuFocus.handOff()
                      setRenamingId(workflow.id)
                    }}
                  >
                    <Pencil />
                    Rename
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onClick={() => setRemoving(workflow)}
                  >
                    <Trash2 />
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          )
        )}
      </div>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              “{removing?.name}” and its diagram are deleted. Nothing else
              refers to a workflow, so nothing else changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) {
                  // Through the strip's own close first, so the pane lands on
                  // the neighbouring tab rather than on this panel's empty
                  // notice with other tabs still in the strip.
                  closePanelTab("workflows", removing.id)
                  void remove(removing.id)
                }
                setRemoving(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
