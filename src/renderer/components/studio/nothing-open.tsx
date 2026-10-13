import { useState, type ReactNode } from "react"
import {
  MessageSquarePlus,
  Search,
  SquareTerminal,
  TextSearch,
} from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { IS_MAC } from "./title-bar"
import { useDock } from "@/lib/dock"
import { usePalette } from "@/lib/palette"
import { useProjects } from "@/lib/projects"
import { useShells } from "@/lib/shell/store"
import { useStudio } from "@/lib/store"
import { useWorkspaceSearch } from "@/lib/workspace-search"
import { useWorktreeChats } from "@/lib/worktree-chat/store"

/**
 * The pane with nothing in it: one notice for the whole workbench rather than
 * whichever panel happens to be showing — the strip belongs to the workbench,
 * so "nothing is on screen" is a fact about the workbench.
 *
 * A few ways in, each with its key, rather than a paragraph saying where things
 * are picked from: the keys are what somebody needs to stop reading this page
 * the next time, and every row does what it says when clicked.
 */
export function NothingOpen() {
  const activeFolderId = useProjects((state) => state.activeFolderId)
  const folders = useStudio((state) => state.folders)
  /** A project picked here; otherwise the active one. */
  const [picked, setPicked] = useState<string | null>(null)
  const project =
    folders.find((folder) => folder.id === picked) ??
    folders.find((folder) => folder.id === activeFolderId) ??
    folders[0]
  const mod = IS_MAC ? "⌘" : "Ctrl+"

  return (
    <div className="flex size-full items-center justify-center p-6">
      <div className="flex w-full max-w-xs flex-col gap-0.5">
        {/* Only with a project to start it in, and the project picked on
            the row: the active one is whatever row was last clicked, which is
            not always the one somebody has in mind. */}
        {project && (
          <div className="flex items-center gap-1">
            <Action
              icon={<MessageSquarePlus />}
              label="New chat"
              onClick={() => {
                // Into that project first, the way its own row's click moves
                // the tree and the shell: the tab is in the strip only while
                // its project is the active one.
                useProjects.getState().setActive(project.id)
                useShells.getState().showFor(project.id)
                void useWorktreeChats
                  .getState()
                  .create({ folderId: project.id })
              }}
            />
            <Select
              value={project.id}
              items={Object.fromEntries(
                folders.map((folder) => [folder.id, folder.name])
              )}
              onValueChange={(next) => {
                if (typeof next === "string") setPicked(next)
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Project"
                className="h-7 max-w-40 min-w-0 border-0 bg-transparent text-xs text-muted-foreground shadow-none hover:text-foreground dark:bg-transparent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {folders.map((folder) => (
                  <SelectItem
                    key={folder.id}
                    value={folder.id}
                    className="text-xs"
                  >
                    {folder.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <Action
          icon={<Search />}
          label="Go to file or chat"
          keys={`${mod}P`}
          onClick={() => usePalette.getState().setOpen(true)}
        />
        <Action
          icon={<TextSearch />}
          label="Find in files"
          keys={IS_MAC ? "⇧⌘F" : "Ctrl+Shift+F"}
          onClick={() => {
            useProjects.getState().showView("search")
            useWorkspaceSearch.getState().focus()
          }}
        />
        <Action
          icon={<SquareTerminal />}
          label="Terminal"
          keys={IS_MAC ? "⌃`" : "Ctrl+`"}
          onClick={() => useDock.getState().toggle()}
        />
      </div>
    </div>
  )
}

function Action({
  icon,
  label,
  keys,
  onClick,
}: {
  icon: ReactNode
  label: string
  keys?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0"
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {keys && (
        <kbd className="font-sans text-xs text-muted-foreground/70">{keys}</kbd>
      )}
    </button>
  )
}
