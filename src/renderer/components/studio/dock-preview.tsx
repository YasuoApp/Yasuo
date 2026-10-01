import { useEffect, useRef, useState, type FormEvent } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  RotateCw,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { usePreview } from "@/lib/preview"
import { useProjects } from "@/lib/projects"
import { useComposerBus } from "@/lib/worktree-chat/composer-bus"
import { IconButton } from "./icon-button"

/**
 * The dock's `Preview` tab: the active project's page in a `<webview>`, with
 * a browser's row over it and one button a browser does not have — the page,
 * as a picture, into the chat's composer.
 *
 * A `<webview>` rather than an `<iframe>`: a dev server's page is free to
 * refuse framing, and `capturePage` is the webview's alone. The page runs in
 * its own process with none of the studio's privileges, which is also why
 * nothing here reaches into it.
 *
 * The URL is driven **imperatively**, not through `src`. A webview rewrites
 * its own `src` as it navigates, and setting the attribute to the value it
 * already holds reloads the page — so a `src` bound to the store would reload
 * on the very `did-navigate` that put the URL into the store. `src` is set
 * once, on mount, and after that the element is told to `loadURL` only when
 * the store asks for somewhere it has not been asked for before.
 */
export function DockPreview() {
  const folderId = useProjects((state) => state.activeFolderId)
  const url = usePreview((state) =>
    folderId ? state.urls[folderId] : undefined
  )
  const suggested = usePreview((state) =>
    folderId ? state.suggested[folderId] : undefined
  )
  const setUrl = usePreview((state) => state.setUrl)

  const viewRef = useRef<WebviewElement | null>(null)
  // The last URL the element was asked for — the store's URL once it has
  // been loaded, so an echo of the page's own navigation is not a request.
  const askedRef = useRef<string | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState({ back: false, forward: false })

  // The field shows the store's URL — a link clicked in the page, a project
  // switched to — except while it is being typed in, when it shows the
  // typing. `field` is only ever what was typed since focus, so there is
  // nothing to keep in step.
  const [editing, setEditing] = useState(false)
  const [field, setField] = useState("")
  const shown = editing ? field : (url ?? "")

  useEffect(() => {
    // No URL is no element: the next one mounts a fresh webview, whose first
    // load is the `src` attribute's. Its methods throw until the guest has
    // attached, so that first URL must not be sent through `loadURL`.
    if (!url) {
      askedRef.current = null
      return
    }
    if (askedRef.current === url) return
    const first = askedRef.current === null
    askedRef.current = url
    setError(null)
    const view = viewRef.current
    if (first || !view) return
    void view.loadURL(url).catch(() => {
      // Reported by `did-fail-load` below, with the reason.
    })
  }, [url])

  // Mounted only while the project has a URL, so the listeners go on with
  // the element and come off with it.
  const mounted = Boolean(url)
  useEffect(() => {
    const view = viewRef.current
    if (!view || !folderId) return

    const settle = () => {
      const current = view.getURL()
      if (current) {
        askedRef.current = current
        setUrl(folderId, current)
      }
      setHistory({ back: view.canGoBack(), forward: view.canGoForward() })
    }
    const onStart = () => {
      setLoading(true)
    }
    const onStop = () => {
      setLoading(false)
      // Not `settle()`: a load this component itself cut off — switching
      // projects while the last page was still arriving — stops with
      // `getURL()` still the old page, and writing that into the *new*
      // project's slot would navigate straight back to it. `did-navigate`
      // is the event that says where the view actually went.
      setHistory({ back: view.canGoBack(), forward: view.canGoForward() })
    }
    const onFail = (event: Event) => {
      const { errorCode, errorDescription, isMainFrame } = event as Event & {
        errorCode: number
        errorDescription: string
        isMainFrame: boolean
      }
      // -3 is `ERR_ABORTED`: a navigation the next one cut off, not a failure
      // anybody can act on. A subframe failing is the page's business.
      if (!isMainFrame || errorCode === -3) return
      setLoading(false)
      setError(errorDescription || `Failed to load (${errorCode})`)
    }

    view.addEventListener("did-navigate", settle)
    view.addEventListener("did-navigate-in-page", settle)
    view.addEventListener("did-start-loading", onStart)
    view.addEventListener("did-stop-loading", onStop)
    view.addEventListener("did-fail-load", onFail)
    return () => {
      view.removeEventListener("did-navigate", settle)
      view.removeEventListener("did-navigate-in-page", settle)
      view.removeEventListener("did-start-loading", onStart)
      view.removeEventListener("did-stop-loading", onStop)
      view.removeEventListener("did-fail-load", onFail)
    }
  }, [mounted, folderId, setUrl])

  const go = (event: FormEvent) => {
    event.preventDefault()
    if (!folderId) return
    const typed = shown.trim()
    if (!typed) return
    // `localhost:5173` is what gets typed; the scheme is the one every dev
    // server speaks.
    const next = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed)
      ? typed
      : `http://${typed}`
    setEditing(false)
    setError(null)
    setUrl(folderId, next)
    // Enter on the URL the page is already at is a reload, as it is in a
    // browser: the store will not change, so nothing else would happen.
    if (next === url) viewRef.current?.reload()
  }

  const screenshot = async () => {
    const view = viewRef.current
    if (!view) return
    const image = await view.capturePage()
    const data = image.toDataURL().replace(/^data:image\/png;base64,/, "")
    useComposerBus.getState().deliver({
      images: [{ mediaType: "image/png", data }],
      text: `Screenshot of ${view.getURL()}\n`,
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={go}
        className="flex shrink-0 items-center gap-0.5 border-b px-1.5 py-1"
      >
        <IconButton
          label="Back"
          disabled={!history.back}
          onClick={() => viewRef.current?.goBack()}
          className="size-6 shrink-0"
        >
          <ArrowLeft className="size-3.5" />
        </IconButton>
        <IconButton
          label="Forward"
          disabled={!history.forward}
          onClick={() => viewRef.current?.goForward()}
          className="size-6 shrink-0"
        >
          <ArrowRight className="size-3.5" />
        </IconButton>
        <IconButton
          label={loading ? "Stop" : "Reload"}
          disabled={!url}
          onClick={() =>
            loading ? viewRef.current?.stop() : viewRef.current?.reload()
          }
          className="size-6 shrink-0"
        >
          <RotateCw className={loading ? "size-3 animate-spin" : "size-3"} />
        </IconButton>

        <Input
          value={shown}
          onChange={(event) => setField(event.target.value)}
          onFocus={() => {
            setField(url ?? "")
            setEditing(true)
          }}
          onBlur={() => setEditing(false)}
          placeholder="http://localhost:5173"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Address"
          className="mx-1 h-6 min-w-0 flex-1 px-2 font-mono text-xs"
        />

        <IconButton
          label="Open in browser"
          disabled={!url}
          onClick={() => {
            if (url) window.open(url, "_blank", "noreferrer")
          }}
          className="size-6 shrink-0"
        >
          <ExternalLink className="size-3.5" />
        </IconButton>
        <IconButton
          label="Screenshot to chat"
          disabled={!url}
          onClick={() => void screenshot()}
          className="size-6 shrink-0"
        >
          <Camera className="size-3.5" />
        </IconButton>
      </form>

      {error && (
        <p className="shrink-0 border-b bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {url ? (
          // `display: flex` is what gives a webview a box: its default is
          // `inline-flex`, which sizes it to nothing inside a block.
          <webview
            ref={viewRef}
            src={url}
            // The webview's own attribute, not one React's table knows; it
            // keeps the page's cookies and storage apart from the studio's.
            // eslint-disable-next-line react/no-unknown-property
            partition="persist:preview"
            className="absolute inset-0 h-full w-full"
            style={{ display: "flex" }}
          />
        ) : (
          <Empty
            suggested={suggested}
            onOpen={(next) => {
              if (folderId) setUrl(folderId, next)
            }}
          />
        )}
      </div>
    </div>
  )
}

function Empty({
  suggested,
  onOpen,
}: {
  suggested: string | undefined
  onOpen: (url: string) => void
}) {
  return (
    <div className="grid h-full place-items-center p-4">
      {suggested ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-xs text-muted-foreground">
            A dev server in the shell said it is at
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpen(suggested)}
            className="font-mono text-xs"
          >
            Open {suggested}
          </Button>
        </div>
      ) : (
        <p className="max-w-64 text-center text-xs text-muted-foreground">
          Start a dev server in a shell and its address is offered here, or
          enter one above.
        </p>
      )}
    </div>
  )
}
