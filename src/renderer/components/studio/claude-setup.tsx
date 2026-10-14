import { useCallback, useEffect, useState } from "react"
import { Check, Copy, Loader2 } from "lucide-react"

import type { ClaudeVersions } from "@shared/api"
import { Button } from "@/components/ui/button"
import { useClaudeProfiles } from "@/lib/chat/claude-profiles"
import {
  installCommand,
  installShell,
  setupStep,
  type SetupStep,
} from "@/lib/chat/claude-setup"
import { ClaudeLoginDialog } from "./claude-login-dialog"

const SETUP_DOCS = "https://docs.claude.com/en/docs/claude-code/setup"

/**
 * Whether this machine has a `claude` to chat with, asked once at launch.
 *
 * The login is read through `useClaudeProfiles` under the default directory's
 * key rather than held here, so Settings › Claude and the login dialog's own
 * re-check land on the same answer this screen is waiting for.
 */
export function useClaudeSetup(): {
  step: SetupStep
  versions: ClaudeVersions | undefined
  /** A re-ask in flight. The last answer is kept meanwhile, so the screen
   * stays put under its button rather than vanishing and coming back. */
  checking: boolean
  recheck: () => Promise<void>
} {
  const [versions, setVersions] = useState<ClaudeVersions>()
  // True from the start, since the launch's own ask begins on mount.
  const [checking, setChecking] = useState(true)
  const account = useClaudeProfiles((state) => state.accounts[""])
  const hasProfiles = useClaudeProfiles((state) => state.profiles.length > 0)

  const ask = useCallback(async () => {
    try {
      const next = await window.desktop.claudeVersions()
      setVersions(next)
      if (next.cli) await useClaudeProfiles.getState().check("")
    } finally {
      setChecking(false)
    }
  }, [])

  const recheck = useCallback(async () => {
    setChecking(true)
    await ask()
  }, [ask])

  useEffect(() => {
    void ask()
  }, [ask])

  return {
    step: setupStep({ versions, account, hasProfiles }),
    versions,
    checking,
    recheck,
  }
}

/**
 * The screen in front of the workbench when `claude` is missing or signed out.
 *
 * **Walk-past, not a lock.** Both answers come through a login shell's PATH,
 * which can miss a `claude` that is there, and everything but the chats works
 * without one — the dock's terminal is even where the install command goes. So
 * `Continue without Claude` is always on the card, and it holds for the run:
 * the next launch asks again.
 */
export function ClaudeSetup({
  step,
  versions,
  checking,
  onRecheck,
  onSkip,
}: {
  step: "install" | "signIn"
  versions: ClaudeVersions | undefined
  checking: boolean
  onRecheck: () => void
  onSkip: () => void
}) {
  const [signingIn, setSigningIn] = useState(false)

  return (
    // `z-50`, the dialogs' own layer, rather than the tour's `z-60`: the login
    // dialog opened from here portals in after this and has to land on top.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal
        aria-labelledby="claude-setup-title"
        className="w-[28rem] animate-rise rounded-xl border bg-popover p-5 text-popover-foreground shadow-lg"
      >
        <p className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
          Step {step === "install" ? 1 : 2} of 2
        </p>
        {step === "install" ? (
          <InstallStep versions={versions} />
        ) : (
          <SignInStep versions={versions} />
        )}

        <div className="mt-5 flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={onSkip}>
            Continue without Claude
          </Button>
          <div className="flex-1" />
          <Button
            size="xs"
            variant={step === "install" ? "default" : "outline"}
            disabled={checking}
            onClick={onRecheck}
          >
            {checking && <Loader2 className="animate-spin" />}
            Check again
          </Button>
          {step === "signIn" && (
            <Button size="xs" onClick={() => setSigningIn(true)}>
              Sign in
            </Button>
          )}
        </div>
      </div>

      {signingIn && (
        // The dialog re-checks the default login when the CLI exits, and a
        // signed-in answer takes this whole screen down with it.
        <ClaudeLoginDialog
          configDir=""
          name="Default"
          onClose={() => setSigningIn(false)}
        />
      )}
    </div>
  )
}

function InstallStep({ versions }: { versions: ClaudeVersions | undefined }) {
  const platform = window.desktop.platform
  return (
    <>
      <h2 id="claude-setup-title" className="mt-1 text-sm font-medium">
        Install Claude Code
      </h2>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Every chat here is your own <code>claude</code> — the Claude Code CLI —
        running in the project folder, and this machine does not have one that a
        login shell can find. Run this in {installShell(platform)}, then press
        Check again:
      </p>
      <CommandLine command={installCommand(platform)} />
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Installed somewhere unusual? Set <code>CLAUDE_BIN</code> to its path and
        restart the app. Other ways to install are in the{" "}
        <a
          href={SETUP_DOCS}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          setup guide
        </a>
        .
      </p>
      {versions?.error && (
        <p className="mt-2 font-mono text-[0.7rem] break-words text-muted-foreground/70">
          {versions.error}
        </p>
      )}
    </>
  )
}

function SignInStep({ versions }: { versions: ClaudeVersions | undefined }) {
  return (
    <>
      <h2 id="claude-setup-title" className="mt-1 text-sm font-medium">
        Sign in to Claude
      </h2>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        <code>claude</code>
        {versions?.cli ? ` ${versions.cli}` : ""} is installed but not signed
        in. Sign in once — with a Claude subscription or a Console account — and
        every chat runs as that account. More accounts can be added later in
        Settings › Claude.
      </p>
    </>
  )
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border bg-muted/50 py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs select-all">
        {command}
      </code>
      <Button
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label="Copy the command"
        onClick={() => {
          void navigator.clipboard.writeText(command)
          setCopied(true)
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}
