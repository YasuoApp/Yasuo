import { useEffect, useRef, useState, type MouseEvent } from "react"
import { markdownToHTML } from "@blocknote/core"

import { cn } from "@/lib/utils"
import { useFiles } from "@/lib/files/store"
import { highlightCodeBlocks } from "@/lib/markdown/highlight"
import { headingSlug, linkOf } from "@/lib/markdown/links"
import { sanitizeHtml } from "@/lib/markdown/sanitize"
import { markdownRenderer } from "@/lib/markdown/renderer"
import "./markdown-view.css"

/**
 * Some markdown, rendered — a chat message, or a `.md` file in the Explorer.
 *
 * At the studio's root rather than in either panel because it is now both, and
 * one stylesheet means a heading looks the same wherever it was read from. What
 * differs between the two is the type scale a document wants and a message does
 * not, which is what `className` is for.
 *
 * The DOM is put in place imperatively rather than as React children: it is a
 * fragment built outside React, and asking React to own nodes it did not create
 * is how the two end up fighting over the same subtree.
 *
 * If rendering fails for any reason the message is shown as plain text — the
 * same thing this pane did before it could format anything. A failure costs
 * the formatting and nothing else, and says so in the console, which
 * `electron/main.ts` mirrors into the dev terminal.
 */

/**
 * **There are two parsers here, and `rawHtml` is which.** A chat message is
 * Milkdown's — this app's markdown stack, so an agent's reply is formatted by
 * the same parser that reads what the user types into the composer next to it.
 * A file is BlockNote's, and the reason is the HTML in it: Milkdown's schema has
 * one node for raw HTML and it renders as its own source text, so a `<details>`
 * in a README comes out as the characters `<details>`. BlockNote's converter
 * passes markup through, which is what a file needs — every other reader of that
 * file renders it, GitHub included — and it is the parser the **Markdown
 * editor** already reads the same file with, so the two views of a `.md` agree
 * about what it says rather than nearly agreeing.
 *
 * Markup that came out of a repository does not go on the page as it was
 * written: `lib/markdown/sanitize.ts` is the allowlist it goes through first,
 * and the reason there is one. A chat message deliberately does not get this —
 * an agent's reply is output, not a document, and there is nothing in it that
 * has to be markup.
 */
export function MarkdownView({
  source,
  className,
  rawHtml = false,
  baseDir,
}: {
  source: string
  className?: string
  /** Whether the markup in this document is part of it. True for a file. */
  rawHtml?: boolean
  /**
   * The directory of the file the document came from: a local picture —
   * `./logo.png` — resolves against it and is read in as a `data:` URL.
   * Absent for a chat message, which has no directory for one to sit next to.
   */
  baseDir?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // The file's own pipeline, and synchronous: `markdownToHTML` is a string
    // function rather than an editor, so there is nothing to wait for and no
    // frame where the document is missing.
    if (rawHtml) {
      const node = host.current
      if (!node) return
      try {
        node.replaceChildren(sanitizeHtml(markdownToHTML(source)))
        if (baseDir) resolveLocalImages(node, baseDir)
      } catch (error) {
        console.error("Could not render markdown", error)
        // The same fallback as `failed` below, put in place rather than flagged:
        // this branch is synchronous, and a setState here would be a second
        // render of the whole document to say the first one did not work.
        const plain = document.createElement("p")
        plain.className = "break-words whitespace-pre-wrap"
        plain.textContent = source
        node.replaceChildren(plain)
      }
      return
    }

    let alive = true

    void markdownRenderer()
      .then((render) => {
        if (!alive) return
        // A `failed` render has already replaced the host with plain text.
        const node = host.current
        if (!node) return
        node.replaceChildren(render(source))
        if (baseDir) resolveLocalImages(node, baseDir)
        // A frame later, once the parser is in: the text is on screen plain
        // first and coloured when the grammar arrives, the way a file tab is.
        void highlightCodeBlocks(node, () => alive)
      })
      .catch((error: unknown) => {
        if (!alive) return
        console.error("Could not render markdown", error)
        setFailed(true)
      })

    return () => {
      alive = false
    }
  }, [source, rawHtml, baseDir])

  if (failed)
    return (
      <p className={cn("text-sm break-words whitespace-pre-wrap", className)}>
        {source}
      </p>
    )

  return (
    <div
      ref={host}
      onClick={(event) => followLink(event, baseDir)}
      className={cn("markdown-prose text-sm", className)}
    />
  )
}

