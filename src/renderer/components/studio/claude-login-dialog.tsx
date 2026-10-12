import { useCallback, useEffect, useRef, useState } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { useClaudeProfiles } from "@/lib/worktree-chat/claude-profiles"
import { TerminalView, type TerminalHandle } from "./terminal-view"

/**
 * Signing a profile's directory in, without leaving the app.
 *
 * **The whole of adding an account is now a click, a login and nothing else.**
 * It used to be: read the paragraph under the section, invent a path, type it
 * into the row, open Terminal.app, export the variable the paragraph named, run
 * `claude`, log in, come back and press Check. Six of those seven steps existed
 * only because the app knew how to *read* a config directory and not how to
 * make one — `defaultConfigDir` picks the path and `claudeLogin` runs the
 * login, so what is left is the one step that is genuinely the user's, which is
 * choosing which account to sign in as.
 *
 * **A terminal rather than a form**, because the login is a conversation the
 * CLI owns: it prints a URL, opens a browser, asks console-or-subscription, and
 * may stop for an SSO prompt. Anything smoother would be this app pretending to
 * know a flow that is free to change under it — and the terminal is not a
 * consolation prize, it is the same screen the CLI would draw in iTerm, minus
 * having to know which variable to export.
 *
 * Closing kills the pty (`TerminalView`'s teardown), so a login somebody
 * thought better of does not leave a `claude` waiting on a browser tab nobody
 * is going to open.
 */
export function ClaudeLoginDialog({
  configDir,
  name,
  onClose,
}: {
  /** The profile's `CLAUDE_CONFIG_DIR`, or empty for the default login. */
  configDir: string
  /** The profile's name, for the title — this is a login to *an* account, and
   * the whole point of profiles is that there is more than one. */
  name: string
  onClose: () => void
}) {
  const check = useClaudeProfiles((state) => state.check)
  /** Non-null once the pty has ended: what the CLI exited with. */
  const [exitCode, setExitCode] = useState<number | null>(null)

  // Keystrokes can be typed before the id has arrived, so writes go through a
  // ref rather than state — the same trade `ShellView` makes.
  const terminalId = useRef<string | null>(null)

  // Through a ref because `onReady` starting the pty must not depend on a
  // callback the parent re-makes each render: a new identity would tear the
  // terminal down and open a second login.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])

  const onReady = useCallback(
    (terminal: TerminalHandle) => {
      let disposed = false
      let unsubscribeData: (() => void) | undefined
      let unsubscribeExit: (() => void) | undefined

      void window.desktop
        .claudeLogin(configDir, terminal.cols, terminal.rows)
        .then((created) => {
          // The dialog closed while the CLI was starting; it would otherwise be
          // left holding a login nobody is watching.
          if (disposed) {
            void window.desktop.terminalKill(created)
            return
          }

          terminalId.current = created

          unsubscribeData = window.desktop.onTerminalData((event) => {
            if (event.terminalId !== created) return
            terminal.write(event.chunk)
          })

          unsubscribeExit = window.desktop.onTerminalExit((event) => {
            if (event.terminalId !== created) return
            terminalId.current = null
            setExitCode(event.exitCode)

            /*
             * The one moment this app knows the answer has changed.
             *
             * Settings otherwise re-checks only when asked to, because a login
             * happens in a terminal it cannot see — that reasoning is exactly
             * what this dialog undoes, so the badge is refreshed here rather
             * than left to the Check button somebody would now have to know to
             * press. Asked whatever the CLI exited with: a login abandoned
             * half-way is still worth telling the truth about.
             */
            void check(configDir).then(() => {
              // Closing on the *answer*, not on the exit code: `claude` exits 0
              // for a login somebody backed out of too, and a dialog that shut
              // itself on that would hide the one line saying it did not work.
              const account =
                useClaudeProfiles.getState().accounts[configDir.trim()]
              if (account?.state === "signedIn") close.current()
            })
          })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          setExitCode(1)
          terminal.write(`\x1b[31m${message}\x1b[0m\r\n`)
        })

      terminal.onData((data) => {
        const current = terminalId.current
        if (current) void window.desktop.terminalWrite(current, data)
      })

      return () => {
        disposed = true
        unsubscribeData?.()
        unsubscribeExit?.()

        const current = terminalId.current
        terminalId.current = null
        if (current) void window.desktop.terminalKill(current)
      }
    },
    [configDir, check]
  )

  const onResize = useCallback((size: { cols: number; rows: number }) => {
    const current = terminalId.current
    if (current)
      void window.desktop.terminalResize(current, size.cols, size.rows)
  }, [])

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="flex h-[30rem] max-h-[85vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {/* `pr-12` clears the close button the dialog draws in the corner. */}
        <header className="shrink-0 border-b px-5 py-4 pr-12">
          <DialogTitle>Sign in — {name}</DialogTitle>
          <DialogDescription className="mt-1 font-mono text-xs">
            {configDir || "~/.claude"}
          </DialogDescription>
        </header>

        {/* The pty's own padding: xterm measures itself against this box, so the
            room has to be around it rather than inside it. */}
        <div className="min-h-0 flex-1 bg-background p-2">
          <TerminalView onReady={onReady} onResize={onResize} />
        </div>

        <footer className="shrink-0 border-t px-5 py-3 text-xs text-muted-foreground">
          {exitCode === null
            ? "Follow the prompts — `claude` opens a browser to finish the login."
            : exitCode === 0
              ? "Done. The account beside this profile has been re-checked."
              : `The login ended with ${exitCode}. Close this and try again, or read what it said above.`}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
