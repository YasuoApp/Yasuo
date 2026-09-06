import { lazy, Suspense, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileText,
  Flag,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Plus,
  RefreshCw,
  Bot,
  Eye,
  FolderGit2,
  GitBranch,
  Trash2,
  TriangleAlert,
  Type,
  Users,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import type {
  ClickupChange,
  ClickupChangeKind,
  ClickupWatch,
} from "@shared/api"
import { Button } from "@/components/ui/button"
import { dueState, todayKey } from "@/lib/board/cards"
// The app's one palette, which lives under `board/` because that is where it
// was written. A second table of hues here would drift from it the first time
// either was tuned, and the ids are `@shared/api`'s rather than a board's.
import { BOARD_TONES, DUE_TONES } from "@/lib/board/tones"
import {
  agentOf,
  agentsIn,
  CLICKUP_AGENTS,
  proposalsIn,
  waitingIn,
} from "@shared/clickup-agents"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CHANGE_TONE, clickupPriorityTone } from "@/lib/clickup/tones"
import { useStudio } from "@/lib/store"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
import { unreadIn, useClickup } from "@/lib/clickup/store"
import { cn } from "@/lib/utils"
import { ago, exactly, lastPolled } from "./when"

/** The diff of one change's two texts, behind a `lazy` for the reason every
 * editor in this app is: it is CodeMirror, and a history nobody expands should
 * not carry one. */
const loadChangeDiff = () => import("./change-diff")
const ChangeDiff = lazy(loadChangeDiff)

/**
 * Every watched ClickUp task, and what has happened to each — one tab of the
 * workbench.
 *
 * **It was a dialog, and before that a section of the left column.** The column
 * went first: two hundred pixels is a bad place to read a list of sentences, and
 * the history unfolding inside a row left no list to navigate by. The dialog
 * that replaced it fixed the width and kept the two things a modal always
 * costs — it is 32rem tall whatever the window is, which is a bad place to read
 * a **diff**, and it is the one surface in this app that cannot be left open
 * beside the work it is about. Watching a task is not a thing you do and
 * dismiss; it is a thing you keep an eye on while doing something else, which is
 * what a tab is for.
 *
 * So it is a **panel** — the fifth, and the first since the Database and API
 * panels were deleted. One tab, not one per task, and workspace-level rather
 * than a project's: no `rootOf` in `lib/panels.ts`, so it stays in the strip
 * whichever project is being worked in, the way the watch list itself has always
 * been the whole workspace's.
 *
 * Tasks down the left, the selected one's history on the right — the shape
 * `SettingsDialog` has, and for the same reason: it stays the same size as the
 * list grows, and it is the only layout where the thing being read has room
 * without the thing being chosen disappearing. Both halves now grow with the
 * window instead of stopping at a modal's edge.
 */
