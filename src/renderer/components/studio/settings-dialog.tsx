import { useEffect, useState, type ReactNode } from "react"
import { useTheme } from "next-themes"
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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  ArrowUpCircle,
  Bell,
  ChevronDown,
  Columns2,
  ExternalLink,
  KeyRound,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react"

import type { McpListing, McpServerInfo } from "@shared/api"
import { useProjects } from "@/lib/projects"
import { useSettings } from "@/lib/settings"
import { useStudio } from "@/lib/store"
import { installLabel, pendingUpdate, useUpdates } from "@/lib/updates"
import {
  accountCaption,
  accountLabel,
  nextProfileName,
  useClaudeProfiles,
} from "@/lib/worktree-chat/claude-profiles"
import {
  isRemovable,
  isServerOff,
  isToolOff,
  orderedServers,
  promptTokensLeftOn,
  serverCaption,
  serverPromptTokens,
  signIn,
  stateLabel,
  withServerOff,
  withToolOff,
} from "@/lib/worktree-chat/mcp-servers"
import { useAgentModels } from "@/lib/worktree-chat/models"
import { compact } from "@/lib/worktree-chat/usage"
import { ClaudeLoginDialog } from "./claude-login-dialog"
import { IconButton } from "./icon-button"
import { UpdateProgressBar } from "./update-progress"
import { serverMark } from "./worktree/chat-marks"
import { ModelMenu, ProfileMenu } from "./worktree/chat-composer"