/**
 * A click on a link, read rather than left to the window — `lib/markdown/
 * links.ts` says what goes wrong otherwise. A web link is the one thing let
 * through, since main already hands that to the browser.
 *
 * A relative link opens in the Explorer, a folder by being revealed in the
 * tree. In a chat message there is no directory to resolve one against, so it
 * does nothing, which is still better than what it did.
 */
function followLink(event: MouseEvent<HTMLDivElement>, baseDir?: string) {
  if (!(event.target instanceof Element)) return
  const anchor = event.target.closest("a[href]")
  if (!anchor || !event.currentTarget.contains(anchor)) return

  const link = linkOf(anchor.getAttribute("href") ?? "")
  if (link.kind === "external") return
  event.preventDefault()

  if (link.kind === "anchor") {
    const heading = Array.from(
      event.currentTarget.querySelectorAll("h1, h2, h3, h4, h5, h6")
    ).find(
      (node) =>
        node.id === link.id ||
        headingSlug(node.textContent ?? "") === link.id.toLowerCase()
    )
    heading?.scrollIntoView({ block: "start" })
    return
  }

  if (link.kind === "relative" && baseDir)
    void openRelative(baseDir, link.paths)
}

async function openRelative(baseDir: string, paths: string[]): Promise<void> {
  for (const candidate of paths) {
    const target = await window.desktop.resolveRelativePath(baseDir, candidate)
    if (!target) continue
    const files = useFiles.getState()
    if (target.directory) await files.reveal(target.path)
    else await files.open(target.path)
    return
  }
  // A dead link stays dead: a README pointing at a file nobody committed is
  // ordinary, and the window staying where it is says as much.
}

/**
 * A document's local pictures, read in and swapped for their paths.
 *
 * `./logo.png` in a README has no meaning to a browser here: the renderer is
 * not on a `file://` origin, so the image is broken unless its bytes come over
 * the bridge like every other file. Main resolves the relative path against
 * the document's own directory — the renderer never joins paths — and reads
 * it back as a `data:` URL, held to the workspace's folders like every other
 * `files:*` call.
 *
 * A `src` with a scheme (`http:`, `data:`, …) is left alone, and so is one
 * anchored at `/`, which in a README means the repository root this preview
 * has no name for.
 */
function resolveLocalImages(host: HTMLElement, baseDir: string): void {
  for (const img of Array.from(host.querySelectorAll("img"))) {
    const src = img.getAttribute("src")
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/")) {
      continue
    }
    // The browser would prefer a relative `srcset` over the fixed `src` below,
    // so a local image takes one without the other.
    img.removeAttribute("srcset")
    void readLocalImage(img, baseDir, src)
  }
}

/**
 * One `<img>` with a relative `src`, read and put in place.
 *
 * A name with a space or a `#` in it travels as `%20`/`%23`, which is not a
 * filename, so the decoded form is tried after the path as written — decoding
 * a `%` that was literal would break a name that is fine as it is. A failure
 * either way leaves the broken image, which is the honest answer for a picture
 * that is too large, not a picture at all, or outside the workspace's folders.
 */
async function readLocalImage(
  img: HTMLImageElement,
  baseDir: string,
  src: string
): Promise<void> {
  const candidates = [src]
  try {
    const decoded = decodeURIComponent(src)
    if (decoded !== src) candidates.push(decoded)
  } catch {
    // Not valid percent-encoding; the path as written is the only reading.
  }

  for (const target of candidates) {
    try {
      img.src = await window.desktop.readImageRelative(baseDir, target)
      return
    } catch {
      // Try the next reading; nothing left to try is the broken image.
    }
  }
}
