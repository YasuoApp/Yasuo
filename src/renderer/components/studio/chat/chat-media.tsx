import { useEffect, useState } from "react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  MessageSquareText,
  X,
} from "lucide-react"

import { noteFileUrl } from "@shared/note-files"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { iconFor } from "@/lib/files/icons"
import { nameOf, parentOf, relativeTo } from "@/lib/files/paths"
import { rootOf } from "@/lib/files/roots"
import { useFiles } from "@/lib/files/store"
import { cn } from "@/lib/utils"
import type { ChatMedia, MediaKind } from "@/lib/chat/media"
import { IconButton } from "../icon-button"
import { SideColumn } from "./side-column"

const TABS: { kind: MediaKind; label: string }[] = [
  { kind: "images", label: "Media" },
  { kind: "files", label: "Files" },
  { kind: "links", label: "Links" },
]

/**
 * What a chat has shared — see `mediaOf` — as a column beside the transcript,
 * where the table of contents goes and for the same reason: it is read while
 * scrolling, so it is a column rather than a popover.
 *
 * Every item can land on the line it came from (`onPick`), which is what makes
 * this a way *into* the conversation rather than a gallery beside it.
 */
export function ChatMediaColumn({
  media,
  onPick,
  onClose,
}: {
  media: ChatMedia
  onPick: (lineId: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<MediaKind>("images")
  const [viewing, setViewing] = useState<number | null>(null)

  return (
    <SideColumn label="Shared media">
      <div className="flex h-8 shrink-0 items-center gap-0.5 pr-1 pl-1.5">
        {/* The tabs give way before the close button does: each may shrink to
            its count, so a narrow column cuts a word rather than pushing
            the X out of reach. */}
        <div role="tablist" className="flex min-w-0 flex-1 gap-0.5">
          {TABS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={tab === kind}
              onClick={() => setTab(kind)}
              className={cn(
                "flex min-w-0 items-baseline rounded-md px-1.5 py-0.5 text-[0.7rem] font-medium whitespace-nowrap text-muted-foreground hover:text-foreground",
                tab === kind && "bg-accent text-foreground"
              )}
            >
              <span className="min-w-0 truncate">{label}</span>
              <span className="ml-1 shrink-0 tabular-nums opacity-60">
                {media[kind].length}
              </span>
            </button>
          ))}
        </div>
        <IconButton
          label="Close media"
          side="bottom"
          onClick={onClose}
          className="shrink-0"
        >
          <X />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {media[tab].length === 0 ? (
          <p className="px-1.5 py-2 text-[0.7rem] text-muted-foreground">
            {tab === "images"
              ? "No pictures yet."
              : tab === "files"
                ? "No files written yet."
                : "No links yet."}
          </p>
        ) : tab === "images" ? (
          <ul className="grid grid-cols-3 gap-1">
            {media.images.map((image, index) => (
              <li key={`${image.lineId}:${image.file}`}>
                <button
                  type="button"
                  aria-label={`Open picture ${index + 1}`}
                  onClick={() => setViewing(index)}
                  className="block aspect-square w-full overflow-hidden rounded-md border bg-muted/50 transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <img
                    src={noteFileUrl(image.file)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    className="size-full object-cover"
                  />
                </button>
              </li>
            ))}
          </ul>
        ) : tab === "files" ? (
          <ul>
            {media.files.map((file) => (
              <Row
                key={file.path}
                title={file.path}
                icon={<FileIcon path={file.path} />}
                label={nameOf(file.path)}
                caption={folderOf(file.path)}
                onOpen={() => void useFiles.getState().open(file.path)}
                onFind={() => onPick(file.lineId)}
              />
            ))}
          </ul>
        ) : (
          <ul>
            {media.links.map((link) => (
              <Row
                key={link.url}
                title={link.url}
                icon={<Link2 className="size-3.5 shrink-0" />}
                label={link.url}
                link
                onOpen={() => openLink(link.url)}
                onFind={() => onPick(link.lineId)}
                actions={
                  <>
                    <CopyButton text={link.url} />
                    <IconButton
                      label="Open in browser"
                      side="left"
                      onClick={() => openLink(link.url)}
                      className="size-6"
                    >
                      <ExternalLink className="size-3.5" />
                    </IconButton>
                  </>
                }
              />
            ))}
          </ul>
        )}
      </div>

      <Viewer
        images={media.images}
        at={viewing}
        onAt={setViewing}
        onFind={(lineId) => {
          setViewing(null)
          onPick(lineId)
        }}
      />
    </SideColumn>
  )
}

/** A file or a link: the row opens it, the buttons beside it — on hover —
 * do the rest, ending with finding it in the chat. What somebody wants from a
 * file listed here is usually the file, and only sometimes the turn that wrote
 * it. */
function Row({
  title,
  icon,
  label,
  caption,
  onOpen,
  onFind,
  actions,
  link = false,
}: {
  title: string
  icon: React.ReactNode
  label: string
  caption?: string
  onOpen: () => void
  onFind: () => void
  /** Buttons ahead of `Show in chat`. */
  actions?: React.ReactNode
  /** Drawn in a link's blue, so a web link reads as one at a glance. */
  link?: boolean
}) {
  return (
    <li className="group/row flex items-center rounded-md hover:bg-accent">
      <button
        type="button"
        title={title}
        onClick={onOpen}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left",
          link
            ? "text-blue-600 group-hover/row:underline dark:text-blue-400"
            : "text-muted-foreground group-hover/row:text-foreground"
        )}
      >
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">{label}</span>
          {caption && (
            <span className="block truncate text-[0.65rem] opacity-60">
              {caption}
            </span>
          )}
        </span>
      </button>
      {/* Hidden rather than unmounted, so a button keeps its focus ring
          for the keyboard; taken out of the row's width only while hidden,
          so a long URL is not cut short for buttons nobody can see. */}
      <span className="hidden shrink-0 items-center group-focus-within/row:flex group-hover/row:flex">
        {actions}
        <IconButton
          label="Show in chat"
          side="left"
          onClick={onFind}
          className="size-6"
        >
          <MessageSquareText className="size-3.5" />
        </IconButton>
      </span>
    </li>
  )
}

