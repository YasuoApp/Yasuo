import { useId, useState } from "react"
import { AlertCircle, Folder, FolderPlus, FolderX, Loader2 } from "lucide-react"
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

import * as repo from "@/lib/workspace"
import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"

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
 * Whether a drag in progress is a folder or a file, from what `dragover` is
 * allowed to see — the items' kinds and MIME types, not their entries, which
 * the browser only hands over on drop. A folder has no type; neither does a
 * file of a kind macOS does not know, so an empty type is let through as a
 * folder and checked again on drop. More than one thing dragged is refused:
 * the dialog adds one folder.
 */
function draggedKind(transfer: DataTransfer): "folder" | "file" {
  const items = [...transfer.items].filter((item) => item.kind === "file")
  if (items.length !== 1) return "file"
  return items[0]!.type === "" ? "folder" : "file"
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
 *
 * The folder is picked from a drop zone — clicked for the system's picker, or
 * a folder dragged in from Finder — and once picked, it is drawn as the folder
 * it is rather than as a path in a field. The field is still there under it,
 * for a path somebody would rather type.
 */
export function AddFolderDialog({ onClose }: { onClose: () => void }) {
  const addFolder = useStudio((state) => state.addFolder)

  const nameId = useId()
  const pathId = useId()

  const [path, setPath] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  /** What is being dragged over the drop zone, as far as can be told. */
  const [dragging, setDragging] = useState<"folder" | "file" | null>(null)

  function choose(chosen: string) {
    setPath(chosen)
    setName((current) => current || basename(chosen))
    setError(null)
  }

  async function browse() {
    const chosen = await repo.pickDirectory()
    if (chosen) choose(chosen)
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
      const message =
        failure instanceof Error ? failure.message : String(failure)
      // Electron's own wrapping of a rejected `invoke`, which says which
      // channel failed — nothing somebody adding a folder can act on.
      setError(
        message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          ""
        )
      )
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
        <DialogHeader className="flex-row items-center gap-3.5">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border bg-gradient-to-b from-card to-muted text-primary shadow-sm ring-1 ring-primary/10">
            <FolderPlus className="size-5" />
          </span>
          <div className="min-w-0 space-y-0.5">
            <DialogTitle>Add a folder</DialogTitle>
            <DialogDescription>
              Work on a folder where it already is. Nothing is copied.
            </DialogDescription>
          </div>
        </DialogHeader>

        <form
          onSubmit={(event) => void submit(event)}
          className="min-w-0 space-y-5"
        >
          {/* A folder dragged in from Finder has a real path, and
              `getPathForFile` gives it — a directory as much as a file. */}
          <button
            type="button"
            onClick={() => void browse()}
            onDragOver={(event) => {
              event.preventDefault()
              const kind = draggedKind(event.dataTransfer)
              // `none` is what puts the no-entry cursor up and keeps the
              // drop from firing at all.
              event.dataTransfer.dropEffect = kind === "file" ? "none" : "copy"
              setDragging(kind)
            }}
            onDragLeave={() => setDragging(null)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(null)
              // Asked again here, where it can be answered for certain: a
              // file with no MIME type passes `draggedKind`, and would
              // otherwise be drawn as the folder chosen and only fail on Add.
              const entry = event.dataTransfer.items[0]?.webkitGetAsEntry()
              if (entry && !entry.isDirectory) {
                setError("Only folders can be added.")
                return
              }
              const file = event.dataTransfer.files[0]
              const dropped = file ? window.desktop.getPathForFile(file) : ""
              if (dropped) choose(dropped)
            }}
            className={cn(
              "group relative flex w-full min-w-0 items-center gap-4 rounded-xl border p-4 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              path
                ? "bg-muted/40 hover:bg-muted/60"
                : "justify-center border-dashed py-8 hover:border-primary/50 hover:bg-primary/5",
              dragging === "folder" && "border-primary bg-primary/10",
              dragging === "file" &&
                "cursor-not-allowed border-destructive/60 bg-destructive/5"
            )}
          >
            {path ? (
              <>
                <span className="grid size-10 shrink-0 animate-pop place-items-center rounded-lg bg-primary/10 text-primary">
                  <Folder className="size-5 fill-current/20" />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-sm font-medium"
                    title={path}
                  >
                    {basename(path)}
                  </span>
                  <span className="block truncate font-mono text-[0.7rem] text-muted-foreground">
                    {path}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                  Change
                </span>
              </>
            ) : (
              <span className="flex flex-col items-center gap-2 text-center">
                <span
                  className={cn(
                    "grid size-11 place-items-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary",
                    dragging === "folder" && "bg-primary/15 text-primary",
                    dragging === "file" &&
                      "bg-destructive/10 text-destructive group-hover:bg-destructive/10 group-hover:text-destructive"
                  )}
                >
                  {dragging === "file" ? (
                    <FolderX className="size-5" />
                  ) : (
                    <FolderPlus className="size-5" />
                  )}
                </span>
                <span
                  className={cn(
                    "text-sm font-medium",
                    dragging === "file" && "text-destructive"
                  )}
                >
                  {dragging === "folder"
                    ? "Drop to add it"
                    : dragging === "file"
                      ? "Only folders can be added"
                      : "Choose a folder"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {dragging === "file"
                    ? "Drag the folder that holds it instead"
                    : "or drag one here from Finder"}
                </span>
              </span>
            )}
          </button>

          <div className="grid gap-4">
            <div>
              <Label
                htmlFor={pathId}
                className="text-xs font-medium text-muted-foreground"
              >
                Path
              </Label>
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
                className="mt-1.5 font-mono text-xs"
              />
            </div>
            <div>
              <Label
                htmlFor={nameId}
                className="text-xs font-medium text-muted-foreground"
              >
                Name
              </Label>
              <Input
                id={nameId}
                value={name}
                placeholder={path ? basename(path) : "my-app"}
                onChange={(event) => setName(event.target.value)}
                className="mt-1.5"
              />
            </div>
          </div>

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-px size-3.5 shrink-0" />
              {error}
            </p>
          )}

          <DialogFooter className="items-center sm:justify-between">
            <p className="text-[0.7rem] text-muted-foreground">
              Removing it later leaves its files untouched.
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!path || adding}>
                {adding && <Loader2 className="animate-spin" />}
                Add folder
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
