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
import { FolderOpen } from "lucide-react"

import * as repo from "@/lib/workspace"
import { useStudio } from "@/lib/store"

/** The directory's own name, as a starting point for the folder's name. */
function basename(target: string): string {
  return (
    target
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? target
  )
}

/**
 * Points the workspace at a folder that already exists on this machine.
 *
 * The folder is worked on where it is, not copied: edits made to it elsewhere
 * are edits to the same repository, and their git sees them. That is stated in
 * the dialog because it is the one thing about this that could surprise
 * someone.
 *
 * A failure — a path that is not there, a folder already added — is shown here
 * and leaves the dialog open, since the field holding the bad value is the only
 * place it can be corrected.
 */
export function AddFolderDialog({ onClose }: { onClose: () => void }) {
  const addFolder = useStudio((state) => state.addFolder)

  const nameId = useId()
  const pathId = useId()

  const [path, setPath] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  async function browse() {
    const chosen = await repo.pickDirectory()
    if (chosen) {
      setPath(chosen)
      setName((current) => current || basename(chosen))
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!path || adding) return

    setAdding(true)
    setError(null)
    try {
      await addFolder({ path, name: name.trim() || basename(path) })
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
          <DialogTitle>Add a folder</DialogTitle>
          <DialogDescription>
            The folder is opened where it is. Files in it stay in that folder —
            nothing is copied, and removing it from the workspace later leaves
            it untouched.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div>
            <Label htmlFor={pathId} className="text-xs font-medium">
              Folder
            </Label>
            <div className="mt-1.5 flex gap-2">
              <Input
                id={pathId}
                value={path}
                onChange={(event) => {
                  const next = event.target.value
                  setPath(next)
                  setName((current) => current || basename(next))
                }}
                placeholder="~/code/my-app"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void browse()}
              >
                <FolderOpen data-icon="inline-start" />
                Browse
              </Button>
            </div>
          </div>

          <div>
            <Label htmlFor={nameId} className="text-xs font-medium">
              Name
            </Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1.5"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!path || adding}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