/**
 * The studio's preferences — **Settings…** in the application menu, ⌘,.
 *
 * A dialog rather than a panel with a tab of its own: what is here is about
 * the workbench itself rather than about anything in the workspace, and a
 * preference read once and closed does not want a place in the strip beside
 * the files it is being read about. It is also the only honest home for a
 * setting whose effect *is* the strip — a tab is a poor place to be holding
 * the switch that moves the tabs.
 *
 * Laid out the way every settings window of this shape is: sections down the
 * left, one section's rows on the right, each row a name and a sentence with
 * its control at the far end. That is not decoration — it is what keeps the
 * dialog the same size as it grows. A single scrolling column is fine for the
 * three settings there are today and stops being fine at ten, and a list of
 * sections is also the only thing that says what *kinds* of preference exist
 * without reading all of them.
 *
 * There is no Save: a preference applies as it is picked, which is what makes
 * the studio behind the dialog its own preview. Everything written here goes
 * through `lib/settings.ts` and lands in the workspace's own settings, so it
 * survives a relaunch the way the strip's arrangement does.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("appearance")

  const current = SECTIONS.find((candidate) => candidate.id === section)!

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="grid h-[34rem] max-h-[85vh] w-full grid-cols-[12rem_1fr] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <nav
          aria-label="Settings sections"
          className="flex min-h-0 flex-col gap-0.5 overflow-y-auto border-r bg-muted/30 p-2"
        >
          <p className="px-2 pt-1 pb-2 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
            Options
          </p>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              // `aria-current` rather than `role="tab"`: these are pages of a
              // dialog, not tabs of a panel, and the panel beside them is not
              // a tabpanel anyone should be able to arrow through.
              aria-current={id === section ? "page" : undefined}
              onClick={() => setSection(id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                id === section
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-col">
          {/* `pr-12` clears the close button, which the dialog draws in the
              corner over whatever is there. */}
          <header className="shrink-0 border-b px-5 py-4 pr-12">
            <DialogTitle>{current.label}</DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              {current.blurb}
            </DialogDescription>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {section === "appearance" ? (
              <AppearanceSection />
            ) : section === "tabs" ? (
              <TabsSection />
            ) : section === "chats" ? (
              <ChatsSection />
            ) : section === "claude" ? (
              <ClaudeSection />
            ) : section === "updates" ? (
              <UpdatesSection />
            ) : (
              <McpSection />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type SectionId = "appearance" | "tabs" | "chats" | "claude" | "mcp" | "updates"

/** The sections, in the order they are listed. Each one is a heading, a line
 * saying what it covers, and the rows below — kept together so adding a
 * section is one entry rather than three edits. */
const SECTIONS: {
  id: SectionId
  label: string
  blurb: string
  icon: LucideIcon
}[] = [
  {
    id: "appearance",
    label: "Appearance",
    blurb: "How the studio looks.",
    icon: Palette,
  },
  {
    id: "tabs",
    label: "Tabs",
    blurb: "Where the workbench's tab strip sits, and how much it gathers.",
    icon: Columns2,
  },
  {
    id: "chats",
    label: "Chats",
    blurb: "What a chat does while you are looking at something else.",
    icon: Bell,
  },
  {
    id: "claude",
    label: "Claude",
    blurb: "Separate `claude` identities a chat's turns can run under.",
    icon: KeyRound,
  },
  {
    id: "updates",
    label: "Updates",
    blurb: "Which Yasuo this is, and whether there is a newer one.",
    icon: ArrowUpCircle,
  },
  {
    id: "mcp",
    label: "MCP",
    blurb:
      "The MCP servers your own `claude` has in this project, and which of their tools a chat here may call.",
    icon: Plug,
  },
]

function AppearanceSection() {
  // `theme` is the choice, `resolvedTheme` what it came out as — the choice is
  // what a settings row is asking about, so `system` stays visible as `system`
  // rather than as whichever of the two it happens to be right now.
  const { theme, setTheme } = useTheme()

  return (
    <Card>
      <Row
        title="Theme"
        description="Follow the system, or pin the studio to one of the two."
      >
        <Segmented
          value={theme ?? "system"}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onPick={setTheme}
        />
      </Row>
    </Card>
  )
}

function TabsSection() {
  const groupTabs = useSettings((state) => state.groupTabs)
  const setGroupTabs = useSettings((state) => state.setGroupTabs)

  return (
    <Card>
      {/*
        Off by default: the strip somebody already has is the one they chose,
        and a preference that rearranges every open tab the first time the app
        launches is not a default, it is a surprise.

        The sessions are not mentioned because they are not affected — they have
        always been gathered this way, for a reason that is theirs alone: a tab
        there stands for a process rather than for something the user opened.
      */}
      <Row
        title="Group tabs by folder"
        description="One tab per folder in the strip, with that folder's own files, requests or notes in a second strip inside it. Off, every file and request is a tab of its own."
      >
        <Switch checked={groupTabs} onCheckedChange={setGroupTabs} />
      </Row>
    </Card>
  )
}

/**
 * What a chat does when nobody is watching it.
 *
 * Its own section rather than a row under `Appearance`, because this is not
 * about how the studio looks: several chats answering at once is the thing this
 * app is for, and what makes that workable is being called back to one. The
 * section is where the rest of that belongs as it arrives.
 */
function ChatsSection() {
  const on = useSettings((state) => state.chatNotifications)
  const setOn = useSettings((state) => state.setChatNotifications)
  const tray = useSettings((state) => state.chatTray)
  const setTray = useSettings((state) => state.setChatTray)

  return (
    <Card>
      {/*
        On by default, which is the other way round from every other switch in
        this dialog and is argued for on `CHAT_NOTIFICATIONS_KEY`: a user who
        has to find this row first has already missed the turn they walked away
        from.
      */}
      <Row
        title="Notify me when a chat finishes"
        description="A notification when a chat goes quiet, fails, or stops to ask you something — only while this window is not focused, and clicking it opens that chat. Off, the only sign is the row in the sidebar."
      >
        <Switch checked={on} onCheckedChange={setOn} />
      </Row>
      {/*
        The standing version of the row above, and on by default for the same
        reason. It is a switch at all because this icon is in a strip shared
        with every other app on the machine — that is the one place in this app
        where "I do not want to see this" is a reasonable thing to want, and
        where there is no way to say it from the icon itself.
      */}
      <Row
        title="Count the chats in the menu bar"
        description="An icon outside the window carrying how many chats are answering and how many are waiting on you, with a menu naming them. Off, the sidebar row is the only count."
      >
        <Switch checked={tray} onCheckedChange={setTray} />
      </Row>
    </Card>
  )
}

/**
 * Which build this is, and the button that replaces it.
 *
 * The same store the status bar's pill reads, and the same install — this page
 * exists because a pill that only appears when there is news cannot answer
 * "am I up to date?", and because somebody who skipped a version needs
 * somewhere to change their mind. So the dismissal is deliberately ignored
 * here: a section headed Updates is not a place to hide one.
 *
 * There is no "check automatically" switch. The check is one request every six
 * hours against a public endpoint, carrying nothing about the user — a
 * preference for that is a decision nobody has enough information to make, and
 * every setting costs a line somebody has to read.
 */
function UpdatesSection() {
  const check = useUpdates((state) => state.check)
  const checking = useUpdates((state) => state.checking)
  const installing = useUpdates((state) => state.installing)
  const progress = useUpdates((state) => state.progress)
  const error = useUpdates((state) => state.error)
  const refresh = useUpdates((state) => state.refresh)
  const install = useUpdates((state) => state.install)
  // Dismissal is the pill's business, not this page's.
  const update = useUpdates((state) => pendingUpdate(state, false))

  return (
    <Card>
      <Row
        title="Version"
        description={
          !check
            ? "Asking GitHub what is out."
            : check.status === "current"
              ? `Yasuo ${check.current} — the latest release.`
              : `Yasuo ${check.current}.`
        }
      >
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={() => void refresh()}
        >
          <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
          Check now
        </Button>
      </Row>

      {update ? (
        <Row
          title={`Yasuo ${update.version} is available`}
          description={
            installing ? (
              // The bar takes the description's place rather than sitting under
              // the button: it is what this row is about while it is on screen,
              // and the sentence it replaces is one the user has just acted on.
              <span className="mt-1.5 block max-w-xs">
                <UpdateProgressBar progress={progress} />
              </span>
            ) : update.installable ? (
              "Installs into /Applications and reopens the app. Terminal sessions and anything running in the dock end with it."
            ) : (
              "Installing from inside the app is macOS only — the release page has the build for this machine."
            )
          }
        >
          <div className="flex items-center gap-2">
            <a
              href={update.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              What&rsquo;s new
              <ExternalLink className="size-3" />
            </a>
            {update.installable && (
              <Button
                size="sm"
                disabled={installing}
                onClick={() => void install()}
              >
                {installLabel(installing, progress)}
              </Button>
            )}
          </div>
        </Row>
      ) : (
        check?.status === "unknown" && (
          // Said out loud rather than left as silence: "no update" and "could
          // not ask" look identical otherwise, and only one of them means the
          // version on screen is worth trusting.
          <Row title="Could not check" description={check.error}>
            <a
              href="https://github.com/YasuoApp/Yasuo/releases"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Releases
              <ExternalLink className="size-3" />
            </a>
          </Row>
        )
      )}

      {error && (
        <p className="px-4 pb-3 text-xs leading-relaxed text-destructive">
          {error} The installer&rsquo;s own output is in{" "}
          <code className="font-mono">~/.yasuo/update.log</code>.
        </p>
      )}
    </Card>
  )
}

/**
 * Named `CLAUDE_CONFIG_DIR`s — separate logins, settings and history for the
 * user's own `claude`, the way pointing that variable at a directory of its
 * own already lets somebody run several identities from one install.
 *
 * Picked per chat, in its own toolbar (`ChatComposer`'s `ProfileMenu`), the way
 * the model and the effort are — this section only holds the list, the same
 * split `EnvironmentDialog` has from the environment picker in the API panel's
 * own toolbar.
 *
 * **Each row says whether that directory is actually signed in, and as whom.**
 * A path is a weak thing to name an identity with — a profile called "Work"
 * pointing at a directory nobody ever logged into looks exactly like one that
 * works, right up until a turn fails — so the account is asked of `claude`
 * itself (`claudeAccount`). Checked on open and on demand rather than watched:
 * nothing here can see a `claude login` run in somebody's own terminal.
 *
 * **Adding one is a name, a click and a login.** There is no path here at all
 * any more: the directory is main's to name (`main/claude-profiles.ts`) and the
 * login is the app's to run (`ClaudeLoginDialog`), because the path was the one
 * thing being asked of the user that they had no way to know the answer to — a
 * row could only be filled in by reading the paragraph at the bottom of this
 * section, and then only in a terminal. `docs/design.md` § Settings has what
 * deleting the field cost.
 */
function ClaudeSection() {
  const profiles = useClaudeProfiles((state) => state.profiles)
  const refresh = useClaudeProfiles((state) => state.refresh)
  const check = useClaudeProfiles((state) => state.check)
  const create = useClaudeProfiles((state) => state.create)
  const rename = useClaudeProfiles((state) => state.rename)
  const remove = useClaudeProfiles((state) => state.remove)

  // The list is loaded once at launch (`studio.tsx`) for the composer's own
  // picker; asked again here so a profile added, renamed or removed in another
  // window of this run is not stale by the time somebody opens Settings.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // The default login, checked on open on its own: it is the account every
  // chat with no profile picked runs under, and the one the rest are being
  // told apart from. The profiles' own directories are not checked here — that
  // would be a `claude` per row on every open of Settings, and most of the
  // time somebody is here for one of them.
  useEffect(() => {
    void check("")
  }, [check])

  const models = useAgentModels()
  const reviewModel = useSettings((state) => state.reviewModel)
  const reviewEffort = useSettings((state) => state.reviewEffort)
  const reviewProfileId = useSettings((state) => state.reviewProfileId)
  const setReviewModel = useSettings((state) => state.setReviewModel)
  const setReviewProfileId = useSettings((state) => state.setReviewProfileId)

  return (
    <div className="space-y-4">
      <Card>
        {/* The turns in the app with no toolbar of their own — a drafted commit
            message and a distilled chat both run on whatever is picked here
            rather than on something asked per turn, since neither is a
            conversation somebody sits in front of. See
            `main/one-turn-agent.ts`; the `review*` field names are what is
            already on disk. */}
        <Row
          title="Helper turns"
          description="Which model, effort and account the drafted commit message and Distill learnings run on."
        >
          <div className="flex items-center gap-1.5">
            <ModelMenu
              models={models}
              model={reviewModel}
              effort={reviewEffort}
              onPick={setReviewModel}
            />
            {profiles.length > 0 && (
              <ProfileMenu
                profiles={profiles}
                profileId={reviewProfileId}
                onPick={setReviewProfileId}
              />
            )}
          </div>
        </Row>
      </Card>

      <Card>
        <AccountRow configDir="" name="Default" />
      </Card>

      <Card>
        {profiles.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            No profiles yet. A chat with none picked runs under the default
            account above.
          </p>
        ) : (
          profiles.map((profile) => (
            <div key={profile.id} className="space-y-2 p-4">
              <div className="flex items-center gap-2">
                <Input
                  value={profile.name}
                  onChange={(event) => rename(profile.id, event.target.value)}
                  placeholder="Name"
                  aria-label="Profile name"
                  className="h-7 w-48 shrink-0 text-xs md:text-xs"
                />
                <IconButton
                  label="Remove profile"
                  className="ml-auto hover:text-destructive"
                  onClick={() => remove(profile.id)}
                >
                  <Trash2 />
                </IconButton>
              </div>
              {/* A profile has a directory as soon as main has answered the
                  save that created it — one round trip, and this is the frame
                  in between. It is not skipped for tidiness: an empty
                  `CLAUDE_CONFIG_DIR` is what `claudeAccount` answers for the
                  *default* login, so a row drawn before the answer arrives
                  would show somebody else's account as its own. */}
              {profile.configDir.trim() ? (
                <AccountStatus
                  configDir={profile.configDir}
                  name={profile.name || "Profile"}
                />
              ) : (
                <p className="text-[0.7rem] text-muted-foreground">
                  Setting up its directory…
                </p>
              )}
            </div>
          ))
        )}
      </Card>

      <Button
        size="xs"
        variant="outline"
        onClick={() => create(nextProfileName(profiles.length))}
      >
        <Plus data-icon="inline-start" />
        Profile
      </Button>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Sets <code className="font-mono">CLAUDE_CONFIG_DIR</code> for the turn —
        the same variable a terminal would export to point{" "}
        <code className="font-mono">claude</code> at a login, its settings and
        its conversation history kept apart from the default{" "}
        <code className="font-mono">~/.claude</code>. Each profile gets a
        directory of its own under{" "}
        <code className="font-mono">~/.yasuo/workspace/claude-profiles</code>,
        which <strong>Log in</strong> creates and signs in.
      </p>
    </div>
  )
}

/** The default login as a row of its own: a name this app chose, and the same
 * status line every profile gets. Its directory is `~/.claude` and there is
 * nothing to edit about it, so there are no inputs. */
function AccountRow({ configDir, name }: { configDir: string; name: string }) {
  return (
    <div className="space-y-2 p-4">
      <p className="flex items-center gap-2 text-sm leading-none font-medium">
        <span className="truncate">{name}</span>
        <span className="truncate font-mono text-[0.7rem] font-normal text-muted-foreground">
          ~/.claude
        </span>
      </p>
      <AccountStatus configDir={configDir} name={name} />
    </div>
  )
}

/**
 * Whether a directory is signed in, the button that asks, and the button that
 * signs it in.
 *
 * **Asked, never assumed**: nothing is drawn as good until `claude` has said
 * so, which is why the unchecked state is its own quiet badge rather than an
 * optimistic one. Neither button runs on a render, and a row is not checked
 * because it was drawn — a section of four profiles opened to rename one is
 * otherwise four `claude` processes.
 *
 * **Log in** is offered on every row, the signed-in ones included: switching
 * which account a directory holds is the same act as filling an empty one, and
 * a button that vanished once it had worked would be missing exactly when
 * somebody's session expired.
 */
function AccountStatus({
  configDir,
  name,
}: {
  configDir: string
  /** What the login dialog calls this account. */
  name: string
}) {
  const key = configDir.trim()
  const account = useClaudeProfiles((state) => state.accounts[key])
  const busy = useClaudeProfiles((state) => state.checking.includes(key))
  const check = useClaudeProfiles((state) => state.check)
  const [loggingIn, setLoggingIn] = useState(false)

  const { label, tone } = accountLabel(account)
  const caption = accountCaption(account)

  return (
    <div className="flex items-center gap-2">
      {loggingIn && (
        <ClaudeLoginDialog
          configDir={key}
          name={name}
          onClose={() => setLoggingIn(false)}
        />
      )}
      <StateBadge
        label={busy ? "Checking" : label}
        tone={busy ? "waiting" : tone}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[0.7rem]",
          account?.error ? "text-destructive" : "text-muted-foreground"
        )}
        title={account?.error ?? caption}
      >
        {account?.error ?? caption}
      </span>
      <Button size="xs" variant="ghost" onClick={() => setLoggingIn(true)}>
        <KeyRound data-icon="inline-start" />
        Log in
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => void check(key)}
      >
        <RefreshCw
          data-icon="inline-start"
          className={cn(busy && "animate-spin")}
        />
        Check
      </Button>
    </div>
  )
}

