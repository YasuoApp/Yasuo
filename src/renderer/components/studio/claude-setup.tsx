import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  FolderOpen,
  GitCompare,
  KeyRound,
  Loader2,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react"

import type { ClaudeVersions } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Claude } from "@/components/ui/svgs/claude"
import { cn } from "@/lib/utils"
import { accountCaption, useClaudeProfiles } from "@/lib/chat/claude-profiles"
import {
  installCommand,
  installShell,
  setupStep,
  type SetupStep,
} from "@/lib/chat/claude-setup"
import { ClaudeLoginDialog } from "./claude-login-dialog"
import { StudioMark } from "./splash"

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

/** The pages of the setup screen, in the order they are walked. */
type Page = "install" | "signIn" | "welcome"

/**
 * The screen in front of the workbench: on the first launch always, and after
 * that only when `claude` is missing or signed out.
 *
 * **On the first launch it is a welcome, not a gate.** Every page is shown even
 * when its answer is already yes — `claude 2.1.3 is installed`, `Signed in as
 * …` — and moved past with Next, so somebody new reads what the app runs on
 * before the app itself, and ends on a page that says what it is for. On a
 * later launch the pages already answered are skipped and the screen closes on
 * its own once the answer is yes, as it always did: a returning user is not
 * shown a welcome twice.
 *
 * **Walk-past, not a lock** — but a quiet one. Both answers come through a
 * login shell's PATH, which can miss a `claude` that is there, and everything
 * but the chats works without one, so a way past stays on the screen as a line
 * of small text under the card. Skipping holds for the run: the next launch
 * asks again.
 */
