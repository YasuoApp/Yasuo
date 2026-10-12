import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  ArrowUpCircle,
  Bell,
  Columns2,
  ChevronRight,
  ExternalLink,
  FileJson,
  FolderOpen,
  KeyRound,
  Palette,
  Plus,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react"

import {
  ACCENT_PALETTES,
  isDensity,
  isFontSize,
  isMonoFont,
  isSansFont,
  MONO_FONT_LABELS,
  monoFontFamily,
  PALETTE_LABELS,
  SANS_FONT_LABELS,
  sansFontFamily,
} from "@/lib/appearance"
import type {
  ClaudeConfig,
  ClaudeConfigFile,
  ClaudeConfigProject,
  ClaudeConfigServer,
  ClaudeSettingsSummary,
  ClaudeVersions,
  SettingsSource,
} from "@shared/api"
import { useSettings } from "@/lib/settings"
import { useStudio } from "@/lib/store"
import { installLabel, pendingUpdate, useUpdates } from "@/lib/updates"
import {
  accountCaption,
  accountLabel,
  nextProfileName,
  useClaudeProfiles,
} from "@/lib/worktree-chat/claude-profiles"
import { useAgentModels } from "@/lib/worktree-chat/models"
import { ClaudeLoginDialog } from "./claude-login-dialog"
import { IconButton } from "./icon-button"
import { UpdateProgressBar } from "./update-progress"
import { ModelMenu, ProfileMenu } from "./worktree/chat-composer"
import { StateBadge } from "./worktree/chat-mcp"

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
              <AppearanceSection onReplayTour={onClose} />
            ) : section === "tabs" ? (
              <TabsSection />
            ) : section === "chats" ? (
              <ChatsSection />
            ) : section === "claude" ? (
              <ClaudeSection />
            ) : section === "config" ? (
              <ClaudeConfigSection />
            ) : (
              <UpdatesSection />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type SectionId =
  "appearance" | "tabs" | "chats" | "claude" | "config" | "updates"

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
    label: "Tabs & editor",
    blurb:
      "Where the workbench's tab strip sits, how much it gathers, and what a file's editor shows beside the code.",
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
    id: "config",
    label: "Claude config",
    blurb:
      "What your own claude has written down in .claude.json and settings.json. Read-only — change it with the CLI.",
    icon: FileJson,
  },
  {
    id: "updates",
    label: "Updates",
    blurb:
      "Which Visual Studio Claude this is, and whether there is a newer one.",
    icon: ArrowUpCircle,
  },
]

/**
 * How the studio looks. Every row here applies as it is picked — the window
 * behind the dialog is the preview — through `applyAppearance`, which the
 * workbench subscribes to the settings store with; nothing in this section
 * touches the document itself.
 */
