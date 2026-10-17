import { useId, useState } from "react"
import { AlertCircle, Check, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { brandIcon } from "@/lib/brand-icons"
import { parentOf } from "@/lib/files/paths"
import { useProjects } from "@/lib/projects"
import { useShells } from "@/lib/shell/store"
import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import * as repo from "@/lib/workspace"
import {
  PACKAGE_MANAGERS,
  PROJECT_TEMPLATES,
  projectNameProblem,
  scaffoldCommand,
  type PackageManager,
} from "@shared/project-templates"

/**
 * A new project from a framework's starter — the other half of
 * `AddFolderDialog`.
 *
 * Main makes the empty directory and adds it; the framework's own CLI is then
 * typed into a dock shell inside it, the way the worktree dialog runs its
 * setup command. That is the whole design: the CLI's questions are answered
 * where they are asked, its install is watched as it happens, and what a
 * starter holds stays the framework's to decide. `shared/project-templates.ts`
 * says why the name is held to npm's rule.
 *
 * The parent is prefilled with the one the newest project sits in, which is
 * almost always where the next one goes.
 */
export function TemplateProjectForm({ onClose }: { onClose: () => void }) {
  const createProject = useStudio((state) => state.createProject)
  const folders = useStudio((state) => state.folders)

  const parentId = useId()
  const nameId = useId()

  const [template, setTemplate] = useState(PROJECT_TEMPLATES[0]!.id)
  const [manager, setManager] = useState<PackageManager>("npm")
  const [parent, setParent] = useState(() => {
    const newest = folders.at(-1)
    return newest ? parentOf(newest.path) : ""
  })
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const trimmed = name.trim()
  // Only once something is typed: an empty field is not yet a mistake.
  const problem = trimmed ? projectNameProblem(trimmed) : null
  const command = scaffoldCommand(template, manager)

  async function browse() {
    const chosen = await repo.pickDirectory()
    if (chosen) setParent(chosen)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (creating || !command || !parent.trim() || projectNameProblem(trimmed))
      return

    setCreating(true)
    setError(null)
    try {
      const created = await createProject({ parent, name: trimmed, template })
      if (created) {
        useProjects.getState().setActive(created)
        useShells.getState().run(created, command)
      }
      onClose()
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : String(failure)
      setError(
        message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          ""
        )
      )
    } finally {
      setCreating(false)
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="min-w-0 space-y-5"
    >
      <fieldset disabled={creating} className="contents">
        <div
          role="radiogroup"
          aria-label="Template"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {PROJECT_TEMPLATES.map((option) => {
            const chosen = option.id === template
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={chosen}
                onClick={() => setTemplate(option.id)}
                className={cn(
                  "relative rounded-lg border p-2.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                  chosen && "border-primary bg-primary/5 hover:bg-primary/10"
                )}
              >
                <BrandIcon name={option.icon} className="mb-2 size-6" />
                <span className="block truncate text-sm font-medium">
                  {option.label}
                </span>
                <span className="block truncate text-[0.7rem] text-muted-foreground">
                  {option.caption}
                </span>
                {chosen && (
                  <Check className="absolute top-2 right-2 size-3.5 text-primary" />
                )}
              </button>
            )
          })}
        </div>

        <div className="grid gap-4">
          <div>
            <Label
              htmlFor={parentId}
              className="text-xs font-medium text-muted-foreground"
            >
              Location
            </Label>
            <div className="mt-1.5 flex gap-2">
              <Input
                id={parentId}
                value={parent}
                onChange={(event) => setParent(event.target.value)}
                placeholder="~/code"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void browse()}
              >
                Browse…
              </Button>
            </div>
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
              autoFocus
              placeholder="my-app"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={!!problem}
              className="mt-1.5"
            />
            {problem && (
              <p className="mt-1.5 text-xs text-destructive">{problem}</p>
            )}
          </div>
          <div>
            <div
              role="radiogroup"
              aria-label="Package manager"
              className="inline-flex rounded-lg bg-muted p-[3px]"
            >
              {PACKAGE_MANAGERS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={option === manager}
                  onClick={() => setManager(option)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-0.5 font-mono text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    option === manager &&
                      "bg-background text-foreground shadow-sm"
                  )}
                >
                  <BrandIcon name={option} className="size-3.5" />
                  {option}
                </button>
              ))}
            </div>
          </div>
        </div>

        {command && (
          <p className="truncate rounded-lg bg-muted/60 px-3 py-2 font-mono text-[0.7rem] text-muted-foreground">
            <span className="text-foreground/50 select-none">$ </span>
            {command}
          </p>
        )}
      </fieldset>

      {error && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}

      <DialogFooter className="items-center sm:justify-between">
        <p className="text-[0.7rem] text-muted-foreground">
          Runs in a terminal, where its questions can be answered.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={creating || !trimmed || !!problem || !parent.trim()}
          >
            {creating && <Loader2 className="animate-spin" />}
            Create
          </Button>
        </div>
      </DialogFooter>
    </form>
  )
}

/**
 * A logo from `lib/brand-icons.ts`, both theme variants drawn and one hidden
 * by the `.dark` class — the theme is a class on the root, so CSS can choose
 * without this subscribing to it. Decorative: the label beside it says the
 * same thing, so it is `alt=""`. Nothing at all when no logo is checked in.
 */
function BrandIcon({ name, className }: { name: string; className?: string }) {
  const icon = brandIcon(name)
  if (!icon) return null
  if (icon.light === icon.dark) {
    return <img src={icon.light} alt="" className={className} />
  }
  return (
    <>
      <img src={icon.light} alt="" className={cn(className, "dark:hidden")} />
      <img
        src={icon.dark}
        alt=""
        className={cn(className, "hidden dark:block")}
      />
    </>
  )
}