/**
 * The MCP servers the user's own `claude` has — what `/mcp` in the CLI lists.
 *
 * **The list is the CLI's; what a chat may call is this app's.** This app used
 * to serve its own panels here as three `yasuo-*` servers with a switch each,
 * and that whole feature is gone (see `docs/design.md`). What is left is the
 * question the section was always really asked: *what can a chat in this project
 * actually reach?* Which servers exist belongs to the user's own `claude` —
 * `~/.claude.json`, the repository's `.mcp.json`, plugins, claude.ai
 * connectors — so installing one is still `claude mcp add` and signing a
 * connector in is still claude.ai. Three things here do more than list, and the
 * line between them is the one worth keeping straight:
 *
 * - **The switches** are this app's own refusal, kept in this app's settings and
 *   handed to a turn as `disallowedTools`. Nothing about the user's config
 *   changes, and their terminal still has every tool.
 * - **Remove** is the opposite: `claude mcp remove` against their config, so it
 *   goes from the terminal too. It confirms first and cannot be undone, and it
 *   is only offered for the scopes the CLI can remove from (`isRemovable`).
 * - **Authorize on claude.ai** is a link, for the one state where the fix is a
 *   page rather than a setting — see `signIn`.
 *
 * **Per project**, because an MCP config is per directory: the listing is asked
 * in the active project's own directory, so a repository's `.mcp.json` is in it.
 * With no project open it is the user's home directory — the user-scope servers
 * and nothing repository-specific.
 */
