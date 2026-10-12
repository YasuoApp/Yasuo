import { useEffect, useRef, useState } from "react"
import { Maximize2, Minimize2 } from "lucide-react"

import { IconButton } from "../icon-button"

/**
 * An `.html` file as the page it draws.
 *
 * A `srcdoc` frame, **sandboxed without `allow-same-origin`**: the page's own
 * scripts run, which is most of what a page is now, but in an opaque origin —
 * so nothing in it can reach `window.desktop`, this window's storage or the
 * parent's DOM. A file in a repository is somebody else's code as often as it
 * is the user's own, and the preview is not the place to find out which.
 *
 * Drawn off `docs[path]` like the markdown preview, so what was typed and not
 * yet saved is what shows.
 *
 * **Relative pictures are read through main** (`readImageRelative`, the
 * markdown preview's call) and put back as `data:` URLs, because a `srcdoc`
 * page has no base a `./logo.png` could resolve against. A relative stylesheet
 * or script is not: the renderer never builds a path, and there is no call
 * that reads text relative to a document — those load as nothing.
 */
export function FileHtml({ text, dir }: { text: string; dir: string }) {
  const [page, setPage] = useState<string | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)

  // Read off the document rather than set by the button: `Esc` leaves
  // fullscreen without passing through anything of ours.
  useEffect(() => {
    const sync = () =>
      setFull(
        document.fullscreenElement !== null &&
          document.fullscreenElement === frame.current
      )
    document.addEventListener("fullscreenchange", sync)
    return () => document.removeEventListener("fullscreenchange", sync)
  }, [])

  const toggle = () => {
    if (full) void document.exitFullscreen()
    else void frame.current?.requestFullscreen()
  }

  useEffect(() => {
    let current = true
    void withLocalImages(text, dir).then((resolved) => {
      if (current) setPage(resolved)
    })
    return () => {
      current = false
    }
  }, [text, dir])

  if (page === null) return null

  return (
    // The wrapper goes fullscreen rather than the frame, so the way back out
    // goes with it.
    <div ref={frame} className="group relative size-full">
      <iframe
        title="HTML preview"
        srcDoc={page}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        // White whatever the theme: a page with no background of its own is
        // drawn on white by every browser, and that is what it is being
        // checked against.
        className="size-full border-0 bg-white"
      />
      <IconButton
        label={full ? "Exit full screen" : "Full screen"}
        variant="outline"
        onClick={toggle}
        className="absolute top-2 right-2 bg-background/90 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        {full ? <Minimize2 /> : <Maximize2 />}
      </IconButton>
    </div>
  )
}

/** Anything with a scheme, a protocol-relative URL, or an in-page anchor is
 * left to the frame. */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

async function withLocalImages(text: string, dir: string): Promise<string> {
  const doc = new DOMParser().parseFromString(text, "text/html")
  const images = [...doc.querySelectorAll("img[src]")].filter(
    (img) => !ABSOLUTE.test(img.getAttribute("src") ?? "")
  )
  if (images.length === 0) return text

  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src") ?? ""
      const url = await window.desktop
        .readImageRelative(dir, decodeOr(src))
        .catch(() => null)
      if (url) img.setAttribute("src", url)
    })
  )

  // Only re-serialised when there was something to rewrite: the parser
  // normalises what it reads, and a page that needed nothing should reach the
  // frame as written.
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}

function decodeOr(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}
