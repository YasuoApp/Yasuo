import { useEffect, useState } from "react"
import {
  ChevronDown,
  ExternalLink,
  Plug,
  RefreshCw,
  Trash2,
} from "lucide-react"

import type { McpListing, McpServerInfo } from "@shared/api"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  isRemovable,
  isServerOff,
  isToolOff,
  orderedServers,
  serverCaption,
  serverPromptTokens,
  signIn,
  stateLabel,
  withServerOff,
  withToolOff,
} from "@/lib/worktree-chat/mcp-servers"
import { compact } from "@/lib/worktree-chat/usage"
import { IconButton } from "../icon-button"
import { serverMark } from "./chat-marks"
import { ToolbarButton } from "./chat-composer"

/**
 * The MCP servers the user's own `claude` has in this chat's project — what
 * `/mcp` in the CLI lists — and which of their tools **this chat** may call.
 *
 * It was Settings › MCP, with one list of switched-off tools for the whole
 * workspace. It is in the composer's toolbar now because the switches are the
 * chat's (`WorktreeChatOptions.disabledTools`): the chat reading a Figma file
 * wants Figma, the one refactoring a module wants its forty tools out of the
 * prompt. The listing and **Remove** came with them rather than being left as a
 * Settings section of their own, so there is one place MCP is looked at.
 *
 * **The list is the CLI's; what a chat may call is this app's.** Which servers
 * exist belongs to the user's own `claude` — `~/.claude.json`, the repository's
 * `.mcp.json`, plugins, claude.ai connectors — so installing one is still
 * `claude mcp add` and signing a connector in is still claude.ai. Three things
 * here do more than list, and the line between them is the one worth keeping
 * straight:
 *
 * - **The switches** are this chat's own refusal, handed to its turns as
 *   `disallowedTools`. Nothing about the user's config changes, and their
 *   terminal still has every tool.
 * - **Remove** is the opposite: `claude mcp remove` against their config, so it
 *   goes from every chat and the terminal too. It confirms first and cannot be
 *   undone, and it is only offered for the scopes the CLI can remove from
 *   (`isRemovable`).
 * - **Authorize on claude.ai** is a link, for the one state where the fix is a
 *   page rather than a setting — see `signIn`.
 *
 * **Asked when opened, not when drawn.** The listing is a `claude` process and
 * several seconds (`main/mcp-servers.ts`), and a composer is mounted for every
 * chat somebody switches to — asking on mount would start one per click. Not
 * cached either, for the reason on `installedMcpServers`: somebody looking at
 * this list has often just installed something. What was last answered stays
 * on screen while the next ask runs.
 */