function McpSection() {
  const activeFolderId = useProjects((state) => state.activeFolderId)
  const folders = useStudio((state) => state.folders)
  const project = folders.find((folder) => folder.id === activeFolderId)

  const [listing, setListing] = useState<McpListing | null>(null)
  const [loading, setLoading] = useState(true)
  /**
   * Bumped by **Refresh**, which is the whole of what that button does.
   *
   * The ask lives in the effect and nowhere else, so there is one path to it
   * whether it was the dialog opening or somebody asking again — and nothing
   * calls `setState` in the effect's own body, which is a cascading render the
   * lint is right to refuse. `setLoading(true)` belongs to the click for the
   * same reason.
   */
  const [asks, setAsks] = useState(0)
  /** The server the confirmation is about, and what the CLI said if it
   * refused. Removal is not undoable, so nothing happens without the dialog. */
  const [pendingRemove, setPendingRemove] = useState<McpServerInfo | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  // Asked on open and never cached in the renderer: main does not hold this
  // answer either, for the reason on `installedMcpServers` — somebody looking
  // at this list has often just installed something.
  useEffect(() => {
    let live = true
    void window.desktop
      .installedMcpServers(activeFolderId)
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
  }, [activeFolderId, asks])

  const servers = orderedServers(listing?.servers ?? [])
  const disabled = useSettings((state) => state.mcpDisabledTools)
  // The cheapest setting in the app, said with a number: every tool left on is
  // a definition in every turn's prompt, in every chat. A floor — see
  // `promptTokensLeftOn` — so it is worded as "at least".
  const promptCost = promptTokensLeftOn(servers, disabled)

  const remove = (server: McpServerInfo) => {
    setRemoveError(null)
    void window.desktop
      .removeMcpServer({
        name: server.name,
        scope: server.scope,
        folderId: activeFolderId,
      })
      .then(() => {
        setPendingRemove(null)
        // Re-asked rather than spliced out of the list held here: a server can
        // be configured in two scopes, and what is left after a removal is the
        // CLI's answer rather than this app's arithmetic.
        setLoading(true)
        setAsks((count) => count + 1)
      })
      .catch((error: unknown) => {
        setRemoveError(error instanceof Error ? error.message : String(error))
      })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
          Whatever your own <code>claude</code> is configured with in{" "}
          {project ? (
            <>
              <span className="font-medium text-foreground">
                {project.name}
              </span>
              &rsquo;s directory
            </>
          ) : (
            "your home directory, since no project is open"
          )}
          : servers added with <code>claude mcp add</code>, the
          repository&rsquo;s own <code>.mcp.json</code>, enabled plugins and
          claude.ai connectors. A chat here is handed all of it, the same way
          running <code>claude</code> in the dock&rsquo;s Terminal would be.
          Switch off a server, or one of its tools, to keep it installed and out
          of this app&rsquo;s chats — a chat picks that up on its next message.
        </p>
        <Button
          size="xs"
          variant="outline"
          disabled={loading}
          onClick={() => {
            setLoading(true)
            setAsks((count) => count + 1)
          }}
        >
          <RefreshCw
            data-icon="inline-start"
            className={cn(loading && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      {loading && !listing ? (
        <Card>
          <p className="p-4 text-xs text-muted-foreground">
            Asking <code className="font-mono">claude</code> what it has&hellip;
          </p>
        </Card>
      ) : listing?.error ? (
        <Card>
          <p className="p-4 text-xs text-destructive">{listing.error}</p>
        </Card>
      ) : servers.length === 0 ? (
        <Card>
          <p className="p-4 text-xs text-muted-foreground">
            No MCP servers here. Add one with{" "}
            <code className="font-mono">claude mcp add</code>, or connect one to
            your account on claude.ai — either way it turns up in this list and
            in every chat in this project.
          </p>
        </Card>
      ) : (
        <Card>
          {promptCost > 0 && (
            <p className="border-b p-4 text-xs leading-relaxed text-muted-foreground">
              The tools left on here put at least ~
              <span className="font-medium text-foreground">
                {compact(promptCost)} tokens
              </span>{" "}
              of definitions into every turn&rsquo;s prompt, in every chat —
              counted from names and descriptions alone, so the true figure is
              higher. Switching off what chats here never call is the cheapest
              setting in the app.
            </p>
          )}
          {servers.map((server) => (
            <ServerRow
              key={`${server.scope}/${server.name}`}
              server={server}
              onRemove={() => {
                setRemoveError(null)
                setPendingRemove(server)
              }}
            />
          ))}
        </Card>
      )}

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
              installed but out of this app&rsquo;s chats, use the switch
              instead.
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
    </div>
  )
}

/**
 * One server: what it is, whether it works, and what it offers.
 *
 * The tools are behind a disclosure rather than listed outright — a connector
 * carries forty of them, and a section that has to be scrolled past to reach
 * the next server is a section nobody reads. Shut by default for the same
 * reason, and counted on the summary so the count is readable without opening
 * anything.
 */
function ServerRow({
  server,
  onRemove,
}: {
  server: McpServerInfo
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const disabled = useSettings((state) => state.mcpDisabledTools)
  const setDisabled = useSettings((state) => state.setMcpDisabledTools)
  const { label, tone } = stateLabel(server.state)
  const caption = serverCaption(server)
  const auth = signIn(server)
  const off = isServerOff(disabled, server.name)

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {serverMark(server.name, "size-4")}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex items-center gap-2 text-sm leading-none font-medium">
            <span className="truncate">{server.name}</span>
            <StateBadge label={label} tone={tone} />
          </p>
          {caption && (
            <p className="text-[0.7rem] text-muted-foreground">{caption}</p>
          )}
          {server.address && (
            <p className="truncate font-mono text-[0.7rem] text-muted-foreground">
              {server.address}
            </p>
          )}
          {server.error && (
            <p className="text-xs leading-relaxed text-destructive">
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
              className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Authorize on claude.ai
              <ExternalLink className="size-3" />
            </a>
          )}
          {auth?.kind === "cli" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
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
              className="hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 />
            </IconButton>
          )}
          {/*
            The server's own switch, which writes one entry standing for every
            tool on it — including one added to it later. Off is this app's
            refusal, not a change to the user's config: the server stays
            installed and their terminal still has it, which is the whole
            difference between this and the button beside it.
          */}
          <Switch
            checked={!off}
            aria-label={`Allow ${server.name}`}
            onCheckedChange={(next) =>
              setDisabled(withServerOff(disabled, server.name, !next))
            }
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pl-7">
        {server.tools.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
            {/* Sized here rather than left to `Button`'s own icon rules: this
                is a plain `button`, and an `<svg>` with only a `viewBox` is
                drawn enormous. */}
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                open && "rotate-180"
              )}
            />
          </button>
        )}
        {/* What the server costs a turn when it is on, beside the count of what
            it offers: the number that decides whether the switch above is worth
            flipping. A floor — see `serverPromptTokens` — and muted out while
            the server is off, since an off server costs nothing. */}
        {serverPromptTokens(server) > 0 && (
          <span
            title="Estimated from tool names and descriptions at ~4 characters per token. Parameter schemas are not in the listing, so the real figure is higher."
            className={cn(
              "text-xs text-muted-foreground",
              off && "line-through opacity-60"
            )}
          >
            ≥ ~{compact(serverPromptTokens(server))} tokens/turn
          </span>
        )}
        {/* Counted where the fold is, because the number is the reason to open
            it: "3 of 56 off" is the state somebody is checking for. */}
        {offCount(disabled, server) > 0 && (
          <span className="text-xs text-muted-foreground">
            {off
              ? "all off"
              : `${offCount(disabled, server)} of ${server.tools.length} off`}
          </span>
        )}
      </div>

      {open && (
        <ul className="space-y-1 border-t pt-2">
          {server.tools.map((tool) => (
            <li key={tool.name} className="flex items-start gap-3 py-0.5">
              <div className="min-w-0 flex-1 text-xs">
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
                aria-label={`Allow ${tool.name}`}
                onCheckedChange={(next) =>
                  setDisabled(
                    withToolOff(disabled, server.name, tool.name, !next)
                  )
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

/** A state in two words, coloured only where the colour means something. */
function StateBadge({
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

/** The box a section's rows sit in — one border around the group rather than
 * one per row, so a section of three reads as three rows of one thing. */
function Card({ children }: { children: ReactNode }) {
  return <div className="divide-y rounded-lg border">{children}</div>
}

/** One setting: what it is, what it does, and the control at the end of the
 * line. There was a `stacked` variant for a control too big for that — the tab
 * strip's two placement pictures — and it went with them. */
function Row({
  title,
  description,
  children,
}: {
  title: string
  /** A sentence, all but always — `ReactNode` because the update row swaps its
   * own for a progress bar while an install runs. */
  description: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex gap-6 p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm leading-none font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

/** A handful of exclusive choices, short enough to show all at once. */
function Segmented({
  value,
  options,
  onPick,
}: {
  value: string
  options: { value: string; label: string }[]
  onPick: (value: string) => void
}) {
  return (
    <div role="radiogroup" className="flex rounded-md border bg-muted/40 p-0.5">
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onPick(option.value)}
            className={cn(
              "rounded-[5px] px-2.5 py-1 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              active
                ? "bg-background font-medium text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
