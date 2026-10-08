import { useCallback, useEffect, useRef } from "react"

import { cn } from "@/lib/utils"
import { useDock } from "@/lib/dock"
import { useShells, type Shell } from "@/lib/shell/store"
import { useStudio } from "@/lib/store"
import { TerminalView, type TerminalHandle } from "./terminal-view"

/**
 * The dock's body: the shell whose tab is selected.
 *
 * A plain shell beside the work rather than a surface of its own. The agent
 * side of what the Terminal *panel* used to be is a project's chat now, which
 * is why a shell can live in a strip under the pane without demoting anything:
 * it is somewhere to run `git log`, not somewhere work happens.
 *
 * Every shell stays mounted, hidden rather than unmounted — a pty taken out of
 * the tree would end, not hide, and switching tab must not kill the command
 * that was left running in the last one. `invisible` rather than `hidden`,
 * because `display: none` collapses the box xterm measures itself against and
 * the pty would be told a size that is not the one it comes back to.
 */
export function DockTerminal() {
  const shells = useShells((state) => state.shells)
  const activeId = useShells((state) => state.activeId)
  const target = useShells((state) => state.target)

  // The one place a shell is started unasked-for, and only while the dock is
  // on screen: a pty is a process, and clicking a project in the column must
  // not start one behind a dock nobody has opened. Following `target` is what
  // makes a project clicked *while* this is showing switch straight away.
  const showing = useDock((state) => state.open)
  // Whether there are folders at all, rather than the list: with nothing
  // clicked yet `ensure` guesses from them, and a dock opened before the
  // workspace had been read would otherwise sit on its empty state — but the
  // list itself changes on every rename, and each change would drag the dock
  // off a tab somebody picked by hand.
  const anyFolder = useStudio((state) => state.folders.length > 0)
  useEffect(() => {
    if (showing) useShells.getState().ensure()
  }, [showing, target, anyFolder])

  if (shells.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4">
        <p className="max-w-56 text-center text-xs text-muted-foreground">
          Add a folder to the workspace and a shell opens in it here.
        </p>
      </div>
    )
  }

  return (
    <div className="relative h-full min-h-0">
      {shells.map((shell) => (
        <div
          key={shell.id}
          className={cn(
            "absolute inset-0",
            shell.id !== activeId && "invisible"
          )}
        >
          <ShellView shell={shell} />
        </div>
      ))}
    </div>
  )
}

/**
 * One shell's pty, on the host and in its place's directory.
 *
 * Deliberately outside any sandbox: a shell edits the very files shown in the
 * editor, and it is the machine's own.
 */
function ShellView({ shell }: { shell: Shell }) {
  const setExited = useShells((state) => state.setExited)
  const setCwd = useShells((state) => state.setCwd)

  // The id arrives asynchronously, but keystrokes can be typed before it does,
  // so writes go through a ref rather than state.
  const terminalId = useRef<string | null>(null)

  const { id, folderId } = shell

  const onReady = useCallback(
    (terminal: TerminalHandle) => {
      let disposed = false
      let unsubscribeData: (() => void) | undefined
      let unsubscribeExit: (() => void) | undefined

      // Where the shell is, for the tab's name. Asked once output has gone
      // quiet after an Enter — a `cd` is only ever a line typed, and the prompt
      // it redraws is the output that says the line has run — so a dev server
      // streaming logs costs no lookups, and neither does typing. True at
      // first so the opening prompt asks once.
      let entered = true
      let settle: ReturnType<typeof setTimeout> | undefined
      const lookSoon = (created: string) => {
        clearTimeout(settle)
        settle = setTimeout(() => {
          if (!entered || disposed) return
          entered = false
          void window.desktop
            .terminalCwd(created)
            .then((cwd) => {
              if (!disposed && cwd) setCwd(id, cwd)
            })
            .catch(() => {})
        }, 300)
      }

      void window.desktop
        .terminalCreate(folderId, terminal.cols, terminal.rows)
        .then((created) => {
          // The pane unmounted while the shell was starting; it would otherwise
          // be left running with nothing reading it.
          if (disposed) {
            void window.desktop.terminalKill(created)
            return
          }

          terminalId.current = created

          unsubscribeData = window.desktop.onTerminalData((event) => {
            if (event.terminalId !== created) return
            terminal.write(event.chunk)
            lookSoon(created)
          })

          unsubscribeExit = window.desktop.onTerminalExit((event) => {
            if (event.terminalId !== created) return
            terminalId.current = null
            setExited(id, true)
            terminal.write(
              `\r\n\x1b[90m[exited with ${event.exitCode}]\x1b[0m\r\n`
            )
          })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          setExited(id, true)
          terminal.write(`\x1b[31m${message}\x1b[0m\r\n`)
        })

      terminal.onData((data) => {
        if (data.includes("\r")) entered = true
        const current = terminalId.current
        if (current) void window.desktop.terminalWrite(current, data)
      })

      return () => {
        disposed = true
        clearTimeout(settle)
        unsubscribeData?.()
        unsubscribeExit?.()

        const current = terminalId.current
        terminalId.current = null
        if (current) void window.desktop.terminalKill(current)
      }
    },
    [id, folderId, setExited, setCwd]
  )

  const onResize = useCallback((size: { cols: number; rows: number }) => {
    const current = terminalId.current
    if (current)
      void window.desktop.terminalResize(current, size.cols, size.rows)
  }, [])

  return (
    <TerminalView
      // Remounting is what starts a shell over, so the key carries the attempt.
      key={`${id}:${shell.attempt}`}
      onReady={onReady}
      onResize={onResize}
    />
  )
}
