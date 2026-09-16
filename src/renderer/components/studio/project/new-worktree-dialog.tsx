import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { useProjects } from "@/lib/projects"
import { useShells } from "@/lib/shell/store"
import { useStudio } from "@/lib/store"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
import type { WorkspaceFolder } from "@shared/api"

/**
 * A second checkout of one project, which becomes a project of its own.
 *
 * Two fields, and the second is filled in from the first: a branch to check
 * out, and what the workspace should call the project it arrives as. **Both are
 * optional**, which is the interesting half — a checkout made with the branch
 * empty goes on a `yasuo/untitled-…` branch and is named by the first chat that
 * runs in it, off the title the CLI writes for that conversation. A worktree
 * cannot be opened nameless the way a chat can, since its branch and directory
 * exist before any prompt does; this is as close as it gets, and it is why the
 * dialog opens a chat in what it made. See `nameWorktree` in `main/ipc.ts`.
 *
 * There is
 * **no path field**, unlike `AddFolderDialog` — the directory is this app's to
 * name, under its own data folder (`main/worktrees.ts` says why not beside the
 * repository), and the renderer cannot see that path to show it. So the
 * description says where it goes in words, which is the same bargain a Claude
 * profile's directory makes.
 *
 * A branch that already exists is checked out rather than refused, so this is
 * also how somebody comes back to work started last week. A failure — a branch
 * already checked out somewhere, a name git will not take — is shown here and
 * leaves the dialog open, since the field holding it is the only place it can
 * be corrected.
 */
export function NewWorktreeDialog({
  folder,
  onClose,
}: {
  /** The project being checked out again. */
  folder: WorkspaceFolder
  onClose: () => void
}) {
  const addWorktree = useStudio((state) => state.addWorktree)

  const branchId = useId()
  const nameId = useId()

  const [branch, setBranch] = useState("")
  const [name, setName] = useState("")
  /** Whether the name is the reader's own, so typing in the branch field stops
   * overwriting it. Without it, correcting a branch after naming the project
   * silently threw the name away. */
  const [named, setNamed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (adding) return

    setAdding(true)
    setError(null)
    try {
      const created = await addWorktree({
        folderId: folder.id,
        branch: branch.trim(),
        name: name.trim(),
      })
      /*
       * And the studio moves into it: the tree, the dock's shell and a chat
       * waiting for its first message, the way clicking a project row moves the
       * first two.
       *
       * The chat is what makes an unnamed checkout nameable at all — the branch
       * is a placeholder until a conversation in it has a title — but it is
       * opened either way, because "make me somewhere else to work" is never
       * the end of the gesture. It writes nothing down until somebody speaks
       * into it, so a dialog somebody thought better of leaves no chat behind.
       */
      if (created) {
        useProjects.getState().setActive(created)
        useShells.getState().showFor(created)
        void useWorktreeChats.getState().create({ folderId: created })
      }
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            A second checkout of “{folder.name}” on a branch of its own, sharing
            the same history — so work can run here without touching the files,
            index or branch of the project itself. It is created inside Yasuo’s
            own data folder and added to the workspace as a project.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div>
            <Label htmlFor={branchId} className="text-xs font-medium">
              Branch <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={branchId}
              value={branch}
              autoFocus
              onChange={(event) => {
                const next = event.target.value
                setBranch(next)
                if (!named) setName(next)
              }}
              placeholder="feature/sso"
              spellCheck={false}
              className="mt-1.5 font-mono text-xs"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Created off the current HEAD; a branch that already exists is
              checked out instead. Leave it empty and the first chat here names
              both the branch and the project, the way a chat names itself.
            </p>
          </div>

          <div>
            <Label htmlFor={nameId} className="text-xs font-medium">
              Name <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => {
                setNamed(true)
                setName(event.target.value)
              }}
              className="mt-1.5"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={adding}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
