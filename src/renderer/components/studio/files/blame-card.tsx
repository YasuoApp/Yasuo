import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileCode,
  FileDiff,
  GitCommitHorizontal,
  GitPullRequest,
  History as HistoryIcon,
  MessageSquarePlus,
  Sparkle,
  UserRound,
} from "lucide-react"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import type { GitLineCommit } from "@shared/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useComposerBus } from "@/lib/chat/composer-bus"
import { dateTimeOf } from "@/lib/chat/since"
import type { BlameCard } from "@/lib/editor-git-blame"
import { useChanges } from "@/lib/files/changes"
import {
  ago,
  askAboutCommit,
  commitUrl,
  fileUrl,
  issueNumbers,
  messageParts,
  provisionalOf,
  statText,
  trailersOf,
} from "@/lib/files/git-blame"
import { GIT_TONES } from "@/lib/files/git-status"
import { rootOf } from "@/lib/files/roots"
import { cn } from "@/lib/utils"

/**
 * The blame card: the commit behind the caret's line, and every commit before
 * it that changed the same line — `git log -L`, read when the card opens.
 *
 * **Stepping back is blaming the previous revision.** The history is the
 * chain GitLens walks one "blame before this change" at a time, read in one
 * call, so the arrows and the rows under them only change which commit the
 * card is about; nothing is asked of git per step.
 *
 * React in a CodeMirror tooltip, mounted by hand: the card's box is DOM the
 * editor builds (`lib/editor-git-blame.ts`), and this is handed in from the
 * component side so that `lib/` does not import a component. Its own root, so
 * its own `TooltipProvider` — context does not cross roots. Rendered with
 * `flushSync` so the card has its full size when the editor measures it.
 */
export function mountBlameCard(host: HTMLElement, card: BlameCard): () => void {
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <Layer value={host}>
        <TooltipProvider delay={400}>
          <Card {...card} />
        </TooltipProvider>
      </Layer>
    )
  )
  // Unmounted on the next tick: the tooltip is destroyed inside a CodeMirror
  // update, which may itself be inside a React render.
  return () => queueMicrotask(() => root.unmount())
}

/**
 * Where the labels are portalled: into the card, not the body.
 *
 * The app's `IconButton` puts its tooltip on the body at `z-50`, and the card
 * is a CodeMirror tooltip — `z-index: 500`, inside the stacking context of the
 * pane that holds the editor — so the labels were drawn under the card they
 * name, and lowering the card did not reach past the pane. A label that is the
 * card's own child is above the card by construction, whatever the panes do.
 */
const Layer = createContext<HTMLElement | null>(null)

/** `-L`'s own cap, in `main/git.ts` — said aloud when the list reaches it. */
const HISTORY_LIMIT = 30