export function ClaudeSetup({
  firstRun,
  step,
  versions,
  checking,
  onRecheck,
  onDone,
}: {
  /** The settings have no `onboarded` yet. */
  firstRun: boolean
  step: SetupStep
  versions: ClaudeVersions | undefined
  checking: boolean
  onRecheck: () => void
  /** Finished or skipped — either way the screen goes, for this run. */
  onDone: () => void
}) {
  const [signingIn, setSigningIn] = useState(false)
  const account = useClaudeProfiles((state) => state.accounts[""])
  const pages: Page[] = firstRun
    ? ["install", "signIn", "welcome"]
    : ["install", "signIn"]
  const [chosen, setPage] = useState<Page>("install")
  // A returning user is only here for what is missing, so a page already
  // answered is walked past without asking them to press anything.
  const page: Page =
    !firstRun && chosen === "install" && step === "signIn" ? "signIn" : chosen

  const installed = Boolean(versions?.cli)
  // `ready` rather than the default login alone: somebody with profiles may
  // never use the default one, and `setupStep` already says that is fine.
  const signedIn = step === "ready"

  useEffect(() => {
    if (!firstRun && step === "ready") onDone()
  }, [firstRun, step, onDone])

  const next = () => {
    const at = pages.indexOf(page)
    const following = pages[at + 1]
    if (following) setPage(following)
    else onDone()
  }

  return (
    // `z-50`, the dialogs' own layer, rather than the tour's `z-60`: the login
    // dialog opened from here portals in after this and has to land on top.
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background">
      {/* Light rather than a shape, as on the launch screen: two washes of the
          brand hue blurred far past their edges, so the screen this follows
          and this one read as the same room. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 animate-breathe rounded-full bg-primary/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-56 left-1/2 size-[28rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />

      <div className="relative flex w-[32rem] max-w-[calc(100vw-3rem)] flex-col items-center">
        <div className="flex animate-rise items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="bg-gradient-to-b from-foreground to-foreground/55 bg-clip-text font-heading text-sm font-medium tracking-tight text-transparent">
            Visual Studio Claude
          </span>
        </div>

        <Stepper pages={pages} page={page} />

        <div
          role="dialog"
          aria-modal
          aria-labelledby="claude-setup-title"
          className="mt-6 w-full animate-settle rounded-2xl border bg-popover/80 p-8 text-popover-foreground shadow-2xl ring-1 ring-primary/5 backdrop-blur-xl"
        >
          {/* Keyed, so each page rises in on its own rather than swapping text
              under a card that stays still. */}
          <div key={page} className="animate-rise">
            {page === "install" && (
              <Hero
                todo={Download}
                state={
                  versions === undefined ? "busy" : installed ? "done" : "todo"
                }
                chips={["$ claude", versions?.cli ? `v${versions.cli}` : "CLI"]}
              />
            )}
            {page === "signIn" && (
              <Hero
                todo={KeyRound}
                state={
                  signedIn ? "done" : step === "checking" ? "busy" : "todo"
                }
                chips={[
                  "claude.ai",
                  <span key="plan" className="capitalize">
                    {account?.plan ?? "Console"}
                  </span>,
                ]}
              />
            )}
            {page === "welcome" && <WelcomeHero />}
            {page === "install" &&
              (versions === undefined ? (
                <Checking label="Looking for Claude Code…" />
              ) : installed ? (
                <Done
                  title="Claude Code is installed"
                  detail={
                    <>
                      <code>claude</code> {versions.cli} — every chat here runs
                      on it, in the project&rsquo;s own folder.
                    </>
                  }
                />
              ) : (
                <InstallStep versions={versions} />
              ))}
            {page === "signIn" &&
              (signedIn ? (
                <Done
                  title="You are signed in"
                  detail={
                    accountCaption(account) ||
                    "Chats run under one of your Claude profiles."
                  }
                />
              ) : step === "checking" ? (
                <Checking label="Checking your sign-in…" />
              ) : (
                <SignInStep versions={versions} />
              ))}
            {page === "welcome" && <WelcomeStep />}
          </div>

          <div className="mt-8 flex items-center justify-end gap-2">
            {page === "install" && !installed && versions !== undefined && (
              <RecheckButton checking={checking} onClick={onRecheck} primary />
            )}
            {page === "signIn" && !signedIn && step !== "checking" && (
              <>
                <RecheckButton checking={checking} onClick={onRecheck} />
                <Button size="sm" onClick={() => setSigningIn(true)}>
                  Sign in
                  <ArrowRight />
                </Button>
              </>
            )}
            {((page === "install" && installed) ||
              (page === "signIn" && signedIn)) &&
              firstRun && (
                <Button size="sm" onClick={next}>
                  Next
                  <ArrowRight />
                </Button>
              )}
            {page === "welcome" && (
              <Button size="sm" onClick={onDone}>
                Get started
                <ArrowRight />
              </Button>
            )}
          </div>
        </div>

        {page !== "welcome" && (
          <button
            type="button"
            onClick={onDone}
            className="mt-5 animate-fade text-xs text-muted-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {page === "install"
              ? "Already installed? Continue without checking"
              : "Continue without signing in"}
          </button>
        )}
      </div>

      {signingIn && (
        // The dialog re-checks the default login when the CLI exits, and a
        // signed-in answer turns the page above into its `Done` state.
        <ClaudeLoginDialog
          configDir=""
          name="Default"
          onClose={() => setSigningIn(false)}
        />
      )}
    </div>
  )
}

const PAGE_LABEL: Record<Page, string> = {
  install: "Install",
  signIn: "Sign in",
  welcome: "Welcome",
}

