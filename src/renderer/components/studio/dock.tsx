import {
  ChevronDown,
  ChevronUp,
  Plus,
  RotateCw,
  SquareTerminal,
  X,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useDock, DOCK_STRIP_HEIGHT } from "@/lib/dock"
import { shellLabels, useShells } from "@/lib/shell/store"
import { useStudio } from "@/lib/store"
import { IconButton } from "./icon-button"
import { DockTerminal } from "./dock-terminal"

/**
 * The strip under the pane: a tab per shell, and a `+` for another.
 *
 * It spans the pane's whole width, and that is the point of where it sits. It
 * was a panel inside the Explorer column — Conductor's `Setup / Run / Terminal`
 * under its file list — but Conductor's list is on the left and this one is a
 * capped 520px on the right, so the shell got 60-odd columns and the tree lost
 * its height whenever the dock opened. See `studio.tsx`.
 *
 * The chevron collapses it rather than a close button: the dock is one of two
 * halves the pane's column is split into, and collapsing it gives the editor
 * the whole column back.
 *
 * **The strip itself never goes.** Closing the dock collapses the panel to
 * `DOCK_STRIP_HEIGHT`, so what is left on screen is this row — the chevron
 * pointing the other way, and tabs that each open the dock on themselves. The
 * row that closed it is the obvious place to reopen it.
 *
 * There was a `Preview` tab past the `+` — the project's dev server in a
 * `<webview>` — and it is gone (`docs/design.md` § Preview, removed).
 */
export function Dock() {
  const open = useDock((state) => state.open)
  const toggle = useDock((state) => state.toggle)
  const show = useDock((state) => state.show)

  const shells = useShells((state) => state.shells)
  const activeId = useShells((state) => state.activeId)
  const select = useShells((state) => state.select)
  const close = useShells((state) => state.close)
  const add = useShells((state) => state.add)
  const restart = useShells((state) => state.restart)
  const installed = useShells((state) => state.installed)
  const loadInstalled = useShells((state) => state.loadInstalled)

  const folders = useStudio((state) => state.folders)
  const labels = shellLabels(
    shells,
    (folderId) =>
      folders.find((folder) => folder.id === folderId)?.name ?? "project"
  )
  const active = shells.find((shell) => shell.id === activeId)
  const shellName = (shellId: string | null) =>
    shellId
      ? installed?.find((candidate) => candidate.id === shellId)?.name
      : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Terminals"
        // The height is the panel's `collapsedSize`, so this row is exactly what
        // is left when the dock is shut.
        style={{ height: DOCK_STRIP_HEIGHT }}
        // The top border belongs to *this row* rather than to the wrapper, and
        // that is the whole of it: a border on the wrapper is 1px the row does
        // not get, so a shut dock was 37px of content in a 36px box — and the
        // panel's own div scrolls (`overflow: auto`, inline, from
        // react-resizable-panels), so that 1px showed up as a scrollbar.
        className="flex shrink-0 items-center gap-0.5 border-t border-b px-1.5"
      >
        <IconButton
          label={open ? "Hide the panel" : "Show the panel"}
          onClick={toggle}
          className="size-6 shrink-0"
        >
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronUp className="size-3.5" />
          )}
        </IconButton>

        <div className="flex min-w-0 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto">
          {shells.length === 0 && (
            // Nothing started yet: one tab that is the way in, since opening
            // the dock is what starts the first shell.
            <TabFace
              label="Terminal"
              selected={false}
              onSelect={() => show()}
            />
          )}
          {shells.map((shell) => (
            <TabFace
              key={shell.id}
              label={labels.get(shell.id) ?? "project"}
              // Named only when picked from the menu: a tab on the default
              // shell is every tab there was before there was a menu.
              kind={shellName(shell.shellId)}
              title={shell.cwd ?? undefined}
              // Nothing is "selected" while the dock is shut: the strip is all
              // there is, and a lit tab would be pointing at a panel that is
              // not on screen.
              selected={open && shell.id === activeId}
              exited={shell.exited}
              onSelect={() => select(shell.id)}
              onClose={() => close(shell.id)}
            />
          ))}
        </div>

        <IconButton
          label="New terminal"
          onClick={() => add()}
          className="size-6 shrink-0"
        >
          <Plus className="size-3.5" />
        </IconButton>
        {/* The other shells, as VS Code's `+` has them beside it — PowerShell,
            Command Prompt, Git Bash on Windows; whatever `/etc/shells` lists
            elsewhere. Asked of main the first time it opens. */}
        <DropdownMenu
          onOpenChange={(next) => {
            if (next) loadInstalled()
          }}
        >
          <DropdownMenuTrigger
            render={
              <IconButton
                label="New terminal with…"
                className="-ml-0.5 h-6 w-4 shrink-0"
              >
                <ChevronDown className="size-3" />
              </IconButton>
            }
          />
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>New terminal</DropdownMenuLabel>
            {installed === null ? (
              <DropdownMenuItem disabled>Looking for shells…</DropdownMenuItem>
            ) : installed.length === 0 ? (
              <DropdownMenuItem disabled>No shells found</DropdownMenuItem>
            ) : (
              installed.map((profile, index) => (
                <DropdownMenuItem
                  key={profile.id}
                  onClick={() => add(profile.id)}
                >
                  <SquareTerminal />
                  {profile.name}
                  {index === 0 && (
                    <span className="ml-auto text-[0.65rem] text-muted-foreground">
                      default
                    </span>
                  )}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {open && active && (
          <IconButton
            label="Restart shell"
            onClick={() => restart(active.id)}
            className="ml-auto size-6 shrink-0"
          >
            <RotateCw className="size-3" />
          </IconButton>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <DockTerminal />
      </div>
    </div>
  )
}

function TabFace({
  label,
  kind,
  title,
  selected,
  exited = false,
  onSelect,
  onClose,
}: {
  label: string
  /** The shell it runs, when that is not the default one. */
  kind?: string
  /** The whole path, on hover — the label is only its last segment. */
  title?: string
  selected: boolean
  exited?: boolean
  onSelect: () => void
  onClose?: () => void
}) {
  return (
    <div
      className={cn(
        "group flex h-7 shrink-0 items-center rounded-md text-xs font-medium transition-colors",
        selected
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={title}
        onClick={onSelect}
        // Middle-click closes, as it does a browser's tab.
        onAuxClick={(event) => {
          if (event.button === 1 && onClose) onClose()
        }}
        className={cn(
          "flex h-full max-w-48 items-center gap-1.5 pl-2",
          onClose ? "pr-1" : "pr-2"
        )}
      >
        <SquareTerminal className="size-3.5 shrink-0" />
        <span className={cn("truncate", exited && "line-through opacity-60")}>
          {label}
        </span>
        {kind && (
          <span className="shrink-0 text-[0.65rem] text-muted-foreground">
            {kind}
          </span>
        )}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          title="Close terminal"
          onClick={onClose}
          className={cn(
            "mr-1 grid size-4 shrink-0 place-items-center rounded-sm hover:bg-foreground/10",
            !selected && "invisible group-hover:visible"
          )}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}
