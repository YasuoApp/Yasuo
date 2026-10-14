import { useEffect, useId, useState } from "react"
import { TriangleAlert } from "lucide-react"

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
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { worktreeStatus } from "@/lib/workspace"
import { removalWarnings } from "@/lib/worktrees"
import type { WorkspaceFolder, WorktreeStatus } from "@shared/api"

/**
 * The one gesture in the app that deletes a directory, so it asks git first
 * what would go: uncommitted files, and commits that exist on this branch
 * alone. Deleting the branch is a box, ticked only when that loses nothing —
 * removing a checkout is tidying up, and the branch is the work.
 *
 * Asked fresh when the dialog opens rather than read off the row, whose answer
 * may be a status signal old. Remove waits for it: the warning is the point.
 *
 * And the dialog waits for the removal: `git worktree remove --force` on a
 * checkout with a `node_modules` in it takes seconds, and a dialog that shut at
 * once left a row sitting there looking as if nothing had been asked. It cannot
 * be dismissed meanwhile, and a refusal is shown here, against the question
 * that caused it, with Remove there to try again.
 */
export function RemoveWorktreeDialog({
  folder,
  onRemove,
  onClose,
}: {
  folder: WorkspaceFolder
  /** Resolves once the checkout is gone; rejects with git's sentence. */
  onRemove: (options: { deleteBranch: boolean }) => Promise<void>
  onClose: () => void
}) {
  const boxId = useId()
  /** Undefined while asked; null when git could not say. */
  const [status, setStatus] = useState<WorktreeStatus | null | undefined>()
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function remove() {
    setRemoving(true)
    setFailure(null)
    try {
      await onRemove({ deleteBranch: !!status?.branch && deleteBranch })
      onClose()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      setRemoving(false)
    }
  }

  useEffect(() => {
    let current = true
    void worktreeStatus(folder.id)
      .catch(() => null)
      .then((answer) => {
        if (!current) return
        setStatus(answer)
        setDeleteBranch(answer !== null && answer.unique === 0)
      })
    return () => {
      current = false
    }
  }, [folder.id])

  const warnings = status ? removalWarnings(status, deleteBranch) : []

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        // Escape and the backdrop included: the directory is half gone while
        // this runs, and the answer belongs to the dialog that asked.
        if (!next && !removing) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this worktree?</AlertDialogTitle>
          {/* No paths: an absolute one under `workspace/worktrees/<uuid>` has
              nowhere to break and pushed the dialog's grid wider than its
              card. */}
          <AlertDialogDescription>
            The checkout and every chat in it are deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {status === undefined && (
          <p className="text-xs text-muted-foreground">Checking for work…</p>
        )}

        {warnings.length > 0 && (
          <ul className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-1.5">
                <TriangleAlert className="mt-px size-3 shrink-0" />
                {warning}
              </li>
            ))}
          </ul>
        )}

        {status?.branch && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={boxId}
              checked={deleteBranch}
              disabled={removing}
              onCheckedChange={(checked) => setDeleteBranch(checked)}
            />
            <Label htmlFor={boxId} className="text-xs font-normal">
              Also delete the branch{" "}
              <span className="font-mono">{status.branch}</span>
            </Label>
          </div>
        )}

        {failure && <p className="text-xs text-destructive">{failure}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={status === undefined || removing}
            onClick={() => void remove()}
          >
            {removing && <Spinner className="size-3.5" />}
            {removing ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