function Stepper({ pages, page }: { pages: Page[]; page: Page }) {
  const current = pages.indexOf(page)
  return (
    <ol className="mt-8 flex animate-rise items-center gap-3 text-xs">
      {pages.map((each, index) => {
        const done = index < current
        const active = index === current
        return (
          <li key={each} className="flex items-center gap-3">
            {index > 0 && (
              <span
                aria-hidden
                className={cn(
                  "h-px w-10 transition-colors",
                  done || active ? "bg-primary/50" : "bg-border"
                )}
              />
            )}
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "grid size-5 place-items-center rounded-full border text-[0.65rem] font-medium tabular-nums transition-colors",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary text-primary",
                  !done && !active && "text-muted-foreground"
                )}
              >
                {done ? <Check className="size-3" /> : index + 1}
              </span>
              <span
                className={cn(
                  active ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {PAGE_LABEL[each]}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function RecheckButton({
  checking,
  onClick,
  primary = false,
}: {
  checking: boolean
  onClick: () => void
  primary?: boolean
}) {
  return (
    <Button
      size="sm"
      variant={primary ? "default" : "outline"}
      disabled={checking}
      onClick={onClick}
    >
      {checking && <Loader2 className="animate-spin" />}
      Check again
    </Button>
  )
}

function Checking({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  )
}

/** A page whose answer is already yes — the picture above carries the check. */
function Done({ title, detail }: { title: string; detail: ReactNode }) {
  return (
    <div className="text-center">
      <h2
        id="claude-setup-title"
        className="font-heading text-xl font-medium tracking-tight"
      >
        {title}
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed break-words text-muted-foreground">
        {detail}
      </p>
    </div>
  )
}

/**
 * The picture at the head of the install and sign-in pages: Claude's own mark
 * as an app icon, two cards fanned out behind it, a badge saying where the
 * page stands and two chips of text drifting either side.
 *
 * The same mark on both pages, and the badge alone telling them apart, so the
 * screen draws one subject rather than an icon per paragraph. The mark is the
 * one the composer's model picker already draws (`components/ui/svgs`); every
 * other glyph here is lucide, the app's one icon set. Built from the theme's
 * tokens rather than shipped as artwork, so it follows the palette and the
 * light or dark theme like everything else on screen does.
 */
function Hero({
  todo: Todo,
  state,
  chips,
}: {
  /** The badge while there is something still to do. */
  todo: LucideIcon
  state: "busy" | "todo" | "done"
  chips: [ReactNode, ReactNode]
}) {
  return (
    <div
      aria-hidden
      className="relative mx-auto mb-7 grid h-28 w-72 place-items-center"
    >
      <div className="absolute size-28 animate-breathe rounded-full bg-primary/20 blur-2xl" />
      <div className="absolute size-16 -translate-x-8 rotate-[-12deg] rounded-2xl border bg-muted/70 shadow-sm" />
      <div className="absolute size-16 translate-x-8 rotate-[12deg] rounded-2xl border bg-muted/70 shadow-sm" />

      <div className="relative grid size-20 animate-settle place-items-center rounded-[1.4rem] border bg-gradient-to-b from-card to-muted shadow-xl ring-1 ring-primary/10">
        <Claude className="size-10" />
        <span
          // Keyed on the state, so the badge pops again when it turns into
          // a check rather than swapping its glyph in place.
          key={state}
          className={cn(
            "absolute -right-2 -bottom-2 grid size-7 animate-pop place-items-center rounded-full ring-4 ring-popover [&_svg]:size-3.5",
            state === "done"
              ? "bg-primary text-primary-foreground"
              : "border bg-muted text-muted-foreground"
          )}
        >
          {state === "busy" ? (
            <Loader2 className="animate-spin" />
          ) : state === "done" ? (
            <Check strokeWidth={3} />
          ) : (
            <Todo />
          )}
        </span>
      </div>

      <Chip className="top-3 left-0">{chips[0]}</Chip>
      <Chip className="right-0 bottom-3 [animation-delay:-2.5s]">
        {chips[1]}
      </Chip>
    </div>
  )
}

function Chip({
  className,
  children,
}: {
  className: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        "absolute flex animate-float items-center gap-1 rounded-full border bg-card/90 px-2 py-0.5 font-mono text-[0.65rem] text-muted-foreground shadow-sm backdrop-blur [&_svg]:size-3 [&_svg]:text-primary",
        className
      )}
    >
      {children}
    </span>
  )
}

/** The welcome page's picture: the studio itself, in the splash's miniature. */
function WelcomeHero() {
  return (
    <div
      aria-hidden
      className="relative mx-auto mb-7 grid h-32 w-72 place-items-center"
    >
      <div className="scale-[0.85]">
        <StudioMark />
      </div>
      <Chip className="top-0 -left-2">
        <MessagesSquare />3 chats
      </Chip>
      <Chip className="-right-2 bottom-1 [animation-delay:-2.5s]">
        <GitCompare />
        +42 −7
      </Chip>
    </div>
  )
}

function InstallStep({ versions }: { versions: ClaudeVersions | undefined }) {
  const platform = window.desktop.platform
  return (
    <>
      <h2
        id="claude-setup-title"
        className="text-center font-heading text-xl font-medium tracking-tight"
      >
        Install Claude Code
      </h2>
      <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
        Chats run on the Claude Code CLI, which this machine does not have yet.
        Run this in {installShell(platform)}, then press Check again.
      </p>
      <CommandLine command={installCommand(platform)} />
      <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
        Installed elsewhere? Set <code>CLAUDE_BIN</code> to its path and
        restart. More options in the{" "}
        <a
          href={SETUP_DOCS}
          target="_blank"
          rel="noreferrer"
          className="text-foreground/80 underline underline-offset-2 hover:text-foreground"
        >
          setup guide
        </a>
        .
      </p>
      {/* "Could not find" is the paragraph above said again; only a `claude`
          that was found and then failed has something to add. */}
      {versions?.error && !versions.error.startsWith("Could not find") && (
        <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 font-mono text-[0.7rem] break-words text-destructive">
          {versions.error}
        </p>
      )}
    </>
  )
}

function SignInStep({ versions }: { versions: ClaudeVersions | undefined }) {
  return (
    <>
      <h2
        id="claude-setup-title"
        className="text-center font-heading text-xl font-medium tracking-tight"
      >
        Sign in to Claude
      </h2>
      <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
        <code>claude</code>
        {versions?.cli ? ` ${versions.cli}` : ""} is installed. Sign in once,
        with a Claude subscription or a Console account, and every chat runs as
        that account.
      </p>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        More accounts can be added later in Settings › Claude.
      </p>
    </>
  )
}

/** What the studio is for, in three lines — the tour after it says where. */
const WELCOME_POINTS = [
  {
    icon: MessagesSquare,
    title: "Several chats at once",
    detail: "Run claude in any number of conversations against a project.",
  },
  {
    icon: GitCompare,
    title: "Read what they did",
    detail: "Every change lands in Git, diffed beside the chat that made it.",
  },
  {
    icon: FolderOpen,
    title: "Your folders, where they are",
    detail: "Add a directory already on this machine; nothing is copied.",
  },
]

function WelcomeStep() {
  return (
    <>
      <h2
        id="claude-setup-title"
        className="bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-center font-heading text-2xl font-medium tracking-tight text-transparent"
      >
        Welcome to Visual Studio Claude
      </h2>
      <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
        You are all set. A short tour of the window comes next.
      </p>
      <ul className="mx-auto mt-6 flex max-w-sm flex-col gap-4">
        {WELCOME_POINTS.map(({ icon: Icon, title, detail }, index) => (
          <li
            key={title}
            style={{ animationDelay: `${120 + index * 70}ms` }}
            className="flex animate-rise items-start gap-3"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-gradient-to-b from-card to-muted text-primary shadow-sm ring-1 ring-primary/10">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{title}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {detail}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

/** The install line as a terminal would show it, prompt and all. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="mt-5 overflow-hidden rounded-xl border bg-muted/60 shadow-inner">
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        {["bg-red-400/70", "bg-amber-400/70", "bg-green-400/70"].map((dot) => (
          <span
            key={dot}
            aria-hidden
            className={cn("size-2 rounded-full", dot)}
          />
        ))}
      </div>
      <div className="flex items-center gap-3 py-2.5 pr-2 pl-4">
        <code className="min-w-0 flex-1 truncate font-mono text-[0.8rem] select-all">
          <span aria-hidden className="mr-2 text-primary select-none">
            $
          </span>
          {command}
        </code>
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0"
          aria-label="Copy the command"
          onClick={() => {
            void navigator.clipboard.writeText(command)
            setCopied(true)
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  )
}