function AppearanceSection({ onReplayTour }: { onReplayTour: () => void }) {
  // `theme` is the choice, `resolvedTheme` what it came out as — the choice is
  // what a settings row is asking about, so `system` stays visible as `system`
  // rather than as whichever of the two it happens to be right now.
  const { theme, setTheme } = useTheme()
  const palette = useSettings((state) => state.palette)
  const setPalette = useSettings((state) => state.setPalette)
  const fontSans = useSettings((state) => state.fontSans)
  const setFontSans = useSettings((state) => state.setFontSans)
  const fontMono = useSettings((state) => state.fontMono)
  const setFontMono = useSettings((state) => state.setFontMono)
  const fontSize = useSettings((state) => state.fontSize)
  const setFontSize = useSettings((state) => state.setFontSize)
  const density = useSettings((state) => state.density)
  const setDensity = useSettings((state) => state.setDensity)
  const setOnboarded = useSettings((state) => state.setOnboarded)

  return (
    <div className="space-y-4">
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
        <Row
          title="Accent"
          description="The colour of buttons, selections and the active row, and the tint every grey in the window carries."
        >
          <div role="radiogroup" className="flex items-center gap-1.5">
            {ACCENT_PALETTES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={candidate === palette}
                aria-label={PALETTE_LABELS[candidate]}
                title={PALETTE_LABELS[candidate]}
                // The swatch is the palette's own `--primary`: the same
                // `[data-palette]` rule the window reads, on a span instead of
                // `<html>`, so there is no second table of colours to keep in
                // step. It is the light accent in both modes, since the dark
                // rule wants `.dark` on the same element.
                data-palette={candidate}
                onClick={() => setPalette(candidate)}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  candidate === palette
                    ? "ring-2 ring-foreground ring-offset-2 ring-offset-popover"
                    : "ring-1 ring-border"
                )}
              >
                <span className="size-4 rounded-full bg-primary" />
              </button>
            ))}
          </div>
        </Row>
      </Card>

      <Card>
        <Row
          title="Font"
          description="The interface's typeface. A family not installed on this machine falls back to the system's."
        >
          <FontPicker
            value={fontSans}
            labels={SANS_FONT_LABELS}
            onPick={(value) => {
              if (isSansFont(value)) setFontSans(value)
            }}
          />
        </Row>
        <Row
          title="Monospace font"
          description="For code: the editors, the diff and the terminal. Open editors pick it up when they are next opened."
        >
          <FontPicker
            value={fontMono}
            labels={MONO_FONT_LABELS}
            onPick={(value) => {
              if (isMonoFont(value)) setFontMono(value)
            }}
          />
        </Row>
        <Row
          title="Font size"
          description="Scales the whole window — the rows and paddings go with the text, not only the text."
        >
          <Segmented
            value={fontSize}
            options={[
              { value: "small", label: "Small" },
              { value: "default", label: "Default" },
              { value: "large", label: "Large" },
            ]}
            onPick={(value) => {
              if (isFontSize(value)) setFontSize(value)
            }}
          />
        </Row>
        <Row
          title="Density"
          description="How tightly the sidebar's rows and a chat's turns sit."
        >
          <Segmented
            value={density}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
              { value: "spacious", label: "Spacious" },
            ]}
            onPick={(value) => {
              if (isDensity(value)) setDensity(value)
            }}
          />
        </Row>
      </Card>

      <Card>
        <Row
          title="Tour"
          description="The five cards shown on first launch, pointing at the parts of the window."
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Unset first, then close: the tour is mounted by the workbench
              // off this flag, and it has to land over a window with no
              // dialog still holding focus.
              setOnboarded(false)
              onReplayTour()
            }}
          >
            Replay the tour
          </Button>
        </Row>
      </Card>
    </div>
  )
}

/** One of a short list of typefaces, each drawn in itself so the list is its
 * own preview — and so a family that is not installed is visibly the fallback
 * before it is picked. */