export function ClickupPane() {
  const watches = useClickup((state) => state.watches)
  const showing = useClickup((state) => state.showing)
  const refreshing = useClickup((state) => state.refreshing)
  const pollError = useClickup((state) => state.pollError)
  const [adding, setAdding] = useState(false)
  const polled = lastPolled(watches)

  // Nothing picked is the footer button's press — "show me the lot" — so it
  // lands on the first task rather than on nothing.
  const selected =
    watches.find((watch) => watch.id === showing) ?? watches[0] ?? null

  return (
    <div className="grid h-full w-full grid-cols-[16rem_1fr] overflow-hidden">
      <nav
        aria-label="Watched ClickUp tasks"
        className="flex min-h-0 flex-col border-r bg-muted/30"
      >
        <div className="flex shrink-0 items-center gap-0.5 px-3 pt-3 pb-2">
          <p className="min-w-0 flex-1 truncate text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
            Watching {watches.length}
          </p>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Watch a ClickUp task"
            onClick={() => setAdding(true)}
            className="size-6"
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Check ClickUp now"
            disabled={refreshing}
            onClick={() => void useClickup.getState().poll()}
            className="size-6"
          >
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </div>

        {adding && <AddWatchRow onDone={() => setAdding(false)} />}

        <div className="min-h-0 flex-1 overflow-y-auto p-2 pt-0">
          {watches.map((watch) => (
            <TaskButton
              key={watch.id}
              watch={watch}
              active={watch.id === selected?.id}
            />
          ))}
        </div>

        {/* When ClickUp was last read. Down here rather than on a row,
            because it is about the poll rather than about any one task —
            and it is the only thing in the app that answers "is this
            watching anything at all". */}
        {pollError ? (
          // A poll that failed as a whole, rather than one task ClickUp
          // refused — that is already on the task's own row. Drawn in place
          // of the stamp, since the stamp would be saying when it last
          // *worked*, which is the wrong thing to read next to a failure.
          <p className="shrink-0 border-t px-3 py-1.5 text-[0.6875rem] leading-snug text-destructive">
            {pollError}
          </p>
        ) : (
          polled && (
            <p
              title={exactly(polled)}
              className="shrink-0 border-t px-3 py-1.5 text-[0.6875rem] text-muted-foreground"
            >
              Last checked {ago(polled)}
            </p>
          )
        )}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-col">
        {selected ? (
          <TaskDetail watch={selected} />
        ) : (
          <div className="grid h-full place-items-center p-6">
            <p className="max-w-xs text-center text-xs leading-relaxed text-muted-foreground">
              Nothing watched yet. Press <span className="font-medium">+</span>{" "}
              and paste a ClickUp task link to be told when its status changes
              or somebody comments.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/** One task in the pane's own list: the name, and the newest thing about it. */
function TaskButton({
  watch,
  active,
}: {
  watch: ClickupWatch
  active: boolean
}) {
  const unread = unreadIn(watch).length > 0
  const latest = (watch.history ?? [])[0]
  // The newest change's own icon and hue, so the list says *what kind of thing*
  // happened to each task before anybody reads a word of it — a comment on one
  // and a status move on another are two different reasons to click.
  const kind = latest?.kind ? KINDS[latest.kind] : null
  const LatestIcon = kind?.icon
  const tone = latest?.kind ? BOARD_TONES[CHANGE_TONE[latest.kind]] : null
  const waiting = waitingIn(watch)

  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => useClickup.getState().show(watch.id)}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {unread && (
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            unread ? "font-medium text-foreground" : "text-foreground/80"
          )}
        >
          {watch.seen?.name ?? watch.id}
        </span>
        {/* ClickUp's own colour for the status this task is in, which is what
            makes the list scannable as a list of *states* rather than of names.
            A dot rather than the word: the word is in the detail pane, and a
            column this narrow has room for the name or the status, not both. */}
        {/* An offer waiting is the one thing on a row worth more than the
            status: it is a button somebody has to press for anything to
            happen, and it is the only mark here that is about this app rather
            than about ClickUp. */}
        {waiting > 0 && (
          <span
            title={`${waiting} waiting on you`}
            className="flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1 text-[0.625rem] font-medium text-primary tabular-nums"
          >
            <Bot aria-hidden className="size-2.5" />
            {waiting}
          </span>
        )}
        {watch.seen?.statusColor && (
          <span
            aria-hidden
            title={watch.seen.status}
            style={{ backgroundColor: watch.seen.statusColor }}
            className="size-2 shrink-0 rounded-full"
          />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1 text-[0.6875rem] text-muted-foreground">
        {watch.error ? (
          <>
            <TriangleAlert aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate text-destructive">
              {watch.error}
            </span>
          </>
        ) : (
          <>
            {LatestIcon && (
              <LatestIcon
                aria-hidden
                className={cn("size-3 shrink-0", tone?.text)}
              />
            )}
            <span className="min-w-0 truncate">
              {latest ? latest.text : watch.seen?.status || "watching"}
            </span>
          </>
        )}
      </span>
    </button>
  )
}

/**
 * One task in full: what it is now, and everything this app has noticed.
 *
 * **What it is now** comes from the last snapshot rather than from the history,
 * because the two answer different questions and only one of them survives the
 * history being capped. The facts row is drawn from whatever is set — a task
 * with no assignee and no due date is a shorter row, not a row of dashes.
 */
function TaskDetail({ watch }: { watch: ClickupWatch }) {
  const history = watch.history ?? []
  const [confirming, setConfirming] = useState(false)

  const seen = watch.seen
  // The day in UTC, for the reason a card's due date is a day: ClickUp stores a
  // date-only due as midnight UTC, and reading it locally names the day before
  // for everybody west of Greenwich.
  const due = seen?.due ? new Date(seen.due).toISOString().slice(0, 10) : null

  return (
    <>
      {/* No clearance for a close button any more: the ✕ is on the tab, which
          is where every other panel's is. */}
      <header className="shrink-0 border-b px-5 py-4">
        <h2 className="truncate text-base font-medium">
          {watch.seen?.name ?? watch.id}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {watch.polledAt
            ? `Last checked ${ago(watch.polledAt)}`
            : "Not checked yet"}
        </p>

        <div className="mt-3 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => window.open(watch.url, "_blank")}
          >
            <ExternalLink className="size-3.5" />
            Open in ClickUp
          </Button>
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                onClick={() => {
                  void useClickup.getState().remove(watch.id)
                  setConfirming(false)
                }}
              >
                Stop watching
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            // Two presses rather than an alert dialog: what is being thrown
            // away is a list of changes this app cannot fetch again, and a
            // modal over a modal for it would be worse than the second press.
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-3.5" />
              Stop watching
            </Button>
          )}
        </div>
      </header>

      {/* Capped rather than full-bleed: this pane is as wide as the window
          now, and a history is prose — a sentence three feet long is not more
          readable for having the room. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-4xl">
          {watch.error && (
            <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {watch.error}
            </p>
          )}

          {/* What the task **is**, as chips rather than a definition list: this
              is the row somebody checks in a second before reading what moved,
              and four labelled rows of grey text is not a thing read in a
              second. Each chip is a shape and a word as well as a colour — the
              rule `card-chips.tsx` states for the board. */}
          {seen && (
            <div className="mb-5 flex flex-wrap items-center gap-1.5">
              {seen.status && (
                <StatusChip status={seen.status} color={seen.statusColor} />
              )}
              {seen.priority && <PriorityChip priority={seen.priority} />}
              {seen.assignees.length > 0 && (
                <Chip icon={Users}>{seen.assignees.join(", ")}</Chip>
              )}
              {due && <DueChip due={due} />}
            </div>
          )}

          <AgentRow watch={watch} />
          <ProposalList watch={watch} />

          <p className="mb-2 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
            History
          </p>

          {history.length === 0 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Nothing has changed since this task was added. This is what Yasuo
              has noticed since then — anything earlier is in ClickUp.
            </p>
          ) : (
            <ol className="flex flex-col">
              {history.map((change, at) => (
                <HistoryRow
                  // The index is in the key because two changes noticed in one
                  // poll share `at` to the millisecond: they are stamped with
                  // when this app looked, not with when each happened.
                  key={`${change.at}-${at}`}
                  change={change}
                />
              ))}
            </ol>
          )}

          {history.length > 0 && (
            <p className="pt-3 text-[0.6875rem] leading-relaxed text-muted-foreground">
              Watching since {exactly(watch.addedAt)}. Anything before that is
              in ClickUp.
            </p>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Who this task is assigned to, and where they would run.
 *
 * **Assignees here are agents, not people.** ClickUp's own assignees are drawn
 * a few lines above, in the facts row, and are somebody else's field — read
 * only, like everything else this app knows about a task. These are this
 * workspace's own: which of `CLICKUP_AGENTS` should offer to do something when
 * this task moves.
 *
 * The project sits beside them because it is the same decision: an agent needs
 * a directory, and a task assigned to one with no project is a card that can
 * only ever refuse. Said here rather than at Run time, where it would be a
 * failure instead of a setting.
 */
function AgentRow({ watch }: { watch: ClickupWatch }) {
  const folders = useStudio((state) => state.folders)
  const assigned = agentsIn(watch)
  const project = folders.find((folder) => folder.id === watch.folderId)

  return (
    <div className="mb-5">
      <p className="mb-1.5 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
        Agents
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" variant="outline" className="h-7 text-xs">
                <Bot className="size-3.5" />
                {assigned.length === 0
                  ? "Assign an agent"
                  : `${assigned.length} assigned`}
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-80">
            {CLICKUP_AGENTS.map((agent) => (
              <DropdownMenuCheckboxItem
                key={agent.id}
                checked={assigned.includes(agent.id)}
                // Not closed on pick: assigning two of three is two clicks, and
                // a menu that shut after each would make it four.
                closeOnClick={false}
                onCheckedChange={(on) =>
                  void useClickup
                    .getState()
                    .assign(
                      watch.id,
                      on
                        ? [...assigned, agent.id]
                        : assigned.filter((id) => id !== agent.id)
                    )
                }
                className="items-start gap-2"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs font-medium">{agent.name}</span>
                  <span className="text-[0.6875rem] leading-snug text-muted-foreground">
                    {agent.blurb}
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {assigned.map((id) => {
          const agent = agentOf(id)
          return (
            agent && (
              <Chip key={id} icon={agent.worktree ? GitBranch : Eye}>
                {agent.name}
              </Chip>
            )
          )
        })}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  "h-7 text-xs",
                  // Loud only when it is the thing standing between an assigned
                  // agent and being able to run at all.
                  !project && assigned.length > 0
                    ? "text-destructive"
                    : "text-muted-foreground"
                )}
              >
                <FolderGit2 className="size-3.5" />
                {project ? project.name : "No project"}
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={watch.folderId ?? ""}
              onValueChange={(value) =>
                void useClickup
                  .getState()
                  .setProject(watch.id, value === "" ? null : value)
              }
            >
              <DropdownMenuRadioItem value="" className="text-xs">
                No project
              </DropdownMenuRadioItem>
              {folders.map((folder) => (
                <DropdownMenuRadioItem
                  key={folder.id}
                  value={folder.id}
                  className="text-xs"
                >
                  {folder.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {assigned.length > 0 && !project && (
        <p className="mt-1.5 text-[0.6875rem] leading-snug text-muted-foreground">
          Pick a project and these agents can run in it. Nothing runs on its own
          — a change makes an offer, and you press Run.
        </p>
      )}
    </div>
  )
}

/**
 * What the agents have offered to do.
 *
 * The one place in this app where a card says "I would do this" — and the whole
 * reason the feature is shaped this way. A poll writes these; **nothing runs
 * until Run is pressed**, which is what keeps a turn something somebody asked
 * for rather than something a two-minute timer decided. `docs/design.md` §
 * Agents on a task has the argument, including what the automatic version
 * would have cost.
 *
 * Dismissed cards are dropped from the list rather than drawn struck through:
 * the record keeps them so the same change cannot come back as a fresh offer,
 * and that is a fact about the file rather than about the afternoon.
 */
function ProposalList({ watch }: { watch: ClickupWatch }) {
  const running = useClickup((state) => state.running)
  const [failed, setFailed] = useState<Record<string, string>>({})
  const proposals = proposalsIn(watch).filter(
    (one) => one.status !== "dismissed"
  )
  if (proposals.length === 0) return null

  return (
    <div className="mb-5">
      <p className="mb-1.5 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
        Offers
      </p>
      <ol className="flex flex-col gap-2">
        {proposals.map((proposal) => {
          const agent = agentOf(proposal.agent)
          const busy = running === proposal.id || proposal.status === "running"
          const said = failed[proposal.id] ?? proposal.error

          return (
            <li
              key={proposal.id}
              className={cn(
                "rounded-md border p-3",
                proposal.status === "pending"
                  ? "border-primary/30 bg-primary/5"
                  : "bg-muted/30"
              )}
            >
              <div className="flex items-center gap-2">
                <Bot
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {agent?.name ?? proposal.agent}
                </span>
                <span
                  title={exactly(proposal.at)}
                  className="shrink-0 text-[0.6875rem] text-muted-foreground"
                >
                  {ago(proposal.at)}
                </span>
              </div>

              {/* Why it is offering, carried on the card rather than looked up:
                  the history is capped, and an offer that outlived its reason
                  would be a button with nothing behind it. */}
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {proposal.because.slice(0, 4).map((line, at) => (
                  <li
                    key={`${line}-${at}`}
                    className="text-[0.6875rem] leading-snug text-muted-foreground"
                  >
                    · {line}
                  </li>
                ))}
              </ul>

              {proposal.result && (
                <p className="mt-2 rounded border bg-background p-2 text-xs leading-relaxed whitespace-pre-wrap">
                  {proposal.result}
                </p>
              )}

              {said && (
                <p className="mt-2 text-[0.6875rem] leading-snug text-destructive">
                  {said}
                </p>
              )}

              <div className="mt-2 flex items-center gap-1.5">
                {proposal.status === "pending" ||
                proposal.status === "failed" ? (
                  <>
                    <Button
                      size="sm"
                      className="h-6 text-xs"
                      disabled={busy}
                      onClick={() => {
                        setFailed((was) => {
                          const next = { ...was }
                          delete next[proposal.id]
                          return next
                        })
                        void useClickup
                          .getState()
                          .run(watch.id, proposal.id)
                          .then((answer) => {
                            if (!answer.error) return
                            setFailed((was) => ({
                              ...was,
                              [proposal.id]: answer.error!,
                            }))
                          })
                      }}
                    >
                      {busy && <Loader2 className="size-3 animate-spin" />}
                      {proposal.status === "failed" ? "Try again" : "Run"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs text-muted-foreground"
                      disabled={busy}
                      onClick={() =>
                        void useClickup
                          .getState()
                          .dismiss(watch.id, proposal.id)
                      }
                    >
                      Dismiss
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-[0.6875rem] text-muted-foreground">
                      {proposal.status === "running" ? "Running" : "Done"}
                      {proposal.branch ? ` · ${proposal.branch}` : ""}
                    </span>
                    {proposal.chatId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs"
                        onClick={() =>
                          useWorktreeChats.getState().select(proposal.chatId!)
                        }
                      >
                        <MessageSquare className="size-3" />
                        Open the chat
                      </Button>
                    )}
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * The chips the facts row is made of.
 *
 * Written here rather than reused from `board/card-chips.tsx` because they are
 * about somebody else's vocabulary: a ClickUp status is free text with a colour
 * the workspace picked, and its priorities are four words rather than the
 * board's three. What *is* shared is the palette — `BOARD_TONES`, which is the
 * app's one table of hues and not the board's own.
 */
function Chip({
  icon: Icon,
  tone,
  style,
  children,
}: {
  icon?: LucideIcon
  /** Tailwind classes; the default is the neutral chip. */
  tone?: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <span
      style={style}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium",
        tone ?? "bg-muted text-muted-foreground"
      )}
    >
      {Icon && <Icon aria-hidden className="size-3 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * The status, in **ClickUp's own colour**.
 *
 * The one hue in this pane this app did not choose, which is the whole point of
 * carrying it: a status somebody made green in ClickUp is green here, and the
 * dot means the same thing in both windows without anybody mapping a vocabulary
 * this app does not own. `hexColor` in `main/clickup.ts` is what makes it safe
 * to put in a `style`; a snapshot from before that field, or a colour ClickUp
 * did not send, falls back to the neutral dot.
 */
function StatusChip({
  status,
  color,
}: {
  status: string
  color?: string | null
}) {
  return (
    <Chip>
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          style={color ? { backgroundColor: color } : undefined}
          className={cn(
            "size-2 shrink-0 rounded-full",
            color ? "" : "bg-muted-foreground/50"
          )}
        />
        <span className="truncate text-foreground">{status}</span>
      </span>
    </Chip>
  )
}

/** The priority, in the hue `clickupPriorityTone` gives its word — named as
 * well as coloured, for the reason the board's is: `Urgent` is a word, and a
 * colour code somebody has to learn saves nothing. */
function PriorityChip({ priority }: { priority: string }) {
  return (
    <Chip icon={Flag} tone={BOARD_TONES[clickupPriorityTone(priority)].chip}>
      {priority}
    </Chip>
  )
}

/** The due date, coloured by how it reads against today — `dueState` and
 * `DUE_TONES` are the board's, and this is the same question about the same
 * shape of string. */
function DueChip({ due }: { due: string }) {
  const state = dueState(due, todayKey())
  return (
    <Chip
      icon={CalendarDays}
      tone={cn(
        "bg-muted",
        DUE_TONES[state],
        state !== "later" && "font-medium"
      )}
    >
      {due}
    </Chip>
  )
}

/** What each kind of change is called and is drawn with — the sentence in
 * `text` is the notification's and the sidebar's. The hue is `CHANGE_TONE`. */
const KINDS: Record<ClickupChangeKind, { label: string; icon: LucideIcon }> = {
  status: { label: "Status", icon: CircleDot },
  name: { label: "Name", icon: Type },
  assignees: { label: "Assigned", icon: Users },
  priority: { label: "Priority", icon: Flag },
  due: { label: "Due", icon: CalendarDays },
  description: { label: "Description", icon: FileText },
  comment: { label: "Comment", icon: MessageSquare },
  "comment-edited": { label: "Comment edited", icon: MessagesSquare },
}

/**
 * One thing that happened, with room for both sides of it.
 *
 * A change carries the sentence *and*, since the fields were added, what the
 * field was and what it became — so here, where there is width for it, the two
 * values are drawn either side of an arrow rather than the sentence, which only
 * ever had room to name the second. "Status → done" becomes "in progress →
 * done", which is the question somebody opening a history is actually asking.
 *
 * A change too long for an arrow — a description, a comment — carries the two
 * **texts** instead, and gets a `Diff` button rather than a third line: the
 * history is a list to scan, and a paragraph opened by default in every row of
 * it is not a list. Expanded **in place** rather than opened anywhere else,
 * since what somebody is doing is reading down a list and a diff that took over
 * the pane would lose their place in it.
 *
 * A change with **no `kind`** is one written before those fields existed and
 * still on disk: it falls back to the sentence, which is all it has. Same for a
 * change with no `body` — every history written before the texts were kept.
 *
 * **What the colour is for.** A history is read by scanning it, and every row
 * was the same grey: the hue on the left edge and on the icon is what makes
 * "the status moved three times this week" visible without reading a word. It
 * is `CHANGE_TONE`, off the app's one palette, and it is never the only
 * difference between two rows — each carries its own icon and its own written
 * label, which is the rule the board's chips are held to.
 */
function HistoryRow({ change }: { change: ClickupChange }) {
  const kind = change.kind ? KINDS[change.kind] : null
  const Icon = kind?.icon
  const tone = change.kind ? BOARD_TONES[CHANGE_TONE[change.kind]] : null
  const moved = change.from !== undefined && change.to !== undefined
  const [open, setOpen] = useState(false)

  return (
    <li
      className={cn(
        // The hue rides the left border rather than a background: it runs the
        // height of the row however tall the row grows — a diff expanded under
        // one is still visibly part of it — and a column of tinted blocks would
        // be louder than the text it is there to organise. The same bargain
        // `edge` makes on a board card.
        "flex gap-2.5 border-l-2 py-1.5 pl-3",
        tone?.edge ?? "border-l-border"
      )}
    >
      {Icon && (
        <span
          aria-hidden
          className={cn(
            // A tinted disc rather than a bare glyph: at 14px an icon carries
            // almost no colour, and this is the mark the eye actually finds.
            "mt-0.5 grid size-5 shrink-0 place-items-center rounded",
            tone?.chip ?? "bg-muted text-muted-foreground"
          )}
        >
          <Icon className="size-3.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        {kind && (
          <p className="text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
            {kind.label}
          </p>
        )}
        {moved ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs leading-relaxed">
            {/* The old value struck through and the new one in the kind's own
                hue: which of the two is the answer should not need reading the
                order. */}
            <span className="min-w-0 break-words text-muted-foreground line-through decoration-muted-foreground/40">
              {change.from}
            </span>
            <ArrowRight
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
            />
            <span
              className={cn(
                "min-w-0 rounded px-1 py-0.5 font-medium break-words",
                tone?.chip ?? "text-foreground"
              )}
            >
              {change.to}
            </span>
          </p>
        ) : (
          <p className="text-xs leading-relaxed break-words text-foreground/90">
            {change.text}
          </p>
        )}

        {change.body && (
          <>
            <button
              type="button"
              aria-expanded={open}
              // Warmed on hover, so the editor's chunk and the reader's mind are
              // made up in parallel — the module registry dedupes it against
              // the `lazy` below.
              onMouseEnter={() => void loadChangeDiff()}
              onClick={() => setOpen((was) => !was)}
              className="mt-1 flex items-center gap-1 rounded text-[0.6875rem] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {open ? (
                <ChevronDown aria-hidden className="size-3" />
              ) : (
                <ChevronRight aria-hidden className="size-3" />
              )}
              {open ? "Hide diff" : "View diff"}
            </button>
            {open && (
              <div className="mt-1.5 overflow-hidden rounded-md border">
                <Suspense
                  // Blank rather than a spinner: the chunk is usually already
                  // in hand from the hover, and a spinner that appears and
                  // leaves inside one frame is more movement than none.
                  fallback={<div className="h-16" />}
                >
                  <ChangeDiff
                    before={change.body.before}
                    after={change.body.after}
                  />
                </Suspense>
              </div>
            )}
          </>
        )}
      </div>
      <span
        title={exactly(change.at)}
        className="shrink-0 pt-0.5 text-[0.6875rem] whitespace-nowrap text-muted-foreground"
      >
        {ago(change.at)}
      </span>
    </li>
  )
}

/**
 * The field the `+` opens: a box for a pasted link, and the button that sends
 * it.
 *
 * A row above the list rather than a dialog, because what it asks for is one
 * line somebody already has on their clipboard — the same bargain `RenameRow`
 * makes for a name, and a second dialog over this one for a single field would
 * be worse than the field.
 *
 * It does **not** commit on blur, unlike a rename. It is filled by a paste, and
 * pasting from another window is a blur — committing there would send half a
 * URL the moment somebody went back to copy the rest of it. Which left `Enter`
 * as the only way to send it, and nothing on screen saying so: hence **Watch**
 * and **Cancel** under the box, the two keys drawn as the buttons they are.
 * Enter and Escape still do what they did.
 */
function AddWatchRow({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("")
  const [failed, setFailed] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const typed = url.trim()

  async function submit() {
    if (!typed) return onDone()
    setAdding(true)
    setFailed(null)
    const answer = await useClickup.getState().add(typed)
    setAdding(false)
    if ("error" in answer) return setFailed(answer.error)
    // Straight to the task that was just added: somebody who pasted a link did
    // it to see that task, not to go looking for it in the list.
    useClickup.getState().show(answer.watch.id)
    onDone()
  }

  return (
    <div className="px-3 pb-2">
      <input
        autoFocus
        value={url}
        disabled={adding}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit()
          if (event.key === "Escape") onDone()
        }}
        placeholder="https://app.clickup.com/t/…"
        aria-label="ClickUp task link"
        className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring disabled:opacity-60"
      />
      {failed && (
        <p className="px-0.5 pt-1 text-[0.6875rem] leading-snug text-destructive">
          {failed}
        </p>
      )}
      <div className="flex items-center gap-1.5 pt-1.5">
        <Button
          size="sm"
          // Disabled on an empty box rather than closing the row, so the
          // button and Enter do not mean two different things.
          disabled={adding || !typed}
          onClick={() => void submit()}
          className="h-6 flex-1 text-xs"
        >
          {adding && <Loader2 className="size-3 animate-spin" />}
          Watch
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={adding}
          onClick={onDone}
          className="h-6 text-xs text-muted-foreground"
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