export function McpMenu({
  folderId,
  disabled,
  onPick,
}: {
  /** The chat's project, whose directory the CLI is asked in — an MCP config
   * is per directory, so a repository's own `.mcp.json` is in the answer. */
  folderId: string | null
  disabled: string[]
  onPick: (disabled: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<McpListing | null>(null)
  const [loading, setLoading] = useState(false)
  /**
   * Bumped by opening the popover and by **Refresh**, which is the whole of
   * what either does to the listing.
   *
   * The ask lives in the effect and nowhere else, so there is one path to it —
   * and nothing calls `setState` in the effect's own body, which is a
   * cascading render the lint is right to refuse. `setLoading(true)` belongs to
   * the click for the same reason.
   */
  const [asks, setAsks] = useState(0)
  /** The server the confirmation is about, and what the CLI said if it
   * refused. Removal is not undoable, so nothing happens without the dialog. */
  const [pendingRemove, setPendingRemove] = useState<McpServerInfo | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const ask = () => {
    setLoading(true)
    setAsks((count) => count + 1)
  }

  useEffect(() => {
    if (asks === 0) return
    let live = true
    void window.desktop
      .installedMcpServers(folderId)
      .then((next) => {
        if (!live) return
        setListing(next)
        setLoading(false)
      })
      .catch(() => {
        // The call itself answers with an `error` field rather than rejecting,
        // so this is the bridge failing — nothing to say about a server.
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [folderId, asks])

  const servers = orderedServers(listing?.servers ?? [])

  // The button says how many entries are off rather than how many tools: it
  // is drawn before anything has been asked, and an entry is what the chat's
  // record holds — a server's prefix counts once, as the one switch it is.
  const offEntries = disabled.length

  const remove = (server: McpServerInfo) => {
    setRemoveError(null)
    void window.desktop
      .removeMcpServer({ name: server.name, scope: server.scope, folderId })
      .then(() => {
        setPendingRemove(null)
        // Re-asked rather than spliced out of the list held here: a server can
        // be configured in two scopes, and what is left after a removal is the
        // CLI's answer rather than this app's arithmetic.
        ask()
      })
      .catch((error: unknown) => {
        setRemoveError(error instanceof Error ? error.message : String(error))
      })
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) ask()
        }}
      >
        <PopoverTrigger
          render={
            <ToolbarButton
              icon={<Plug />}
              label={offEntries > 0 ? `MCP · ${offEntries} off` : "MCP"}
              title="MCP servers, and which of their tools this chat may call"
              on={offEntries > 0}
            />
          }
        />
        <PopoverContent
          align="start"
          className="max-h-[min(70vh,36rem)] w-[26rem] gap-0 overflow-y-auto p-0"
        >
          <div className="flex items-center gap-2 border-b py-1.5 pr-1.5 pl-3">
            <p className="flex-1 text-xs font-medium">MCP servers</p>
            <IconButton
              label="Refresh"
              side="bottom"
              disabled={loading}
              onClick={ask}
              className="size-6 shrink-0"
            >
              <RefreshCw
                className={cn("size-3.5", loading && "animate-spin")}
              />
            </IconButton>
          </div>

          {loading && !listing ? (
            <p className="p-3 text-xs text-muted-foreground">
              Asking <code className="font-mono">claude</code> what it
              has&hellip;
            </p>
          ) : listing?.error ? (
            <p className="p-3 text-xs text-destructive">{listing.error}</p>
          ) : servers.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No MCP servers here. Add one with{" "}
              <code className="font-mono">claude mcp add</code>, or connect one
              to your account on claude.ai.
            </p>
          ) : (
            <div className="divide-y">
              {servers.map((server) => (
                <ServerRow
                  key={`${server.scope}/${server.name}`}
                  server={server}
                  disabled={disabled}
                  onPick={onPick}
                  onRemove={() => {
                    setRemoveError(null)
                    setPendingRemove(server)
                  }}
                />
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemove(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove &ldquo;{pendingRemove?.name}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This runs <code className="font-mono">claude mcp remove</code>{" "}
              against your own <code className="font-mono">claude</code>
              {pendingRemove?.scope
                ? ` ${pendingRemove.scope} configuration`
                : " configuration"}
              , so it goes from every chat here <em>and</em> from your terminal.
              There is no undo — adding it back means{" "}
              <code className="font-mono">claude mcp add</code>. To keep it
              installed but out of this chat, use the switch instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && (
            <p className="text-xs leading-relaxed text-destructive">
              {removeError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                // Held open on purpose: the CLI can refuse, and its message has
                // to land somewhere the user is still looking.
                event.preventDefault()
                if (pendingRemove) remove(pendingRemove)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * One server: what it is, whether it works, and what it offers.
 *
 * The tools are behind a disclosure rather than listed outright — a connector
 * carries forty of them, and a list that has to be scrolled past to reach the
 * next server is a list nobody reads. Shut by default for the same reason, and
 * counted on the summary so the count is readable without opening anything.
 */
function ServerRow({
  server,
  disabled,
  onPick,
  onRemove,
}: {
  server: McpServerInfo
  disabled: string[]
  onPick: (disabled: string[]) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const { label, tone } = stateLabel(server.state)
  const caption = serverCaption(server)
  const auth = signIn(server)
  const off = isServerOff(disabled, server.name)
  const offTools = offCount(disabled, server)

  return (
    <div className="space-y-1.5 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {serverMark(server.name, "size-4")}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex items-center gap-2 text-xs leading-none font-medium">
            <span className="truncate">{server.name}</span>
            <StateBadge label={label} tone={tone} />
          </p>
          {caption && (
            <p className="text-[0.65rem] text-muted-foreground">{caption}</p>
          )}
          {server.address && (
            <p
              title={server.address}
              className="truncate font-mono text-[0.65rem] text-muted-foreground"
            >
              {server.address}
            </p>
          )}
          {server.error && (
            <p className="text-[0.7rem] leading-relaxed text-destructive">
              {server.error}
            </p>
          )}
          {/*
            A plain anchor, which is all it takes: `main.ts` catches the
            navigation in `will-navigate` and hands an `https:` URL to the
            user's browser — a link opened in this window would leave the studio
            with no chrome and no way back. The CLI case is a sentence rather
            than a link on purpose; see `signIn`.
          */}
          {auth?.kind === "connector" && (
            <a
              href={auth.url}
              className="inline-flex items-center gap-1 text-[0.7rem] font-medium text-primary underline-offset-2 hover:underline"
            >
              Authorize on claude.ai
              <ExternalLink className="size-3" />
            </a>
          )}
          {auth?.kind === "cli" && (
            <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
              Sign in with <code className="font-mono">/mcp</code> in a{" "}
              <code className="font-mono">claude</code> session — the
              dock&rsquo;s Terminal will do — then Refresh.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isRemovable(server) && (
            <IconButton
              label={`Remove ${server.name}`}
              className="size-6 hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          )}
          {/*
            The server's own switch, which writes one entry standing for every
            tool on it — including one added to it later. Off is this chat's
            refusal, not a change to the user's config: the server stays
            installed and their terminal still has it, which is the whole
            difference between this and the button beside it.
          */}
          <Switch
            checked={!off}
            aria-label={`Allow ${server.name} in this chat`}
            onCheckedChange={(next) =>
              onPick(withServerOff(disabled, server.name, !next))
            }
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pl-6">
        {server.tools.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-[0.7rem] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                open && "rotate-180"
              )}
            />
          </button>
        )}
        {/* What the server costs a turn when it is on — the number that decides
            whether the switch above is worth flipping. A floor (see
            `serverPromptTokens`), and struck through while the server is off,
            since an off server costs nothing. */}
        {serverPromptTokens(server) > 0 && (
          <span
            title="Estimated from tool names and descriptions at ~4 characters per token. Parameter schemas are not in the listing, so the real figure is higher."
            className={cn(
              "text-[0.7rem] text-muted-foreground",
              off && "line-through opacity-60"
            )}
          >
            ≥ ~{compact(serverPromptTokens(server))} tokens/turn
          </span>
        )}
        {offTools > 0 && (
          <span className="text-[0.7rem] text-muted-foreground">
            {off ? "all off" : `${offTools} of ${server.tools.length} off`}
          </span>
        )}
      </div>

      {open && (
        <ul className="space-y-1 border-t pt-1.5 pl-6">
          {server.tools.map((tool) => (
            <li key={tool.name} className="flex items-start gap-2 py-0.5">
              <div
                title={tool.description ?? undefined}
                className="min-w-0 flex-1 truncate text-[0.7rem]"
              >
                <span className="font-mono">{tool.name}</span>
                {tool.description && (
                  // One line: a tool's own description is a paragraph in some
                  // servers, and this list is being scanned rather than read.
                  <span className="ml-2 text-muted-foreground">
                    {tool.description.split("\n")[0]}
                  </span>
                )}
              </div>
              {/*
                Disabled while the whole server is off, and drawn off with it:
                turning one tool back on from there would mean expanding the
                server's single entry into every other tool it stood for and
                guessing which ones were meant to stay — see `withToolOff`.
              */}
              <Switch
                checked={!isToolOff(disabled, server.name, tool.name)}
                disabled={off}
                aria-label={`Allow ${tool.name} in this chat`}
                onCheckedChange={(next) =>
                  onPick(withToolOff(disabled, server.name, tool.name, !next))
                }
                className="mt-0.5 shrink-0 scale-90"
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** How many of a server's tools are switched off, for the line by the fold. */
function offCount(disabled: string[], server: McpServerInfo): number {
  if (isServerOff(disabled, server.name)) return server.tools.length
  return server.tools.filter((tool) =>
    isToolOff(disabled, server.name, tool.name)
  ).length
}

/** A state in two words, coloured only where the colour means something.
 * Settings' Claude section draws an account's sign-in with the same badge. */
export function StateBadge({
  label,
  tone,
}: {
  label: string
  tone: "good" | "bad" | "waiting" | "off"
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-px text-[0.65rem] font-normal",
        tone === "good" && "border-emerald-500/30 text-emerald-600",
        tone === "bad" && "border-destructive/30 text-destructive",
        tone === "waiting" && "border-amber-500/30 text-amber-600",
        tone === "off" && "text-muted-foreground"
      )}
    >
      {label}
    </span>
  )
}