function FontPicker<Value extends string>({
  value,
  labels,
  onPick,
}: {
  value: Value
  labels: Record<Value, string>
  onPick: (value: string) => void
}) {
  const values = Object.keys(labels) as Value[]
  return (
    <Select
      value={value}
      items={labels}
      onValueChange={(next) => {
        if (typeof next === "string") onPick(next)
      }}
    >
      <SelectTrigger size="sm" className="w-52 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {values.map((candidate) => (
          <SelectItem
            key={candidate}
            value={candidate}
            className="text-xs"
            style={{ fontFamily: previewFamily(candidate) }}
          >
            {labels[candidate]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The stack a row is drawn in: a key is a sans or a mono name, never both. */
function previewFamily(value: string): string {
  if (isMonoFont(value) && value !== "system") return monoFontFamily(value)
  if (isSansFont(value) && value !== "system") return sansFontFamily(value)
  return "inherit"
}

function TabsSection() {
  const groupTabs = useSettings((state) => state.groupTabs)
  const setGroupTabs = useSettings((state) => state.setGroupTabs)
  const gitBlame = useSettings((state) => state.gitBlame)
  const setGitBlame = useSettings((state) => state.setGitBlame)

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
      <Row
        title="Show who last changed the line"
        description="The author, the date and the commit message after the line the caret is on, with the commit in a card when you hover it — the way GitLens does. Read from git blame; nothing leaves this machine."
      >
        <Switch checked={gitBlame} onCheckedChange={setGitBlame} />
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
  const [versions, setVersions] = useState<ClaudeVersions | null>(null)

  const askVersions = () =>
    void window.desktop.claudeVersions().then(setVersions)
  // Asked on open rather than at launch: the CLI updates itself, so the answer
  // is worth having only when somebody is looking at it.
  useEffect(askVersions, [])

  return (
    <Card>
      <Row
        title="Version"
        description={
          !check
            ? "Asking GitHub what is out."
            : check.status === "current"
              ? `Visual Studio Claude ${check.current} — the latest release.`
              : `Visual Studio Claude ${check.current}.`
        }
      >
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={() => {
            askVersions()
            void refresh()
          }}
        >
          <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
          Check now
        </Button>
      </Row>

      <Row
        title="Claude Code"
        description={
          !versions
            ? "Asking claude for its version."
            : `CLI ${versions.cli ?? "not found"} · Agent SDK ${versions.sdk}${
                versions.error ? ` — ${versions.error}` : ""
              }`
        }
      />

      {update ? (
        <Row
          title={`Visual Studio Claude ${update.version} is available`}
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
              href="https://github.com/vsclaude/visual-studio-claude/releases"
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
          <code className="font-mono">~/.vsclaude/update.log</code>.
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
        {/* The one turn in the app with no toolbar of its own — a drafted
            commit message runs on whatever is picked here rather than on
            something asked per turn, since it is not a conversation somebody
            sits in front of. See
            `main/one-turn-agent.ts`; the `review*` field names are what is
            already on disk. */}
        <Row
          title="Helper turns"
          description="Which model, effort and account the drafted commit message runs on."
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
        <code className="font-mono">~/.vsclaude/workspace/claude-profiles</code>
        , which <strong>Log in</strong> creates and signs in.
      </p>
    </div>
  )
}

/**
 * What the user's own `claude` has written down — `.claude.json` and
 * `settings.json`, for the default login or one profile.
 *
 * **A listing and nothing else.** No row here edits, for the reason the MCP
 * menu's Remove runs `claude mcp remove` instead of touching the file: it is the
 * CLI's, rewritten on every start, and two writers of one JSON file is how it
 * is corrupted. Reveal is the way to the file for somebody who means to
 * edit it anyway. `docs/design.md` § Claude config, read-only has the argument.
 *
 * Asked on open and on Refresh rather than watched — the CLI writes the state
 * file constantly, and nothing here is worth a re-render per write.
 */
function ClaudeConfigSection() {
  const profiles = useClaudeProfiles((state) => state.profiles)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [config, setConfig] = useState<ClaudeConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Only the newest ask may land: a profile picked while the last one was
  // still being read must not be overwritten by it.
  const asked = useRef(0)

  const fetchConfig = (id: string | null) => {
    const ask = ++asked.current
    void window.desktop
      .claudeConfig(id)
      .then(
        (next) => {
          if (ask === asked.current) setConfig(next)
        },
        (reason: unknown) => {
          if (ask !== asked.current) return
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      )
      .finally(() => {
        if (ask === asked.current) setLoading(false)
      })
  }
  // Bumped by every Refresh and profile pick, so the effective view below
  // re-reads with the listing rather than on its own schedule.
  const [generation, setGeneration] = useState(0)
  const load = (id: string | null) => {
    setLoading(true)
    setError(null)
    setGeneration((current) => current + 1)
    fetchConfig(id)
  }
  // Once, on open; a profile pick and Refresh ask from their own handlers.
  useEffect(() => fetchConfig(null), [])

  const summary = config?.summary
  const settingsRows = summary ? summaryRows(summary) : []
  const policy = config?.policy
  const policyRows = policy
    ? [
        ...summaryRows(policy.summary),
        ...[
          {
            label: "Minimum version",
            values: policy.minimumVersion ? [policy.minimumVersion] : [],
          },
          {
            label: "Bypass mode",
            values: policy.bypassPermissions === "disable" ? ["Disabled"] : [],
          },
          {
            label: "Sandbox",
            values:
              policy.sandbox === null ? [] : [policy.sandbox ? "On" : "Off"],
          },
          {
            label: "MCP allowed",
            values: policy.managedMcpOnly
              ? [...policy.allowedMcpServers, "(nothing else)"]
              : policy.allowedMcpServers,
          },
          { label: "MCP denied", values: policy.deniedMcpServers },
        ].filter((row) => row.values.length > 0),
      ]
    : []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {profiles.length > 0 && (
          <ProfileMenu
            profiles={profiles}
            profileId={profileId}
            onPick={(id) => {
              setProfileId(id)
              load(id)
            }}
          />
        )}
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={loading}
          onClick={() => load(profileId)}
        >
          <RefreshCw
            data-icon="inline-start"
            className={cn(loading && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <EffectiveSettingsCard profileId={profileId} generation={generation} />

      {config && (
        <>
          <Card>
            <ConfigFileRow
              title="settings.json"
              file={config.settings}
              onReveal={() =>
                void window.desktop.revealClaudeConfig(profileId, "settings")
              }
            />
            <ConfigFileRow
              title=".claude.json"
              file={config.state}
              onReveal={() =>
                void window.desktop.revealClaudeConfig(profileId, "state")
              }
            />
            {/* Only when there is one: most accounts have no organization
                policy, and a row saying so for each of them is noise. */}
            {config.remote.exists && (
              <ConfigFileRow
                title="remote-settings.json"
                file={config.remote}
                onReveal={() =>
                  void window.desktop.revealClaudeConfig(profileId, "remote")
                }
              />
            )}
          </Card>

          {policy && (
            <>
              <ConfigHeading>Managed by your organization</ConfigHeading>
              <p className="-mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
                remote-settings.json ranks above settings.json: what it denies
                stays denied whatever your own files say. It is fetched from
                your account, so editing it here would be undone.
              </p>
              <SummaryCard
                rows={policyRows}
                empty="Sets nothing this listing reads."
              />
            </>
          )}

          <ConfigHeading>settings.json</ConfigHeading>
          <SummaryCard
            rows={settingsRows}
            empty={summary ? "Sets nothing this listing reads." : "No file."}
          />

          <ConfigHeading>MCP servers · user scope</ConfigHeading>
          <Card>
            {config.servers.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">
                None. <code className="font-mono">claude mcp add -s user</code>{" "}
                adds one; the composer&rsquo;s MCP menu shows whether they
                connect.
              </p>
            ) : (
              config.servers.map((server) => (
                <ServerLine key={server.name} server={server} />
              ))
            )}
          </Card>

          <ConfigHeading>Projects · {config.projects.length}</ConfigHeading>
          <Card>
            {config.projects.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">None.</p>
            ) : (
              config.projects.map((project) => (
                <ProjectEntry key={project.path} project={project} />
              ))
            )}
          </Card>
        </>
      )}
    </div>
  )
}

const SOURCE_LABELS: Record<SettingsSource, string> = {
  managed: "Managed",
  local: "Local",
  project: "Project",
  user: "User",
}

/**
 * Every settings file a session in one project would read, folded into the
 * values it starts with — `main/effective-settings.ts` has the rules and what
 * is not modelled. Per project because two of the five levels live in the
 * repository; "No project" is user and managed alone.
 */
function EffectiveSettingsCard({
  profileId,
  generation,
}: {
  profileId: string | null
  generation: number
}) {
  const folders = useStudio((state) => state.folders)
  const [folderId, setFolderId] = useState<string | null>(
    folders[0]?.id ?? null
  )
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof window.desktop.claudeEffectiveSettings>
  > | null>(null)
  const [error, setError] = useState<string | null>(null)
  const asked = useRef(0)

  useEffect(() => {
    const ask = ++asked.current
    void window.desktop.claudeEffectiveSettings(profileId, folderId).then(
      (next) => {
        if (ask !== asked.current) return
        setResult(next)
        setError(null)
      },
      (reason: unknown) => {
        if (ask !== asked.current) return
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    )
  }, [profileId, folderId, generation])

  const options: Record<string, string> = {
    none: "No project",
    ...Object.fromEntries(folders.map((folder) => [folder.id, folder.name])),
  }

  return (
    <>
      <div className="flex items-center gap-2 px-1">
        <p className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
          Effective settings
        </p>
        <Select
          value={folderId ?? "none"}
          items={options}
          onValueChange={(next) => {
            if (typeof next === "string") {
              setFolderId(next === "none" ? null : next)
            }
          }}
        >
          <SelectTrigger size="sm" className="ml-auto w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {Object.entries(options).map(([value, label]) => (
              <SelectItem key={value} value={value} className="text-xs">
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="-mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
        Managed, then local, project and user settings folded by the CLI&rsquo;s
        documented precedence — lists combine, the higher level wins the rest.
        <code className="font-mono"> /status</code> in a session is still the
        final word.
      </p>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {result && (
        <Card>
          <div className="flex flex-wrap gap-x-3 gap-y-1 px-4 py-2.5 text-[0.7rem] text-muted-foreground">
            {result.layers.map((layer) => (
              <span
                key={layer.path}
                title={layer.path}
                className={cn(
                  !layer.exists && "line-through opacity-60",
                  layer.error && "text-destructive"
                )}
              >
                {layer.label}
                {layer.source === "managed" &&
                  layer.label === result.managedSource &&
                  " ✓"}
              </span>
            ))}
          </div>
          {result.origins.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              No settings file sets anything.
            </p>
          ) : (
            result.origins.map((row) => (
              <div
                key={row.key}
                className="flex items-start gap-3 px-4 py-2 text-xs"
              >
                <span className="w-56 shrink-0 font-mono text-[0.7rem] break-all">
                  {row.key}
                </span>
                {/* Whole and wrapped: a cut-off deny list is the one row
                    somebody opened this to read. */}
                <span className="min-w-0 flex-1 font-mono text-[0.7rem] break-all whitespace-pre-wrap text-muted-foreground">
                  {row.value}
                </span>
                <span className="flex shrink-0 gap-1">
                  {row.sources.map((source) => (
                    <StateBadge
                      key={source}
                      label={SOURCE_LABELS[source]}
                      tone={source === "managed" ? "waiting" : "off"}
                    />
                  ))}
                </span>
              </div>
            ))
          )}
          {result.notes.length > 0 && (
            <ul className="space-y-1 px-4 py-2.5 text-[0.7rem] text-muted-foreground">
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  )
}

type SummaryRow = { label: string; values: string[] }

/** A settings file's rows, the ones it actually sets. */
function summaryRows(summary: ClaudeSettingsSummary): SummaryRow[] {
  return [
    { label: "Model", values: summary.model ? [summary.model] : [] },
    {
      label: "Permission mode",
      values: summary.defaultMode ? [summary.defaultMode] : [],
    },
    { label: "Allow", values: summary.allow },
    { label: "Ask", values: summary.ask },
    { label: "Deny", values: summary.deny },
    { label: "Env", values: summary.env },
    { label: "Hooks", values: summary.hooks },
    { label: "Plugins", values: summary.plugins },
    { label: "Other keys", values: summary.other },
  ].filter((row) => row.values.length > 0)
}

function SummaryCard({ rows, empty }: { rows: SummaryRow[]; empty: string }) {
  return (
    <Card>
      {rows.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">{empty}</p>
      ) : (
        rows.map((row) => (
          <div key={row.label} className="flex gap-4 px-4 py-2.5">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">
              {row.label}
            </span>
            <ValueList values={row.values} />
          </div>
        ))
      )}
    </Card>
  )
}

function ConfigHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  )
}

function ConfigFileRow({
  title,
  file,
  onReveal,
}: {
  title: string
  file: ClaudeConfigFile
  onReveal: () => void
}) {
  return (
    <Row
      title={title}
      description={
        <>
          <span className="block truncate font-mono" title={file.path}>
            {file.path}
          </span>
          {file.error ? (
            <span className="text-destructive">{file.error}</span>
          ) : file.exists ? (
            `${sizeOf(file.bytes ?? 0)} · changed ${new Date(
              file.modifiedAt ?? ""
            ).toLocaleString()}`
          ) : (
            "Not there yet."
          )}
        </>
      }
    >
      <Button size="xs" variant="ghost" onClick={onReveal}>
        <FolderOpen data-icon="inline-start" />
        Reveal
      </Button>
    </Row>
  )
}

/** One directory `claude` was started in, folded: the line says whether it
 * still matters, the fold says what was remembered about it. */
function ProjectEntry({ project }: { project: ClaudeConfigProject }) {
  const mcpjson = [
    ...project.enabledMcpjsonServers.map((name) => `${name} (on)`),
    ...project.disabledMcpjsonServers.map((name) => `${name} (off)`),
  ]
  const counts = [
    project.allowedTools.length > 0 && `${project.allowedTools.length} allowed`,
    project.servers.length > 0 &&
      `${project.servers.length} server${project.servers.length === 1 ? "" : "s"}`,
  ].filter(Boolean)
  const empty =
    project.allowedTools.length === 0 &&
    project.servers.length === 0 &&
    project.disabledServers.length === 0 &&
    mcpjson.length === 0

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-xs outline-none hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span
          className="min-w-0 flex-1 truncate font-mono"
          title={project.path}
        >
          {project.path}
        </span>
        {counts.length > 0 && (
          <span className="shrink-0 text-muted-foreground">
            {counts.join(" · ")}
          </span>
        )}
        {project.inWorkspace && <StateBadge label="In workspace" tone="good" />}
        {!project.exists && <StateBadge label="Folder gone" tone="off" />}
      </summary>
      <div className="space-y-2 px-4 pb-3 pl-9">
        {empty ? (
          <p className="text-xs text-muted-foreground">
            Nothing but the CLI&rsquo;s own bookkeeping.
          </p>
        ) : (
          <>
            {project.allowedTools.length > 0 && (
              <ProjectField label="Allowed tools">
                <ValueList values={project.allowedTools} />
              </ProjectField>
            )}
            {project.servers.length > 0 && (
              <ProjectField label="MCP · local">
                <div className="min-w-0 flex-1 divide-y rounded-md border">
                  {project.servers.map((server) => (
                    <ServerLine key={server.name} server={server} />
                  ))}
                </div>
              </ProjectField>
            )}
            {project.disabledServers.length > 0 && (
              <ProjectField label="MCP switched off">
                <ValueList values={project.disabledServers} />
              </ProjectField>
            )}
            {mcpjson.length > 0 && (
              <ProjectField label=".mcp.json">
                <ValueList values={mcpjson} />
              </ProjectField>
            )}
          </>
        )}
      </div>
    </details>
  )
}

function ProjectField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-4">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

function ServerLine({ server }: { server: ClaudeConfigServer }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs">
      <span className="shrink-0 font-medium">{server.name}</span>
      <span className="shrink-0 text-muted-foreground">{server.transport}</span>
      {server.address && (
        <span
          className="min-w-0 flex-1 truncate font-mono text-[0.7rem] text-muted-foreground"
          title={server.address}
        >
          {server.address}
        </span>
      )}
    </div>
  )
}

function ValueList({ values }: { values: string[] }) {
  return (
    <ul className="min-w-0 flex-1 space-y-0.5">
      {values.map((value) => (
        <li key={value} className="font-mono text-[0.7rem] break-all">
          {value}
        </li>
      ))}
    </ul>
  )
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  children?: ReactNode
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