function FileIcon({ path }: { path: string }) {
  const url = iconFor(path)
  return url ? (
    <img src={url} alt="" aria-hidden className="size-3.5 shrink-0" />
  ) : (
    <FileText className="size-3.5 shrink-0" />
  )
}

/** Where the file sits, relative to its project — the absolute path is forty
 * characters of checkout before it says anything (see `ObjectChip`). */
function folderOf(path: string): string {
  const root = rootOf(path)
  if (!root) return parentOf(path)
  const relative = relativeTo(root.path, path)
  // `parentOf` answers a bare name with the name itself.
  return relative === nameOf(relative)
    ? root.label
    : `${root.label}/${parentOf(relative)}`
}

/** `window.open` is handed to the browser by main's `setWindowOpenHandler` —
 * no second app window. */
function openLink(url: string): void {
  window.open(url)
}

/** Copies, and says so for a moment with a tick in the button's place — the
 * one feedback a button this small has room for. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <IconButton
      label={copied ? "Copied" : "Copy link"}
      side="left"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => setCopied(true))
      }
      className="size-6"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </IconButton>
  )
}

/**
 * One picture full size, with the rest of the chat's a key away — the
 * Telegram viewer's `←` / `→`. Contained and never scaled up, the rule
 * `ImageThumb`'s dialog follows.
 */
function Viewer({
  images,
  at,
  onAt,
  onFind,
}: {
  images: ChatMedia["images"]
  at: number | null
  onAt: (at: number | null) => void
  onFind: (lineId: string) => void
}) {
  const image = at === null ? undefined : images[at]
  // Newest first, so `←` is back to the newer picture and `→` on to the older:
  // the grid's own reading order.
  const step = (by: number) => {
    if (at === null) return
    const next = at + by
    if (next >= 0 && next < images.length) onAt(next)
  }

  useEffect(() => {
    if (at === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1)
      else if (event.key === "ArrowRight") step(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <Dialog
      open={image !== undefined}
      onOpenChange={(open) => !open && onAt(null)}
    >
      <DialogContent className="w-auto max-w-[calc(100vw-4rem)] gap-2 p-2 sm:max-w-[calc(100vw-4rem)]">
        <DialogTitle className="sr-only">
          Picture {(at ?? 0) + 1} of {images.length}
        </DialogTitle>
        {image && (
          <>
            <img
              src={noteFileUrl(image.file)}
              alt=""
              className="max-h-[calc(100vh-9rem)] max-w-full rounded-md object-contain"
            />
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <IconButton
                label="Newer"
                disabled={at === 0}
                onClick={() => step(-1)}
                className="size-6"
              >
                <ChevronLeft className="size-3.5" />
              </IconButton>
              <span className="tabular-nums">
                {(at ?? 0) + 1} / {images.length}
              </span>
              <IconButton
                label="Older"
                disabled={at === images.length - 1}
                onClick={() => step(1)}
                className="size-6"
              >
                <ChevronRight className="size-3.5" />
              </IconButton>
              <button
                type="button"
                onClick={() => onFind(image.lineId)}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent hover:text-foreground"
              >
                <MessageSquareText className="size-3.5" />
                Show in chat
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