function Card({
  filePath,
  blame,
  commit,
  line,
  source,
  close,
  remeasure,
}: BlameCard) {
  const [history, setHistory] = useState<GitLineCommit[] | null>(
    source ? null : []
  )
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (!source) return
    let alive = true
    void window.desktop
      .gitLineHistory(filePath, commit.hash, source.path, source.line)
      .catch(() => [])
      .then((found) => {
        if (alive) setHistory(found)
      })
    return () => {
      alive = false
    }
  }, [filePath, commit.hash, source])

  // Not on the first paint: that is measured by the tooltip opening, and asking
  // again from inside the update that creates it is asking twice.
  const painted = useRef(false)
  useLayoutEffect(() => {
    if (painted.current) remeasure()
    painted.current = true
  }, [history, index, remeasure])

  // The walk starts at the blame's commit, so its first entry is that one. A
  // history that does not — `-L` lost the line, or has not answered yet — is
  // drawn behind the blame's own fields rather than instead of them.
  const latest = provisionalOf(
    commit,
    source?.path ?? blame.path,
    source?.line ?? line
  )
  const entries =
    history?.[0]?.hash === commit.hash ? history : [latest, ...(history ?? [])]
  const selected = entries[Math.min(index, entries.length - 1)]!
  const step = (to: number) =>
    setIndex(Math.max(0, Math.min(entries.length - 1, to)))

  const { webUrl } = blame
  const forge = webUrl && new URL(webUrl).hostname.replace(/\.(com|org)$/, "")
  const root = rootOf(filePath)

  const { text: body, trailers } = trailersOf(selected.body)

  return (
    // Its own corners: the tooltip's `overflow` is opened for the labels, so
    // the footer's ground would otherwise square off the rounded border.
    <div className="flex w-[30rem] max-w-[80vw] flex-col overflow-hidden rounded-[calc(var(--radius-md)-1px)] text-xs leading-normal">
      <div className="flex flex-col gap-2 px-3.5 pt-3 pb-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[0.8125rem] leading-snug font-semibold break-words whitespace-pre-wrap">
              <Linked text={selected.subject} webUrl={webUrl} />
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <UserRound className="size-3 shrink-0" />
              <span
                className="truncate font-medium text-foreground/85"
                title={selected.email || undefined}
              >
                {selected.author}
              </span>
              <span aria-hidden>·</span>
              <span className="shrink-0" title={dateTimeOf(selected.date)}>
                {ago(selected.date)}
              </span>
            </div>
          </div>
          {entries.length > 1 && (
            <div className="-mt-0.5 -mr-1 flex shrink-0 items-center rounded-md border border-border">
              <ActionButton
                label="Newer change"
                disabled={index === 0}
                onClick={() => step(index - 1)}
              >
                <ChevronUp />
              </ActionButton>
              <span className="px-0.5 text-[0.65rem] text-muted-foreground tabular-nums">
                {index + 1}/{entries.length}
              </span>
              <ActionButton
                label="Older change — blame before this commit"
                disabled={index === entries.length - 1}
                onClick={() => step(index + 1)}
              >
                <ChevronDown />
              </ActionButton>
            </div>
          )}
        </div>

        {body && (
          <div className="max-h-36 overflow-auto break-words whitespace-pre-wrap text-muted-foreground">
            <Linked text={body} webUrl={webUrl} />
          </div>
        )}
        {trailers.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {trailers.map((trailer, i) => (
              <span
                key={i}
                title={trailer.email || undefined}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.65rem]"
              >
                <span className="shrink-0 text-muted-foreground">
                  {trailerLabel(trailer.key)}
                </span>
                <span className="truncate">{trailer.name}</span>
              </span>
            ))}
          </div>
        )}

        <LineChange
          line={selected.line}
          before={selected.before}
          after={selected.after}
        />
      </div>

      <div className="flex items-center gap-1 border-t border-border bg-muted/40 px-2 py-1.5">
        {" "}
        <Actions
          commit={selected}
          forge={forge ? forge[0]!.toUpperCase() + forge.slice(1) : null}
          commitHref={webUrl && commitUrl(webUrl, selected.hash)}
          // The forge's links are absent rather than greyed for a remote
          // `webUrlOf` cannot address — a button that cannot work is not an
          // option.
          fileHref={
            webUrl &&
            fileUrl(webUrl, selected.hash, selected.path, selected.line || line)
          }
          issues={
            webUrl
              ? issueNumbers(`${selected.subject}\n${selected.body}`)
                  .slice(0, 3)
                  .map((number) => ({
                    number,
                    href: `${webUrl}/issues/${number}`,
                  }))
              : []
          }
          onOpenDiff={
            root
              ? () => {
                  close()
                  useChanges.getState().openCommitFile(root.id, {
                    hash: selected.hash,
                    shortHash: selected.hash.slice(0, 7),
                    subject: selected.subject,
                    path: selected.path,
                    ...(selected.from === undefined
                      ? {}
                      : { from: selected.from }),
                  })
                }
              : null
          }
          onAsk={() => {
            close()
            // Into the draft, never sent — the question is the user's to
            // write, the same bargain the terminal's `Ask about this` makes.
            useComposerBus.getState().deliver({
              text: askAboutCommit(
                { ...selected, summary: selected.subject },
                blame.path,
                line,
                index === 0
              ),
            })
          }}
        />
      </div>

      {source && (
        <History
          entries={history === null ? null : entries}
          index={index}
          onPick={step}
        />
      )}
      {source && history !== null && entries.length === 1 && (
        <div className="flex items-center gap-1.5 border-t border-border px-3.5 py-2 text-[0.7rem] text-muted-foreground">
          <Sparkle className="size-3" />
          The line has not changed since this commit.
        </div>
      )}
    </div>
  )
}

