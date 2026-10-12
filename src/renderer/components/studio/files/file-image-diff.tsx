import { useEffect, useState } from "react"

import type { ImageDoc } from "@/lib/files/store"
import { FileImage } from "./file-image"

/**
 * A changed picture in the `Changes` tab: what was committed beside what is on
 * disk.
 *
 * Two pictures rather than one with a slider or an onion skin: the question a
 * row in `Changes` asks is "what did this turn do to the icon", and for the
 * changes a chat actually makes — a new asset, a recoloured one, a resized
 * one — two pictures at their own sizes answer it without a control to learn.
 *
 * `revision` is the checkout's git status, passed in so a commit made while the
 * comparison is on screen re-reads the committed side too.
 */
export function FileImageDiff({
  path,
  image,
  revision,
}: {
  path: string
  image: ImageDoc
  revision: unknown
}) {
  const [head, setHead] = useState<ImageDoc | "absent">({ kind: "loading" })

  useEffect(() => {
    let current = true
    window.desktop.imageAtHead(path).then(
      (src) => {
        if (current) setHead(src === null ? "absent" : { kind: "image", src })
      },
      (error: unknown) => {
        if (current) {
          setHead({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    )
    return () => {
      current = false
    }
  }, [path, revision])

  // A working copy that will not read beside a committed one that did is a
  // deletion, which is the one failure here worth naming as what it is.
  const deleted = image.kind === "error" && head !== "absent"

  return (
    <div className="grid h-full min-h-0 grid-cols-2 divide-x">
      <Side label="HEAD">
        {head === "absent" ? (
          <Missing text="Not in HEAD — this picture is new." />
        ) : (
          <FileImage image={head} alt={`${path} at HEAD`} />
        )}
      </Side>
      <Side label="Working tree">
        {deleted && head.kind !== "loading" ? (
          <Missing text="Deleted." />
        ) : (
          <FileImage image={image} alt={path} />
        )}
      </Side>
    </div>
  )
}

function Side({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <p className="shrink-0 border-b px-3 py-1.5 font-mono text-[0.65rem] text-muted-foreground">
        {label}
      </p>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

function Missing({ text }: { text: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-xs text-muted-foreground">
      {text}
    </div>
  )
}
