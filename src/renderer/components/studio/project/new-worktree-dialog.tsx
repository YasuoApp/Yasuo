import { useEffect, useId, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { useProjects } from "@/lib/projects"
import { useShells } from "@/lib/shell/store"
import { useStudio } from "@/lib/store"
import { useChats } from "@/lib/chat/store"
import { worktreeOptions } from "@/lib/workspace"
import type { WorkspaceFolder, WorktreeOptions } from "@shared/api"

/**
 * A second checkout of one project, which becomes a project of its own.
 *
 * Two fields, and the second is filled in from the first: a branch to check
 * out, and what the workspace should call the project it arrives as. **Both are
 * optional**, which is the interesting half — a checkout made with the branch
 * empty goes on a `vsclaude/untitled-…` branch and is named by the first chat that
 * runs in it, off the title the CLI writes for that conversation. A worktree
 * cannot be opened nameless the way a chat can, since its branch and directory
 * exist before any prompt does; this is as close as it gets, and it is why the
 * dialog opens a chat in what it made. See `nameWorktree` in `main/ipc.ts`.
 *
 * There is
 * **no path field**, unlike `AddFolderDialog` — the directory is this app's to
 * name, under its own data folder (`main/worktrees.ts` says why not beside the
 * repository), and the renderer cannot see that path to show it.
 *
 * A branch that already exists is checked out rather than refused, so this is
 * also how somebody comes back to work started last week. A failure — a branch
 * already checked out somewhere, a name git will not take — is shown here and
 * leaves the dialog open, since the field holding it is the only place it can
 * be corrected.
 *
 * `From` is the branch a **new** one is cut from — the main checkout's when
 * empty — and is dimmed while the branch field names one that exists, since
 * git checks that one out as it is. `Setup` is prefilled off the lock file and
 * runs in a dock shell in the new checkout, where it can be watched; files the
 * repository lists in `.worktreeinclude` are copied by main before that.
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
  const baseId = useId()
  const setupId = useId()

  const [options, setOptions] = useState<WorktreeOptions | null>(null)
  const [base, setBase] = useState("")
  /** Null until the options arrive, so the suggestion fills the field once and
   * a field somebody cleared stays cleared. */
  const [setup, setSetup] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void worktreeOptions(folder.id)
      .then((answer) => {
        if (!current) return
        setOptions(answer)
        setSetup((typed) => typed ?? answer.setup ?? "")
      })
      // A dialog without suggestions is still the whole dialog.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [folder.id])

  const [branch, setBranch] = useState("")
  const [name, setName] = useState("")
  /** Whether the name is the reader's own, so typing in the branch field stops
   * overwriting it. Without it, correcting a branch after naming the project
   * silently threw the name away. */
  const [named, setNamed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  /** Whether the branch typed is one git will check out rather than create —
   * local, or `feature/x` that exists only as `origin/feature/x`. */
  const typed = branch.trim()
  const existing =
    !!typed &&
    (!!options?.branches.includes(typed) ||
      // The remote's own name is the first segment; one remote, as main's
      // check and git's DWIM both require.
      options?.remotes.filter(
        (known) => known.slice(known.indexOf("/") + 1) === typed
      ).length === 1)

  /*
   * Two lists, because the two fields mean different things by a remote
   * branch. To check out, `origin/feature/sso` is typed as `feature/sso` —
   * the name git's DWIM turns into a local branch tracking it; typed whole it
   * would be a new local branch *called* `origin/feature/sso`. To cut from, the
   * remote ref is exactly what is meant.
   */
  const local = options?.branches ?? []
  const remote = options?.remotes ?? []
  const checkoutGroups: BranchGroup[] = [
    { value: "Local", items: local },
    {
      value: "Remote",
      items: [
        ...new Set(remote.map((ref) => ref.slice(ref.indexOf("/") + 1))),
      ].filter((name) => !local.includes(name)),
    },
  ]
  const baseGroups: BranchGroup[] = [
    { value: "Local", items: local },
    { value: "Remote", items: remote },
  ]

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
        base: existing ? undefined : base.trim() || undefined,
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
        const command = setup?.trim()
        if (command) useShells.getState().run(created, command)
        else useShells.getState().showFor(created)
        void useChats.getState().create({ folderId: created })
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
            A separate checkout of “{folder.name}” on its own branch.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div>
            <Label htmlFor={branchId} className="text-xs font-medium">
              Branch <span className="text-muted-foreground">(optional)</span>
            </Label>
            <BranchField
              id={branchId}
              value={branch}
              autoFocus
              onChange={(next) => {
                setBranch(next)
                if (!named) setName(next)
              }}
              placeholder="feature/sso"
              groups={checkoutGroups}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {existing
                ? "Exists already — it will be checked out as it is."
                : "Leave empty to name it after the first chat."}
            </p>
          </div>

          <div>
            <Label htmlFor={baseId} className="text-xs font-medium">
              From <span className="text-muted-foreground">(optional)</span>
            </Label>
            <BranchField
              id={baseId}
              value={base}
              onChange={setBase}
              placeholder={options?.current ?? "HEAD"}
              groups={baseGroups}
              disabled={existing}
            />
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

          <div>
            <Label htmlFor={setupId} className="text-xs font-medium">
              Setup <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={setupId}
              value={setup ?? ""}
              onChange={(event) => setSetup(event.target.value)}
              placeholder="bun install"
              spellCheck={false}
              className="mt-1.5 font-mono text-xs"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Runs in a terminal in the new checkout.
              {options?.includes &&
                " Files listed in .worktreeinclude are copied first."}
            </p>
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

type BranchGroup = { value: string; items: string[] }

/**
 * A branch field: free text, with the repository's branches offered under it.
 *
 * shadcn's Combobox rather than a Select, since a name nobody has used yet is
 * the ordinary answer here. Base UI's combobox resets its text to the selected
 * item when it closes, and nothing is ever "selected" in a field whose value is
 * whatever was typed — so the text is controlled, and only typing, picking an
 * item or the clear button may change it.
 */
function BranchField({
  id,
  value,
  onChange,
  placeholder,
  groups,
  disabled = false,
  autoFocus = false,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  groups: BranchGroup[]
  disabled?: boolean
  autoFocus?: boolean
}) {
  const shown = groups.filter((group) => group.items.length > 0)
  return (
    <Combobox
      items={shown}
      inputValue={value}
      onInputValueChange={(next, details) => {
        if (KEPT_REASONS.has(details.reason)) onChange(next)
      }}
      onValueChange={(picked) => {
        if (typeof picked === "string") onChange(picked)
      }}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        placeholder={placeholder}
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        className="mt-1.5 w-full font-mono text-xs"
      />
      <ComboboxContent>
        {/* Not a dead end: no match is a branch that will be created. */}
        <ComboboxEmpty>
          No branch by that name — it will be created.
        </ComboboxEmpty>
        <ComboboxList>
          {(group: BranchGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(item: string) => (
                  <ComboboxItem
                    key={item}
                    value={item}
                    className="font-mono text-xs"
                  >
                    {item}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

const KEPT_REASONS = new Set<string>([
  "input-change",
  "item-press",
  "clear-press",
])
