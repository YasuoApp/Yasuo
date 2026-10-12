import { File, FileText, Image } from "lucide-react"

import { iconFor } from "@/lib/files/icons"
import { isImage, isNote } from "@/lib/files/viewers"
import { cn } from "@/lib/utils"

/**
 * A file's icon: the vendored file-type one, or the glyph the studio uses for
 * anything it has no icon checked in for.
 *
 * Shared by the tab strip and the `Changes` list, which want exactly this and
 * nothing more — a coloured icon reads as "a kind of file the studio knows"
 * rather than as decoration, and the same `.ts` has to look the same in the
 * strip as it does in the list it was clicked in.
 *
 * The Explorer tree deliberately does **not** come through here. Its rows dim
 * the icon for an ignored path, at a different opacity for the image than for
 * the glyph (a full-colour TypeScript logo beside a greyed `dist/bundle.ts`
 * would be the brightest thing in the subtree it is meant to play down), and
 * threading two class names through here would make this shared piece uglier
 * than the copy it removed. Folders never reach it at all: they keep the tree's
 * own chevron and folder glyph, since forty coloured folder icons would compete
 * with the files they hold.
 */
export function FileIcon({
  filePath,
  className,
}: {
  filePath: string
  className?: string
}) {
  const url = iconFor(filePath)
  const classes = cn("size-3.5 shrink-0", className)

  if (url) return <img src={url} alt="" aria-hidden className={classes} />
  if (isImage(filePath)) return <Image aria-hidden className={classes} />
  // A `.note` is the block editor over a file, and this is the glyph that
  // says so.
  if (isNote(filePath)) return <FileText aria-hidden className={classes} />
  return <File aria-hidden className={classes} />
}