/** `Co-Authored-By` as a chip's caption. */
function trailerLabel(key: string): string {
  const lower = key.toLowerCase()
  if (lower === "co-authored-by") return "Co-author"
  if (lower === "signed-off-by") return "Signed off"
  if (lower === "reviewed-by") return "Reviewed"
  return key
}

/** A message with its `#27`s made links, when there is a forge to link to. */
function Linked({ text, webUrl }: { text: string; webUrl: string | null }) {
  return messageParts(text, webUrl).map((part, i) =>
    "href" in part ? (
      <a
        key={i}
        href={part.href}
        // Out to the browser — `setWindowOpenHandler` in `main.ts` sends a
        // new window's URL to `shell.openExternal`.
        target="_blank"
        rel="noreferrer"
        className="text-primary hover:underline"
      >
        {part.text}
      </a>
    ) : (
      <span key={i}>{part.text}</span>
    )
  )
}

/** The line as the commit found it and left it — the part of a commit's diff
 * that is about this line, without opening the diff. */
function LineChange({
  line,
  before,
  after,
}: {
  line: number
  before: string[]
  after: string[]
}) {
  if (before.length === 0 && after.length === 0) return null
  const rows = [
    ...before.map((text) => ({ sign: "−", text, tone: "deleted" as const })),
    ...after.map((text) => ({ sign: "+", text, tone: "added" as const })),
  ]
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background/60">
      <div className="flex items-center justify-between border-b border-border px-2.5 py-1 text-[0.65rem] text-muted-foreground">
        <span>This line, in this commit</span>
        {line > 0 && <span className="tabular-nums">L{line}</span>}
      </div>
      <div className="py-1 font-mono text-[0.7rem] leading-relaxed">
        {rows.map((row, i) => (
          <div
            key={i}
            className={cn(
              "flex gap-2 px-2.5 whitespace-pre",
              row.tone === "added" ? "bg-[#007100]/10" : "bg-[#ad0707]/10"
            )}
          >
            <span
              className={cn("w-2 shrink-0 select-none", GIT_TONES[row.tone])}
            >
              {row.sign}
            </span>
            <span className="min-w-0 truncate">{row.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Every commit that changed the line, newest first, as a timeline; the one
 * the card is about is filled, and a row picks another. */
function History({
  entries,
  index,
  onPick,
}: {
  entries: GitLineCommit[] | null
  index: number
  onPick: (index: number) => void
}) {
  if (entries !== null && entries.length <= 1) return null
  return (
    <div className="border-t border-border py-2">
      <div className="flex items-center gap-1.5 px-3.5 pb-1 text-[0.65rem] font-medium text-muted-foreground">
        <HistoryIcon className="size-3" />
        Line history
        {entries === null ? (
          <Spinner className="size-3" />
        ) : (
          <span className="rounded-full bg-muted px-1.5 tabular-nums">
            {entries.length}
          </span>
        )}
      </div>
      {entries !== null && (
        <ol className="max-h-44 overflow-auto">
          {entries.map((entry, i) => (
            <li key={entry.hash}>
              <button
                type="button"
                onClick={() => onPick(i)}
                className={cn(
                  "grid w-full grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-1 text-left hover:bg-accent/60",
                  i === index && "bg-accent/60"
                )}
              >
                <span className="relative flex h-full items-center justify-center">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-1/2 w-px -translate-x-1/2 bg-border",
                      i === 0 ? "top-1/2" : "-top-1",
                      i === entries.length - 1 ? "bottom-1/2" : "-bottom-1"
                    )}
                  />
                  <span
                    className={cn(
                      "relative size-2 rounded-full border-[1.5px]",
                      i === index
                        ? "border-primary bg-primary"
                        : "border-muted-foreground/60 bg-popover"
                    )}
                  />
                </span>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[0.65rem] text-warning">
                    {entry.hash.slice(0, 7)}
                  </span>
                  <span
                    className={cn("truncate", i === index && "font-medium")}
                  >
                    {entry.subject}
                  </span>
                </span>
                <span className="max-w-[9rem] truncate text-[0.65rem] text-muted-foreground">
                  {entry.author} · {ago(entry.date)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {entries !== null && entries.length >= HISTORY_LIMIT && (
        <div className="px-3.5 pt-1 text-[0.65rem] text-muted-foreground">
          The last {HISTORY_LIMIT} changes.
        </div>
      )}
    </div>
  )
}

function ActionButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  const container = use(Layer)
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className={className}
          >
            {children}
          </Button>
        }
      />
      <TooltipPrimitive.Portal container={container}>
        <TooltipPrimitive.Positioner
          sideOffset={4}
          className="pointer-events-none isolate z-50"
        >
          <TooltipPrimitive.Popup className="pointer-events-none rounded-md bg-foreground px-2 py-1 text-xs whitespace-nowrap text-background">
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

/**
 * The card's buttons, as icons whose names are their tooltips — the card is a
 * hover over code, and a row of sentences under it was a second paragraph to
 * read past to get back to the line.
 */
function Actions({
  commit,
  forge,
  commitHref,
  fileHref,
  issues,
  onOpenDiff,
  onAsk,
}: {
  commit: GitLineCommit
  /** `GitHub`, `GitLab`, `Bitbucket` — null for a remote with no forge. */
  forge: string | null
  commitHref: string | null
  fileHref: string | null
  issues: { number: number; href: string }[]
  /** Null for a file in no root the diff tab could be opened for. */
  onOpenDiff: (() => void) | null
  onAsk: () => void
}) {
  const [copied, setCopied] = useState<"hash" | "message" | null>(null)

  function copy(what: "hash" | "message", text: string) {
    void navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1200)
  }

  // `window.open`, which `setWindowOpenHandler` in `main.ts` sends to the
  // system browser.
  const open = (href: string) => window.open(href, "_blank", "noreferrer")
  const message = commit.body
    ? `${commit.subject}\n\n${commit.body}`
    : commit.subject

  return (
    <>
      <ActionButton
        label={copied === "hash" ? "Copied" : "Copy commit SHA"}
        onClick={() => copy("hash", commit.hash)}
        className="w-auto gap-1 rounded-full bg-warning/10 px-2 font-mono text-[0.65rem] text-warning hover:bg-warning/20"
      >
        {copied === "hash" ? <Check /> : <GitCommitHorizontal />}
        {commit.hash.slice(0, 7)}
      </ActionButton>
      {commit.stat && (
        <span
          className="ml-1 flex items-center gap-1.5 text-[0.65rem] text-muted-foreground tabular-nums"
          title={statText(commit.stat)}
        >
          <span>
            {commit.stat.files} {commit.stat.files === 1 ? "file" : "files"}
          </span>
          <span className={GIT_TONES.added}>+{commit.stat.added}</span>
          <span className={GIT_TONES.deleted}>−{commit.stat.removed}</span>
        </span>
      )}
      <span className="flex-1" />
      <ActionButton
        label={copied === "message" ? "Copied" : "Copy message"}
        onClick={() => copy("message", message)}
      >
        {copied === "message" ? <Check /> : <Copy />}
      </ActionButton>
      {onOpenDiff && (
        <ActionButton label="Open this commit's diff" onClick={onOpenDiff}>
          <FileDiff />
        </ActionButton>
      )}
      <ActionButton label="Ask in chat" onClick={onAsk}>
        <MessageSquarePlus />
      </ActionButton>

      {forge && (
        <>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          {commitHref && (
            <ActionButton
              label={`Open commit on ${forge}`}
              onClick={() => open(commitHref)}
            >
              <GitCommitHorizontal />
            </ActionButton>
          )}
          {fileHref && (
            <ActionButton
              label="Open file at this commit"
              onClick={() => open(fileHref)}
            >
              <FileCode />
            </ActionButton>
          )}
          {issues.map(({ number, href }) => (
            <ActionButton
              key={number}
              label={`Open #${number} on ${forge}`}
              onClick={() => open(href)}
            >
              <GitPullRequest />
            </ActionButton>
          ))}
        </>
      )}
    </>
  )
}
