import { useCallback, useRef, useState } from "react"
import { filenameFromURL } from "@blocknote/core"
import {
  useBlockNoteEditor,
  useDictionary,
  type FilePanelProps,
} from "@blocknote/react"
import { ImageUpIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { MAX_UPLOAD_LABEL } from "@/lib/note/uploads"

/**
 * The panel an empty image block opens: where a picture is chosen, dropped, or
 * embedded from a URL.
 *
 * BlockNote's own is replaced rather than restyled, the same way the `/` menu
 * is. Its shadcn build renders the Upload tab as a bare `<input type="file">`,
 * which the browser draws itself — a grey "Choose File / No file chosen" that
 * follows the platform rather than the studio, cannot be dropped onto, and has
 * nowhere to say what went wrong. Nor is it this app's shadcn: that build ships
 * a vendored copy of the components and its own tokens, so restyling would have
 * meant tracking someone else's `Input` from the outside.
 *
 * What it is instead is a drop zone and a URL field built from
 * `components/ui/` like the rest of the studio, which is what makes it follow
 * the theme toggle, and which is what lets a failed upload say *why* — the
 * reason `uploadNoteFile` throws a sentence.
 */
export function NoteFilePanel({ blockId }: FilePanelProps) {
  const editor = useBlockNoteEditor()
  const dict = useDictionary()

  const block = editor.getBlock(blockId)
  // Between the panel opening and this render the block can be gone — undone,
  // or deleted from under it.
  if (!block) return null

  const kind =
    block.type in dict.file_panel.upload.file_placeholder ? block.type : "file"

  // What the block will take, from the block's own spec — `image/*` for an
  // image — so the file dialog offers what the editor would accept.
  const types =
    editor.schema.blockSpecs[block.type]?.implementation.meta?.fileBlockAccept

  return (
    <Tabs
      defaultValue="upload"
      className="w-72 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-md"
    >
      <TabsList className="w-full">
        <TabsTrigger value="upload" className="flex-1">
          {dict.file_panel.upload.title}
        </TabsTrigger>
        <TabsTrigger value="embed" className="flex-1">
          {dict.file_panel.embed.title}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="upload">
        <UploadPanel
          blockId={blockId}
          kind={kind}
          accept={types?.length ? types.join(",") : "*/*"}
        />
      </TabsContent>
      <TabsContent value="embed">
        <EmbedPanel blockId={blockId} kind={kind} />
      </TabsContent>
    </Tabs>
  )
}

/**
 * Choose a file, or drop one on the zone.
 *
 * The drop is handled here rather than left to the editor underneath: a file
 * let go over an open panel is meant for the block the panel belongs to, and
 * without `stopPropagation` it reaches ProseMirror's own handler as well and
 * lands as a second block below.
 */
function UploadPanel({
  blockId,
  kind,
  accept,
}: {
  blockId: string
  kind: string
  /** The file dialog's filter, from the block's own spec. */
  accept: string
}) {
  const editor = useBlockNoteEditor()
  const dict = useDictionary()

  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const upload = useCallback(
    async (file: File | undefined) => {
      if (!file || !editor.uploadFile) return

      setFailed(null)
      setBusy(true)
      try {
        const uploaded = await editor.uploadFile(file, blockId)
        // The block can go while the file is being written — a long upload and
        // an undo, or the note closed. Updating one that is gone throws.
        if (!editor.getBlock(blockId)) return

        editor.updateBlock(blockId, {
          props:
            typeof uploaded === "string"
              ? { name: file.name, url: uploaded }
              : uploaded,
        })
        // Nothing closes the panel here: setting the block's URL is a document
        // change, and the panel closes itself on one.
      } catch (error) {
        setFailed(
          error instanceof Error && error.message
            ? error.message
            : dict.file_panel.upload.upload_error
        )
      } finally {
        setBusy(false)
      }
    },
    [blockId, dict, editor]
  )

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        // `dragover` has to be answered on every event, not just the first, or
        // the browser treats the element as refusing the drop and shows the
        // "no" cursor over it.
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOver(false)
          void upload(event.dataTransfer.files[0])
        }}
        className={cn(
          "flex h-24 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-input px-3 text-center transition-colors",
          "hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          over && "border-ring bg-muted/60",
          busy && "pointer-events-none"
        )}
      >
        {busy ? (
          <>
            <Spinner className="text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Saving…</span>
          </>
        ) : (
          <>
            <ImageUpIcon
              aria-hidden
              className="size-5 text-muted-foreground/70"
            />
            <span className="text-sm font-medium">
              {dict.file_panel.upload.file_placeholder[kind]}
            </span>
            <span className="text-xs text-muted-foreground">
              Drop it here, or click to choose
            </span>
          </>
        )}
      </button>

      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        // Cleared on the way out, so choosing the same file twice — after a
        // failure, in practice — is still a change event.
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          void upload(file)
        }}
      />

      <p
        className={cn(
          "px-0.5 text-xs",
          failed ? "text-destructive" : "text-muted-foreground/70"
        )}
      >
        {failed ?? `Up to ${MAX_UPLOAD_LABEL}, kept in this workspace`}
      </p>
    </div>
  )
}

/** A URL, embedded as it is — the file stays wherever it is served from, which
 * is why it is the other tab rather than the same one. */
function EmbedPanel({ blockId, kind }: { blockId: string; kind: string }) {
  const editor = useBlockNoteEditor()
  const dict = useDictionary()

  const [url, setUrl] = useState("")

  const embed = useCallback(() => {
    const trimmed = url.trim()
    if (!trimmed || !editor.getBlock(blockId)) return

    editor.updateBlock(blockId, {
      props: { name: filenameFromURL(trimmed), url: trimmed },
    })
  }, [blockId, editor, url])

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        // The panel is opened by the block, so the field it exists for is what
        // should have the caret.
        autoFocus
        value={url}
        placeholder={dict.file_panel.embed.url_placeholder}
        onChange={(event) => setUrl(event.currentTarget.value)}
        onKeyDown={(event) => {
          // `isComposing` for the same reason BlockNote checks it: Enter is how
          // an IME accepts a candidate, and that Enter is not a submit.
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return
          event.preventDefault()
          embed()
        }}
      />
      <Button size="sm" disabled={!url.trim()} onClick={embed}>
        {dict.file_panel.embed.embed_button[kind]}
      </Button>
    </div>
  )
}
