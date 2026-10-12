import { useEffect, useState } from "react"
import { X } from "lucide-react"

import { noteFileUrl } from "@shared/note-files"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { imageTag } from "@/lib/worktree-chat/images"
import { cn } from "@/lib/utils"

/**
 * The pictures of a message, as thumbnails that open full size.
 *
 * One component for both places a picture is shown — the draft, where the
 * bytes are still in memory and a `data:` URL is the picture, and the
 * transcript, where they are a note file the line names. Labelled with the
 * `[Image #n]` the text says, since that tag is how the text refers to it.
 */
export function ImageThumb({
  src,
  n,
  onRemove,
}: {
  src: string
  n: number
  /** Only in the draft: takes the picture's tag out of the text, which is what
   * takes the picture out of the message — see `attachedIn`. */
  onRemove?: () => void
}) {
  const [open, setOpen] = useState(false)
  const label = imageTag(n)

  return (
    <span className="group/thumb relative inline-flex shrink-0">
      <button
        type="button"
        title={label}
        aria-label={`Open ${label}`}
        onClick={() => setOpen(true)}
        className={cn(
          "size-12 overflow-hidden rounded-md border bg-muted/50",
          "transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        )}
      >
        <img
          src={src}
          alt={label}
          loading="lazy"
          draggable={false}
          className="size-full object-cover"
        />
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Take ${label} out`}
          title={`Take ${label} out`}
          onClick={onRemove}
          className={cn(
            "absolute -top-1.5 -right-1.5 inline-flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground",
            "opacity-0 transition-opacity group-hover/thumb:opacity-100 hover:text-foreground focus-visible:opacity-100"
          )}
        >
          <X className="size-2.5" />
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-auto max-w-[calc(100vw-4rem)] p-2 sm:max-w-[calc(100vw-4rem)]">
          <DialogTitle className="sr-only">{label}</DialogTitle>
          {/* Contained, never scaled up — the Explorer's image view's rule. */}
          <img
            src={src}
            alt={label}
            className="max-h-[calc(100vh-6rem)] max-w-full rounded-md object-contain"
          />
        </DialogContent>
      </Dialog>
    </span>
  )
}

/**
 * A line's pictures, by the note files it names — a sent message's, or what a
 * tool call came back with.
 *
 * The URL is asked of `resolveNoteFileUrl` rather than built: under Electron a
 * `note-file://` URL is the picture, in a browser tab it is a route of the
 * server's — the same split the block editor's pictures go through.
 */
export function NoteImages({ files }: { files: string[] }) {
  const [urls, setUrls] = useState<string[] | null>(null)

  useEffect(() => {
    let current = true
    void Promise.all(
      files.map((name) => window.desktop.resolveNoteFileUrl(noteFileUrl(name)))
    ).then((resolved) => {
      if (current) setUrls(resolved)
    })
    return () => {
      current = false
    }
  }, [files])

  if (!urls) return null
  return (
    <div className="flex flex-wrap gap-1.5 pt-1.5 pb-0.5">
      {urls.map((src, index) => (
        <ImageThumb key={files[index]} src={src} n={index + 1} />
      ))}
    </div>
  )
}
